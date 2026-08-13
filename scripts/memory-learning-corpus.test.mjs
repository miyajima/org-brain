import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrivateCorpusManifest, main } from "./memory-learning-corpus.mjs";
import { evaluateStrictBaseline } from "./memory-learning-baseline.mjs";

function writeSession(root, id, startedAt, project, threadSource = "user") {
  const directory = path.join(root, id);
  mkdirSync(directory, { recursive: true });
  const rows = [
    {
      timestamp: new Date(startedAt).toISOString(),
      type: "session_meta",
      payload: { id, cwd: `/workspace/${project}`, thread_source: threadSource }
    },
    {
      timestamp: new Date(startedAt + 1).toISOString(),
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "credential-that-must-not-appear" }
    },
    {
      timestamp: new Date(startedAt + 2).toISOString(),
      type: "event_msg",
      payload: { type: "agent_message", phase: "final_answer", message: "durable-looking answer text" }
    }
  ];
  writeFileSync(path.join(directory, `${id}.jsonl`), `${rows.map(JSON.stringify).join("\n")}\n`);
}

describe("private learning corpus manifest", () => {
  it("splits by session chronology and persists only hashes and counts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "orgbrain-corpus-"));
    for (let index = 0; index < 10; index += 1) {
      writeSession(root, `session-${index}`, 1_700_000_000_000 + index * 1_000, `project-${index % 2}`);
    }
    writeSession(root, "automation", 1_700_000_020_000, "project-3", "automation");

    const manifest = buildPrivateCorpusManifest(root);
    const serialized = JSON.stringify(manifest);
    expect(manifest.counts).toMatchObject({
      sessions: 10,
      final_answers: 10,
      projects: 2,
      by_split: { development: 6, validation: 2, locked_test: 2 }
    });
    expect(manifest.privacy).toEqual({
      raw_transcript_copied: false,
      reasoning_read: false,
      subagent_or_automation_included: false,
      text_persisted: false
    });
    expect(serialized).not.toContain("credential-that-must-not-appear");
    expect(serialized).not.toContain("durable-looking answer text");
    expect(manifest.sessions.every((session) => !Object.hasOwn(session, "text"))).toBe(true);
  });

  it("writes a mode-0600 manifest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "orgbrain-corpus-main-"));
    writeSession(root, "session-1", 1_700_000_000_000, "project-1");
    const output = path.join(root, "private", "manifest.json");

    main(["--sessions-root", root, "--output", output]);

    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(readFileSync(output, "utf8")).not.toContain("durable-looking answer text");
  });

  it("replays the strict baseline without persisting answer or candidate text", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "orgbrain-baseline-"));
    writeSession(root, "session-1", 1_700_000_000_000, "project-1");

    const report = await evaluateStrictBaseline(root);
    const serialized = JSON.stringify(report);

    expect(report.counts).toMatchObject({ sessions: 1, final_answers: 1, candidate_count: 0 });
    expect(report.privacy).toMatchObject({ text_persisted: false, candidate_content_persisted: false });
    expect(serialized).not.toContain("durable-looking answer text");
  });
});
