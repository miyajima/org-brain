import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function quotedValues(source, key) {
  return [...source.matchAll(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "gmu"))]
    .map((match) => match[1])
    .sort();
}

test("API Gateway local and production Wrangler configs keep runtime parity", async () => {
  const production = await readFile(new URL("../apps/api-gateway/wrangler.toml", import.meta.url), "utf8");
  const local = await readFile(new URL("../apps/api-gateway/wrangler.local.toml", import.meta.url), "utf8");
  for (const variable of ["HYBRID_V3_MODE", "HYBRID_V4_MODE", "HYBRID_V4_SHADOW_SAMPLE_RATE"]) {
    assert.deepEqual(quotedValues(local, variable), quotedValues(production, variable), `${variable} differs`);
  }
  assert.deepEqual(quotedValues(local, "binding"), quotedValues(production, "binding"), "bindings differ");
  assert.equal(quotedValues(local, "name").includes("API_RATE_LIMITER"), true);
  assert.equal(quotedValues(production, "name").includes("API_RATE_LIMITER"), true);
  assert.equal(production.includes("database_id"), false);
  assert.equal(local.includes("database_id"), false);
});
