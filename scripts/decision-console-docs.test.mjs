import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const documents = {
  concept: read("docs/CONCEPT.md"),
  spec: read("docs/SPEC.md"),
  architecture: read("docs/ARCHITECTURE.md"),
  systemDesign: read("docs/SYSTEM_DESIGN.md"),
  runbook: read("docs/DECISION_CONSOLE_V2_RUNBOOK.md"),
};

const requiredRoutes = [
  "/v1/decision-briefing",
  "/v1/decisions/:id/trace",
  "/v1/decisions/:id/map",
  "/v1/skill-providers",
  "/v1/skills/generate",
  "/v1/agents/:id/context-preview",
  "/v1/access-policies/:resourceType/:resourceId",
  "/v1/ops/access-policy-shadow",
];

test("decision-first product documents keep approved frontmatter", () => {
  for (const [name, body] of Object.entries(documents)) {
    assert.match(body, /^---\n/);
    assert.match(body, /\nstatus: approved\n/, `${name} status`);
    assert.match(body, /\nowner: org-brain-maintainers\n/, `${name} owner`);
    assert.match(body, /\nlast_updated: 2026-08-18\n/, `${name} freshness`);
  }
});

test("concept fixes the decision chain, safe distribution, and P0 boundary", () => {
  for (const phrase of [
    "Decision -> Reason -> Evidence -> Artifact",
    "Private by default",
    "ACL first",
    "Cloud source of truth",
    "Code graph construction",
    "repository ingestion",
    "local-only Skill storage",
  ]) {
    assert.ok(documents.concept.includes(phrase), `missing concept: ${phrase}`);
  }
});

test("spec documents every additive Decision Console API route", () => {
  const gateway = read("apps/api-gateway/src/index.ts");
  for (const route of requiredRoutes) {
    assert.ok(documents.spec.includes(route), `missing spec route: ${route}`);
    assert.ok(gateway.includes(route), `missing gateway route: ${route}`);
  }
});

test("architecture and system design define authorization and runtime invariants", () => {
  for (const phrase of [
    "resource_access_policies",
    "skill_asset_versions",
    "on_demand",
    "DECISION_CONSOLE_MODE=off|beta|on",
    "LOADOUT_RESOLUTION_MODE=off|beta|on",
  ]) {
    assert.ok(
      documents.architecture.includes(phrase),
      `missing architecture invariant: ${phrase}`,
    );
    assert.ok(
      documents.systemDesign.includes(phrase),
      `missing system-design invariant: ${phrase}`,
    );
  }
});

test("release runbook preserves additive rollback and deployment order", () => {
  for (const phrase of [
    "API Gateway and capability runner",
    "Deploy Console",
    "DECISION_CONSOLE_MODE=on",
    "LOADOUT_RESOLUTION_MODE=on",
    "Do not perform a down migration",
    "Revoking a Skill policy removes it on the next preview/context request",
  ]) {
    assert.ok(documents.runbook.includes(phrase), `missing runbook gate: ${phrase}`);
  }
});
