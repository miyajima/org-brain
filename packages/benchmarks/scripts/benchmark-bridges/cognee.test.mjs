import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./cognee.py", import.meta.url), "utf8");

test("Cognee bridge uses cognify and native CHUNKS retrieval", () => {
  assert.match(source, /await cognee\.add\(/);
  assert.match(source, /await cognee\.cognify\(/);
  assert.match(source, /await cognee\.search\(/);
  assert.match(source, /query_type=SearchType\.CHUNKS/);
});

test("Cognee bridge fixes the ingest and embedding models and does not claim zero cost", () => {
  assert.match(source, /gemini\/gemini-3\.5-flash-lite/);
  assert.match(source, /BAAI\/bge-small-en-v1\.5/);
  assert.match(source, /"cost_usd": None/);
  assert.match(source, /"ingest_cost_measured": False/);
});

test("Cognee bridge scopes searches by native dataset without principal ACL synthesis", () => {
  assert.match(source, /datasets=\[tenant_id\]/);
  assert.doesNotMatch(source, /principal_id.*filter/s);
});
