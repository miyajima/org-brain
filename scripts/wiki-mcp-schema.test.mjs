import test from "node:test";
import assert from "node:assert/strict";
import * as wikiMcp from "../packages/orgbrain-cli/src/lib/wiki-mcp.mjs";

const { WIKI_TOOLS } = wikiMcp;
const OPERATIONS = [
  "pages", "read", "search", "sources", "catalog", "source_read", "capture", "capture_audit",
  "recall", "put", "patch", "ingest", "extraction_put", "links", "rename", "delete", "history",
  "diff", "restore_revision", "draft", "drafts", "draft_read", "approve", "diagnose",
];
const tools = new Map(
  WIKI_TOOLS.filter((tool) => OPERATIONS.some((op) => tool.name === `orgbrain_wiki_${op}`))
    .map((tool) => [tool.name.slice("orgbrain_wiki_".length), tool]),
);
const shared = () => {
  assert.ok(wikiMcp.WIKI_INPUT_PROPERTIES, "the shared property table must be exported for drift checks");
  return wikiMcp.WIKI_INPUT_PROPERTIES;
};
const size = (value) => JSON.stringify(value).length;
const legacySchema = () => ({ type: "object", properties: shared(), additionalProperties: false });
const hash = "a".repeat(64);
const origin = { session_id: "s", turn_id: "t", recorded_at: "2026-11-01T00:00:00Z" };
const targets = [{ event_since: "2026-11-01T00:00:00Z", event_until: "2026-11-02T00:00:00Z" }, { experiment_id: "exp-1" }];

// Argument sets taken from existing tests, CLI flags (wiki-cli.mjs), the skill and docs.
const validCalls = {
  pages: [{ limit: 20, offset: 40, token_budget: 1000 }],
  read: [
    { path: "a.md" },
    { page_id: "p", token_budget: 1000 },
    { page_id: "p", section: "Intro", max_chars: 4000, char_offset: 100 },
    { path: "a.md", start_line: 3, end_line: 9 },
  ],
  search: [
    { query: "検索", token_budget: 1000 },
    {
      query: "alpha", mode: "hybrid", scope: "all", match_mode: "any", project_id: "p", page_id: "pg", source_id: "s",
      path_prefix: "raw/", heading: "H", since: "2026-11-01T00:00:00Z", until: "2026-11-02T00:00:00Z",
      per_owner_limit: 3, limit: 10, max_chars: 800, token_budget: 2000, wiki_id: "personal",
    },
  ],
  sources: [{ limit: 50, offset: 50, token_budget: 800 }],
  catalog: [{ folder_id: hash, token_budget: 1500 }, { folder_id: hash, offset: 50, limit: 10, token_budget: 1500 }],
  source_read: [
    { source_id: "s", version: 1, query: "採用未確認", max_chars: 6000, token_budget: 800 },
    { source_id: "s", version: 1, query: "x", char_offset: 30 },
    {
      source_id: "s", section: "Intro", start_line: 1, end_line: 5, context_lines: 3, match_mode: "any", offset: 0,
    },
  ],
  capture: [
    { path: "a.md", name: "a.txt", text: "# 重要\n146件成功。\n", summary: "# 要約" },
    {
      file: "/tmp/report.md", summary: "s", expected_hash: hash, origin, project_id: "p", title: "T", page_id: "pg",
      path: "a.md", source_id: "s", url: "https://example.test/r",
    },
  ],
  capture_audit: [{ text: "# 重要\n146件成功。\n", summary: "# 要約" }],
  recall: [
    { query: "146 未確認", token_budget: 900 },
    { query: "alpha beta", targets, excerpt_mode: "passages", passage_chars: 500, token_budget: 1400 },
    {
      query: "needle", session_files: ["/tmp/s.jsonl"], workspace: "/tmp", session_policy: "always",
      session_since: "2026-11-01T00:00:00Z", session_until: "2026-11-02T00:00:00Z", context_mode: "broad",
      context_lines: 2, project_id: "p", page_id: "pg", source_id: "s", path_prefix: "raw/", heading: "H",
      since: "2026-11-01T00:00:00Z", until: "2026-11-02T00:00:00Z", limit: 4, max_chars: 4000,
    },
  ],
  put: [
    { path: "x.md", content: "x" },
    { path: "x.md", title: "T", content: "c", expected_hash: hash, project_id: "p", origin },
    { page_id: "p", expected_hash: hash, content: "MCP update" },
  ],
  patch: [
    { page_id: "p", expected_hash: hash, section: "Intro", content: "c", project_id: "p" },
    { path: "a.md", expected_hash: hash, start_line: 2, end_line: 4, content: "c" },
  ],
  ingest: [
    { file: "/tmp/a.md", name: "a.md", url: "https://example.test/a", source_id: "s" },
    { name: "long.md", text: "# T" },
  ],
  extraction_put: [{ source_id: "s", version: 1, expected_hash: hash, text: "t", extractor: "pdf", page_count: 3 }],
  links: [{ path: "a.md", depth: 2 }, { page_id: "p" }],
  rename: [{ page_id: "p", path: "b.md", expected_hash: hash, title: "T" }],
  delete: [{ page_id: "p", expected_hash: hash }, { path: "a.md", expected_hash: hash }],
  history: [{ page_id: "p" }, { path: "a.md" }],
  diff: [{ revision_id: "r" }, { revision_id: "r", page_id: "p" }],
  restore_revision: [{ revision_id: "r", expected_hash: hash, project_id: "p" }],
  draft: [{ page_id: "p", expected_hash: hash, content: "c" }, { path: "a.md", expected_hash: hash, content: "c" }],
  drafts: [{ limit: 20, offset: 20 }],
  draft_read: [{ draft_id: "d" }],
  approve: [{ draft_id: "d", expected_hash: hash, project_id: "p" }],
  diagnose: [{}],
};

test("the 24 Wiki operations keep their names, order and descriptions", () => {
  assert.deepEqual([...tools.keys()], OPERATIONS);
  for (const tool of tools.values()) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 10);
  }
});

test("every Wiki tool schema is strictly smaller than the old shared schema and the total drops substantially", () => {
  const legacy = size(legacySchema());
  let total = 0;
  const sizes = [];
  for (const [op, tool] of tools) {
    const bytes = size(tool.inputSchema);
    sizes.push(bytes);
    total += bytes;
    assert.ok(bytes < legacy, `${op} (${bytes}) must be smaller than the shared schema (${legacy})`);
  }
  assert.ok(total < legacy * OPERATIONS.length * 0.5, `total ${total} must be under half of ${legacy * OPERATIONS.length}`);
  console.log(`wiki schema chars: legacy ${legacy} x ${OPERATIONS.length} = ${legacy * OPERATIONS.length}; ` +
    `now total ${total}, per tool ${Math.min(...sizes)}..${Math.max(...sizes)}`);
});

test("per-tool properties are the identical definitions from the shared table, in table order", () => {
  const table = shared();
  const order = Object.keys(table);
  for (const [op, tool] of tools) {
    const schema = tool.inputSchema;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false, `${op} stays strict`);
    const keys = Object.keys(schema.properties);
    assert.deepEqual(keys, order.filter((key) => keys.includes(key)), `${op} keeps shared-table order`);
    for (const key of keys) {
      assert.ok(Object.hasOwn(table, key), `${op}.${key} exists in the shared table`);
      assert.deepEqual(schema.properties[key], table[key], `${op}.${key} must not drift`);
    }
    assert.ok(keys.includes("wiki_id") && keys.includes("token_budget"), `${op} keeps wiki_id and token_budget`);
  }
});

test("every shared property is still reachable through at least one operation", () => {
  const used = new Set([...tools.values()].flatMap((tool) => Object.keys(tool.inputSchema.properties)));
  for (const key of Object.keys(shared())) assert.ok(used.has(key), `${key} is unused by every operation`);
});

test("representative valid calls only use allowed keys and satisfy required keys", () => {
  assert.deepEqual(Object.keys(validCalls), OPERATIONS);
  for (const [op, calls] of Object.entries(validCalls)) {
    const schema = tools.get(op).inputSchema;
    for (const call of calls) {
      for (const key of Object.keys(call))
        assert.ok(Object.hasOwn(schema.properties, key), `${op} must allow ${key}`);
      for (const key of schema.required ?? [])
        assert.ok(Object.hasOwn(call, key), `${op} call ${JSON.stringify(Object.keys(call))} lacks required ${key}`);
    }
  }
});

test("operations expose only the arguments they consume", () => {
  const keys = (op) => Object.keys(tools.get(op).inputSchema.properties);
  assert.deepEqual(keys("diagnose"), ["wiki_id", "token_budget"]);
  assert.deepEqual(keys("draft_read"), ["wiki_id", "token_budget", "draft_id"]);
  for (const op of ["pages", "sources", "drafts", "history", "links", "diff", "delete", "diagnose"])
    for (const key of ["query", "content", "session_files", "targets", "summary"])
      assert.ok(!keys(op).includes(key), `${op} must not advertise ${key}`);
  for (const key of ["session_files", "workspace", "targets", "excerpt_mode", "session_policy"])
    assert.ok(keys("recall").includes(key), `recall allows ${key}`);
  for (const op of OPERATIONS.filter((name) => name !== "recall"))
    assert.ok(!keys(op).includes("session_files"), `${op} must not advertise session access`);
  for (const key of ["path", "title", "content", "expected_hash", "project_id", "origin"])
    assert.ok(keys("put").includes(key), `put allows ${key}`);
  for (const key of ["scope", "mode", "match_mode", "path_prefix", "heading", "since", "until", "per_owner_limit"])
    assert.ok(keys("search").includes(key), `search allows ${key}`);
  assert.ok(!keys("read").includes("content"));
});

test("required keys appear only where every call fails without them", () => {
  const required = (op) => tools.get(op).inputSchema.required ?? [];
  // Alternative identifiers (path or page_id; text or file) must never be forced.
  for (const op of ["read", "history", "links", "put", "patch", "delete", "rename", "draft", "capture"]) {
    assert.ok(!required(op).includes("path"), `${op} accepts an alternative identifier`);
    assert.ok(!required(op).includes("page_id"), `${op} accepts an alternative identifier`);
  }
  assert.ok(!required("capture").includes("text") && !required("capture").includes("file"));
  assert.ok(!required("put").includes("expected_hash"), "creating a page needs no hash");
  assert.deepEqual(required("approve").sort(), ["draft_id", "expected_hash"]);
  assert.deepEqual(required("diff"), ["revision_id"]);
  assert.deepEqual(required("search"), ["query"]);
  assert.deepEqual(required("recall"), ["query"]);
  assert.deepEqual(required("diagnose"), []);
});

// The local MCP server validates tools/call input with this same validator before the handler
// runs, so a schema mistake here is a rejected call for an agent.
test("the server's validator accepts the representative calls and rejects undeclared or incomplete ones", async () => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const resolve = createRequire(new URL("../packages/orgbrain-cli/package.json", import.meta.url)).resolve;
  const { fromJsonSchema } = await import(pathToFileURL(resolve("@modelcontextprotocol/server")).href);
  const issues = async (op, call) =>
    (await fromJsonSchema(tools.get(op).inputSchema)["~standard"].validate(call)).issues ?? [];
  for (const [op, calls] of Object.entries(validCalls))
    for (const call of calls)
      assert.deepEqual(await issues(op, call), [], `${op} ${JSON.stringify(call)}`);
  assert.notDeepEqual(await issues("pages", { limit: 5, content: "x" }), [], "an undeclared argument is rejected");
  assert.notDeepEqual(await issues("search", { limit: 5 }), [], "search without a query is rejected");
  assert.notDeepEqual(await issues("delete", { path: "a.md" }), [], "delete without the read hash is rejected");
  assert.deepEqual(await issues("put", { path: "a.md", content: "# A" }), [], "creating a page needs no hash");
  assert.deepEqual(await issues("rename", { page_id: "p", path: "b.md", expected_hash: hash }), []);
});
