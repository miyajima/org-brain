import assert from "node:assert/strict";
import test from "node:test";
import { checkMemoryContractV2 } from "./memory-contract-v2-contract-check.mjs";

test("memory contract v2 artifacts have one consistent manifest hash", async () => {
  const report = await checkMemoryContractV2();
  assert.equal(report.ok, true, JSON.stringify(report));
});

