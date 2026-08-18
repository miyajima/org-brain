import {
  SKILL_ASSET_CONTRACT_VERSION,
  SKILL_GENERATION_PROVIDERS,
  skillAssetCreateSchema,
  skillAssetVersionCreateSchema,
  skillGenerationCreateSchema,
  skillManifestSchema,
  skillPublishSchema,
  type SkillGenerationProvider,
  type SkillManifest,
  type SkillSourceType
} from "@org-brain/contracts";
import {
  HttpError,
  sha256,
  ulid
} from "@org-brain/shared";
import { assertResourceReadable, canReadResource, ensureAccessPolicy, loadAccessPolicy } from "./access-policy-service";
import { createTask } from "./task-service";
import type { Env } from "./types";

const MAX_FILES = 50;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 10 * 1_048_576;
const PROMPT_VERSION = "decision-skill-v1";

type SkillAssetRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  name: string;
  description: string;
  status: "draft" | "published" | "retired";
  current_version_id: string | null;
  published_version_id: string | null;
  source_decision_id: string | null;
  owner_principal: string;
  valid_until: number | null;
  generation_task_id: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  retired_at: number | null;
};

type SkillVersionRow = {
  id: string;
  skill_asset_id: string;
  version: number;
  schema_version: number;
  manifest_json: string;
  content_hash: string;
  validation_json: string;
  generation_provider: string | null;
  generation_model: string | null;
  generation_prompt_version: string | null;
  source_digest: string | null;
  created_by_principal: string;
  created_at: number;
};

type StoredFile = {
  id: string;
  path: string;
  media_type: string;
  content_hash: string;
  size_bytes: number;
  r2_key: string;
};

type GenerationSource = {
  source_type: SkillSourceType;
  source_id: string;
  version_hash: string;
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseLimit(value: unknown, fallback = 50): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(100, Math.max(1, parsed)) : fallback;
}

function safeFilePath(path: string): string {
  const normalized = path.trim().replace(/\\/gu, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new HttpError(400, "invalid_skill_file", "Skill file paths must be relative and cannot traverse");
  }
  return normalized;
}

function renderSkillMarkdown(manifest: SkillManifest): string {
  return [
    "---",
    `name: ${JSON.stringify(manifest.name)}`,
    `description: ${JSON.stringify(manifest.description)}`,
    "---",
    "",
    `# ${manifest.name}`,
    "",
    manifest.instructions.trim(),
    "",
    "## Validation",
    "",
    ...manifest.validation_conditions.map((condition) => `- ${condition}`),
    ""
  ].join("\n");
}

function completeFiles(manifest: SkillManifest) {
  const supplied = manifest.files.map((file) => ({
    path: safeFilePath(file.path),
    media_type: file.media_type,
    content: file.content
  }));
  const withoutManifest = supplied.filter((file) => file.path.toLocaleLowerCase("en-US") !== "skill.md");
  return [{ path: "SKILL.md", media_type: "text/markdown", content: renderSkillMarkdown(manifest) }, ...withoutManifest];
}

async function prepareFiles(manifest: SkillManifest) {
  const files = completeFiles(manifest);
  if (files.length > MAX_FILES) throw new HttpError(400, "skill_too_large", `A Skill can contain at most ${MAX_FILES} files`);
  const seen = new Set<string>();
  let totalBytes = 0;
  const prepared = [] as Array<(typeof files)[number] & { content_hash: string; size_bytes: number }>;
  for (const file of files) {
    const folded = file.path.toLocaleLowerCase("en-US");
    if (seen.has(folded)) throw new HttpError(400, "duplicate_skill_file", `Duplicate Skill file path: ${file.path}`);
    seen.add(folded);
    const sizeBytes = new TextEncoder().encode(file.content).byteLength;
    if (sizeBytes > MAX_FILE_BYTES) throw new HttpError(400, "skill_file_too_large", `${file.path} exceeds 1 MiB`);
    totalBytes += sizeBytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new HttpError(400, "skill_too_large", "Skill package exceeds 10 MiB");
    prepared.push({ ...file, content_hash: await sha256(file.content), size_bytes: sizeBytes });
  }
  return prepared;
}

async function loadAsset(env: Env, tenantId: string, assetId: string): Promise<SkillAssetRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, name, description, status, current_version_id,
            published_version_id, source_decision_id, owner_principal, valid_until,
            generation_task_id, created_at, updated_at, published_at, retired_at
     FROM skill_assets WHERE tenant_id = ? AND id = ?`
  ).bind(tenantId, assetId).first<SkillAssetRow>();
  if (!row) throw new HttpError(404, "skill_not_found", "Skill not found");
  return row;
}

async function assertSkillOwner(
  env: Env,
  asset: SkillAssetRow,
  options: { actorPrincipal: string; isAdmin: boolean }
) {
  const policy = await loadAccessPolicy(env, asset.tenant_id, "skill_asset", asset.id);
  if (!policy) throw new HttpError(404, "skill_not_found", "Skill not found");
  if (!options.isAdmin && policy.owner_principal !== options.actorPrincipal) {
    throw new HttpError(403, "forbidden", "Only the owner or tenant admin can modify a Skill");
  }
  return policy;
}

async function readableSourceDecisionId(
  env: Env,
  asset: SkillAssetRow,
  args: { principal: string; projectId?: string | null }
): Promise<string | null> {
  if (!asset.source_decision_id) return null;
  const policy = await loadAccessPolicy(env, asset.tenant_id, "decision_memory", asset.source_decision_id);
  return await canReadResource(env, policy, {
    tenantId: asset.tenant_id,
    principal: args.principal,
    projectId: args.projectId ?? asset.project_id
  }) ? asset.source_decision_id : null;
}

async function loadVersion(env: Env, tenantId: string, assetId: string, versionId: string): Promise<SkillVersionRow> {
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, skill_asset_id, version, schema_version, manifest_json, content_hash,
            validation_json, generation_provider, generation_model,
            generation_prompt_version, source_digest, created_by_principal, created_at
     FROM skill_asset_versions
     WHERE tenant_id = ? AND skill_asset_id = ? AND id = ?`
  ).bind(tenantId, assetId, versionId).first<SkillVersionRow>();
  if (!row) throw new HttpError(404, "skill_version_not_found", "Skill version not found");
  return row;
}

async function versionFiles(env: Env, tenantId: string, versionId: string): Promise<StoredFile[]> {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, path, media_type, content_hash, size_bytes, r2_key
     FROM skill_asset_files
     WHERE tenant_id = ? AND skill_asset_version_id = ?
     ORDER BY path`
  ).bind(tenantId, versionId).all<StoredFile>();
  return result.results;
}

async function persistVersion(
  env: Env,
  args: {
    tenantId: string;
    asset: SkillAssetRow;
    manifest: SkillManifest;
    actorPrincipal: string;
    expectedCurrentVersionId?: string | null;
    provider?: string | null;
    model?: string | null;
    sourceDigest?: string | null;
    validation?: Record<string, unknown>;
  }
) {
  const parsedManifest = skillManifestSchema.parse(args.manifest);
  const files = await prepareFiles(parsedManifest);
  const latest = await env.OPEN_BRAIN_DB.prepare(
    `SELECT COALESCE(MAX(version), 0) AS version FROM skill_asset_versions
     WHERE tenant_id = ? AND skill_asset_id = ?`
  ).bind(args.tenantId, args.asset.id).first<{ version: number }>();
  const version = Number(latest?.version ?? 0) + 1;
  const versionId = ulid();
  const now = Date.now();
  const digestInput = files
    .map((file) => `${file.path}\n${file.content_hash}\n${file.size_bytes}`)
    .sort()
    .join("\n");
  const contentHash = await sha256(digestInput);
  const storedFiles: StoredFile[] = [];
  for (const file of files) {
    const key = `tenants/${args.tenantId}/skills/${args.asset.id}/versions/${versionId}/${file.path}`;
    await env.OPEN_BRAIN_BUCKET.put(key, file.content, {
      httpMetadata: { contentType: file.media_type },
      customMetadata: {
        tenant_id: args.tenantId,
        skill_asset_id: args.asset.id,
        skill_asset_version_id: versionId,
        content_hash: file.content_hash
      }
    });
    storedFiles.push({ id: ulid(), path: file.path, media_type: file.media_type, content_hash: file.content_hash, size_bytes: file.size_bytes, r2_key: key });
  }
  const manifestRecord = {
    name: parsedManifest.name,
    description: parsedManifest.description,
    validation_conditions: parsedManifest.validation_conditions,
    files: storedFiles.map(({ path, media_type, content_hash, size_bytes }) => ({ path, media_type, content_hash, size_bytes }))
  };
  const expected = args.expectedCurrentVersionId === undefined ? args.asset.current_version_id : args.expectedCurrentVersionId;
  const statements: D1PreparedStatement[] = [
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE skill_assets SET name = ?, description = ?, current_version_id = ?,
          status = CASE WHEN published_version_id IS NULL THEN 'draft' ELSE status END, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND COALESCE(current_version_id, '') = COALESCE(?, '')`
    ).bind(parsedManifest.name, parsedManifest.description, versionId, now, args.tenantId, args.asset.id, expected),
    env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO skill_asset_versions(
        id, tenant_id, skill_asset_id, version, schema_version, manifest_json,
        content_hash, validation_json, generation_provider, generation_model,
        generation_prompt_version, source_digest, created_by_principal, created_at
      )
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (
        SELECT 1 FROM skill_assets
        WHERE tenant_id = ? AND id = ? AND current_version_id = ?
      )`
    ).bind(
      versionId, args.tenantId, args.asset.id, version, 1, JSON.stringify(manifestRecord),
      contentHash, JSON.stringify(args.validation ?? { schema: "passed" }), args.provider ?? null,
      args.model ?? null, args.provider ? PROMPT_VERSION : null, args.sourceDigest ?? null,
      args.actorPrincipal, now, args.tenantId, args.asset.id, versionId
    ),
    ...storedFiles.map((file) => env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO skill_asset_files(
        id, tenant_id, skill_asset_id, skill_asset_version_id, path, media_type,
        content_hash, size_bytes, r2_key, created_at
      )
      SELECT ?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (
        SELECT 1 FROM skill_assets
        WHERE tenant_id = ? AND id = ? AND current_version_id = ?
      )`
    ).bind(
      file.id, args.tenantId, args.asset.id, versionId, file.path, file.media_type,
      file.content_hash, file.size_bytes, file.r2_key, now,
      args.tenantId, args.asset.id, versionId
    ))
  ];
  const results = await env.OPEN_BRAIN_DB.batch(statements);
  const updateResult = results[0];
  const versionResult = results[1];
  if (Number(updateResult?.meta.changes ?? 0) !== 1 || Number(versionResult?.meta.changes ?? 0) !== 1) {
    throw new HttpError(409, "skill_version_conflict", "Skill changed; reload before creating a version");
  }
  return { version_id: versionId, version, content_hash: contentHash, files: storedFiles };
}

export function availableSkillProviders(env: Env) {
  const hasCredential: Record<SkillGenerationProvider, boolean> = {
    gemini: Boolean(env.GEMINI_API_KEY?.trim()),
    openai: Boolean(env.OPENAI_API_KEY?.trim()),
    anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim())
  };
  if (env.SKILL_GENERATION_PROVIDERS_JSON !== undefined) {
    try {
      const configured = JSON.parse(env.SKILL_GENERATION_PROVIDERS_JSON) as unknown;
      if (!Array.isArray(configured)) return [];
      const enabled = new Set(configured.filter((value): value is SkillGenerationProvider =>
        typeof value === "string" && SKILL_GENERATION_PROVIDERS.includes(value as SkillGenerationProvider)
      ));
      return SKILL_GENERATION_PROVIDERS.filter((provider) => enabled.has(provider) && hasCredential[provider])
        .map((provider) => ({ provider, available: true }));
    } catch {
      return [];
    }
  }
  return SKILL_GENERATION_PROVIDERS.map((provider) => ({ provider, available: hasCredential[provider] }))
    .filter((item) => item.available);
}

async function assertProviderAvailable(env: Env, provider: SkillGenerationProvider) {
  if (!availableSkillProviders(env).some((item) => item.provider === provider)) {
    throw new HttpError(409, "provider_unavailable", "Selected generation provider is not configured");
  }
}

async function verifyGenerationSource(
  env: Env,
  args: { tenantId: string; principal: string; projectId?: string | null; source: GenerationSource }
): Promise<void> {
  if (args.source.source_type === "decision_memory") {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT d.project_id, v.snapshot_json
       FROM decision_memories d
       JOIN decision_memory_versions v ON v.tenant_id = d.tenant_id AND v.decision_memory_id = d.id
       WHERE d.tenant_id = ? AND d.id = ? ORDER BY v.created_at DESC LIMIT 1`
    ).bind(args.tenantId, args.source.source_id).first<{ project_id: string | null; snapshot_json: string }>();
    if (!row) throw new HttpError(404, "source_not_found", "Selected decision was not found");
    await assertResourceReadable(env, {
      tenantId: args.tenantId,
      resourceType: "decision_memory",
      resourceId: args.source.source_id,
      principal: args.principal,
      projectId: args.projectId ?? row.project_id
    });
    if (await sha256(row.snapshot_json) !== args.source.version_hash) {
      throw new HttpError(409, "source_version_changed", "Selected decision changed; review it before generating");
    }
    return;
  }
  if (args.source.source_type === "decision_rationale") {
    const row = await env.OPEN_BRAIN_DB.prepare(
      `SELECT r.memory_id, r.project_id, r.conclusion, r.reason_summary, r.confirmation_state,
              r.confidence_score, r.confirmed_at
       FROM decision_rationales r WHERE r.tenant_id = ? AND r.id = ?`
    ).bind(args.tenantId, args.source.source_id).first<Record<string, unknown> & { memory_id: string; project_id: string | null }>();
    if (!row) throw new HttpError(404, "source_not_found", "Selected rationale was not found");
    await assertResourceReadable(env, {
      tenantId: args.tenantId,
      resourceType: "memory",
      resourceId: row.memory_id,
      principal: args.principal,
      projectId: args.projectId ?? row.project_id
    });
    if (await sha256(JSON.stringify(row)) !== args.source.version_hash) {
      throw new HttpError(409, "source_version_changed", "Selected rationale changed; review it before generating");
    }
    return;
  }
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT v.resource_id, v.content_hash, r.project_id
     FROM knowledge_resource_versions v
     JOIN knowledge_resources r ON r.tenant_id = v.tenant_id AND r.id = v.resource_id
     WHERE v.tenant_id = ? AND v.id = ?`
  ).bind(args.tenantId, args.source.source_id).first<{ resource_id: string; content_hash: string; project_id: string | null }>();
  if (!row) throw new HttpError(404, "source_not_found", "Selected resource version was not found");
  await assertResourceReadable(env, {
    tenantId: args.tenantId,
    resourceType: "knowledge_resource",
    resourceId: row.resource_id,
    principal: args.principal,
    projectId: args.projectId ?? row.project_id
  });
  if (row.content_hash !== args.source.version_hash) {
    throw new HttpError(409, "source_version_changed", "Selected resource changed; review it before generating");
  }
}

export async function createSkillAsset(
  env: Env,
  rawBody: unknown,
  options: { tenantId: string; actorPrincipal: string }
) {
  const parsed = skillAssetCreateSchema.safeParse(rawBody);
  if (!parsed.success) throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid Skill");
  const input = parsed.data;
  if (input.source_decision_id) {
    await assertResourceReadable(env, {
      tenantId: options.tenantId,
      resourceType: "decision_memory",
      resourceId: input.source_decision_id,
      principal: options.actorPrincipal,
      projectId: input.project_id
    });
  }
  const now = Date.now();
  const assetId = ulid();
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO skill_assets(
      id, tenant_id, project_id, name, description, status, source_decision_id,
      owner_principal, created_at, updated_at
    ) VALUES(?,?,?,?,?,'draft',?,?,?,?)`
  ).bind(
    assetId, options.tenantId, input.project_id ?? null, input.manifest.name,
    input.manifest.description, input.source_decision_id ?? null,
    options.actorPrincipal, now, now
  ).run();
  await ensureAccessPolicy(env, {
    tenantId: options.tenantId,
    resourceType: "skill_asset",
    resourceId: assetId,
    scope: "private",
    ownerPrincipal: options.actorPrincipal,
    projectId: input.project_id ?? null,
    storageLocation: "d1_r2",
    actorPrincipal: options.actorPrincipal
  });
  const asset = await loadAsset(env, options.tenantId, assetId);
  const version = await persistVersion(env, {
    tenantId: options.tenantId,
    asset,
    manifest: input.manifest,
    actorPrincipal: options.actorPrincipal,
    expectedCurrentVersionId: null
  });
  return { contract_version: SKILL_ASSET_CONTRACT_VERSION, asset: await loadAsset(env, options.tenantId, assetId), version };
}

export async function createSkillVersion(
  env: Env,
  tenantId: string,
  assetId: string,
  rawBody: unknown,
  options: { actorPrincipal: string; isAdmin: boolean }
) {
  const parsed = skillAssetVersionCreateSchema.safeParse(rawBody);
  if (!parsed.success) throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid Skill version");
  const asset = await loadAsset(env, tenantId, assetId);
  await assertSkillOwner(env, asset, options);
  if (asset.status === "retired") throw new HttpError(409, "skill_retired", "Retired Skills cannot be revised");
  const version = await persistVersion(env, {
    tenantId,
    asset,
    manifest: parsed.data.manifest,
    actorPrincipal: options.actorPrincipal,
    expectedCurrentVersionId: parsed.data.expected_current_version_id
  });
  return { contract_version: SKILL_ASSET_CONTRACT_VERSION, asset: await loadAsset(env, tenantId, assetId), version };
}

export async function generateSkillAsset(
  env: Env,
  rawBody: unknown,
  options: { tenantId: string; actorPrincipal: string }
) {
  const parsed = skillGenerationCreateSchema.safeParse(rawBody);
  if (!parsed.success) throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid generation request");
  const input = parsed.data;
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, skill_asset_id, task_id, status FROM skill_generation_runs
     WHERE tenant_id = ? AND idempotency_key = ?`
  ).bind(options.tenantId, input.idempotency_key).first<{ id: string; skill_asset_id: string; task_id: string; status: string }>();
  if (existing) return {
    contract_version: SKILL_ASSET_CONTRACT_VERSION,
    asset_id: existing.skill_asset_id,
    generation_run_id: existing.id,
    task_id: existing.task_id,
    status: existing.status,
    private_draft: true,
    deduped: true
  };
  await assertProviderAvailable(env, input.provider);
  for (const source of input.sources) {
    await verifyGenerationSource(env, {
      tenantId: options.tenantId,
      principal: options.actorPrincipal,
      projectId: input.project_id,
      source
    });
  }
  const now = Date.now();
  const assetId = ulid();
  const runId = ulid();
  const provisionalTaskId = `pending:${runId}`;
  const sourceDigest = await sha256(JSON.stringify(input.sources));
  const instructionDigest = await sha256(input.instructions);
  const inputKey = `tenants/${options.tenantId}/skill-generation/${runId}/input.json`;
  const inputRef = `r2://${inputKey}`;
  const generationInput = {
    schema_version: 1,
    generation_run_id: runId,
    tenant_id: options.tenantId,
    project_id: input.project_id ?? null,
    skill_asset_id: assetId,
    requested_by_principal: options.actorPrincipal,
    provider: input.provider,
    model: input.model,
    prompt_version: PROMPT_VERSION,
    sources: input.sources,
    source_digest: sourceDigest,
    instructions: input.instructions,
    instruction_digest: instructionDigest
  };
  await env.OPEN_BRAIN_BUCKET.put(inputKey, JSON.stringify(generationInput), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { tenant_id: options.tenantId, generation_run_id: runId, source_digest: sourceDigest }
  });
  try {
    await env.OPEN_BRAIN_DB.batch([
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO skill_assets(
          id, tenant_id, project_id, name, description, status, source_decision_id,
          owner_principal, generation_task_id, created_at, updated_at
        ) VALUES(?,?,?,?,?,'draft',?,?,?,?,?)`
      ).bind(
        assetId, options.tenantId, input.project_id ?? null, input.name, input.description,
        input.source_decision_id ?? null, options.actorPrincipal, provisionalTaskId, now, now
      ),
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO skill_generation_runs(
          id, tenant_id, project_id, skill_asset_id, task_id, idempotency_key,
          provider, model, prompt_version, input_ref, source_refs_json, source_digest,
          instruction_digest, status, created_by_principal, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`
      ).bind(
        runId, options.tenantId, input.project_id ?? null, assetId, provisionalTaskId,
        input.idempotency_key, input.provider, input.model, PROMPT_VERSION, inputRef,
        JSON.stringify(input.sources), sourceDigest, instructionDigest,
        options.actorPrincipal, now, now
      )
    ]);
  } catch (error) {
    const raced = await env.OPEN_BRAIN_DB.prepare(
      `SELECT id, skill_asset_id, task_id, status FROM skill_generation_runs
       WHERE tenant_id = ? AND idempotency_key = ?`
    ).bind(options.tenantId, input.idempotency_key).first<{ id: string; skill_asset_id: string; task_id: string; status: string }>();
    if (raced) return {
      contract_version: SKILL_ASSET_CONTRACT_VERSION,
      asset_id: raced.skill_asset_id,
      generation_run_id: raced.id,
      task_id: raced.task_id,
      status: raced.status,
      private_draft: true,
      deduped: true
    };
    throw error;
  }
  await ensureAccessPolicy(env, {
    tenantId: options.tenantId,
    resourceType: "skill_asset",
    resourceId: assetId,
    scope: "private",
    ownerPrincipal: options.actorPrincipal,
    projectId: input.project_id ?? null,
    storageLocation: "d1_r2",
    actorPrincipal: options.actorPrincipal
  });
  let task: Awaited<ReturnType<typeof createTask>>;
  try {
    task = await createTask(env, {
      tenant_id: options.tenantId,
      project_id: input.project_id ?? undefined,
      capability: "skill_generation",
      input_ref: inputRef,
      constraints: { generation_run_id: runId },
      idempotency_key: `skill-generation:${options.tenantId}:${input.idempotency_key}`,
      wait_event_type: "skill.generation.completed"
    }, { actorPrincipal: options.actorPrincipal });
  } catch (error) {
    await markGenerationFailure(env, options.tenantId, runId, error);
    throw error;
  }
  await env.OPEN_BRAIN_DB.batch([
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE skill_assets SET generation_task_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(task.task_id, Date.now(), options.tenantId, assetId),
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE skill_generation_runs SET task_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(task.task_id, Date.now(), options.tenantId, runId)
  ]);
  return {
    contract_version: SKILL_ASSET_CONTRACT_VERSION,
    asset_id: assetId,
    generation_run_id: runId,
    task_id: task.task_id,
    status: "pending",
    private_draft: true,
    deduped: false
  };
}

export async function listSkillAssets(
  env: Env,
  args: { tenantId: string; principal: string; projectId?: string | null; q?: string | null; status?: string | null; limit?: number }
) {
  const limit = parseLimit(args.limit);
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, name, description, status, current_version_id,
            published_version_id, source_decision_id, owner_principal, valid_until,
            generation_task_id, created_at, updated_at, published_at, retired_at
     FROM skill_assets
     WHERE tenant_id = ?
       AND (? IS NULL OR project_id = ?)
       AND (? IS NULL OR status = ?)
       AND (? = '' OR lower(name || ' ' || description) LIKE '%' || lower(?) || '%')
     ORDER BY updated_at DESC LIMIT ?`
  ).bind(
    args.tenantId, args.projectId ?? null, args.projectId ?? null,
    args.status ?? null, args.status ?? null, args.q?.trim() ?? "", args.q?.trim() ?? "", Math.min(200, limit * 4)
  ).all<SkillAssetRow>();
  const visible: SkillAssetRow[] = [];
  for (const row of rows.results) {
    const policy = await loadAccessPolicy(env, args.tenantId, "skill_asset", row.id);
    if (await canReadResource(env, policy, { tenantId: args.tenantId, principal: args.principal, projectId: args.projectId ?? row.project_id })) {
      visible.push({
        ...row,
        source_decision_id: await readableSourceDecisionId(env, row, {
          principal: args.principal,
          projectId: args.projectId
        })
      });
      if (visible.length >= limit) break;
    }
  }
  return { contract_version: SKILL_ASSET_CONTRACT_VERSION, items: visible, truncated: rows.results.length > visible.length && visible.length >= limit };
}

export async function getSkillAsset(
  env: Env,
  args: { tenantId: string; assetId: string; principal: string; projectId?: string | null }
) {
  const asset = await loadAsset(env, args.tenantId, args.assetId);
  await assertResourceReadable(env, {
    tenantId: args.tenantId,
    resourceType: "skill_asset",
    resourceId: args.assetId,
    principal: args.principal,
    projectId: args.projectId ?? asset.project_id
  });
  const versions = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, skill_asset_id, version, schema_version, manifest_json, content_hash,
            validation_json, generation_provider, generation_model,
            generation_prompt_version, source_digest, created_by_principal, created_at
     FROM skill_asset_versions WHERE tenant_id = ? AND skill_asset_id = ?
     ORDER BY version DESC LIMIT 100`
  ).bind(args.tenantId, args.assetId).all<SkillVersionRow>();
  return {
    contract_version: SKILL_ASSET_CONTRACT_VERSION,
    asset: {
      ...asset,
      source_decision_id: await readableSourceDecisionId(env, asset, {
        principal: args.principal,
        projectId: args.projectId
      })
    },
    versions: versions.results.map((row) => ({ ...row, manifest: parseJson(row.manifest_json, {}), validation: parseJson(row.validation_json, {}) }))
  };
}

export async function publishSkillAsset(
  env: Env,
  tenantId: string,
  assetId: string,
  rawBody: unknown,
  options: { actorPrincipal: string; isAdmin: boolean }
) {
  const parsed = skillPublishSchema.safeParse(rawBody);
  if (!parsed.success) throw new HttpError(400, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid publish request");
  const asset = await loadAsset(env, tenantId, assetId);
  await assertSkillOwner(env, asset, options);
  if (asset.status === "retired") throw new HttpError(409, "skill_retired", "Retired Skills cannot be published");
  if (asset.current_version_id !== parsed.data.expected_current_version_id || parsed.data.version_id !== asset.current_version_id) {
    throw new HttpError(409, "publish_conflict", "Skill changed; reload before publishing");
  }
  await loadVersion(env, tenantId, assetId, parsed.data.version_id);
  const now = Date.now();
  const result = await env.OPEN_BRAIN_DB.prepare(
    `UPDATE skill_assets SET status = 'published', published_version_id = ?, published_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND current_version_id = ? AND status <> 'retired'`
  ).bind(parsed.data.version_id, now, now, tenantId, assetId, parsed.data.expected_current_version_id).run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new HttpError(409, "publish_conflict", "Skill changed; reload before publishing");
  return { contract_version: SKILL_ASSET_CONTRACT_VERSION, asset: await loadAsset(env, tenantId, assetId) };
}

export async function retireSkillAsset(
  env: Env,
  tenantId: string,
  assetId: string,
  options: { actorPrincipal: string; isAdmin: boolean }
) {
  const asset = await loadAsset(env, tenantId, assetId);
  await assertSkillOwner(env, asset, options);
  const now = Date.now();
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE skill_assets SET status = 'retired', retired_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
  ).bind(now, now, tenantId, assetId).run();
  return { contract_version: SKILL_ASSET_CONTRACT_VERSION, asset: await loadAsset(env, tenantId, assetId) };
}

export async function exportSkillAsset(
  env: Env,
  args: { tenantId: string; assetId: string; principal: string; projectId?: string | null; versionId?: string | null }
) {
  const asset = await loadAsset(env, args.tenantId, args.assetId);
  const policy = await assertResourceReadable(env, {
    tenantId: args.tenantId,
    resourceType: "skill_asset",
    resourceId: args.assetId,
    principal: args.principal,
    projectId: args.projectId ?? asset.project_id
  });
  const versionId = args.versionId ?? asset.published_version_id ?? (policy.owner_principal === args.principal ? asset.current_version_id : null);
  if (!versionId) throw new HttpError(409, "skill_not_exportable", "No readable Skill version is available");
  const version = await loadVersion(env, args.tenantId, args.assetId, versionId);
  if (policy.owner_principal !== args.principal && version.id !== asset.published_version_id) {
    throw new HttpError(404, "skill_version_not_found", "Skill version not found");
  }
  const files = await versionFiles(env, args.tenantId, versionId);
  const exported = [] as Array<{ path: string; media_type: string; content_hash: string; size_bytes: number; content: string }>;
  for (const file of files) {
    const object = await env.OPEN_BRAIN_BUCKET.get(file.r2_key);
    if (!object) throw new HttpError(503, "skill_file_unavailable", "Skill file is unavailable");
    exported.push({ path: file.path, media_type: file.media_type, content_hash: file.content_hash, size_bytes: file.size_bytes, content: await object.text() });
  }
  return {
    contract_version: SKILL_ASSET_CONTRACT_VERSION,
    asset: { id: asset.id, name: asset.name, description: asset.description, status: asset.status },
    version: { id: version.id, version: version.version, content_hash: version.content_hash },
    files: exported
  };
}

export async function markGenerationFailure(env: Env, tenantId: string, runId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE skill_generation_runs SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND status <> 'succeeded'`
  ).bind("generation_failed", message.slice(0, 1000), Date.now(), tenantId, runId).run();
}

export const __skillAssetInternals = { persistVersion, renderSkillMarkdown, prepareFiles };
