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
