import assert from "node:assert/strict";
import test from "node:test";
import {
  historyAfterCompaction,
  isolatedDatabase,
  parseSession,
  summarizeContext,
  transcriptRows
} from "./hook-injection-replay.mjs";

const line = (row) => JSON.stringify(row);
const user = (text) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const developer = (text) => ({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text }] } });

test("a session yields its real prompts and compactions in order", () => {
  const session = parseSession(Buffer.from([
    line({ type: "session_meta", payload: { id: "session-1", cwd: "/work/project" } }),
    line({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    line({ type: "turn_context", payload: { cwd: "/work/project" } }),
    line(user("<environment_context>injected by the harness</environment_context>")),
    line({ type: "turn_context", payload: { turn_id: "turn-2", cwd: "/work/project" } }),
    line(user("Fix the retry bug")),
    line(user("A second user row in the same turn is not a new prompt")),
    line({ type: "compacted", payload: { message: "summary" } }),
    line({ type: "turn_context", payload: { turn_id: "turn-3" } }),
    "{ this line is truncated",
    line(user("Add a regression test"))
  ].join("\n")));
  assert.deepEqual(session.meta, { id: "session-1", cwd: "/work/project", subagent: false });
  assert.deepEqual(session.events, [
    { prompt: "Fix the retry bug", turnId: "turn-2" },
    { compacted: true },
    { prompt: "Add a regression test", turnId: "turn-3" }
  ]);
  assert.equal(session.prompts, 2);
  assert.equal(parseSession(Buffer.from(line({ type: "session_meta", payload: { id: "child", cwd: "/w", parent_thread_id: "p" } }))).meta.subagent, true);
});

test("a variant's history keeps its own output until a compaction and ends with the current turn", () => {
  const history = [user("first prompt"), developer("first hook output")];
  const rows = transcriptRows(history, "/work/project", "turn-2", "second prompt");
  assert.deepEqual(rows.slice(0, 2), history);
  assert.deepEqual(rows.at(-2), { type: "turn_context", payload: { turn_id: "turn-2", cwd: "/work/project" } });
  assert.deepEqual(rows.at(-1), user("second prompt"));
  assert.deepEqual(historyAfterCompaction(history), [user("first prompt"), { type: "compacted", payload: {} }]);
});

test("a hook output is summarized into counts without keeping its text", () => {
  const seen = new Set();
  const preview = (id, version) => JSON.stringify({ memory_id: id, kind: "fact", current_version: version, preview: "text" });
  const context = ["OrgBrain memory protocol v2 (internal)", "OrgBrain eager learning is enabled for this workspace.",
    preview("memory-a", 1), preview("memory-b", 2), "OrgBrain Knowledge Wiki (personal) maintenance is enabled."].join("\n\n");
  const first = summarizeContext(context, seen, (text) => text.length);
  assert.deepEqual(first, { chars: context.length, tokens: context.length, previews: 2, repeated_previews: 0, prompts_with_previews: 1,
    prompts_with_contract: 1, prompts_with_eager: 1, prompts_with_observe_hint: 0, prompts_with_wiki_guidance: 1, prompts_without_context: 0 });
  const second = summarizeContext([preview("memory-a", 1), preview("memory-b", 3)].join("\n\n"), seen, (text) => text.length);
  assert.equal(second.repeated_previews, 1, "the same version counts as repeated; a new version does not");
  assert.deepEqual(summarizeContext("", seen, () => { throw new Error("an empty output is not tokenized"); }),
    { chars: 0, tokens: 0, previews: 0, repeated_previews: 0, prompts_with_previews: 0, prompts_with_contract: 0, prompts_with_eager: 0,
      prompts_with_observe_hint: 0, prompts_with_wiki_guidance: 0, prompts_without_context: 1 });
});

test("a variant must point at a database copy", () => {
  const live = "/home/user/.org-brain/memory.sqlite";
  assert.equal(isolatedDatabase("ORGBRAIN_TENANT_ID=default\nORGBRAIN_LOCAL_DB=/tmp/replay/copy.sqlite\n", live), true);
  assert.equal(isolatedDatabase(`ORGBRAIN_LOCAL_DB=${live}\n`, live), false);
  assert.equal(isolatedDatabase("ORGBRAIN_LOCAL_DB=/home/user/.org-brain/../.org-brain/memory.sqlite\n", live), false);
  assert.equal(isolatedDatabase("ORGBRAIN_TENANT_ID=default\n", live), false, "an unset database falls back to the live default");
});
