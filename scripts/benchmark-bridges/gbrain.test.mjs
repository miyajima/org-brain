import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./gbrain.ts", import.meta.url), "utf8");

test("GBrain bridge uses the actual PGLite import and keyword search APIs", () => {
  assert.match(source, /GBRAIN_ROOT/);
  assert.match(source, /pglite-engine\.ts/);
  assert.match(source, /import-file\.ts/);
  assert.match(source, /importFromContent\(/);
  assert.match(source, /engine\.searchKeyword\(/);
  assert.match(source, /noEmbed: true/);
});

test("GBrain bridge does not synthesize tenant or principal filtering", () => {
  assert.doesNotMatch(source, /query\.tenant_id.*filter/s);
  assert.doesNotMatch(source, /query\.principal_id.*filter/s);
  assert.match(source, /mode: "keyword"/);
});
