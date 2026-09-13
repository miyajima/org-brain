#!/usr/bin/env node

import { randomBytes } from "node:crypto";

const flow = process.argv[2];
if (!new Set(["onboarding", "retrospectives", "dashboard"]).has(flow)) {
  throw new Error("usage: knowledge-loop-live-smoke.mjs <onboarding|retrospectives|dashboard>");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function ulid(now = Date.now()) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = now;
  let encodedTime = "";
  for (let index = 0; index < 10; index += 1) { encodedTime = alphabet[time % 32] + encodedTime; time = Math.floor(time / 32); }
  const bytes = randomBytes(10);
  let encodedRandom = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; encodedRandom += alphabet[(buffer >> bits) & 31]; }
  }
  return `${encodedTime}${encodedRandom.slice(0, 16)}`;
}

const apiUrl = required("ORGBRAIN_API_URL").replace(/\/+$/u, "");
const apiKey = required("ORGBRAIN_API_KEY");
const tenantId = required("ORGBRAIN_TENANT_ID");
const projectId = process.env.ORGBRAIN_PROJECT_ID?.trim() || null;
const smokeId = `smoke:${ulid()}`;

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { accept: "application/json", "content-type": "application/json", "x-api-key": apiKey, ...(options.headers ?? {}) }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) throw new Error(`${options.method ?? "GET"} ${path}: HTTP ${response.status} ${body?.error?.code ?? "invalid_response"}`);
  return body.data;
}

const capabilities = await request(`/v1/capabilities?tenant_id=${encodeURIComponent(tenantId)}`);
let readSummary;
if (flow === "onboarding") {
  const packs = await request(`/v1/domain-packs?tenant_id=${encodeURIComponent(tenantId)}`);
  readSummary = { catalog_count: Array.isArray(packs) ? packs.length : 0 };
} else if (flow === "retrospectives") {
  const sessions = await request(`/v1/retrospectives?tenant_id=${encodeURIComponent(tenantId)}`);
  readSummary = { session_count: Array.isArray(sessions) ? sessions.length : 0 };
} else {
  const projectQuery = projectId ? `&project_id=${encodeURIComponent(projectId)}` : "";
  const dashboard = await request(`/v1/dashboard/organization?tenant_id=${encodeURIComponent(tenantId)}${projectQuery}`);
  readSummary = { goal_count: dashboard.goals?.length ?? 0, installed_packs: dashboard.summary?.installed_packs ?? null };
}

let writeSummary = null;
if (process.env.ORGBRAIN_SMOKE_WRITE_MODE === "confirm") {
  if (process.env.ORGBRAIN_SMOKE_WRITE_TENANT_ID?.trim() !== tenantId) throw new Error("write smoke tenant does not exactly match ORGBRAIN_TENANT_ID");
  const capabilityKey = flow === "onboarding" ? "knowledge_pack_onboarding" : flow === "retrospectives" ? "retrospective" : "organization_dashboard";
  if (capabilities?.[capabilityKey]?.writable !== true) throw new Error(`${capabilityKey} is not writable for this tenant`);
  if (flow === "onboarding") {
    const created = await request("/v1/knowledge-pack-onboardings", {
      method: "POST", headers: { "x-idempotency-key": smokeId },
      body: JSON.stringify({ tenant_id: tenantId, project_id: projectId })
    });
    writeSummary = { smoke_id: smokeId, onboarding_id: created.id, state: created.state };
  } else if (flow === "retrospectives") {
    const created = await request("/v1/retrospectives", {
      method: "POST",
      body: JSON.stringify({ tenant_id: tenantId, project_id: projectId, title: smokeId, participant_principals: [] })
    });
    writeSummary = { smoke_id: smokeId, retrospective_id: created.id, item_count: created.items?.length ?? 0 };
  } else {
    const projectQuery = projectId ? `&project_id=${encodeURIComponent(projectId)}` : "";
    const dashboard = await request(`/v1/dashboard/organization?tenant_id=${encodeURIComponent(tenantId)}${projectQuery}`);
    const goal = dashboard.goals?.find((item) => item.source?.binding_id === null && typeof item.current?.value === "number");
    if (!goal) throw new Error("no manual goal with an existing numeric value is available for a non-fabricated write smoke");
    const snapshot = await request(`/v1/dashboard/organization/knowledge-packs/${encodeURIComponent(goal.link.knowledge_pack_installation_id)}/goals/${encodeURIComponent(goal.link.id)}/snapshots`, {
      method: "POST", headers: { "x-idempotency-key": smokeId },
      body: JSON.stringify({ tenant_id: tenantId, value: goal.current.value, observed_at: Date.now(), evidence_ref: smokeId })
    });
    writeSummary = { smoke_id: smokeId, snapshot_id: snapshot.id, value: snapshot.value };
  }
}

process.stdout.write(`${JSON.stringify({ ok: true, flow, tenant_id: tenantId, mode: writeSummary ? "write" : "read", read: readSummary, write: writeSummary }, null, 2)}\n`);
