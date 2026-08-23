import assert from "node:assert/strict";
import test from "node:test";
import { fixtureDefinition, parseArgs } from "./ux-fixture.mjs";

test("UX fixture has the required team, project, group, and evidence states", () => {
  const fixture = fixtureDefinition("ux-audit-test");
  assert.equal(fixture.users.filter((user) => user.role === "tenant_admin").length, 2);
  assert.equal(fixture.users.length, 8);
  assert.equal(fixture.groups.length, 3);
  assert.equal(fixture.projects.length, 2);
  assert.deepEqual(fixture.memories.map((memory) => memory.key), ["shared", "restricted", "conflict-a", "conflict-b", "low-confidence", "expired"]);
  assert.ok(fixture.users.every((user) => user.email.endsWith(".invalid")));
});

test("UX fixture requires an explicit target and mutation mode", () => {
  assert.throws(() => parseArgs([]), /Usage/u);
  assert.deepEqual(parseArgs(["--target", "local", "--apply", "--tenant", "ux-audit-test"]).target, "local");
});
