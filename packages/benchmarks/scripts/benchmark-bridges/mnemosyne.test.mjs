import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./mnemosyne.py", import.meta.url), "utf8");

test("Mnemosyne bridge uses native SQLite remember and recall", () => {
  assert.match(source, /from mnemosyne import Mnemosyne/);
  assert.match(source, /Mnemosyne\(session_id=tenant_id, db_path=path\)/);
  assert.match(source, /store\.remember\(/);
  assert.match(source, /store\.recall\(/);
});

test("Mnemosyne bridge is local and does not synthesize ACL behavior", () => {
  assert.match(source, /BAAI\/bge-small-en-v1\.5/);
  assert.match(source, /MNEMOSYNE_DATA_DIR/);
  assert.match(source, /"cost_usd": 0/);
  assert.doesNotMatch(source, /principal_id.*(?:filter|metadata)/s);
  assert.match(source, /extract=False/);
});
