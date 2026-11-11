import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { stableJson } from "../packages/orgbrain-cli/src/lib/canonical-json.mjs";
import { canonicalJson } from "../packages/orgbrain-cli/src/verified-collector.mjs";
import { canonicalPipelineReviewHash } from "../packages/orgbrain-cli/src/lib/memory-pipeline-review.mjs";

// RFC 8785 style: plain UTF-16 code unit order. localeCompare would give a_1, a1, b, B.
const input = { b: 1, B: 2, a_1: 3, a1: 4 };
const expected = '{"B":2,"a1":4,"a_1":3,"b":1}';

test("CLI canonical JSON implementations sort keys by UTF-16 code unit order", () => {
  assert.equal(stableJson(input), expected);
  assert.equal(stableJson({ n: [{ ...input }] }), `{"n":[${expected}]}`);
  assert.equal(canonicalJson(input), expected);
  assert.equal(canonicalPipelineReviewHash(input), createHash("sha256").update(expected).digest("hex"));
});

test("canonical JSON implementations never fall back to locale-dependent key ordering", async () => {
  const files = [
    "packages/orgbrain-cli/src/lib/local-domain-recall.mjs",
    "packages/orgbrain-cli/src/lib/canonical-json.mjs",
    "scripts/validate-domain-packs.mjs",
    "packages/core/src/domain-pack.ts",
    "apps/api-gateway/src/domain-recall-service.ts",
    "apps/api-gateway/src/audit-service.ts",
    "apps/api-gateway/src/memory-strata-service.ts"
  ];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(/Object\.(?:entries|keys)\([^\n]*\.sort\([^\n]*localeCompare/u.test(source), false, `${file} must not sort object keys with localeCompare`);
  }
});
