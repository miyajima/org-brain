import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function quotedValues(source, key) {
  return [...source.matchAll(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "gmu"))]
    .map((match) => match[1])
    .sort();
}

test("API Gateway local and production Wrangler configs keep local-safe runtime parity", async () => {
  const production = await readFile(new URL("../apps/api-gateway/wrangler.toml", import.meta.url), "utf8");
  const local = await readFile(new URL("../apps/api-gateway/wrangler.local.toml", import.meta.url), "utf8");
  for (const variable of [
    "HYBRID_V3_MODE",
    "HYBRID_V4_MODE",
    "HYBRID_V4_SHADOW_SAMPLE_RATE",
    "ORGBRAIN_MEMORY_CAPTURE_V2_MODE",
    "ORGBRAIN_UNCONFIRMED_DECISION_BLOCKING",
    "MEMORY_CLASSIFICATION_MODE",
    "RETRIEVAL_GENERATION_ROUTING"
  ]) {
    assert.deepEqual(quotedValues(local, variable), quotedValues(production, variable), `${variable} differs`);
  }
  assert.deepEqual(quotedValues(local, "RETENTION_SWEEP_MODE"), ["observe"]);
  assert.deepEqual(quotedValues(production, "RETENTION_SWEEP_MODE"), ["off"]);
  const productionOnlyBindings = ["AI", "MEMORY_VECTOR_INDEX_V3"];
  const productionBindings = quotedValues(production, "binding");
  const localBindings = quotedValues(local, "binding");
  assert.deepEqual(
    productionBindings.filter((binding) => !productionOnlyBindings.includes(binding)),
    localBindings,
    "local-safe bindings differ"
  );
  assert.deepEqual(
    productionBindings.filter((binding) => !localBindings.includes(binding)),
    productionOnlyBindings,
    "production-only bindings differ"
  );
  assert.equal(quotedValues(local, "name").includes("API_RATE_LIMITER"), true);
  assert.equal(quotedValues(production, "name").includes("API_RATE_LIMITER"), true);
  assert.equal(production.includes("database_id"), false);
  assert.equal(local.includes("database_id"), false);
  assert.match(production, /crons\s*=\s*\["15 19 \* \* \*"\]/u);
});

test("CI starts the API integration Worker with remote bindings disabled", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const startBlock = workflow.match(/pnpm exec wrangler dev[\s\S]*?worker\.log[^\n]*/u)?.[0];
  assert.ok(startBlock, "CI Worker start command is missing");
  assert.match(startBlock, /(?:^|\s)--local(?:\s|$)/u);
  assert.match(startBlock, /(?:^|\s)-c\s+wrangler\.local\.toml(?:\s|$)/u);
  assert.match(startBlock, /API_TENANT_POLICY_JSON:/u);
  assert.match(startBlock, /"role":"tenant_admin"/u);
});
