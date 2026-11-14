import { describe, expect, it } from "vitest";
import { memoryD1Fixture } from "./fixtures/memory-d1";
import { CloudAmpService } from "../src/amp-service";

function setup() {
  const { env, sql } = memoryD1Fixture();
  env.ORGBRAIN_AMP_ENABLED = "true";
  const service = (tenantId = "default", principal = "alice", projectId = "amp-test") =>
    new CloudAmpService(env, { tenantId, principal, projectId });
  return { env, sql, service, amp: service() };
}

const index = `---
amp: '0.4'
kind: project_index
project_id: amp-test
---
# Test procedures

Read complete conditions before using a procedure.

## Always
- [Working rules](amp/rules.md): Read before work.

## Procedures
- [Start the local server](amp/start.md): Preview the development screen.
`;

describe("Cloud AMP private Markdown storage and shared retrieval", () => {
  it("saves canonical Markdown, preserves typed conditions and exceptions, and reads pinned evidence", async () => {
    const { amp, sql } = setup();
    const source = await amp.ingest({ name: "operating notes", text: "Start only in local mode.\nDo not start when maintenance is true.\n" });
    const saved = await amp.save({ path: "amp/start.md", memory: {
      title: "Preview", claim: "Launch the development process.", conditions: [{ key: "runtime", equals: "local" }],
      exceptions: [{ when: [{ key: "maintenance", equals: true }], reason: "Wait until maintenance finishes." }],
      evidence: [`source:${source.source_id}@${source.version}#L1-L2`]
    } });
    const row = sql.prepare("SELECT markdown FROM amp_pages").get() as { markdown: string };
    expect(row.markdown).toContain("amp: \"0.4\"");
    expect(row.markdown).toContain("conditions:\n  runtime: local");
    expect(row.markdown).not.toContain("source_hashes:");
    const read = await amp.read({ path: saved.path, expected_hash: saved.hash, include_evidence: true });
    expect(read.results[0].evidence[0]).toMatchObject({ integrity: "verified", sha256: source.hash });
    expect(read.results[0].memory).toContain("Wait until maintenance finishes.");
    const excluded = await amp.search({ query: "Launch", mode: "apply", facts: { runtime: "local", maintenance: true } });
    expect(excluded.results).toEqual([]);
    expect(excluded.gaps).toContainEqual(expect.objectContaining({ reason: "exception_matches" }));
  });

  it("uses project index labels independently of prose and returns scoped read instructions", async () => {
    const { amp } = setup();
    await amp.save({ path: "amp/start.md", memory: { claim: "Run the preview process." } });
    await amp.save({ path: "amp/rules.md", memory: { claim: "Read the current rules." } });
    await amp.save({ markdown: index });
    const context = await amp.projectIndex();
    expect(context!.next_read.arguments).toMatchObject({ tenant_id: "default", project_id: "amp-test" });
    const search = await amp.search({ query: "Start the local server", detail: "memory", limit: 1, fallback: false });
    expect(search.results[0]).toMatchObject({ path: "amp/start.md", requires_read: false });
    expect((await amp.validate({ path: "amp/projects/amp-test/index.md" })).valid).toBe(true);
  });

  it("isolates tenant, principal and project for pages, indexes and source bytes", async () => {
    const { amp, service } = setup();
    const source = await amp.ingest({ name: "private", text: "Private deployment condition." });
    const saved = await amp.save({ path: "amp/private.md", memory: { claim: "Private deployment condition." } });
    await amp.save({ markdown: index });
    for (const other of [service("other"), service("default", "bob"), service("default", "alice", "other")]) {
      expect((await other.search({ query: "Private deployment" })).results).toEqual([]);
      await expect(other.read({ path: saved.path, expected_hash: saved.hash })).rejects.toThrow("page_not_found");
      await expect(other.sourceRead({ source_id: source.source_id, version: 1 })).rejects.toThrow("source_not_found");
      expect(await other.projectIndex()).toBeUndefined();
    }
    await expect(amp.save({ project_id: "other", memory: { claim: "Wrong scope" } })).rejects.toThrow("project_scope_mismatch");
  });

  it("uses atomic expected hashes and rejects stale reads or missing evidence without writes", async () => {
    const { amp, sql } = setup();
    const first = await amp.save({ path: "amp/one.md", memory: { claim: "Original" } });
    await expect(amp.save({ path: first.path, memory: { claim: "Unconditional overwrite" } })).rejects.toThrow("expected_hash_required");
    const outcomes = await Promise.allSettled(["Update A", "Update B"].map(claim =>
      amp.save({ path: first.path, expected_hash: first.hash, memory: { claim } })));
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(r => r.status === "rejected")).toHaveLength(1);
    await expect(amp.read({ path: first.path, expected_hash: first.hash })).rejects.toThrow("amp_memory_changed");
    await expect(amp.save({ path: "amp/broken.md", memory: { claim: "Broken", evidence: ["source:missing@1#L1-L1"] } })).rejects.toThrow();
    expect(sql.prepare("SELECT COUNT(*) AS n FROM amp_pages").get()).toMatchObject({ n: 1 });
  });

  it("keeps immutable source versions and returns original-only search results with usable read pointers", async () => {
    const { amp } = setup();
    const first = await amp.ingest({ source_id: "manual", name: "guide", text: "Bluebird condition one.\n" });
    const second = await amp.ingest({ source_id: "manual", name: "guide", text: "Bluebird condition two.\n" });
    expect(second.version).toBe(2);
    expect((await amp.sourceRead({ source_id: "manual", version: 1 })).hash).toBe(first.hash);
    const result = await amp.search({ query: "Bluebird", detail: "summary" });
    expect(result.results[0].next_read.arguments).toMatchObject({ project_id: "amp-test", tenant_id: "default", source_id: "manual" });
    const read = await amp.sourceRead(result.results[0].next_read.arguments);
    expect(read.text).toContain("Bluebird");
  });

  it("does not write when disabled or during dry run and rejects invalid source ranges", async () => {
    const { amp, env, sql } = setup();
    await amp.save({ memory: { claim: "Draft" }, dry_run: true });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM amp_pages").get()).toMatchObject({ n: 0 });
    const s = await amp.ingest({ name: "lines", text: "first\r\nsecond\r\n" });
    expect((await amp.sourceRead({ source_id: s.source_id, version: 1, start_line: 2, end_line: 2 })).text).toBe("second");
    await expect(amp.sourceRead({ source_id: s.source_id, version: 1, start_line: 1, end_line: 9 })).rejects.toThrow("invalid_line_range");
    env.ORGBRAIN_AMP_ENABLED = "false";
    await expect(amp.save({ memory: { claim: "Disabled" } })).rejects.toThrow("feature_disabled");
    await expect(amp.search({ query: "Disabled" })).rejects.toThrow("feature_disabled");
  });
});
