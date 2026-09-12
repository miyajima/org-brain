import {
  verifiedCandidates,
  assertMemoryExtractionInputWithinCeiling,
  validateV3Packet,
  assertV3ProviderProfile,
  buildMemoryFtsQuery,
  buildMemoryExtractionPrompt,
  decideCoverageSecondPass,
  MEMORY_EXTRACTION_COVERAGE_PROFILE,
  mergeCoverageCandidates,
  packCoverageGroups,
  MEMORY_EXTRACTION_MAX_CANDIDATES,
  MEMORY_EXTRACTION_MAX_INPUT_TOKENS,
  MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACTION_OUTPUT_SCHEMA,
  MEMORY_EXTRACTION_TOKEN_PROFILE,
  memoryExtractionProviderInputUpperBound,
  MEMORY_CONTRACT_V2_CONTRACT_HASH,
  MEMORY_CONTRACT_V2_PROMPT_HASH,
  MEMORY_CONTRACT_V2_PROMPT_ID,
  MEMORY_CONTRACT_V2_VERIFIER_VERSION,
  screenSensitiveMemory,
  sha256,
  ulid
} from "@org-brain/shared";
import type { CapabilityContext, CapabilityResult, Env } from "../types";

const LEGACY_RESERVED_TOKENS = 2_800;
const COVERAGE_RESERVED_TOKENS = 5_600;
const PASS_UNKNOWN_CHARGE = 2_800;
const MAX_INPUT_TOKENS = MEMORY_EXTRACTION_MAX_INPUT_TOKENS;
const MAX_OUTPUT_TOKENS = MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS;
const MAX_CANDIDATES = MEMORY_EXTRACTION_MAX_CANDIDATES;
const DEFAULT_TIER2_LIMIT = 500_000;
const PROVIDER_TIMEOUT_MS = 30_000;

type ProviderName = "openai" | "gemini" | "anthropic";
type ExtractionTier = "tier2" | "tier3";

type ExtractionInput = {
  schema_version: 1;
  run_id: string;
  tenant_id: string;
  project_id: string | null;
  installation_id: string;
  provider: ProviderName;
  model: string;
  tier: ExtractionTier;
  packet_hash: string;
  contract_hash: string;
  prompt_version: string;
  redaction_version: string;
  prefilter_version: string;
  extraction_profile: "coverage/v1" | null;
  prompt_policy_hash: string;
  verifier_policy_hash: string;
  execution_policy_hash: string;
  capsule_expires_at: number;
  packet: {
    schema: string;
    snippets: Array<{ span_id: string; role: string; text: string; text_hash?: string; parent_span_id?: string; source?: string; call_id?: string; start?: number; end?: number; order?: number }>;
    events: Array<Record<string, unknown>>;
    rule_proposals: Array<{ lesson_type: string; support_span_ids: string[]; gaps: string[]; observation?: Record<string, unknown> }>;
    routing?: Record<string, unknown> | null;
    existing_memories?: Array<{ id: string; kind: string; text: string }>;
    extraction_profile?: "coverage/v1";
    refinement_profile?: "a-plus/v1";
    coverage?: { groups?: Array<{ group_id: string; span_ids: string[]; priority: number; important: boolean; latest_order: number; review_signal_score?: number; review_signal_reasons?: string[] }>; pass1_group_ids?: string[]; omitted?: unknown[] };
    coverage_pass?: number;
    accepted_candidates?: unknown[];
    limits: { input_tokens: number; output_tokens: number; candidates: number; calls: number };
  };
};

type ProviderCandidate = {
  lesson_type: "success" | "decision" | "failure";
  support_span_ids: string[];
  gaps: string[];
  fields: Array<{ name: string; values: string[] }>;
};


type ProviderResult = {
  candidates: ProviderCandidate[];
  inputTokens: number | null;
  outputTokens: number | null;
};

type RunRow = {
  id: string;
  installation_id: string;
  provider: string;
  model: string;
  packet_hash: string;
  contract_hash: string;
  execution_status: string;
  outcome: string | null;
  result_r2_key: string | null;
  tombstoned_at: number | null;
  extraction_profile: string | null;
  prompt_policy_hash: string;
  verifier_policy_hash: string;
  execution_policy_hash: string;
};

const outputJsonSchema = MEMORY_EXTRACTION_OUTPUT_SCHEMA;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
}

function requiredString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`invalid memory extraction input: ${field}`);
  return value.trim();
}

function parseInput(raw: unknown, ctx: CapabilityContext): ExtractionInput {
  const value = asRecord(raw);
  const packet = asRecord(value.packet);
  validateV3Packet(packet);
  const limits = asRecord(packet.limits);
  const provider = requiredString(value.provider, "provider", 32);
  if (!(["openai", "gemini", "anthropic"] as string[]).includes(provider)) throw new Error("invalid memory extraction input: provider");
  const tier = requiredString(value.tier ?? "tier2", "tier", 16);
  if (!(["tier2", "tier3"] as string[]).includes(tier)) throw new Error("invalid memory extraction input: tier");
  const tenantId = requiredString(value.tenant_id, "tenant_id", 128);
  if (tenantId !== ctx.tenantId) throw new Error("memory extraction tenant mismatch");
  if (value.schema_version !== 1 || !["learning-extraction-proposal/v1", "learning-extraction-proposal/v2", "learning-extraction-proposal/v3"].includes(String(packet.schema))) {
    throw new Error("invalid memory extraction schema");
  }
  if (packet.provider !== provider || packet.model !== value.model) throw new Error("invalid memory extraction input: provider/model mismatch");
  if (packet.session_hash !== value.session_hash || packet.turn_hash !== value.turn_hash) throw new Error("invalid memory extraction input: turn identity mismatch");
  const extractionProfile = packet.extraction_profile === MEMORY_EXTRACTION_COVERAGE_PROFILE ? MEMORY_EXTRACTION_COVERAGE_PROFILE : null;
  if (packet.extraction_profile !== undefined && !extractionProfile) throw new Error("invalid memory extraction profile");
  const refined = packet.refinement_profile === "a-plus/v1";
  if (packet.refinement_profile !== undefined && !refined) throw new Error("invalid memory refinement profile");
  if (refined && (packet.schema !== "learning-extraction-proposal/v2" || extractionProfile)) throw new Error("a-plus/v1 requires the one-call v2 contract");
  if (refined && (!Array.isArray(packet.snippets) || packet.snippets.length < 1 || packet.snippets.length > 3)) throw new Error("a-plus/v1 requires one to three evidence spans");
  if (extractionProfile && packet.schema !== "learning-extraction-proposal/v2") throw new Error("invalid memory extraction profile schema");
  if (limits.input_tokens !== MAX_INPUT_TOKENS || limits.output_tokens !== MAX_OUTPUT_TOKENS || limits.candidates !== MAX_CANDIDATES || limits.calls !== (extractionProfile ? 2 : 1)) {
    throw new Error("invalid memory extraction limits");
  }
  const packetSnippets = Array.isArray(packet.snippets) ? packet.snippets : [];
  if (extractionProfile && packetSnippets.length > 16) throw new Error("coverage evidence pool exceeds fixed ceiling");
  const snippets = packetSnippets.slice(0, extractionProfile ? 16 : 8).map((item, index) => {
    const row = asRecord(item);
    return {
      span_id: requiredString(row.span_id, `packet.snippets[${index}].span_id`, 128),
      role: requiredString(row.role, `packet.snippets[${index}].role`, 32),
      text: requiredString(row.text, `packet.snippets[${index}].text`, 4_000),
      ...(typeof row.text_hash === "string" ? { text_hash: row.text_hash.slice(0, 80) } : {}),
      ...(typeof row.parent_span_id === "string" ? { parent_span_id: row.parent_span_id.slice(0, 128) } : {}),
      ...(typeof row.source === "string" ? { source: row.source.slice(0, 32) } : {}),
      ...(typeof row.call_id === "string" ? { call_id: row.call_id } : {}),
      ...(Number.isInteger(row.start) ? { start: Number(row.start) } : {}),
      ...(Number.isInteger(row.end) ? { end: Number(row.end) } : {}),
      ...(Number.isInteger(row.order) ? { order: Number(row.order) } : {})
    };
  });
  const ruleProposals = Array.isArray(packet.rule_proposals) ? packet.rule_proposals.slice(0, 3).map((item) => {
    const row = asRecord(item);
    return {
      lesson_type: requiredString(row.lesson_type, "rule_proposal.lesson_type", 32),
      support_span_ids: Array.isArray(row.support_span_ids) ? row.support_span_ids.filter((id): id is string => typeof id === "string").slice(0, 16) : [],
      gaps: Array.isArray(row.gaps) ? row.gaps.filter((gap): gap is string => typeof gap === "string").slice(0, 16) : [],
      ...(row.observation && typeof row.observation === "object" ? { observation: row.observation as Record<string, unknown> } : {})
    };
  }) : [];
  return {
    schema_version: 1,
    run_id: requiredString(value.run_id, "run_id"),
    tenant_id: tenantId,
    project_id: typeof value.project_id === "string" ? value.project_id.slice(0, 256) : null,
    installation_id: requiredString(value.installation_id, "installation_id"),
    provider: provider as ProviderName,
    model: requiredString(value.model, "model", 128),
    tier: tier as ExtractionTier,
    packet_hash: requiredString(value.packet_hash, "packet_hash", 80),
    contract_hash: requiredString(value.contract_hash, "contract_hash", 80),
    prompt_version: requiredString(value.prompt_version, "prompt_version", 128),
    redaction_version: requiredString(value.redaction_version, "redaction_version", 128),
    prefilter_version: requiredString(value.prefilter_version, "prefilter_version", 128),
    extraction_profile: extractionProfile,
    prompt_policy_hash: extractionProfile ? requiredString(value.prompt_policy_hash, "prompt_policy_hash", 80) : (typeof value.prompt_policy_hash === "string" ? value.prompt_policy_hash : ""),
    verifier_policy_hash: extractionProfile ? requiredString(value.verifier_policy_hash, "verifier_policy_hash", 80) : (typeof value.verifier_policy_hash === "string" ? value.verifier_policy_hash : ""),
    execution_policy_hash: extractionProfile ? requiredString(value.execution_policy_hash, "execution_policy_hash", 80) : (typeof value.execution_policy_hash === "string" ? value.execution_policy_hash : ""),
    capsule_expires_at: Number(value.capsule_expires_at),
    packet: {
      schema: packet.schema as string,
      snippets,
      events: Array.isArray(packet.events) ? packet.events.slice(0, 24).map(asRecord) : [],
      rule_proposals: ruleProposals,
      routing: packet.routing && typeof packet.routing === "object" ? asRecord(packet.routing) : null,
      existing_memories: [],
      ...(refined ? { refinement_profile: "a-plus/v1" as const } : {}),
      ...(extractionProfile ? {
        extraction_profile: extractionProfile,
        coverage: asRecord(packet.coverage) as ExtractionInput["packet"]["coverage"]
      } : {}),
      limits: { input_tokens: MAX_INPUT_TOKENS, output_tokens: MAX_OUTPUT_TOKENS, candidates: MAX_CANDIDATES, calls: extractionProfile ? 2 : 1 }
    }
  };
}

async function readInput(ctx: CapabilityContext): Promise<ExtractionInput> {
  if (!ctx.inputRef.startsWith("r2://")) throw new Error("memory extraction input must use R2");
  const object = await ctx.env.OPEN_BRAIN_BUCKET.get(ctx.inputRef.slice(5));
  if (!object) throw new Error(`input artifact not found: ${ctx.inputRef}`);
  const raw = await object.json<unknown>();
  const rawPacket = asRecord(raw).packet;
  const input = parseInput(raw, ctx);
  const packetHash = `sha256:${await sha256(JSON.stringify(stableValue(rawPacket)))}`;
  if (packetHash !== input.packet_hash) throw new Error("memory extraction packet hash mismatch");
  if (input.contract_hash !== MEMORY_CONTRACT_V2_CONTRACT_HASH) throw new Error("memory extraction contract hash mismatch");
  if (input.packet.refinement_profile) {
    const ids = new Set<string>();
    for (const span of input.packet.snippets) {
      if (ids.has(span.span_id) || !["user", "assistant", "tool"].includes(span.role)) throw new Error("a-plus evidence identity invalid");
      ids.add(span.span_id);
      if (span.text_hash !== `sha256:${await sha256(span.text)}`) throw new Error("a-plus evidence hash mismatch");
    }
  }
  if (input.extraction_profile) {
    const bytes = input.packet.snippets.reduce((sum, snippet) => sum + new TextEncoder().encode(snippet.text).byteLength, 0);
    if (input.packet.snippets.length > 16 || bytes > 16 * 1024) throw new Error("coverage evidence pool exceeds fixed ceiling");
    const ids = new Set<string>();
    for (const snippet of input.packet.snippets) {
      if (ids.has(snippet.span_id)) throw new Error("coverage duplicate span id");
      ids.add(snippet.span_id);
      if (!snippet.text_hash || snippet.text_hash !== `sha256:${await sha256(snippet.text)}`) throw new Error("coverage snippet hash mismatch");
      if (!snippet.parent_span_id || !snippet.source || !Number.isInteger(snippet.start) || !Number.isInteger(snippet.end) || !Number.isInteger(snippet.order)) throw new Error("coverage snippet provenance missing");
      if (snippet.start! < 0 || snippet.end! <= snippet.start! || snippet.span_id !== `${snippet.parent_span_id}@${snippet.start}:${snippet.end}`) throw new Error("coverage snippet offset mismatch");
    }
    const metadata = Array.isArray(input.packet.coverage?.groups) ? input.packet.coverage!.groups! : [];
    if (metadata.some((group) => !Array.isArray(group.span_ids) || group.span_ids.some((id) => !ids.has(id)))) throw new Error("coverage group dependency missing");
    const groups = coverageGroups(input);
    const groupIds = groups.map((group) => group.group_id);
    const pass1Ids = [...new Set(input.packet.coverage?.pass1_group_ids ?? [])];
    const pass1Groups = groups.filter((group) => pass1Ids.includes(group.group_id));
    const pass1SpanCount = pass1Groups.reduce((sum, group) => sum + group.snippets.length, 0);
    if (groups.length === 0 || pass1Ids.length === 0 || new Set(groupIds).size !== groupIds.length
      || pass1Groups.length !== pass1Ids.length || pass1SpanCount === 0 || pass1SpanCount > 8) throw new Error("coverage groups missing");
    const pass1Packet = coverageRequestPacket(input, 1, []).packet;
    assertMemoryExtractionInputWithinCeiling(buildMemoryExtractionPrompt(pass1Packet as unknown as Record<string, unknown>));
  }
  return input;
}

async function loadExistingMemoryCandidates(ctx: CapabilityContext, input: ExtractionInput) {
  const query = input.packet.snippets.map((item) => item.text).join(" ").slice(0, 1_000);
  const ftsQuery = buildMemoryFtsQuery(query);
  if (!ftsQuery || !input.project_id) return [];
  try {
    const rows = await ctx.env.OPEN_BRAIN_DB.prepare(
      `SELECT m.id, m.kind, m.summary, m.content
       FROM memories_fts
       JOIN memories m ON m.id = memories_fts.memory_id AND m.tenant_id = memories_fts.tenant_id
       WHERE memories_fts.tenant_id = ? AND memories_fts.content MATCH ?
         AND m.project_id = ?
         AND (m.permissions_json IS NULL OR m.permissions_json = '[]')
         AND m.deleted_at IS NULL
         AND (m.lifecycle_state IS NULL OR m.lifecycle_state != 'suppressed')
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND (m.valid_from IS NULL OR m.valid_from <= ?)
         AND (m.valid_until IS NULL OR m.valid_until > ?)
       ORDER BY bm25(memories_fts) ASC, m.created_at DESC
       LIMIT 5`
    ).bind(ctx.tenantId, ftsQuery, input.project_id, Date.now(), Date.now(), Date.now())
      .all<{ id: string; kind: string; summary: string | null; content: string }>();
    // No trusted requesting principal is carried by this capability. Never
    // forward ACL-restricted records, even if a caller supplies an identity.
    // Screen full content AND summary before truncating either for the provider.
    return rows.results.flatMap((row) => {
      // JSON escaping changes quotes and line boundaries used by secret rules.
      // Inspect each raw field independently; serialization is not sanitization.
      if ([row.summary ?? "", row.content].some((field) =>
        !screenSensitiveMemory(field.normalize("NFKC"), { mode: "deny", allowed_principals: [] }).allowed
      )) return [];
      return [{
        id: row.id,
        kind: row.kind,
        text: (row.summary ?? row.content).normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 120)
      }];
    });
  } catch (error) {
    throw new Error(`retrieval_unavailable:${error instanceof Error ? error.message : "query_failed"}`);
  }
}

function withBoundedExistingMemories(input: ExtractionInput, candidates: Array<{ id: string; kind: string; text: string }>): ExtractionInput {
  const accepted: Array<{ id: string; kind: string; text: string }> = [];
  for (const candidate of candidates) {
    const next = { ...input, packet: { ...input.packet, existing_memories: [...accepted, candidate] } };
    try {
      const promptPacket = input.extraction_profile ? coverageRequestPacket(next as ExtractionInput, 1, []).packet : next.packet;
      assertMemoryExtractionInputWithinCeiling(buildMemoryExtractionPrompt(promptPacket as unknown as Record<string, unknown>));
      accepted.push(candidate);
    } catch {
      break;
    }
  }
  return { ...input, packet: { ...input.packet, existing_memories: accepted } };
}

function providerEntry(env: Env, input: ExtractionInput): Record<string, unknown> | null {
  if (!env.MEMORY_EXTRACTION_PROVIDER_MODELS_JSON?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.MEMORY_EXTRACTION_PROVIDER_MODELS_JSON);
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(asRecord(parsed).entries) ? asRecord(parsed).entries as unknown[] : [];
  return entries.map(asRecord).find((item) => item.provider === input.provider && item.model === input.model) ?? null;
}

function providerKey(env: Env, input: ExtractionInput): string | null {
  const entry = providerEntry(env, input);
  if (!entry
    || entry.zero_retention !== true
    || entry.strict_json_schema !== true
    || entry.input_token_profile !== MEMORY_EXTRACTION_TOKEN_PROFILE) return null;
  const key = input.provider === "openai" ? env.OPENAI_API_KEY : input.provider === "gemini" ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY;
  return key?.trim() || null;
}

function coverageAllowed(env: Env, input: ExtractionInput): boolean {
  if (!input.extraction_profile || !env.MEMORY_EXTRACTION_COVERAGE_ALLOWLIST_JSON?.trim()) return !input.extraction_profile;
  try {
    const parsed = JSON.parse(env.MEMORY_EXTRACTION_COVERAGE_ALLOWLIST_JSON) as unknown;
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(asRecord(parsed).entries) ? asRecord(parsed).entries as unknown[] : [];
    return entries.map(asRecord).some((entry) => entry.tenant_id === input.tenant_id && entry.project_id === input.project_id && entry.installation_id === input.installation_id
      && ![entry.tenant_id, entry.project_id, entry.installation_id].includes("*"));
  } catch { return false; }
}

function reservationTokens(input: ExtractionInput): number {
  return input.extraction_profile ? COVERAGE_RESERVED_TOKENS : LEGACY_RESERVED_TOKENS;
}

function utcMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function tierLimit(env: Env, tier: ExtractionTier): number {
  const raw = tier === "tier2" ? env.MEMORY_EXTRACTION_TIER2_MONTHLY_TOKENS : env.MEMORY_EXTRACTION_TIER3_MONTHLY_TOKENS;
  const fallback = tier === "tier2" ? DEFAULT_TIER2_LIMIT : 0;
  const parsed = Number(raw ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function reserveBudget(ctx: CapabilityContext, input: ExtractionInput, now: number): Promise<boolean> {
  const month = utcMonth(now);
  const limit = tierLimit(ctx.env, input.tier);
  const reservedTokens = reservationTokens(input);
  await ctx.env.OPEN_BRAIN_DB.prepare(
    `INSERT OR IGNORE INTO memory_extraction_token_buckets(
       tenant_id, utc_month, tier, token_limit, reserved_tokens, consumed_tokens, updated_at
     ) VALUES(?,?,?,?,0,0,?)`
  ).bind(ctx.tenantId, month, input.tier, limit, now).run();
  const results = await ctx.env.OPEN_BRAIN_DB.batch([
    ctx.env.OPEN_BRAIN_DB.prepare(
      `INSERT OR IGNORE INTO memory_extraction_token_reservations(
         tenant_id, run_id, utc_month, tier, reserved_tokens, applied, settled, created_at
       )
       SELECT ?,?,?,?,?,0,0,?
       WHERE EXISTS (
         SELECT 1 FROM memory_extraction_token_buckets
         WHERE tenant_id = ? AND utc_month = ? AND tier = ?
           AND consumed_tokens + reserved_tokens + ? <= token_limit
       )`
    ).bind(ctx.tenantId, input.run_id, month, input.tier, reservedTokens, now, ctx.tenantId, month, input.tier, reservedTokens),
    ctx.env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_extraction_token_buckets
       SET reserved_tokens = reserved_tokens + ?, updated_at = ?
       WHERE tenant_id = ? AND utc_month = ? AND tier = ?
         AND EXISTS (
           SELECT 1 FROM memory_extraction_token_reservations r
           WHERE r.tenant_id = ? AND r.run_id = ? AND r.applied = 0
         )`
    ).bind(reservedTokens, now, ctx.tenantId, month, input.tier, ctx.tenantId, input.run_id),
    ctx.env.OPEN_BRAIN_DB.prepare(
      "UPDATE memory_extraction_token_reservations SET applied = 1 WHERE tenant_id = ? AND run_id = ? AND applied = 0"
    ).bind(ctx.tenantId, input.run_id),
    ctx.env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_extraction_runs SET execution_status = 'reserved', reserved_tokens = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND execution_status = 'planned'
         AND EXISTS (
           SELECT 1 FROM memory_extraction_token_reservations r
           WHERE r.tenant_id = ? AND r.run_id = ? AND r.applied = 1 AND r.settled = 0
         )`
    ).bind(reservedTokens, now, ctx.tenantId, input.run_id, ctx.tenantId, input.run_id)
  ]);
  return Number(results[3]?.meta.changes ?? 0) === 1;
}

async function settleBudget(ctx: CapabilityContext, input: ExtractionInput, chargedTokens: number, now: number): Promise<void> {
  const reservation = await ctx.env.OPEN_BRAIN_DB.prepare(
    `SELECT utc_month, tier, reserved_tokens FROM memory_extraction_token_reservations
     WHERE tenant_id = ? AND run_id = ? AND applied = 1 AND settled = 0`
  ).bind(ctx.tenantId, input.run_id).first<{ utc_month: string; tier: string; reserved_tokens: number }>();
  if (!reservation) return;
  await ctx.env.OPEN_BRAIN_DB.batch([
    ctx.env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_extraction_token_buckets
       SET reserved_tokens = MAX(0, reserved_tokens - ?), consumed_tokens = consumed_tokens + ?, updated_at = ?
       WHERE tenant_id = ? AND utc_month = ? AND tier = ?`
    ).bind(reservation.reserved_tokens, chargedTokens, now, ctx.tenantId, reservation.utc_month, reservation.tier),
    ctx.env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_extraction_token_reservations
       SET charged_tokens = ?, settled = 1, settled_at = ?
       WHERE tenant_id = ? AND run_id = ? AND settled = 0`
    ).bind(chargedTokens, now, ctx.tenantId, input.run_id)
  ]);
}

function compactPrompt(input: ExtractionInput): string {
  const prompt = buildMemoryExtractionPrompt(input.packet as unknown as Record<string, unknown>);
  assertMemoryExtractionInputWithinCeiling(prompt);
  return prompt;
}

async function providerRequest(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`outcome_unknown:${error instanceof Error ? error.name : "network"}`);
  }
  if (!response.ok) throw new Error(`provider_failed:http_${response.status}`);
  return asRecord(await response.json<unknown>());
}

function providerText(provider: ProviderName, response: Record<string, unknown>): string {
  if (typeof response.output_text === "string") return response.output_text;
  if (provider === "openai" && Array.isArray(response.output)) {
    for (const item of response.output) {
      for (const block of Array.isArray(asRecord(item).content) ? asRecord(item).content as unknown[] : []) {
        if (typeof asRecord(block).text === "string") return asRecord(block).text as string;
      }
    }
  }
  if (provider === "anthropic" && Array.isArray(response.content)) {
    return response.content.map((item) => asRecord(item).text).filter((item): item is string => typeof item === "string").join("");
  }
  for (const output of Array.isArray(response.outputs) ? response.outputs : []) {
    if (typeof asRecord(output).text === "string") return asRecord(output).text as string;
  }
  return "";
}

function usage(response: Record<string, unknown>): { inputTokens: number | null; outputTokens: number | null } {
  const value = asRecord(response.usage ?? response.usageMetadata);
  const inputTokens = Number(value.input_tokens ?? value.inputTokenCount);
  const outputTokens = Number(value.output_tokens ?? value.outputTokenCount);
  return {
    inputTokens: Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : null,
    outputTokens: Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : null
  };
}

async function generate(env: Env, input: ExtractionInput, prompt: string, key: string): Promise<ProviderResult> {
  let response: Record<string, unknown>;
  if (input.provider === "openai") {
    response = await providerRequest("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        store: false,
        temperature: 0,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        text: { format: { type: "json_schema", name: "orgbrain_memory_extraction", strict: true, schema: outputJsonSchema } }
      })
    });
  } else if (input.provider === "gemini") {
    response = await providerRequest("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        input: prompt,
        generation_config: { temperature: 0, max_output_tokens: MAX_OUTPUT_TOKENS },
        response_format: { type: "text", mime_type: "application/json", schema: outputJsonSchema }
      })
    });
  } else {
    response = await providerRequest("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: { type: "json_schema", schema: outputJsonSchema } }
      })
    });
  }
  const text = providerText(input.provider, response);
  if (!text) throw new Error("provider_failed:empty_structured_output");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("provider_failed:invalid_json");
  }
  const rows = asRecord(parsed).candidates;
  if (!Array.isArray(rows)) throw new Error("provider_failed:invalid_schema");
  if ((input.packet.schema === "learning-extraction-proposal/v3" || input.extraction_profile) && (rows.length > MAX_CANDIDATES
    || Object.keys(asRecord(parsed)).some((key) => key !== "candidates"))) throw new Error("provider_failed:invalid_schema");
  return { candidates: rows.slice(0, MAX_CANDIDATES) as ProviderCandidate[], ...usage(response) };
}

function coverageGroups(input: ExtractionInput) {
  const metadata = Array.isArray(input.packet.coverage?.groups) ? input.packet.coverage!.groups! : [];
  return metadata.map((group) => {
    const spanIds = new Set(Array.isArray(group.span_ids) ? group.span_ids : []);
    const snippets = input.packet.snippets.filter((snippet) => spanIds.has(snippet.span_id));
    return {
      ...group,
      span_ids: snippets.map((snippet) => snippet.span_id),
      snippets,
      byte_length: snippets.reduce((sum, snippet) => sum + new TextEncoder().encode(snippet.text).byteLength, 0)
    };
  }).filter((group) => group.snippets.length > 0);
}

function acceptedPromptContext(candidates: ProviderCandidate[]) {
  return candidates.slice(0, 3).map((candidate) => ({
    lesson_type: candidate.lesson_type,
    support_span_ids: candidate.support_span_ids,
    fields: candidate.fields.map((field) => ({ name: field.name, values: field.values.slice(0, 4) }))
  }));
}

function coverageRequestPacket(input: ExtractionInput, passNo: 1 | 2, accepted: ProviderCandidate[], targetGroupIds?: string[]) {
  const groups = coverageGroups(input);
  const requested = new Set(targetGroupIds ?? (passNo === 1 ? input.packet.coverage?.pass1_group_ids ?? [] : groups.map((group) => group.group_id)));
  const basePacket = {
    ...input.packet,
    snippets: [],
    coverage_pass: passNo,
    ...(passNo === 2 ? { accepted_candidates: acceptedPromptContext(accepted) } : {})
  };
  return packCoverageGroups(basePacket, groups.filter((group) => requested.has(group.group_id)), {
    reserve_bytes: 0,
    max_snippets: 8,
    upper_bound: (packet: Record<string, unknown>) => memoryExtractionProviderInputUpperBound(buildMemoryExtractionPrompt(packet))
  });
}

type PassExecution = {
  pass_no: 1 | 2;
  state: "succeeded" | "failed" | "outcome_unknown" | "skipped";
  request_hash: string | null;
  generated: ProviderResult | null;
  verification: Awaited<ReturnType<typeof verifiedCandidates>> | null;
  input_tokens: number | null;
  output_tokens: number | null;
  charged_tokens: number;
  error_code: string | null;
  result_r2_key: string | null;
  omitted_groups?: unknown[];
  presented_group_ids?: string[];
};

async function readPassArtifact(ctx: CapabilityContext, key: string): Promise<PassExecution> {
  const object = await ctx.env.OPEN_BRAIN_BUCKET.get(key);
  if (!object) throw new Error("coverage_pass_result_missing");
  return object.json<PassExecution>();
}

async function executeCoveragePass(
  ctx: CapabilityContext,
  input: ExtractionInput,
  passNo: 1 | 2,
  accepted: ProviderCandidate[],
  key: string,
  targetGroupIds?: string[]
): Promise<PassExecution> {
  const now = Date.now();
  await ctx.env.OPEN_BRAIN_DB.prepare(
    `INSERT OR IGNORE INTO memory_extraction_passes(tenant_id, run_id, pass_no, state, charged_tokens, created_at, updated_at)
     VALUES(?,?,?,'planned',0,?,?)`
  ).bind(ctx.tenantId, input.run_id, passNo, now, now).run();
  const existing = await ctx.env.OPEN_BRAIN_DB.prepare(
    "SELECT state, result_r2_key, request_hash, actual_input_tokens, actual_output_tokens, charged_tokens, error_code FROM memory_extraction_passes WHERE tenant_id=? AND run_id=? AND pass_no=?"
  ).bind(ctx.tenantId, input.run_id, passNo).first<{ state: PassExecution["state"] | "planned" | "running"; result_r2_key: string | null; request_hash: string | null; actual_input_tokens: number | null; actual_output_tokens: number | null; charged_tokens: number; error_code: string | null }>();
  if (existing?.state === "succeeded" && existing.result_r2_key) return readPassArtifact(ctx, existing.result_r2_key);
  if (existing?.state === "failed" || existing?.state === "outcome_unknown" || existing?.state === "skipped") return {
    pass_no: passNo, state: existing.state, request_hash: existing.request_hash, generated: null, verification: null,
    input_tokens: existing.actual_input_tokens, output_tokens: existing.actual_output_tokens, charged_tokens: existing.charged_tokens,
    error_code: existing.error_code, result_r2_key: existing.result_r2_key
  };
  if (existing?.state === "running") {
    const deterministicKey = `tenants/${ctx.tenantId}/memory-extraction/passes/${input.run_id}/${passNo}.json`;
    const recoveredObject = await ctx.env.OPEN_BRAIN_BUCKET.get(deterministicKey);
    if (recoveredObject) {
      const recovered = await recoveredObject.json<PassExecution>();
      if (recovered.request_hash === existing.request_hash && (recovered.state === "succeeded" || recovered.state === "failed")) {
        await ctx.env.OPEN_BRAIN_DB.prepare(
          `UPDATE memory_extraction_passes SET state=?, result_r2_key=?, actual_input_tokens=?, actual_output_tokens=?, charged_tokens=?, error_code=?, completed_at=?, updated_at=?
           WHERE tenant_id=? AND run_id=? AND pass_no=? AND state='running' AND request_hash=?`
        ).bind(recovered.state, deterministicKey, recovered.input_tokens, recovered.output_tokens, recovered.charged_tokens, recovered.error_code, now, now, ctx.tenantId, input.run_id, passNo, existing.request_hash).run();
        return recovered;
      }
    }
    await ctx.env.OPEN_BRAIN_DB.prepare(
      "UPDATE memory_extraction_passes SET state='outcome_unknown', charged_tokens=?, error_code='redelivery_after_running', completed_at=?, updated_at=? WHERE tenant_id=? AND run_id=? AND pass_no=? AND state='running'"
    ).bind(PASS_UNKNOWN_CHARGE, now, now, ctx.tenantId, input.run_id, passNo).run();
    return { pass_no: passNo, state: "outcome_unknown", request_hash: existing.request_hash, generated: null, verification: null, input_tokens: null, output_tokens: null, charged_tokens: PASS_UNKNOWN_CHARGE, error_code: "redelivery_after_running", result_r2_key: null };
  }

  const packed = coverageRequestPacket(input, passNo, accepted, targetGroupIds);
  if (packed.groups.length === 0) {
    const reason = "coverage_skipped_input_budget";
    await ctx.env.OPEN_BRAIN_DB.prepare(
      "UPDATE memory_extraction_passes SET state='skipped', charged_tokens=0, error_code=?, completed_at=?, updated_at=? WHERE tenant_id=? AND run_id=? AND pass_no=? AND state='planned'"
    ).bind(reason, now, now, ctx.tenantId, input.run_id, passNo).run();
    return { pass_no: passNo, state: "skipped", request_hash: null, generated: null, verification: null, input_tokens: null, output_tokens: null, charged_tokens: 0, error_code: reason, result_r2_key: null, omitted_groups: packed.omitted, presented_group_ids: [] };
  }
  const requestPacket = packed.packet as ExtractionInput["packet"];
  const requestInput = { ...input, packet: requestPacket };
  const prompt = compactPrompt(requestInput);
  const requestHash = `sha256:${await sha256(JSON.stringify(stableValue(requestPacket)))}`;
  const claimed = await ctx.env.OPEN_BRAIN_DB.prepare(
    "UPDATE memory_extraction_passes SET state='running', request_hash=?, started_at=?, updated_at=? WHERE tenant_id=? AND run_id=? AND pass_no=? AND state='planned'"
  ).bind(requestHash, now, now, ctx.tenantId, input.run_id, passNo).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) throw new Error("coverage_pass_claim_lost");
  try {
    const generated = await generate(ctx.env, requestInput, prompt, key);
    const usageKnown = generated.inputTokens !== null && generated.outputTokens !== null;
    const chargedTokens = usageKnown ? generated.inputTokens! + generated.outputTokens! : PASS_UNKNOWN_CHARGE;
    const ceilingExceeded = (generated.inputTokens ?? 0) > MAX_INPUT_TOKENS || (generated.outputTokens ?? 0) > MAX_OUTPUT_TOKENS;
    const verification = ceilingExceeded ? { candidates: [], accepted_indices: [], rejections: [{ candidate_index: -1, reason_codes: ["provider_usage_ceiling_exceeded"] }] } : await verifiedCandidates(requestInput, generated.candidates);
    const artifactKey = `tenants/${ctx.tenantId}/memory-extraction/passes/${input.run_id}/${passNo}.json`;
    const artifact: PassExecution = {
      pass_no: passNo, state: ceilingExceeded ? "failed" : "succeeded", request_hash: requestHash, generated, verification,
      input_tokens: generated.inputTokens, output_tokens: generated.outputTokens, charged_tokens: chargedTokens,
      error_code: ceilingExceeded ? "provider_usage_ceiling_exceeded" : null, result_r2_key: artifactKey,
      omitted_groups: packed.omitted,
      presented_group_ids: packed.groups.map((group: { group_id: string }) => group.group_id)
    };
    await ctx.env.OPEN_BRAIN_BUCKET.put(artifactKey, JSON.stringify(artifact), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { tenant_id: ctx.tenantId, run_id: input.run_id, pass_no: String(passNo), request_hash: requestHash }
    });
    await ctx.env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_extraction_passes SET state=?, result_r2_key=?, actual_input_tokens=?, actual_output_tokens=?, charged_tokens=?, error_code=?, completed_at=?, updated_at=?
       WHERE tenant_id=? AND run_id=? AND pass_no=? AND state='running' AND request_hash=?`
    ).bind(artifact.state, artifactKey, generated.inputTokens, generated.outputTokens, chargedTokens, artifact.error_code, Date.now(), Date.now(), ctx.tenantId, input.run_id, passNo, requestHash).run();
    return artifact;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = message.startsWith("outcome_unknown:") ? "outcome_unknown" : "failed";
    await ctx.env.OPEN_BRAIN_DB.prepare(
      "UPDATE memory_extraction_passes SET state=?, charged_tokens=?, error_code=?, completed_at=?, updated_at=? WHERE tenant_id=? AND run_id=? AND pass_no=? AND state='running' AND request_hash=?"
    ).bind(state, PASS_UNKNOWN_CHARGE, message.slice(0, 160), Date.now(), Date.now(), ctx.tenantId, input.run_id, passNo, requestHash).run();
    return { pass_no: passNo, state, request_hash: requestHash, generated: null, verification: null, input_tokens: null, output_tokens: null, charged_tokens: PASS_UNKNOWN_CHARGE, error_code: message.slice(0, 160), result_r2_key: null, omitted_groups: packed.omitted, presented_group_ids: packed.groups.map((group: { group_id: string }) => group.group_id) };
  }
}

async function writeResult(ctx: CapabilityContext, input: ExtractionInput, result: Record<string, unknown>) {
  const key = `tenants/${ctx.tenantId}/memory-extraction/results/${input.run_id}.json`;
  await ctx.env.OPEN_BRAIN_BUCKET.put(key, JSON.stringify(result), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { tenant_id: ctx.tenantId, run_id: input.run_id, packet_hash: input.packet_hash }
  });
  return key;
}

async function settleRun(
  ctx: CapabilityContext,
  input: ExtractionInput,
  outcome: string,
  options: {
    candidates?: Awaited<ReturnType<typeof verifiedCandidates>>["candidates"];
    verificationRejections?: Awaited<ReturnType<typeof verifiedCandidates>>["rejections"];
    inputTokens?: number | null;
    outputTokens?: number | null;
    chargedTokens?: number;
    errorCode?: string;
    coverageStatus?: string | null;
    passes?: PassExecution[];
    inputOmitted?: unknown[];
    candidateLimitCount?: number;
    conflictCount?: number;
    durationMs?: number;
  } = {}
) {
  const now = Date.now();
  const candidates = options.candidates ?? [];
  const chargedTokens = options.chargedTokens ?? 0;
  const usedSpanIds = new Set(candidates.flatMap((item) => item.support_span_ids));
  let capsuleKey: string | null = null;
  if (candidates.length > 0) {
    capsuleKey = `tenants/${ctx.tenantId}/memory-extraction/evidence/${input.run_id}.json`;
    const capsule = {
      schema: "memory-extraction-evidence-capsule/v1",
      run_id: input.run_id,
      packet_hash: input.packet_hash,
      snippets: input.packet.snippets.filter((item) => usedSpanIds.has(item.span_id)),
      events: input.packet.events.filter((item) => usedSpanIds.has(String(item.event_id ?? ""))),
      expires_at: input.capsule_expires_at
    };
    await ctx.env.OPEN_BRAIN_BUCKET.put(capsuleKey, JSON.stringify(capsule), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { tenant_id: ctx.tenantId, run_id: input.run_id, packet_hash: input.packet_hash }
    });
  }
  const report = {
    schema: "memory-extraction-result/v1",
    run_id: input.run_id,
    execution_status: "settled",
    outcome,
    candidate_count: candidates.length,
    candidate_hashes: await Promise.all(candidates.map((item) => sha256(JSON.stringify(item)))),
    verification_rejection_count: options.verificationRejections?.length ?? 0,
    verification_rejections: options.verificationRejections ?? [],
    input_tokens: options.inputTokens ?? null,
    output_tokens: options.outputTokens ?? null,
    charged_tokens: chargedTokens,
    actual_input_tokens: options.inputTokens ?? null,
    actual_output_tokens: options.outputTokens ?? null,
    conservative_charged_tokens: chargedTokens,
    ...(input.extraction_profile ? {
      extraction_profile: input.extraction_profile,
      coverage_status: options.coverageStatus ?? null,
      pass_count: options.passes?.filter((item) => item.state === "succeeded" || item.state === "failed" || item.state === "outcome_unknown").length ?? 0,
      passes: (options.passes ?? []).map((item) => ({
        pass_no: item.pass_no, state: item.state, request_hash: item.request_hash,
        input_tokens: item.input_tokens, output_tokens: item.output_tokens,
        charged_tokens: item.charged_tokens, error_code: item.error_code
      })),
      presented_group_count: new Set((options.passes ?? []).flatMap((item) => item.presented_group_ids ?? [])).size,
      omitted_groups: options.inputOmitted ?? input.packet.coverage?.omitted ?? [],
      omitted_group_count: (options.inputOmitted ?? input.packet.coverage?.omitted ?? []).length,
      candidate_limit_count: options.candidateLimitCount ?? 0,
      conflict_count: options.conflictCount ?? 0,
      review_signals: input.packet.coverage?.groups ?? [],
      duration_ms: options.durationMs ?? null
    } : {}),
    read_only_source: true
  };
  const resultKey = await writeResult(ctx, input, report);
  const statements: D1PreparedStatement[] = candidates.map((candidate) => {
    const id = `learning-candidate:${input.run_id}:${candidate.external_key.slice(-24)}`;
    return ctx.env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_learning_candidates(
         id, tenant_id, project_id, task_key, external_key, payload_json, status,
         reason_codes_json, prompt_contract_id, prompt_hash, verifier_version,
         created_at, updated_at, expires_at
       ) VALUES(?,?,?,?,?,?,'quarantine',?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id, external_key) DO NOTHING`
    ).bind(
      id, ctx.tenantId, input.project_id, `extraction:${input.run_id}`, candidate.external_key,
      JSON.stringify({ ...candidate, contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH, capsule_ref: capsuleKey ? `r2://${capsuleKey}` : null }),
      JSON.stringify(candidate.reason_codes), MEMORY_CONTRACT_V2_PROMPT_ID, MEMORY_CONTRACT_V2_PROMPT_HASH,
      MEMORY_CONTRACT_V2_VERIFIER_VERSION, now, now, input.capsule_expires_at
    );
  });
  statements.push(ctx.env.OPEN_BRAIN_DB.prepare(
    `UPDATE memory_extraction_runs
     SET execution_status = 'settled', outcome = ?, actual_input_tokens = ?, actual_output_tokens = ?,
         charged_tokens = ?, capsule_r2_key = ?, result_r2_key = ?, error_code = ?, coverage_status = ?, settled_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND execution_status <> 'settled'`
  ).bind(
    outcome, options.inputTokens ?? null, options.outputTokens ?? null, chargedTokens,
    capsuleKey, resultKey, options.errorCode ?? null, options.coverageStatus ?? null, now, now, ctx.tenantId, input.run_id
  ));
  await ctx.env.OPEN_BRAIN_DB.batch(statements);
  await settleBudget(ctx, input, chargedTokens, now);
  await ctx.env.OPEN_BRAIN_BUCKET.delete(ctx.inputRef.slice(5)).catch(() => undefined);
  return { resultKey, report };
}

function capabilityResult(startedAt: number, resultKey: string, summary: string, inputTokens = 0, outputTokens = 0): CapabilityResult {
  return {
    outputRef: `r2://${resultKey}`,
    summary,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs: Math.max(0, Date.now() - startedAt),
    retrievalCount: 0,
    retrievedIds: []
  };
}

async function skipCoveragePass(ctx: CapabilityContext, input: ExtractionInput, passNo: 1 | 2, reason: string): Promise<PassExecution> {
  const now = Date.now();
  await ctx.env.OPEN_BRAIN_DB.prepare(
    `INSERT OR IGNORE INTO memory_extraction_passes(tenant_id, run_id, pass_no, state, charged_tokens, error_code, completed_at, created_at, updated_at)
     VALUES(?,?,?,'skipped',0,?,?,?,?)`
  ).bind(ctx.tenantId, input.run_id, passNo, reason, now, now, now).run();
  await ctx.env.OPEN_BRAIN_DB.prepare(
    "UPDATE memory_extraction_passes SET state='skipped', charged_tokens=0, error_code=?, completed_at=?, updated_at=? WHERE tenant_id=? AND run_id=? AND pass_no=? AND state='planned'"
  ).bind(reason, now, now, ctx.tenantId, input.run_id, passNo).run();
  return { pass_no: passNo, state: "skipped", request_hash: null, generated: null, verification: null, input_tokens: null, output_tokens: null, charged_tokens: 0, error_code: reason, result_r2_key: null, presented_group_ids: [] };
}

function acceptedProviderCandidates(pass: PassExecution): ProviderCandidate[] {
  if (pass.state !== "succeeded" || !pass.generated || !pass.verification) return [];
  return pass.generated.candidates.filter((_, index) => pass.verification!.accepted_indices.includes(index));
}

async function runCoverageExtraction(ctx: CapabilityContext, input: ExtractionInput, key: string, startedAt: number): Promise<CapabilityResult> {
  const existingMemories = await loadExistingMemoryCandidates(ctx, input);
  const enrichedInput = withBoundedExistingMemories(input, existingMemories);
  const pass1 = await executeCoveragePass(ctx, enrichedInput, 1, [], key);
  let pass2: PassExecution;
  if (pass1.state !== "succeeded") {
    pass2 = await skipCoveragePass(ctx, enrichedInput, 2, "pass1_not_successful");
  } else {
    const adoptedSpanIds = pass1.verification?.candidates.flatMap((candidate) => candidate.support_span_ids) ?? [];
    const decision = decideCoverageSecondPass({
      groups: coverageGroups(enrichedInput),
      pass1_presented_group_ids: enrichedInput.packet.coverage?.pass1_group_ids ?? [],
      pass1_adopted_span_ids: adoptedSpanIds,
      pass1_status: "succeeded"
    });
    pass2 = decision.run
      ? await executeCoveragePass(ctx, enrichedInput, 2, acceptedProviderCandidates(pass1), key, decision.group_ids)
      : await skipCoveragePass(ctx, enrichedInput, 2, decision.reason);
  }
  const successfulRaw = [pass1, pass2].map(acceptedProviderCandidates);
  const groups = coverageGroups(enrichedInput);
  const priorityBySpan = Object.fromEntries(groups.flatMap((group) => group.span_ids.map((id) => [id, group.priority])));
  const orderBySpan = Object.fromEntries(enrichedInput.packet.snippets.map((snippet, index) => [snippet.span_id, snippet.order ?? index]));
  const signalBySpan = Object.fromEntries(groups.flatMap((group) => group.span_ids.map((id) => [id, group.review_signal_score ?? 0])));
  const merged = mergeCoverageCandidates(successfulRaw, { priority_by_span: priorityBySpan, order_by_span: orderBySpan, signal_by_span: signalBySpan });
  const verification = await verifiedCandidates(enrichedInput, merged.candidates);
  verification.rejections.push(...merged.conflicts.map((_: unknown, index: number) => ({ candidate_index: -1 - index, reason_codes: ["atomic_evidence_conflict"] })));
  verification.rejections.push(...merged.omitted.map((_: unknown, index: number) => ({ candidate_index: -100 - index, reason_codes: ["candidate_limit"] })));
  const passes = [pass1, pass2];
  const chargedTokens = passes.reduce((sum, pass) => sum + pass.charged_tokens, 0);
  const actualKnown = passes.filter((pass) => pass.state !== "skipped").every((pass) => pass.input_tokens !== null && pass.output_tokens !== null);
  const inputTokens = actualKnown ? passes.reduce((sum, pass) => sum + (pass.input_tokens ?? 0), 0) : null;
  const outputTokens = actualKnown ? passes.reduce((sum, pass) => sum + (pass.output_tokens ?? 0), 0) : null;
  const failedPass = passes.find((pass) => pass.state === "failed" || pass.state === "outcome_unknown");
  const coverageStatus = failedPass ? "failed" : pass2.state === "succeeded" ? "executed" : pass2.error_code;
  const outcome = verification.candidates.length > 0 ? "succeeded" : failedPass ? (failedPass.state === "outcome_unknown" ? "outcome_unknown" : "provider_failed") : "no_candidate";
  const settled = await settleRun(ctx, enrichedInput, outcome, {
    candidates: verification.candidates,
    verificationRejections: verification.rejections,
    inputTokens,
    outputTokens,
    chargedTokens,
    errorCode: failedPass?.error_code ?? undefined,
    coverageStatus,
    passes,
    inputOmitted: [...(enrichedInput.packet.coverage?.omitted ?? []), ...passes.flatMap((pass) => pass.omitted_groups ?? [])],
    candidateLimitCount: merged.omitted.length,
    conflictCount: merged.conflicts.length,
    durationMs: Math.max(0, Date.now() - startedAt)
  });
  return capabilityResult(startedAt, settled.resultKey, `Memory extraction ${outcome}; coverage ${coverageStatus}`, inputTokens ?? 0, outputTokens ?? 0);
}

export async function runMemoryExtraction(ctx: CapabilityContext): Promise<CapabilityResult> {
  const startedAt = Date.now();
  const run = await ctx.env.OPEN_BRAIN_DB.prepare(
    `SELECT id, installation_id, provider, model, packet_hash, contract_hash,
            extraction_profile, prompt_policy_hash, verifier_policy_hash, execution_policy_hash,
            execution_status, outcome, result_r2_key, tombstoned_at
     FROM memory_extraction_runs WHERE tenant_id = ? AND task_id = ?`
  ).bind(ctx.tenantId, ctx.taskId).first<RunRow>();
  if (!run) throw new Error("memory extraction run not found");
  if (run.tombstoned_at) throw new Error("memory extraction run tombstoned");
  if (run.execution_status === "settled" && run.result_r2_key) {
    return capabilityResult(startedAt, run.result_r2_key, `Memory extraction already settled: ${run.outcome ?? "unknown"}`);
  }
  const input = await readInput(ctx);
  if (input.packet.schema === "learning-extraction-proposal/v3") assertV3ProviderProfile();
  if (input.run_id !== run.id) throw new Error("memory extraction task/run mismatch");
  if (input.installation_id !== run.installation_id
    || input.provider !== run.provider
    || input.model !== run.model
    || input.packet_hash !== run.packet_hash
    || input.contract_hash !== run.contract_hash
    || input.extraction_profile !== run.extraction_profile
    || input.prompt_policy_hash !== run.prompt_policy_hash
    || input.verifier_policy_hash !== run.verifier_policy_hash
    || input.execution_policy_hash !== run.execution_policy_hash) {
    throw new Error("memory extraction run attestation mismatch");
  }
  const installation = await ctx.env.OPEN_BRAIN_DB.prepare(
    "SELECT status, purpose FROM mcp_client_installations WHERE tenant_id = ? AND id = ?"
  ).bind(ctx.tenantId, input.installation_id).first<{ status: string; purpose: string }>();
  if (!installation || installation.status !== "active" || installation.purpose !== "capture") {
    const settled = await settleRun(ctx, input, "model_unavailable", { errorCode: "installation_inactive" });
    return capabilityResult(startedAt, settled.resultKey, "Memory extraction installation inactive");
  }
  if (input.tier !== "tier2") {
    const settled = await settleRun(ctx, input, "model_unavailable", { errorCode: "tier3_certification_pipeline_required" });
    return capabilityResult(startedAt, settled.resultKey, "Memory extraction Tier 3 certification unavailable");
  }
  if (input.extraction_profile && !coverageAllowed(ctx.env, input)) {
    const settled = await settleRun(ctx, input, "provider_failed", { errorCode: "memory_extraction_coverage_not_allowlisted", coverageStatus: "rejected" });
    return capabilityResult(startedAt, settled.resultKey, "Coverage extraction allowlist mismatch");
  }
  if (run.execution_status === "running" && !input.extraction_profile) {
    const settled = await settleRun(ctx, input, "outcome_unknown", { chargedTokens: LEGACY_RESERVED_TOKENS, errorCode: "redelivery_after_running" });
    return capabilityResult(startedAt, settled.resultKey, "Memory extraction outcome unknown after redelivery");
  }
  const key = providerKey(ctx.env, input);
  if (!key) {
    const settled = await settleRun(ctx, input, "model_unavailable", { errorCode: "same_model_not_allowlisted" });
    return capabilityResult(startedAt, settled.resultKey, "Same provider/model unavailable; no fallback used");
  }
  const reserved = run.execution_status === "reserved"
    || (Boolean(input.extraction_profile) && run.execution_status === "running")
    || await reserveBudget(ctx, input, Date.now());
  if (!reserved) {
    const settled = await settleRun(ctx, input, "budget_exhausted", { errorCode: "monthly_token_budget_exhausted" });
    return capabilityResult(startedAt, settled.resultKey, "Memory extraction monthly budget exhausted");
  }
  await ctx.env.OPEN_BRAIN_DB.prepare(
    `UPDATE memory_extraction_runs SET execution_status = 'running', started_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND execution_status = 'reserved'`
  ).bind(Date.now(), Date.now(), ctx.tenantId, input.run_id).run();
  if (input.extraction_profile) return runCoverageExtraction(ctx, input, key, startedAt);
  try {
    const existingMemories = await loadExistingMemoryCandidates(ctx, input);
    const enrichedInput = withBoundedExistingMemories(input, existingMemories);
    const prompt = compactPrompt(enrichedInput);
    const generated = await generate(ctx.env, enrichedInput, prompt, key);
    if (
      (generated.inputTokens !== null && generated.inputTokens > MAX_INPUT_TOKENS) ||
      (generated.outputTokens !== null && generated.outputTokens > MAX_OUTPUT_TOKENS)
    ) {
      const settled = await settleRun(ctx, input, "provider_failed", {
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        chargedTokens: LEGACY_RESERVED_TOKENS,
        errorCode: "provider_usage_ceiling_exceeded"
      });
      return capabilityResult(startedAt, settled.resultKey, "Memory extraction provider_failed", generated.inputTokens ?? 0, generated.outputTokens ?? 0);
    }
    const verification = await verifiedCandidates(enrichedInput, generated.candidates);
    const candidates = verification.candidates;
    const usageKnown = generated.inputTokens !== null && generated.outputTokens !== null;
    const charged = usageKnown ? generated.inputTokens! + generated.outputTokens! : LEGACY_RESERVED_TOKENS;
    const outcome = candidates.length > 0 ? "succeeded" : "no_candidate";
    const settled = await settleRun(ctx, input, outcome, {
      candidates,
      verificationRejections: verification.rejections,
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
      chargedTokens: Math.min(LEGACY_RESERVED_TOKENS, charged)
    });
    return capabilityResult(startedAt, settled.resultKey, `Memory extraction ${outcome}`, generated.inputTokens ?? 0, generated.outputTokens ?? 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = message.startsWith("outcome_unknown:") ? "outcome_unknown" : "provider_failed";
    const settled = await settleRun(ctx, input, outcome, { chargedTokens: LEGACY_RESERVED_TOKENS, errorCode: message.slice(0, 160) });
    return capabilityResult(startedAt, settled.resultKey, `Memory extraction ${outcome}`);
  }
}

export const __memoryExtractionInternals = {
  parseInput,
  loadExistingMemoryCandidates,
  withBoundedExistingMemories,
  providerEntry,
  tierLimit,
  compactPrompt,
  verifiedCandidates,
  outputJsonSchema,
  RESERVED_TOKENS: LEGACY_RESERVED_TOKENS,
  COVERAGE_RESERVED_TOKENS,
  coverageAllowed,
  coverageRequestPacket,
  executeCoveragePass,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS
};
