import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./hindsight.py", import.meta.url), "utf8");

test("Hindsight bridge uses native retain, recall, and bank isolation", () => {
  assert.match(source, /from hindsight_client import Hindsight/);
  assert.match(source, /client\.retain\(/);
  assert.match(source, /client\.recall\(/);
  assert.match(source, /client\.delete_bank\(/);
  assert.match(source, /tenant_bank\(tenant_id\)/);
});

test("Hindsight bridge exposes unknown ingest cost and adds no ACL synthesis", () => {
  assert.match(source, /"ingest_cost_usd": None/);
  assert.doesNotMatch(source, /principal_id.*(?:filter|metadata)/s);
  assert.match(source, /gemini-3\.5-flash-lite/);
});
