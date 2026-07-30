import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./mem0.py", import.meta.url), "utf8");

test("Mem0 bridge uses the actual OSS Memory API without online inference", () => {
  assert.match(source, /from mem0 import Memory/);
  assert.match(source, /memory\.add\(/);
  assert.match(source, /infer=False/);
  assert.match(source, /memory\.search\(/);
});

test("Mem0 bridge preserves tenant filtering and does not synthesize ACL filtering", () => {
  assert.match(source, /filters=\{"user_id": tenant_id\}/);
  assert.doesNotMatch(source, /principal_id.*filters/s);
  assert.match(source, /records_by_mem0_id/);
});

test("Mem0 bridge declares the fixed extractor boundary and local embedder", () => {
  assert.match(source, /gemini-3\.5-flash-lite/);
  assert.match(source, /BAAI\/bge-small-en-v1\.5/);
  assert.match(source, /"cost_usd": 0/);
});
