#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultArtifacts = resolve(root, "apps/console/artifacts/ux-audit/2026-08-22/improved-state");

export function fixtureDefinition(tenantId = "ux-audit-20260822") {
  const users = [
    { key: "owner", display_name: "UX Audit Owner", role: "tenant_admin" },
    { key: "admin", display_name: "UX Audit Admin", role: "tenant_admin" },
    ...Array.from({ length: 6 }, (_, index) => ({
      key: `member-${index + 1}`,
      display_name: `UX Audit Member ${index + 1}`,
      role: index < 4 ? "contributor" : "reader"
    }))
  ].map((user) => ({ ...user, email: `${user.key}@${tenantId}.invalid` }));
  return {
    tenant_id: tenantId,
    projects: [`${tenantId}-project-a`, `${tenantId}-project-b`],
    users,
    groups: ["platform", "product", "audit"].map((slug) => ({ slug: `ux-audit-${slug}`, name: `UX Audit ${slug}` })),
    memories: [
      { key: "shared", project: 0, kind: "decision", visibility: "tenant", confidence: 0.95, valid_until: null, content: "UX audit releases require a smoke test before rollout." },
      { key: "restricted", project: 0, kind: "constraint", visibility: "restricted", confidence: 0.9, valid_until: null, content: "Restricted UX audit findings are visible only to explicitly allowed reviewers." },
      { key: "conflict-a", project: 1, kind: "decision", visibility: "project", confidence: 0.92, valid_until: null, conflicts: ["ux-audit:conflict-b"], content: "The UX audit checkout flow requires approval before deployment." },
      { key: "conflict-b", project: 1, kind: "decision", visibility: "project", confidence: 0.92, valid_until: null, conflicts: ["ux-audit:conflict-a"], content: "The UX audit checkout flow may deploy without approval." },
      { key: "low-confidence", project: 0, kind: "fact", visibility: "project", confidence: 0.35, valid_until: null, content: "The UX audit suggests keyboard completion may be below target." },
      { key: "expired", project: 1, kind: "constraint", visibility: "project", confidence: 0.95, valid_until: Date.UTC(2026, 0, 1), content: "The legacy UX audit release window ends in January 2026." }
    ]
  };
}

export function parseArgs(argv) {
  const value = (flag, fallback = null) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] ?? fallback : fallback;
  };
  const target = value("--target");
  const mode = argv.includes("--apply") ? "apply" : argv.includes("--archive") ? "archive" : null;
  if (!target || !["local", "cloud"].includes(target) || !mode) {
    throw new Error("Usage: node scripts/ux-fixture.mjs --target local|cloud --apply|--archive [--tenant <id>] [--manifest <path>]");
  }
  const tenantId = value("--tenant", "ux-audit-20260822");
  return {
    target,
    mode,
    tenantId,
    manifest: resolve(value("--manifest", resolve(defaultArtifacts, `fixture-manifest-${target}.json`)))
  };
}

function apiConfiguration(target) {
  const baseUrl = target === "local"
    ? process.env.ORGBRAIN_LOCAL_API_URL || "http://127.0.0.1:8787"
    : process.env.ORGBRAIN_API_URL || process.env.ORGBRAIN_API_BASE;
  const apiKey = target === "local"
    ? process.env.ORGBRAIN_LOCAL_API_KEY || process.env.ORGBRAIN_API_KEY
    : process.env.ORGBRAIN_API_KEY;
  if (!baseUrl) throw new Error(target === "cloud" ? "ORGBRAIN_API_URL is required" : "local API URL is unavailable");
  if (!apiKey) throw new Error(target === "local" ? "ORGBRAIN_LOCAL_API_KEY or ORGBRAIN_API_KEY is required" : "ORGBRAIN_API_KEY is required");
  return { baseUrl: baseUrl.replace(/\/+$/u, ""), apiKey };
}

function apiClient(configuration) {
  return async (path, init = {}) => {
    const response = await fetch(`${configuration.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": configuration.apiKey,
        ...(init.headers || {})
      }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
      const code = payload?.error?.code || `http_${response.status}`;
      const message = payload?.error?.message || "request failed";
      throw new Error(`${init.method || "GET"} ${path}: ${code}: ${message}`);
    }
    return payload?.data ?? payload;
  };
}

async function writeManifest(path, manifest) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function applyFixture(options, request) {
  const definition = fixtureDefinition(options.tenantId);
  const manifest = {
    schema_version: 1,
    target: options.target,
    tenant_id: definition.tenant_id,
    applied_at: new Date().toISOString(),
    resources: { users: [], groups: [], role_assignments: [], memories: [] }
  };
  const existingUsers = (await request(`/v1/users?tenant_id=${encodeURIComponent(definition.tenant_id)}`)).users || [];
  for (const spec of definition.users) {
    let user = existingUsers.find((candidate) => candidate.email === spec.email);
    if (!user) {
      user = await request("/v1/users", { method: "POST", body: JSON.stringify({ tenant_id: definition.tenant_id, email: spec.email, display_name: spec.display_name, role: spec.role }) });
    }
    manifest.resources.users.push({ principal: user.principal, email: spec.email, role: spec.role });
  }
  const principals = Object.fromEntries(definition.users.map((spec, index) => [spec.key, manifest.resources.users[index].principal]));
  const existingGroups = (await request(`/v1/groups?tenant_id=${encodeURIComponent(definition.tenant_id)}`)).groups || [];
  for (const [groupIndex, spec] of definition.groups.entries()) {
    let group = existingGroups.find((candidate) => candidate.slug === spec.slug);
    if (!group) group = (await request("/v1/groups", { method: "POST", body: JSON.stringify({ tenant_id: definition.tenant_id, ...spec, description: "Idempotent UX evaluation fixture" }) })).group;
    const members = definition.users.filter((_, index) => index % definition.groups.length === groupIndex || index < 2);
    for (const member of members) {
      await request(`/v1/groups/${encodeURIComponent(group.id)}/members`, { method: "POST", body: JSON.stringify({ tenant_id: definition.tenant_id, principal: principals[member.key], role: member.key === "owner" ? "owner" : member.key === "admin" ? "admin" : "member" }) });
    }
    manifest.resources.groups.push({ id: group.id, slug: group.slug, members: members.map((member) => principals[member.key]) });
  }
  for (const [projectIndex, projectId] of definition.projects.entries()) {
    for (const member of definition.users.filter((_, index) => index % 2 === projectIndex)) {
      const assignment = await request("/v1/role-assignments", { method: "PUT", body: JSON.stringify({ tenant_id: definition.tenant_id, project_id: projectId, principal: principals[member.key], role: member.key === "owner" ? "project_owner" : member.role }) });
      manifest.resources.role_assignments.push({ id: assignment.id, project_id: projectId, principal: assignment.principal, role: assignment.role });
    }
  }
  const capture = await request("/v1/memories/capture", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: definition.tenant_id,
      source: "ux-audit-fixture",
      items: definition.memories.map((memory) => ({
        external_key: `ux-audit:${memory.key}`,
        project_id: definition.projects[memory.project],
        kind: memory.kind,
        content: memory.content,
        summary: `UX fixture: ${memory.key}`,
        tags: ["ux-audit", memory.key],
        visibility: memory.visibility,
        ...(memory.visibility === "restricted" ? { allowed_principals: [principals.owner, principals.admin] } : {}),
        confidence_score: memory.confidence,
        conflicts: memory.conflicts || [],
        utility_score: 0.8,
        valid_until: memory.valid_until,
        source_references: [{ type: "fixture", ref: `ux-audit/${memory.key}` }]
      }))
    })
  });
  manifest.resources.memories = (capture.items || []).map((item, index) => ({ id: item.memory_id, external_key: `ux-audit:${definition.memories[index]?.key || index}` }));
  await writeManifest(options.manifest, manifest);
  return manifest;
}

async function archiveFixture(options, request) {
  const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
  const outcomes = [];
  for (const memory of manifest.resources?.memories || []) {
    await request(`/v1/memories/${encodeURIComponent(memory.id)}/trash`, { method: "POST", body: JSON.stringify({ tenant_id: manifest.tenant_id }) });
    outcomes.push({ type: "memory", id: memory.id, outcome: "trashed" });
  }
  for (const assignment of manifest.resources?.role_assignments || []) {
    await request(`/v1/role-assignments/${encodeURIComponent(assignment.id)}?tenant_id=${encodeURIComponent(manifest.tenant_id)}`, { method: "DELETE" });
    outcomes.push({ type: "role_assignment", id: assignment.id, outcome: "deleted" });
  }
  for (const group of manifest.resources?.groups || []) {
    await request(`/v1/groups/${encodeURIComponent(group.id)}?tenant_id=${encodeURIComponent(manifest.tenant_id)}`, { method: "DELETE" });
    outcomes.push({ type: "group", id: group.id, outcome: "archived" });
  }
  for (const user of manifest.resources?.users || []) {
    await request(`/v1/users/${encodeURIComponent(user.principal)}`, { method: "PATCH", body: JSON.stringify({ tenant_id: manifest.tenant_id, status: "deprovisioned" }) });
    outcomes.push({ type: "user", id: user.principal, outcome: "deprovisioned" });
  }
  const archived = { ...manifest, archived_at: new Date().toISOString(), archive_outcomes: outcomes };
  await writeManifest(options.manifest, archived);
  return archived;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const request = apiClient(apiConfiguration(options.target));
  const manifest = options.mode === "apply" ? await applyFixture(options, request) : await archiveFixture(options, request);
  process.stdout.write(`${JSON.stringify({ ok: true, target: options.target, mode: options.mode, tenant_id: manifest.tenant_id, manifest: options.manifest, counts: Object.fromEntries(Object.entries(manifest.resources || {}).map(([key, value]) => [key, value.length])) })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
