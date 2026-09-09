import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPlan,
  parseArgs,
  readCodexSession
} from "./codex-session-hook-replay.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeSession(root, name, rows) {
  const directory = path.join(root, "2026", "08", "12");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${name}.jsonl`);
  await writeFile(target, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return target;
}

function meta(id, cwd, threadSource = "user") {
  return {
    timestamp: "2026-08-12T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd, thread_source: threadSource }
  };
}

function final(message, minute = 1) {
  return {
    timestamp: `2026-08-12T00:${String(minute).padStart(2, "0")}:00.000Z`,
    type: "event_msg",
    payload: { type: "agent_message", phase: "final_answer", message }
  };
}

function responseFinal(message, minute = 1) {
  return {
    timestamp: `2026-08-12T00:${String(minute).padStart(2, "0")}:00.000Z`,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: message }]
    }
  };
}

describe("Codex session Stop-hook replay", () => {
  it("reads only final-answer events from a root session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-replay-test-"));
    temporaryRoots.push(root);
    const file = await writeSession(root, "root", [
      meta("session-root", "/workspace/org-brain"),
      {
        timestamp: "2026-08-12T00:00:30.000Z",
        type: "response_item",
        payload: { role: "assistant", content: "must not be replayed" }
      },
      final("Never commit credentials.")
    ]);

    expect(readCodexSession(file)).toMatchObject({
      id: "session-root",
      threadSource: "user",
      finals: [{ text: "Never commit credentials." }]
    });
  });

  it("streams past an oversized irrelevant row without loading the full session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-replay-test-"));
    temporaryRoots.push(root);
    const file = await writeSession(root, "oversized", [
      meta("session-oversized", "/workspace/org-brain"),
      { timestamp: "2026-08-12T00:00:30.000Z", type: "response_item", payload: { output: "x".repeat(2 * 1024 * 1024 + 1) } },
      final("Streamed final answer.")
    ]);

    expect(readCodexSession(file)).toMatchObject({
      id: "session-oversized",
      finals: [{ text: "Streamed final answer." }]
    });
  });

  it("infers a modern git-backed desktop root when thread_source is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-replay-test-"));
    temporaryRoots.push(root);
    const row = meta("session-modern-root", "/workspace/org-brain");
    delete row.payload.thread_source;
    Object.assign(row.payload, {
      source: "vscode",
      originator: "Codex Desktop",
      git: { branch: "codex/example" },
      parent_thread_id: null,
      subagent_history_start_ordinal: null
    });
    const file = await writeSession(root, "modern-root", [row, responseFinal("Modern root final answer.")]);

    expect(readCodexSession(file)).toMatchObject({
      id: "session-modern-root",
      threadSource: "user",
      finals: [{ text: "Modern root final answer." }]
    });
  });

  it("prefers event finals when a session contains both persisted representations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-replay-test-"));
    temporaryRoots.push(root);
    const file = await writeSession(root, "duplicate-final", [
      meta("session-duplicate-final", "/workspace/org-brain"),
      responseFinal("Same final answer."),
      final("Same final answer.")
    ]);

    expect(readCodexSession(file)?.finals).toEqual([{ text: "Same final answer.", occurredAt: Date.parse("2026-08-12T00:01:00.000Z") }]);
  });

  it("retains distinct turns when a session changes final-answer representation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-replay-test-"));
    temporaryRoots.push(root);
    const file = await writeSession(root, "mixed-finals", [
      meta("session-mixed-finals", "/workspace/org-brain"),
      final("Earlier event final."),
      responseFinal("Later response final.", 2)
    ]);

    expect(readCodexSession(file)?.finals.map((item) => item.text)).toEqual([
      "Earlier event final.",
      "Later response final."
    ]);
  });

  it("fails closed for unlabeled parented and subagent-shaped sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-replay-test-"));
    temporaryRoots.push(root);
    const shapes = [
      { source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } }, originator: "Codex Desktop", git: {} },
      { source: "vscode", originator: "Codex Desktop", git: {}, parent_thread_id: "parent" },
      { source: "vscode", originator: "Codex Desktop" },
      { source: "vscode", originator: "unknown", git: {} }
    ];

    for (const [index, shape] of shapes.entries()) {
      const row = meta(`session-excluded-${index}`, "/workspace/org-brain");
      delete row.payload.thread_source;
      Object.assign(row.payload, shape);
      const file = await writeSession(root, `excluded-${index}`, [row, final("Excluded final answer.")]);
      expect(readCodexSession(file)?.threadSource).toBe("");
    }
  });

  it("excludes subagents and structural noise while producing a stable plan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orgbrain-replay-test-"));
    temporaryRoots.push(root);
    await writeSession(root, "root", [
      meta("session-root", "/workspace/org-brain"),
      final([
        "## Conclusion",
        "Stop hookは既知のcapture toolを必ず一回だけ呼ぶ。",
        "",
        "## Rationale",
        "tool discoveryと複数送信を避けることで、停止処理の遅延と重複保存を防げるため。",
        "",
        "## Reuse",
        "新しいagent lifecycle hookを実装する場合は、候補を一つのbatch requestへまとめる。",
        "",
        "## Evidence",
        "packages/orgbrain-cli/src/hook-memory-bridge.mjs",
        "scripts/hook-memory-bridge.test.mjs"
      ].join("\n")),
      final("| Runtime | State | Decision |\n| Hermes | stopped | not adopted |", 2)
    ]);
    await writeSession(root, "subagent", [
      meta("session-subagent", "/workspace/org-brain", "subagent"),
      final("We decided to persist this internal guardian report.")
    ]);
    await writeSession(root, "other-project", [
      meta("session-other", "/workspace/elsewhere"),
      final("Never commit credentials.")
    ]);

    const options = parseArgs([
      "--sessions-root", root,
      "--tenant", "default",
      "--project", "org-brain",
      "--output", path.join(root, "report.json")
    ]);
    const first = await buildPlan(options);
    const second = await buildPlan(options);

    expect(first.planHash).toBe(second.planHash);
    expect(first.summary).toMatchObject({
      sessions_scanned: 1,
      completed_turns_scanned: 2,
      batches_with_candidates: 1,
      candidate_count: 1,
      kind_counts: { constraint: 1 }
    });
    expect(first.planCore.session_ids).toEqual(["session-root"]);
    expect(first.planCore.batches[0].items[0]).toMatchObject({
      kind: "constraint",
      content: "Stop hookは既知のcapture toolを必ず一回だけ呼ぶ。"
    });
  });
});
