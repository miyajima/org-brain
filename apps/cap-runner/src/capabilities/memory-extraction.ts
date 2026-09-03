import {
  assertMemoryExtractionInputWithinCeiling,
  buildMemoryExtractionPrompt,
  MEMORY_EXTRACTION_MAX_CANDIDATES,
  MEMORY_EXTRACTION_MAX_INPUT_TOKENS,
  MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACTION_OUTPUT_SCHEMA,
  MEMORY_EXTRACTION_TOKEN_PROFILE,
  MEMORY_CONTRACT_V2_CONTRACT_HASH,
  MEMORY_CONTRACT_V2_PROMPT_HASH,
  MEMORY_CONTRACT_V2_PROMPT_ID,
  MEMORY_CONTRACT_V2_VERIFIER_VERSION,
  normalizeMemoryContractV2Event,
  sha256,
  ulid
} from "@org-brain/shared";
import type { CapabilityContext, CapabilityResult, Env } from "../types";

const RESERVED_TOKENS = 2_800;
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
  capsule_expires_at: number;
  packet: {
    schema: string;
    snippets: Array<{ span_id: string; role: string; text: string; text_hash?: string }>;
    events: Array<Record<string, unknown>>;
    rule_proposals: Array<{ lesson_type: string; support_span_ids: string[]; gaps: string[]; observation?: Record<string, unknown> }>;
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
  const limits = asRecord(packet.limits);
  const provider = requiredString(value.provider, "provider", 32);
  if (!(["openai", "gemini", "anthropic"] as string[]).includes(provider)) throw new Error("invalid memory extraction input: provider");
  const tier = requiredString(value.tier ?? "tier2", "tier", 16);
  if (!(["tier2", "tier3"] as string[]).includes(tier)) throw new Error("invalid memory extraction input: tier");
  const tenantId = requiredString(value.tenant_id, "tenant_id", 128);
  if (tenantId !== ctx.tenantId) throw new Error("memory extraction tenant mismatch");
  if (value.schema_version !== 1 || packet.schema !== "learning-extraction-proposal/v1") throw new Error("invalid memory extraction schema");
  if (packet.provider !== provider || packet.model !== value.model) throw new Error("invalid memory extraction input: provider/model mismatch");
  if (packet.session_hash !== value.session_hash || packet.turn_hash !== value.turn_hash) throw new Error("invalid memory extraction input: turn identity mismatch");
  if (limits.input_tokens !== MAX_INPUT_TOKENS || limits.output_tokens !== MAX_OUTPUT_TOKENS || limits.candidates !== MAX_CANDIDATES || limits.calls !== 1) {
    throw new Error("invalid memory extraction limits");
  }
  const snippets = Array.isArray(packet.snippets) ? packet.snippets.slice(0, 8).map((item, index) => {
    const row = asRecord(item);
    return {
      span_id: requiredString(row.span_id, `packet.snippets[${index}].span_id`, 128),
      role: requiredString(row.role, `packet.snippets[${index}].role`, 32),
      text: requiredString(row.text, `packet.snippets[${index}].text`, 4_000),
      ...(typeof row.text_hash === "string" ? { text_hash: row.text_hash.slice(0, 80) } : {})
    };
  }) : [];
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
    capsule_expires_at: Number(value.capsule_expires_at),
    packet: {
      schema: packet.schema as string,
      snippets,
      events: Array.isArray(packet.events) ? packet.events.slice(0, 24).map(asRecord) : [],
      rule_proposals: ruleProposals,
      limits: { input_tokens: MAX_INPUT_TOKENS, output_tokens: MAX_OUTPUT_TOKENS, candidates: MAX_CANDIDATES, calls: 1 }
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
  return input;
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
    ).bind(ctx.tenantId, input.run_id, month, input.tier, RESERVED_TOKENS, now, ctx.tenantId, month, input.tier, RESERVED_TOKENS),
    ctx.env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_extraction_token_buckets
       SET reserved_tokens = reserved_tokens + ?, updated_at = ?
       WHERE tenant_id = ? AND utc_month = ? AND tier = ?
         AND EXISTS (
           SELECT 1 FROM memory_extraction_token_reservations r
           WHERE r.tenant_id = ? AND r.run_id = ? AND r.applied = 0
         )`
    ).bind(RESERVED_TOKENS, now, ctx.tenantId, month, input.tier, ctx.tenantId, input.run_id),
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
    ).bind(RESERVED_TOKENS, now, ctx.tenantId, input.run_id, ctx.tenantId, input.run_id)
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
  return { candidates: rows.slice(0, MAX_CANDIDATES) as ProviderCandidate[], ...usage(response) };
}

function exactGrounded(value: unknown, evidenceText: string, gaps: string[], field: string): string | null {
  if (value === null || typeof value !== "string" || !value.trim()) return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const haystack = evidenceText.normalize("NFKC").replace(/\s+/gu, " ");
  if (haystack.includes(normalized)) return normalized;
  gaps.push(`${field}_unsupported`);
  return null;
}

function providerFields(raw: ProviderCandidate): Map<string, string[]> {
  const output = new Map<string, string[]>();
  for (const field of Array.isArray(raw.fields) ? raw.fields : []) {
    if (!field || typeof field.name !== "string" || !Array.isArray(field.values)) continue;
    const values = field.values.filter((value): value is string => typeof value === "string").slice(0, 16);
    if (values.length > 0) output.set(field.name, [...(output.get(field.name) ?? []), ...values].slice(0, 16));
  }
  return output;
}

function inferredDecisionType(evidenceText: string): "preference" | "implementation" | "governance" | null {
  if (/\b(?:policy|governance|approval|permission|acl|must|never)\b|(?:規約|承認|権限|禁止|必須)/iu.test(evidenceText)) return "governance";
  if (/\b(?:prefer|preference)\b|(?:好む|希望|優先)/iu.test(evidenceText)) return "preference";
  if (/\b(?:api|schema|architecture|implementation|library|framework|database|runtime)\b|(?:API|スキーマ|設計|実装|ライブラリ|フレームワーク|データベース|ランタイム)/iu.test(evidenceText)) return "implementation";
  return null;
}

async function verifiedCandidates(input: ExtractionInput, candidates: ProviderCandidate[]) {
  const snippetIds = new Set(input.packet.snippets.map((item) => item.span_id));
  const eventIds = new Set(input.packet.events.map((item) => String(item.event_id ?? "")).filter(Boolean));
  const resolvesSupportId = (id: string) => eventIds.has(id)
    || [...snippetIds].some((snippetId) => id === snippetId || id.startsWith(`${snippetId}.`));
  const output = [];
  for (const [index, raw] of candidates.entries()) {
    if (!raw || !["success", "decision", "failure"].includes(raw.lesson_type)) continue;
    const supportSpanIds = Array.isArray(raw.support_span_ids)
      ? [...new Set(raw.support_span_ids.filter((id) => typeof id === "string" && resolvesSupportId(id)))].slice(0, 16)
      : [];
    if (supportSpanIds.length === 0) continue;
    const supportedSnippets = input.packet.snippets.filter((item) => supportSpanIds.some((id) => id === item.span_id || id.startsWith(`${item.span_id}.`)));
    const evidenceText = supportedSnippets.map((item) => item.text).join("\n");
    const gaps = Array.isArray(raw.gaps) ? raw.gaps.filter((item) => typeof item === "string").slice(0, 16) : [];
    const fields = providerFields(raw);
    const one = (name: string) => fields.get(name)?.[0] ?? null;
    const many = (name: string) => fields.get(name) ?? [];
    const grounded = (value: string | null, field: string) => exactGrounded(value, evidenceText, gaps, field);
    const decisionType = raw.lesson_type === "decision" ? inferredDecisionType(evidenceText) : null;
    if (raw.lesson_type === "decision" && !decisionType) gaps.push("decision_type_missing");
    if (raw.lesson_type === "decision" && one("decision_type") && one("decision_type") !== decisionType) gaps.push("decision_type_unsupported");
    const common = {
      record_type: "learning_observation",
      schema_version: 2,
      lesson_type: raw.lesson_type,
      capture_intent: "review",
      trigger: grounded(one("trigger"), "trigger"),
      applicability: {
        target_files: many("target_files").flatMap((item) => {
          const value = grounded(item, "target_files");
          return value && !value.startsWith("/") ? [value] : [];
        }),
        components: input.project_id ? [input.project_id] : []
      },
      evidence_selectors: input.packet.snippets.filter((item) => supportSpanIds.some((id) => id === item.span_id || id.startsWith(`${item.span_id}.`))).filter((item) => item.role === "user").map((item) => ({ type: "user_statement", ref: item.text, supports: supportSpanIds.filter((id) => id === item.span_id || id.startsWith(`${item.span_id}.`)) })),
      gaps: [...new Set(gaps)]
    } as Record<string, unknown>;
    if (raw.lesson_type === "success") Object.assign(common, {
      procedure: grounded(one("procedure"), "procedure"),
      why_it_worked: grounded(one("why_it_worked"), "why_it_worked"),
      observed_outcome: grounded(one("observed_outcome"), "observed_outcome"),
      reuse_when: grounded(one("reuse_when"), "reuse_when")
    });
    if (raw.lesson_type === "decision") Object.assign(common, {
      decision_type: decisionType,
      decision_key: `inferred.${(await sha256(`${input.run_id}:${index}`)).slice(0, 24)}`,
      question: grounded(one("question"), "question"),
      selected_value: grounded(one("selected_value"), "selected_value"),
      decision: grounded(one("decision"), "decision"),
      constraints: many("constraints").flatMap((item) => {
        const value = grounded(item, "constraints");
        return value ? [value] : [];
      }),
      rationale: grounded(one("rationale"), "rationale"),
      alternatives: many("alternative").flatMap((item, alternativeIndex) => {
        const alternative = grounded(item, "alternative");
        if (!alternative) return [];
        return [{ alternative, reason_rejected: grounded(many("reason_rejected")[alternativeIndex] ?? null, "reason_rejected") }];
      }),
      reuse_when: grounded(one("reuse_when"), "reuse_when")
    });
    if (raw.lesson_type === "failure") Object.assign(common, {
      symptom: grounded(one("symptom"), "symptom"),
      failed_approach: grounded(one("failed_approach"), "failed_approach"),
      root_cause: grounded(one("root_cause"), "root_cause"),
      correction: grounded(one("correction"), "correction"),
      verified_outcome: grounded(one("verified_outcome"), "verified_outcome"),
      avoidance_rule: grounded(one("avoidance_rule"), "avoidance_rule")
    });
    common.gaps = [...new Set(gaps)];
    const normalized = await normalizeMemoryContractV2Event(common, { sensitivePolicy: { mode: "deny", allowed_principals: [] } });
    if (!normalized.accepted || !normalized.event) continue;
    output.push({
      external_key: `memory-extraction:${input.run_id}:${normalized.event_hash}`,
      observation: normalized.event,
      support_span_ids: supportSpanIds,
      gaps: normalized.event.gaps,
      reason_codes: [...new Set(["llm_proposed_review_only", ...normalized.reason_codes])]
    });
  }
  return output.slice(0, MAX_CANDIDATES);
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
  options: { candidates?: Awaited<ReturnType<typeof verifiedCandidates>>; inputTokens?: number | null; outputTokens?: number | null; chargedTokens?: number; errorCode?: string } = {}
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
      snippets: input.packet.snippets.filter((item) => [...usedSpanIds].some((id) => id === item.span_id || String(id).startsWith(`${item.span_id}.`))),
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
    input_tokens: options.inputTokens ?? null,
    output_tokens: options.outputTokens ?? null,
    charged_tokens: chargedTokens,
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
         charged_tokens = ?, capsule_r2_key = ?, result_r2_key = ?, error_code = ?, settled_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND execution_status <> 'settled'`
  ).bind(
    outcome, options.inputTokens ?? null, options.outputTokens ?? null, chargedTokens,
    capsuleKey, resultKey, options.errorCode ?? null, now, now, ctx.tenantId, input.run_id
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

export async function runMemoryExtraction(ctx: CapabilityContext): Promise<CapabilityResult> {
  const startedAt = Date.now();
  const run = await ctx.env.OPEN_BRAIN_DB.prepare(
    `SELECT id, installation_id, provider, model, packet_hash, contract_hash,
            execution_status, outcome, result_r2_key, tombstoned_at
     FROM memory_extraction_runs WHERE tenant_id = ? AND task_id = ?`
  ).bind(ctx.tenantId, ctx.taskId).first<RunRow>();
  if (!run) throw new Error("memory extraction run not found");
  if (run.tombstoned_at) throw new Error("memory extraction run tombstoned");
  if (run.execution_status === "settled" && run.result_r2_key) {
    return capabilityResult(startedAt, run.result_r2_key, `Memory extraction already settled: ${run.outcome ?? "unknown"}`);
  }
  const input = await readInput(ctx);
  if (input.run_id !== run.id) throw new Error("memory extraction task/run mismatch");
  if (input.installation_id !== run.installation_id
    || input.provider !== run.provider
    || input.model !== run.model
    || input.packet_hash !== run.packet_hash
    || input.contract_hash !== run.contract_hash) {
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
  if (run.execution_status === "running") {
    const settled = await settleRun(ctx, input, "outcome_unknown", { chargedTokens: RESERVED_TOKENS, errorCode: "redelivery_after_running" });
    return capabilityResult(startedAt, settled.resultKey, "Memory extraction outcome unknown after redelivery");
  }
  const key = providerKey(ctx.env, input);
  if (!key) {
    const settled = await settleRun(ctx, input, "model_unavailable", { errorCode: "same_model_not_allowlisted" });
    return capabilityResult(startedAt, settled.resultKey, "Same provider/model unavailable; no fallback used");
  }
  const reserved = run.execution_status === "reserved" || await reserveBudget(ctx, input, Date.now());
  if (!reserved) {
    const settled = await settleRun(ctx, input, "budget_exhausted", { errorCode: "monthly_token_budget_exhausted" });
    return capabilityResult(startedAt, settled.resultKey, "Memory extraction monthly budget exhausted");
  }
  await ctx.env.OPEN_BRAIN_DB.prepare(
    `UPDATE memory_extraction_runs SET execution_status = 'running', started_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND execution_status = 'reserved'`
  ).bind(Date.now(), Date.now(), ctx.tenantId, input.run_id).run();
  try {
    const prompt = compactPrompt(input);
    const generated = await generate(ctx.env, input, prompt, key);
    if (
      (generated.inputTokens !== null && generated.inputTokens > MAX_INPUT_TOKENS) ||
      (generated.outputTokens !== null && generated.outputTokens > MAX_OUTPUT_TOKENS)
    ) {
      const settled = await settleRun(ctx, input, "provider_failed", {
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        chargedTokens: RESERVED_TOKENS,
        errorCode: "provider_usage_ceiling_exceeded"
      });
      return capabilityResult(startedAt, settled.resultKey, "Memory extraction provider_failed", generated.inputTokens ?? 0, generated.outputTokens ?? 0);
    }
    const candidates = await verifiedCandidates(input, generated.candidates);
    const usageKnown = generated.inputTokens !== null && generated.outputTokens !== null;
    const charged = usageKnown ? generated.inputTokens! + generated.outputTokens! : RESERVED_TOKENS;
    const outcome = candidates.length > 0 ? "succeeded" : "no_candidate";
    const settled = await settleRun(ctx, input, outcome, {
      candidates,
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
      chargedTokens: Math.min(RESERVED_TOKENS, charged)
    });
    return capabilityResult(startedAt, settled.resultKey, `Memory extraction ${outcome}`, generated.inputTokens ?? 0, generated.outputTokens ?? 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = message.startsWith("outcome_unknown:") ? "outcome_unknown" : "provider_failed";
    const settled = await settleRun(ctx, input, outcome, { chargedTokens: RESERVED_TOKENS, errorCode: message.slice(0, 160) });
    return capabilityResult(startedAt, settled.resultKey, `Memory extraction ${outcome}`);
  }
}

export const __memoryExtractionInternals = {
  parseInput,
  providerEntry,
  tierLimit,
  compactPrompt,
  verifiedCandidates,
  outputJsonSchema,
  RESERVED_TOKENS,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS
};
