import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifiedCandidates } from "../packages/shared/src/memory-extraction-verifier-runtime.mjs";
import {
  loadSessionPipelinePacket,
  loadSessionPipelineSource,
  loadWikiPipelineSource,
} from "../packages/orgbrain-cli/src/lib/memory-pipeline-sources.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;

async function sessionFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-pipeline-source-"));
  const queueDir = path.join(root, "queue");
  await mkdir(queueDir);
  const snippets = [
    { span_id: "a", role: "assistant", source: "assistant", text: "Use the cache.", text_hash: `sha256:${sha256("Use the cache.")}` },
    { span_id: "r", role: "assistant", source: "assistant", text: "The reason is reduced duplicate work.", text_hash: `sha256:${sha256("The reason is reduced duplicate work.")}` },
    { span_id: "c", role: "assistant", source: "assistant", text: "Except in production.", text_hash: `sha256:${sha256("Except in production.")}` },
    { span_id: "v", role: "assistant", source: "assistant", text: "27 tests passed; production remains unverified.", text_hash: `sha256:${sha256("27 tests passed; production remains unverified.")}` },
  ];
  const packet = {
    policy: "session-extraction/v1",
    schema: "learning-extraction-proposal/v2",
    tenant_id: "default",
    project_id: "org-brain",
    snippets,
    events: [{ event_id: "event-1", call_id: "call-1", type: "tool_execution", name: "test", status: "completed" }],
  };
  const jobId = "a".repeat(64);
  const verified = await verifiedCandidates(
    { packet, run_id: jobId, project_id: packet.project_id },
    [{
      lesson_type: "success",
      support_span_ids: ["a", "r", "c", "v"],
      fields: [
        { name: "procedure", values: [snippets[0].text] },
        { name: "why_it_worked", values: [snippets[1].text] },
        { name: "reuse_when", values: [snippets[2].text] },
        { name: "reported_verification", values: [snippets[3].text] },
      ],
      gaps: ["observed_outcome_missing"],
    }],
  );
  assert.equal(verified.candidates.length, 1, JSON.stringify(verified.rejections));
  const candidate = {
    ...verified.candidates[0],
    automatic_promotion: false,
    source_client: "cursor",
    extraction_model: "anthropic/claude-haiku-5.5",
    extraction_effort: "medium",
  };
  const candidateId = "learning-candidate:fixture";
  const taskKey = `session-extraction:${jobId}`;
  const memoryDb = new DatabaseSync(path.join(root, "memory.sqlite"));
  memoryDb.exec(`CREATE TABLE memory_learning_candidates (
    id TEXT, tenant_id TEXT, project_id TEXT, task_key TEXT, external_key TEXT,
    payload_json TEXT, status TEXT, reason_codes_json TEXT, created_at INTEGER, expires_at INTEGER
  )`);
  memoryDb.prepare(`INSERT INTO memory_learning_candidates
    (id,tenant_id,project_id,task_key,external_key,payload_json,status,reason_codes_json,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    candidateId,
    "default",
    "org-brain",
    taskKey,
    candidate.external_key,
    JSON.stringify(candidate),
    "quarantine",
    JSON.stringify(candidate.reason_codes),
    1,
    2,
  );
  const queueDb = new DatabaseSync(path.join(queueDir, "queue.sqlite"));
  queueDb.exec(`CREATE TABLE jobs (
    id TEXT, tenant_id TEXT, project_id TEXT, client TEXT, packet_json TEXT,
    packet_hash TEXT, status TEXT, policy_hash TEXT
  )`);
  const packetHash = sha256(JSON.stringify(packet));
  queueDb.prepare(`INSERT INTO jobs
    (id,tenant_id,project_id,client,packet_json,packet_hash,status,policy_hash)
    VALUES(?,?,?,?,?,?,?,?)`).run(
    jobId,
    "default",
    "org-brain",
    "cursor",
    JSON.stringify(packet),
    packetHash,
    "completed",
    "fixture-policy-hash",
  );
  queueDb.close();
  return { root, queueDir, memoryDb, packet, candidate, candidateId, jobId, packetHash };
}

function updatePacket(fixture, packet) {
  const queueDb = new DatabaseSync(path.join(fixture.queueDir, "queue.sqlite"));
  const packetHash = sha256(JSON.stringify(packet));
  queueDb.prepare("UPDATE jobs SET packet_json=?, packet_hash=? WHERE id=?").run(
    JSON.stringify(packet), packetHash, fixture.jobId,
  );
  queueDb.close();
  fixture.packet = packet;
  fixture.packetHash = packetHash;
  return packetHash;
}

async function wikiFixture({ pageText, pageHash, sourceText, sourceId, sourceVersion = 1 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-"));
  const config = path.join(root, "features.json");
  await writeFile(config, JSON.stringify({ features: { llm_wiki: { enabled: true, epoch: 3 } } }));
  const source = sourceText ?? "# Evidence\nUse the verified command.\n";
  const id = sourceId ?? "11111111-1111-4111-8111-111111111111";
  const version = sourceVersion;
  const text = pageText ?? `# Procedure\n\nsource:${id}@${version}#L2-L2\n`;
  const hash = pageHash ?? sha256("wiki revision 1");
  const sourceHash = sha256("immutable original bytes");
  const service = {
    config,
    wikiId: "personal",
    async request(input) {
      assert.equal(input.wiki_id, "personal");
      assert.ok(["default", "tenant-1"].includes(input.tenant_id));
      if (input.op === "read") {
        return {
          page_id: "page-1",
          path: "wiki/procedures/cache.md",
          title: "Cache procedure",
          content: text,
          hash,
          content_hash: sha256(text),
          project_id: "org-brain",
          deleted: 0,
          truncated: false,
        };
      }
      if (input.op === "history") {
        return { revisions: [{ revision_id: "revision-1", hash, path: "wiki/procedures/cache.md", deleted: false }] };
      }
      if (input.op === "source_read") {
        return {
          source_id: id,
          version,
          hash: sourceHash,
          extraction_hash: sha256(source),
          text: source,
          truncated: false,
          next_char_offset: null,
        };
      }
      throw new Error(`unexpected_wiki_op:${input.op}`);
    },
  };
  return { root, config, service, pageText: text, pageHash: hash, sourceText: source, sourceHash, sourceId: id, sourceVersion: version };
}

test("session adapter returns a frozen, source-grounded snapshot without changing promotion state", async (t) => {
  const fixture = await sessionFixture();
  t.after(async () => { fixture.memoryDb.close(); await rm(fixture.root, { recursive: true, force: true }); });
  const before = fixture.memoryDb.prepare("SELECT payload_json FROM memory_learning_candidates WHERE id=?").get(fixture.candidateId).payload_json;
  const source = await loadSessionPipelineSource({
    db: fixture.memoryDb,
    queueDir: fixture.queueDir,
    tenantId: "default",
    projectId: "org-brain",
    candidateId: fixture.candidateId,
  });
  const after = fixture.memoryDb.prepare("SELECT payload_json FROM memory_learning_candidates WHERE id=?").get(fixture.candidateId).payload_json;
  assert.equal(before, after);
  assert.equal(source.provenance, "retained_packet");
  assert.equal(source.source_type, "session_extraction");
  assert.ok(source.source_key.includes(fixture.jobId));
  assert.equal(source.tenant_id, "default");
  assert.equal(source.authorship, "unverified");
  assert.equal(source.automatic_promotion, false);
  assert.equal(source.packet_hash, fixture.packetHash);
  assert.equal(source.support_span_ids.length, 4);
  assert.deepEqual(source.snippets.map((snippet) => snippet.span_id), ["a", "r", "c", "v"]);
  assert.equal(source.observation.procedure, "Use the cache.");
  assert.ok(Object.isFrozen(source) && Object.isFrozen(source.snippets) && Object.isFrozen(source.observation));
  assert.equal(source.source_hash, sha256(JSON.stringify(stable({
    source_type: source.source_type,
    source_key: source.source_key,
    candidate_id: source.candidate_id,
    candidate_hash: source.candidate_hash,
    job_id: source.job_id,
    packet_hash: source.packet_hash,
    policy_hash: source.policy_hash,
    tenant_id: source.tenant_id,
    project_id: source.project_id,
    status: source.status,
    automatic_promotion: source.automatic_promotion,
    provenance: source.provenance,
    authorship: source.authorship,
    observation: source.observation,
    support_span_ids: source.support_span_ids,
    snippets: source.snippets,
  }))));
});

test("session packet source returns the complete retained packet without candidate claims", async (t) => {
  const fixture = await sessionFixture();
  t.after(async () => { fixture.memoryDb.close(); await rm(fixture.root, { recursive: true, force: true }); });
  const packet = structuredClone(fixture.packet);
  while (packet.snippets.length < 20) {
    const index = packet.snippets.length;
    const text = `Additional retained span ${index}.`;
    packet.snippets.push({ span_id: `extra-${index}`, role: "assistant", source: "assistant", text, text_hash: `sha256:${sha256(text)}` });
  }
  packet.events = Array.from({ length: 24 }, (_, index) => ({
    event_id: `event-${index + 1}`,
    call_id: `call-${index + 1}`,
    type: "tool_execution",
    name: "test",
    status: "completed",
  }));
  const packetHash = updatePacket(fixture, packet);
  const source = await loadSessionPipelinePacket({
    queueDir: fixture.queueDir,
    tenantId: "default",
    projectId: "org-brain",
    jobId: fixture.jobId,
  });
  assert.equal(source.source_type, "session_extraction");
  assert.equal(source.source_key, `packet:${fixture.jobId}:${packetHash}`);
  assert.equal(source.tenant_id, "default");
  assert.equal(source.project_id, "org-brain");
  assert.equal(source.job_id, fixture.jobId);
  assert.equal(source.packet_hash, packetHash);
  assert.equal(source.policy_hash, "fixture-policy-hash");
  assert.equal(source.provenance, "retained_packet");
  assert.equal(source.authorship, "unverified");
  assert.deepEqual(source.support_span_ids, packet.snippets.map((snippet) => snippet.span_id));
  assert.deepEqual(source.snippets, packet.snippets);
  assert.deepEqual(source.events, packet.events);
  assert.equal(source.snippets.length, 20);
  assert.equal(source.events.length, 24);
  assert.equal("observation" in source, false);
  assert.equal("candidate_id" in source, false);
  assert.equal("automatic_promotion" in source, false);
  assert.match(source.source_hash, /^[a-f0-9]{64}$/u);
  const { source_hash: _sourceHash, ...base } = source;
  assert.equal(source.source_hash, sha256(JSON.stringify(stable(base))));
  assert.ok(Object.isFrozen(source) && Object.isFrozen(source.support_span_ids));
  assert.ok(Object.isFrozen(source.snippets) && Object.isFrozen(source.snippets[0]));
  assert.ok(Object.isFrozen(source.events) && Object.isFrozen(source.events[0]));
});

test("session packet source accepts legacy snippets without per-snippet hashes when the packet hash is valid", async (t) => {
  const fixture = await sessionFixture();
  t.after(async () => { fixture.memoryDb.close(); await rm(fixture.root, { recursive: true, force: true }); });
  const packet = structuredClone(fixture.packet);
  for (const snippet of packet.snippets) snippet.text_hash = null;
  const packetHash = updatePacket(fixture, packet);
  const source = await loadSessionPipelinePacket({
    queueDir: fixture.queueDir,
    tenantId: "default",
    projectId: "org-brain",
    jobId: fixture.jobId,
  });
  assert.equal(source.packet_hash, packetHash);
  assert.deepEqual(source.snippets, packet.snippets);
});

test("session packet source rejects packet policy or embedded scope that disagrees with the job", async (t) => {
  const fixture = await sessionFixture();
  t.after(async () => { fixture.memoryDb.close(); await rm(fixture.root, { recursive: true, force: true }); });
  const original = structuredClone(fixture.packet);
  for (const [field, value] of [["policy", "session-extraction/other"], ["tenant_id", "other-tenant"], ["project_id", "other-project"]]) {
    const packet = structuredClone(original);
    packet[field] = value;
    updatePacket(fixture, packet);
    await assert.rejects(
      loadSessionPipelinePacket({ queueDir: fixture.queueDir, tenantId: "default", projectId: "org-brain", jobId: fixture.jobId }),
      /session_packet_mismatch/u,
    );
  }
});

test("session packet source rejects packet hash, scope, status, and span-integrity mismatches", async (t) => {
  const fixture = await sessionFixture();
  t.after(async () => { fixture.memoryDb.close(); await rm(fixture.root, { recursive: true, force: true }); });

  const wrongHashDb = new DatabaseSync(path.join(fixture.queueDir, "queue.sqlite"));
  wrongHashDb.prepare("UPDATE jobs SET packet_hash=? WHERE id=?").run("f".repeat(64), fixture.jobId);
  wrongHashDb.close();
  await assert.rejects(
    loadSessionPipelinePacket({ queueDir: fixture.queueDir, tenantId: "default", projectId: "org-brain", jobId: fixture.jobId }),
    /session_packet_mismatch/u,
  );

  updatePacket(fixture, fixture.packet);
  await assert.rejects(
    loadSessionPipelinePacket({ queueDir: fixture.queueDir, tenantId: "default", projectId: "another-project", jobId: fixture.jobId }),
    /session_job_not_found|session_candidate_scope_mismatch/u,
  );

  const queueDb = new DatabaseSync(path.join(fixture.queueDir, "queue.sqlite"));
  queueDb.prepare("UPDATE jobs SET status='pending' WHERE id=?").run(fixture.jobId);
  queueDb.close();
  await assert.rejects(
    loadSessionPipelinePacket({ queueDir: fixture.queueDir, tenantId: "default", projectId: "org-brain", jobId: fixture.jobId }),
    /session_job_not_completed/u,
  );

  const statusDb = new DatabaseSync(path.join(fixture.queueDir, "queue.sqlite"));
  statusDb.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(fixture.jobId);
  statusDb.close();
  const tampered = structuredClone(fixture.packet);
  tampered.snippets[0].text = "Edited without updating its snippet hash.";
  updatePacket(fixture, tampered);
  await assert.rejects(
    loadSessionPipelinePacket({ queueDir: fixture.queueDir, tenantId: "default", projectId: "org-brain", jobId: fixture.jobId }),
    /session_snippet_mismatch/u,
  );

  const duplicateSpan = structuredClone(fixture.packet);
  duplicateSpan.snippets[1].span_id = duplicateSpan.snippets[0].span_id;
  updatePacket(fixture, duplicateSpan);
  await assert.rejects(
    loadSessionPipelinePacket({ queueDir: fixture.queueDir, tenantId: "default", projectId: "org-brain", jobId: fixture.jobId }),
    /session_snippet_mismatch/u,
  );
});

test("session adapter rejects a queue packet whose stored packet hash no longer matches", async (t) => {
  const fixture = await sessionFixture();
  t.after(async () => { fixture.memoryDb.close(); await rm(fixture.root, { recursive: true, force: true }); });
  const queueDb = new DatabaseSync(path.join(fixture.queueDir, "queue.sqlite"));
  const tampered = structuredClone(fixture.packet);
  tampered.snippets[0].text = "Changed after extraction.";
  queueDb.prepare("UPDATE jobs SET packet_json=? WHERE id=?").run(JSON.stringify(tampered), fixture.jobId);
  queueDb.close();
  await assert.rejects(
    loadSessionPipelineSource({ db: fixture.memoryDb, queueDir: fixture.queueDir, tenantId: "default", projectId: "org-brain", candidateId: fixture.candidateId }),
    /session_packet_mismatch/u,
  );
});

test("session adapter rejects missing support spans and altered observation claims", async (t) => {
  const fixture = await sessionFixture();
  t.after(async () => { fixture.memoryDb.close(); await rm(fixture.root, { recursive: true, force: true }); });
  const row = fixture.memoryDb.prepare("SELECT payload_json FROM memory_learning_candidates WHERE id=?").get(fixture.candidateId);
  const payload = JSON.parse(row.payload_json);
  payload.support_span_ids = ["missing-span"];
  fixture.memoryDb.prepare("UPDATE memory_learning_candidates SET payload_json=? WHERE id=?").run(JSON.stringify(payload), fixture.candidateId);
  await assert.rejects(
    loadSessionPipelineSource({ db: fixture.memoryDb, queueDir: fixture.queueDir, tenantId: "default", projectId: "org-brain", candidateId: fixture.candidateId }),
    /session_support_unresolved/u,
  );

  payload.support_span_ids = ["a", "r", "c", "v"];
  payload.observation.procedure = "Invented procedure.";
  fixture.memoryDb.prepare("UPDATE memory_learning_candidates SET payload_json=? WHERE id=?").run(JSON.stringify(payload), fixture.candidateId);
  await assert.rejects(
    loadSessionPipelineSource({ db: fixture.memoryDb, queueDir: fixture.queueDir, tenantId: "default", projectId: "org-brain", candidateId: fixture.candidateId }),
    /session_candidate_unverified/u,
  );
});

test("Wiki adapter binds a personal page revision and exact immutable source version", async (t) => {
  const fixture = await wikiFixture();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });
  const source = await loadWikiPipelineSource({
    wikiService: fixture.service,
    path: "wiki/procedures/cache.md",
    expectedHash: fixture.pageHash,
    projectId: "org-brain",
    tenantId: "tenant-1",
  });
  assert.equal(source.provenance, "wiki_revision_and_immutable_source");
  assert.equal(source.source_type, "personal_wiki");
  assert.ok(source.source_key.includes("revision-1"));
  assert.equal(source.tenant_id, "tenant-1");
  assert.equal(source.authorship, "unverified");
  assert.equal(source.page_id, "page-1");
  assert.equal(source.revision_id, "revision-1");
  assert.equal(source.hash, fixture.pageHash);
  assert.equal(source.path, "wiki/procedures/cache.md");
  assert.equal(source.text, fixture.pageText);
  assert.equal(source.sources.length, 1);
  assert.equal(source.sources[0].ref, `source:${fixture.sourceId}@${fixture.sourceVersion}#L2-L2`);
  assert.equal(source.sources[0].text, "Use the verified command.");
  assert.equal(source.sources[0].source_hash, fixture.sourceHash);
  assert.equal(source.sources[0].hash, fixture.sourceHash);
  assert.ok(Object.isFrozen(source) && Object.isFrozen(source.sources[0]));
  assert.match(source.source_hash, /^[a-f0-9]{64}$/u);
});

test("Wiki adapter rejects stale pages, unresolved sources, and over-limit references", async (t) => {
  const stale = await wikiFixture();
  t.after(async () => { await rm(stale.root, { recursive: true, force: true }); });
  await assert.rejects(
    loadWikiPipelineSource({ wikiService: stale.service, pageId: "page-1", expectedHash: sha256("old revision"), projectId: "org-brain" }),
    /wiki_page_stale/u,
  );

  const unresolved = await wikiFixture();
  t.after(async () => { await rm(unresolved.root, { recursive: true, force: true }); });
  const brokenService = { ...unresolved.service, request: async (input) => {
    if (input.op === "source_read") return { source_id: "wrong", version: 1, hash: "0".repeat(64), extraction_hash: "0".repeat(64), text: "wrong", truncated: false };
    return unresolved.service.request(input);
  } };
  await assert.rejects(
    loadWikiPipelineSource({ wikiService: brokenService, path: "wiki/procedures/cache.md", expectedHash: unresolved.pageHash, projectId: "org-brain" }),
    /wiki_source_unresolved/u,
  );

  const tooMany = await wikiFixture({ pageText: Array.from({ length: 9 }, (_, i) => `source:${"11111111-1111-4111-8111-" + String(i + 1).padStart(12, "0")}@1`).join("\n") });
  t.after(async () => { await rm(tooMany.root, { recursive: true, force: true }); });
  await assert.rejects(
    loadWikiPipelineSource({ wikiService: tooMany.service, path: "wiki/procedures/cache.md", expectedHash: tooMany.pageHash, projectId: "org-brain" }),
    /wiki_source_limit/u,
  );
});
