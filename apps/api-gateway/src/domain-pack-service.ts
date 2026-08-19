import { domainPackManifestSchema, type DomainPackManifestV1 } from "@org-brain/contracts";
import { canonicalJson, domainPackManifestDigest, resolveDomainPackOrder } from "@org-brain/core";
import { HttpError, sha256, ulid } from "@org-brain/shared";
import { FIRST_PARTY_DOMAIN_PACKS } from "./first-party-domain-packs";
import type { Env } from "./types";

type InstalledRow = {
  id: string;
  pack_id: string;
  version: string;
  manifest_digest: string;
  state: "installed" | "uninstalled";
  installed_at: number;
};

function bodyRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  return raw as Record<string, unknown>;
}

function requestedPackIds(raw: unknown): string[] {
  const body = bodyRecord(raw);
  const value = body.pack_ids ?? (body.pack_id ? [body.pack_id] : null);
  if (!Array.isArray(value) || !value.length || value.length > 32 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new HttpError(400, "pack_ids_required", "pack_ids must contain between 1 and 32 pack IDs");
  }
  return [...new Set(value.map((item) => String(item).trim()))];
}

function assertPackCatalog(env: Env) {
  if (!env.DOMAIN_PACKS_MODE || env.DOMAIN_PACKS_MODE === "off") {
    throw new HttpError(404, "domain_packs_disabled", "Domain Packs are disabled");
  }
}

function assertPackInstall(env: Env) {
  assertPackCatalog(env);
  if (env.DOMAIN_PACKS_MODE !== "install") {
    throw new HttpError(409, "domain_pack_install_disabled", "Domain Pack installation is disabled in catalog mode");
  }
}

async function tenantCatalog(env: Env, tenantId: string): Promise<DomainPackManifestV1[]> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT manifest_json FROM domain_pack_releases
     WHERE status = 'active' AND owner_tenant_id = ? AND visibility IN ('private', 'unlisted')
     ORDER BY created_at DESC`
  ).bind(tenantId).all<{ manifest_json: string }>();
  return result.results.map((row) => domainPackManifestSchema.parse(JSON.parse(row.manifest_json)));
}

export async function listDomainPacks(env: Env, tenantId: string) {
  assertPackCatalog(env);
  const manifests = [...FIRST_PARTY_DOMAIN_PACKS, ...await tenantCatalog(env, tenantId)];
  const installed = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, pack_id, version, manifest_digest, state, installed_at FROM domain_pack_installations
     WHERE tenant_id = ? AND state = 'installed'`
  ).bind(tenantId).all<InstalledRow>();
  const installedByPack = new Map(installed.results.map((row) => [row.pack_id, row]));
  return Promise.all(manifests.map(async (manifest) => ({
    manifest,
    digest: await domainPackManifestDigest(manifest),
    publisher: manifest.pack_id.startsWith("function.") ? "orgbrain" : tenantId,
    visibility: manifest.pack_id.startsWith("function.") ? "first_party" : "private",
    installation: installedByPack.get(manifest.pack_id) ?? null
  })));
}

async function selectedManifests(env: Env, tenantId: string, ids: string[]) {
  const available = [...FIRST_PARTY_DOMAIN_PACKS, ...await tenantCatalog(env, tenantId)];
  const byId = new Map(available.map((manifest) => [manifest.pack_id, manifest]));
  const selected = new Map<string, DomainPackManifestV1>();
  const add = (packId: string) => {
    const manifest = byId.get(packId);
    if (!manifest) throw new HttpError(404, "domain_pack_not_found", `Domain Pack not found: ${packId}`);
    if (selected.has(packId)) return;
    selected.set(packId, manifest);
    for (const dependency of manifest.dependencies) add(dependency.pack_id);
  };
  ids.forEach(add);
  try {
    return resolveDomainPackOrder([...selected.values()]);
  } catch (error) {
    throw new HttpError(409, "domain_pack_dependency_invalid", String(error));
  }
}

async function existingCustomKeys(env: Env, tenantId: string) {
  const [metricRows, typeRows, dashboardRows] = await Promise.all([
    env.OPEN_BRAIN_DB.prepare("SELECT metric_key FROM metric_definitions WHERE tenant_id = ? AND origin_type = 'custom'").bind(tenantId).all<{ metric_key: string }>(),
    env.OPEN_BRAIN_DB.prepare("SELECT type_key FROM managed_object_types WHERE tenant_id = ? AND origin_type = 'custom'").bind(tenantId).all<{ type_key: string }>(),
    env.OPEN_BRAIN_DB.prepare("SELECT dashboard_key FROM domain_dashboards WHERE tenant_id = ? AND origin_type = 'custom'").bind(tenantId).all<{ dashboard_key: string }>()
  ]);
  return {
    metrics: new Set(metricRows.results.map((row) => row.metric_key)),
    objectTypes: new Set(typeRows.results.map((row) => row.type_key)),
    dashboards: new Set(dashboardRows.results.map((row) => row.dashboard_key))
  };
}

export async function planDomainPackInstallation(env: Env, tenantId: string, raw: unknown) {
  assertPackCatalog(env);
  const ids = requestedPackIds(raw);
  const manifests = await selectedManifests(env, tenantId, ids);
  const installed = await env.OPEN_BRAIN_DB.prepare(
    "SELECT id, pack_id, version, manifest_digest, state, installed_at FROM domain_pack_installations WHERE tenant_id = ? AND state = 'installed'"
  ).bind(tenantId).all<InstalledRow>();
  const installedByPack = new Map(installed.results.map((row) => [row.pack_id, row]));
  const custom = await existingCustomKeys(env, tenantId);
  const packs = [];
  for (const manifest of manifests) {
    const digest = await domainPackManifestDigest(manifest);
    const current = installedByPack.get(manifest.pack_id);
    packs.push({
      pack_id: manifest.pack_id,
      version: manifest.version,
      digest,
      action: !current ? "install" : current.manifest_digest === digest ? "unchanged" : "upgrade",
      previous: current ?? null,
      creates: {
        managed_object_types: manifest.object_types.filter((item) => !custom.objectTypes.has(item.key)).length,
        metric_definitions: manifest.metrics.filter((item) => !custom.metrics.has(item.key)).length,
        dashboards: manifest.dashboards.filter((item) => !custom.dashboards.has(item.key)).length,
        asset_references: manifest.assets.length,
        loadout_references: manifest.loadout_templates.length
      },
      preserved_custom_conflicts: {
        managed_object_types: manifest.object_types.filter((item) => custom.objectTypes.has(item.key)).map((item) => item.key),
        metric_definitions: manifest.metrics.filter((item) => custom.metrics.has(item.key)).map((item) => item.key),
        dashboards: manifest.dashboards.filter((item) => custom.dashboards.has(item.key)).map((item) => item.key)
      },
      connector_permissions: manifest.connectors.map((connector) => ({ adapter_id: connector.adapter_id, required: connector.required }))
    });
  }
  const planDigest = await sha256(canonicalJson(packs.map(({ previous: _previous, ...pack }) => pack)));
  return {
    plan_digest: planDigest,
    packs,
    examples_loaded: false,
    warnings: packs.flatMap((pack) => Object.entries(pack.preserved_custom_conflicts)
      .flatMap(([kind, keys]) => (keys as string[]).map((key) => `preserve_custom:${kind}:${key}`)))
  };
}

async function ensureRelease(env: Env, manifest: DomainPackManifestV1, tenantId: string, digest: string, now: number) {
  const firstParty = FIRST_PARTY_DOMAIN_PACKS.some((pack) => pack.pack_id === manifest.pack_id && pack.version === manifest.version);
  const releaseId = `domain:${manifest.pack_id}:${manifest.version}:${digest.slice(0, 12)}`;
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT OR IGNORE INTO domain_pack_releases(
       id, owner_tenant_id, pack_id, version, classification, visibility,
       manifest_digest, manifest_json, publisher_id, license_id, archive_json,
       signature_json, status, created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(releaseId, firstParty ? null : tenantId, manifest.pack_id, manifest.version,
    manifest.classification, firstParty ? "first_party" : "private", digest,
    canonicalJson(manifest), firstParty ? "orgbrain" : tenantId, "Apache-2.0", null, null, "active", now).run();
  const release = await env.OPEN_BRAIN_DB.prepare(
    "SELECT status FROM domain_pack_releases WHERE id = ?"
  ).bind(releaseId).first<{ status: string }>();
  if (release?.status === "revoked") throw new HttpError(409, "domain_pack_revoked", `Domain Pack release is revoked: ${manifest.pack_id}@${manifest.version}`);
  return releaseId;
}

async function installObjectTypes(env: Env, tenantId: string, principal: string, installationId: string, manifest: DomainPackManifestV1, now: number) {
  for (const item of manifest.object_types) {
    const current = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id, origin_type, origin_pack_id FROM managed_object_types WHERE tenant_id = ? AND type_key = ?"
    ).bind(tenantId, item.key).first<{ id: string; origin_type: string; origin_pack_id: string | null }>();
    if (current?.origin_type === "custom" || (current?.origin_pack_id && current.origin_pack_id !== manifest.pack_id)) continue;
    const id = current?.id ?? ulid(now + Math.floor(Math.random() * 10_000));
    if (current) {
      await env.OPEN_BRAIN_DB.prepare(
        `UPDATE managed_object_types SET label = ?, description = ?, attribute_schema_json = ?,
         allowed_relations_json = ?, origin_pack_version = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
      ).bind(item.label, item.description, canonicalJson(item.attribute_schema), canonicalJson(item.allowed_relations),
        manifest.version, now, tenantId, id).run();
    } else {
      await env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO managed_object_types(
           id, tenant_id, type_key, label, description, attribute_schema_json, allowed_relations_json,
           origin_type, origin_pack_id, origin_pack_version, created_by, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, tenantId, item.key, item.label, item.description, canonicalJson(item.attribute_schema),
        canonicalJson(item.allowed_relations), "pack", manifest.pack_id, manifest.version, principal, now, now).run();
    }
    await recordInstallItem(env, tenantId, installationId, "managed_object_type", item.key, id, manifest, now);
  }
}

async function installMetrics(env: Env, tenantId: string, principal: string, installationId: string, manifest: DomainPackManifestV1, now: number) {
  for (const item of manifest.metrics) {
    const current = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id, current_version, origin_type, origin_pack_id FROM metric_definitions WHERE tenant_id = ? AND metric_key = ?"
    ).bind(tenantId, item.key).first<{ id: string; current_version: number; origin_type: string; origin_pack_id: string | null }>();
    if (current?.origin_type === "custom" || (current?.origin_pack_id && current.origin_pack_id !== manifest.pack_id)) continue;
    const id = current?.id ?? ulid(now + Math.floor(Math.random() * 10_000));
    const definition = domainPackManifestSchema.parse(manifest).metrics.find((candidate) => candidate.key === item.key)!;
    const definitionJson = canonicalJson(definition);
    const definitionDigest = await sha256(definitionJson);
    const latest = current ? await env.OPEN_BRAIN_DB.prepare(
      "SELECT definition_digest FROM metric_definition_versions WHERE metric_definition_id = ? AND version = ?"
    ).bind(id, current.current_version).first<{ definition_digest: string }>() : null;
    let version = current?.current_version ?? 0;
    if (!current) {
      version = 1;
      await env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO metric_definitions(
           id, tenant_id, metric_key, current_version, origin_type, origin_pack_id,
           origin_pack_version, promoted_release_id, created_by, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, tenantId, item.key, version, "pack", manifest.pack_id, manifest.version, null, principal, now, now).run();
    } else if (latest?.definition_digest !== definitionDigest) {
      version += 1;
      await env.OPEN_BRAIN_DB.prepare(
        "UPDATE metric_definitions SET current_version = ?, origin_pack_version = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
      ).bind(version, manifest.version, now, tenantId, id).run();
    }
    if (!latest || latest.definition_digest !== definitionDigest) {
      await env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO metric_definition_versions(
           id, tenant_id, metric_definition_id, version, definition_json,
           definition_digest, created_by, created_at
         ) VALUES(?,?,?,?,?,?,?,?)`
      ).bind(ulid(now + version), tenantId, id, version, definitionJson, definitionDigest, principal, now).run();
    }
    if (item.source_type === "connector" && item.connector) {
      await env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO metric_source_bindings(
           id, tenant_id, metric_definition_id, metric_binding_id, binding_key,
           adapter_id, query_template, connection_ref, external_scope_ref, status,
           last_attempt_at, last_success_at, last_error_code, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, metric_definition_id, binding_key) DO UPDATE SET
           adapter_id = excluded.adapter_id,
           query_template = excluded.query_template,
           updated_at = excluded.updated_at`
      ).bind(ulid(now + Math.floor(Math.random() * 10_000)), tenantId, id, null, "__definition__",
        item.connector.adapter_id, item.connector.query_template, null, null, "unconfigured",
        null, null, null, now, now).run();
    }
    await recordInstallItem(env, tenantId, installationId, "metric_definition", item.key, id, manifest, now);
  }
}

async function installDashboards(env: Env, tenantId: string, principal: string, installationId: string, manifest: DomainPackManifestV1, now: number) {
  for (const dashboard of manifest.dashboards) {
    const current = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id, origin_type, origin_pack_id FROM domain_dashboards WHERE tenant_id = ? AND dashboard_key = ?"
    ).bind(tenantId, dashboard.key).first<{ id: string; origin_type: string; origin_pack_id: string | null }>();
    if (current?.origin_type === "custom" || (current?.origin_pack_id && current.origin_pack_id !== manifest.pack_id)) continue;
    const id = current?.id ?? ulid(now + Math.floor(Math.random() * 10_000));
    if (current) {
      await env.OPEN_BRAIN_DB.prepare(
        "UPDATE domain_dashboards SET title = ?, definition_json = ?, origin_pack_version = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
      ).bind(dashboard.title, canonicalJson(dashboard), manifest.version, now, tenantId, id).run();
    } else {
      await env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO domain_dashboards(
           id, tenant_id, dashboard_key, title, definition_json, origin_type,
           origin_pack_id, origin_pack_version, created_by, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(id, tenantId, dashboard.key, dashboard.title, canonicalJson(dashboard), "pack",
        manifest.pack_id, manifest.version, principal, now, now).run();
    }
    for (const widget of dashboard.widgets) {
      const metricKey = widget.metric_keys[0];
      const metric = metricKey ? await env.OPEN_BRAIN_DB.prepare(
        "SELECT id FROM metric_definitions WHERE tenant_id = ? AND metric_key = ?"
      ).bind(tenantId, metricKey).first<{ id: string }>() : null;
      await env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO dashboard_metric_widgets(id, tenant_id, dashboard_id, widget_key, metric_definition_id, widget_json, created_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(dashboard_id, widget_key) DO UPDATE SET metric_definition_id = excluded.metric_definition_id, widget_json = excluded.widget_json`
      ).bind(ulid(now + widget.layout.y + widget.layout.x), tenantId, id, widget.key, metric?.id ?? null, canonicalJson(widget), now).run();
    }
    await recordInstallItem(env, tenantId, installationId, "dashboard", dashboard.key, id, manifest, now);
  }
}

async function recordInstallItem(env: Env, tenantId: string, installationId: string, itemType: string, itemKey: string, entityId: string | null, manifest: DomainPackManifestV1, now: number) {
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT OR REPLACE INTO domain_pack_install_items(
       id, tenant_id, installation_id, item_type, item_key, entity_id, provenance_json, created_at
     ) VALUES(?,?,?,?,?,?,?,?)`
  ).bind(ulid(now + Math.floor(Math.random() * 10_000)), tenantId, installationId, itemType, itemKey,
    entityId, canonicalJson({ pack_id: manifest.pack_id, version: manifest.version }), now).run();
}

export async function installDomainPacks(env: Env, tenantId: string, principal: string, raw: unknown) {
  assertPackInstall(env);
  const plan = await planDomainPackInstallation(env, tenantId, raw);
  const suppliedDigest = bodyRecord(raw).plan_digest;
  if (suppliedDigest && suppliedDigest !== plan.plan_digest) {
    throw new HttpError(409, "domain_pack_plan_changed", "installation plan has changed; preview it again");
  }
  const manifests = await selectedManifests(env, tenantId, requestedPackIds(raw));
  const results = [];
  for (const manifest of manifests) {
    const now = Date.now();
    const digest = await domainPackManifestDigest(manifest);
    const current = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id, pack_id, version, manifest_digest, state, installed_at FROM domain_pack_installations WHERE tenant_id = ? AND pack_id = ? AND state = 'installed'"
    ).bind(tenantId, manifest.pack_id).first<InstalledRow>();
    if (current?.manifest_digest === digest) {
      results.push({ installation_id: current.id, pack_id: manifest.pack_id, version: manifest.version, action: "unchanged" });
      continue;
    }
    const releaseId = await ensureRelease(env, manifest, tenantId, digest, now);
    const installationId = ulid(now);
    if (current) {
      await env.OPEN_BRAIN_DB.prepare(
        "UPDATE domain_pack_installations SET state = 'uninstalled', uninstalled_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?"
      ).bind(now, now, tenantId, current.id).run();
    }
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO domain_pack_installations(
         id, tenant_id, release_id, pack_id, version, manifest_digest, state,
         installed_by, installed_at, updated_at, uninstalled_at, previous_installation_id
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(installationId, tenantId, releaseId, manifest.pack_id, manifest.version, digest,
      "installed", principal, now, now, null, current?.id ?? null).run();
    await installObjectTypes(env, tenantId, principal, installationId, manifest, now);
    await installMetrics(env, tenantId, principal, installationId, manifest, now);
    await installDashboards(env, tenantId, principal, installationId, manifest, now);
    for (const asset of manifest.assets) await recordInstallItem(env, tenantId, installationId, "asset", asset.asset_key, null, manifest, now);
    for (const loadout of manifest.loadout_templates) await recordInstallItem(env, tenantId, installationId, "loadout", loadout.key, null, manifest, now);
    results.push({ installation_id: installationId, pack_id: manifest.pack_id, version: manifest.version, action: current ? "upgraded" : "installed" });
  }
  return { installations: results, examples_loaded: false, plan_digest: plan.plan_digest };
}

export async function uninstallDomainPack(env: Env, tenantId: string, installationId: string) {
  assertPackInstall(env);
  const now = Date.now();
  const result = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE domain_pack_installations SET state = 'uninstalled', uninstalled_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND state = 'installed'`
  ).bind(now, now, tenantId, installationId).run();
  if (!result.meta.changes) throw new HttpError(404, "domain_pack_installation_not_found", "active installation not found");
  return { installation_id: installationId, state: "uninstalled", data_preserved: true };
}
