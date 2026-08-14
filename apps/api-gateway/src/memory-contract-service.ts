import {
  HttpError,
  MEMORY_CONTRACT_V2_CONTRACT_HASH,
  MEMORY_CONTRACT_V2_PROMPT_HASH,
  MEMORY_CONTRACT_V2_PROMPT_ID,
  MEMORY_CONTRACT_V2_VERIFIER_VERSION,
  normalizeMemoryContractV2Event,
  sha256,
  isAiConsensusCertified,
  normalizeMemoryPaths,
  screenSensitiveMemory,
  type MemoryWorkType
} from "@org-brain/shared";
import type { Env } from "./types";
import { captureMemoryWithInferredRationale } from "./rationale-service";
import { upsertAutoDecisionMemory } from "./context-engine-service";
import { screenMemoryWriteText } from "./memory-screening-service";

const COMMITMENT_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const FORBIDDEN_CANDIDATE_KEYS = new Set([
  "rawtranscript", "transcript", "prompttext", "responsetext", "reasoning", "rawreasoning",
  "privatereasoning", "chainofthought", "analysis"
]);

function isForbiddenCandidateKey(key: string) {
  return FORBIDDEN_CANDIDATE_KEYS.has(key.replace(/[_-]/gu, "").toLocaleLowerCase());
}

type CommitmentInput = {
  record_type?: "task_commitment";
  schema_version?: 1;
  tenant_id?: string;
  project_id?: string | null;
  task_key: string;
  decision_key: string;
  question_fingerprint: string;
  question: string;
  answer: { option_id?: string | null; label: string; raw?: string | null };
  authority?: "explicit_user";
  confirmation_state?: "user_confirmed" | "user_corrected";
  ask_policy?: "reuse_until_superseded";
  evidence: { type: "request_user_input_result"; digest: string };
  created_at?: number;
  expires_at?: number | null;
};

type LearningBatchInput = {
  tenant_id?: string;
  project_id?: string | null;
  task_key?: string | null;
  source?: string;
  prompt_contract_id?: string;
  prompt_hash?: string;
  contract_hash?: string;
  verifier_version?: string;
  commitments?: CommitmentInput[];
  verified_items?: Array<Record<string, unknown>>;
  deterministically_verified_items?: Array<Record<string, unknown>>;
  review_candidates?: Array<Record<string, unknown>>;
  semantic_aliases?: Array<Record<string, unknown>>;
};

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stableValue((value as Record<string, unknown>)[key])]));
}

function contractLearningProjection(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const projection = { ...(value as Record<string, unknown>) };
  delete projection.contract_metadata;
  return stableValue(projection);
}

function text(value: unknown, limit = 2_000): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, limit);
}

function redactCandidateValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeMemoryPaths(value, null);
  if (Array.isArray(value)) return value.map(redactCandidateValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isForbiddenCandidateKey(key))
    .map(([key, item]) => [key, redactCandidateValue(item)]));
}

function sanitizeCandidate(candidate: Record<string, unknown>) {
  const normalized = redactCandidateValue(candidate);
  const screened = screenSensitiveMemory(JSON.stringify(normalized), {
    mode: "restricted_7d",
    allowed_principals: ["orgbrain-learning-review"]
  });
  if (!screened.allowed) throw new HttpError(400, screened.reason ?? "candidate_sensitive_content", "learning candidate contains prohibited sensitive content");
  try {
    return JSON.parse(screened.text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "candidate_serialization_invalid", "learning candidate could not be safely serialized");
  }
}

function tenantIdFrom(input: { tenant_id?: string }, fallback = "default") {
  const value = text(input.tenant_id ?? fallback, 128);
  if (!value) throw new HttpError(400, "tenant_required", "tenant_id is required");
  return value;
}

function projectScope(input: { project_id?: string | null }) {
  const value = input.project_id == null ? null : text(input.project_id, 128);
  return value || null;
}

function commitmentJson(row: Record<string, unknown>, semanticAliases: Array<Record<string, unknown>> = []) {
  return {
    record_type: "task_commitment",
    schema_version: 1,
    id: row.id,
    task_key: row.task_key,
    decision_key: row.decision_key,
    question_fingerprint: row.question_fingerprint,
    question: row.question,
    answer: parseJson(row.answer_json as string, { label: "(answer unavailable)" }),
    authority: row.authority,
    confirmation_state: row.confirmation_state,
    ask_policy: row.ask_policy,
    scope: { level: "task", project_id: row.project_id ?? null },
    evidence: { type: row.evidence_type, digest: row.evidence_digest },
    semantic_aliases: semanticAliases,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    superseded_at: row.superseded_at
  };
}

function normalizedCommitment(input: CommitmentInput, tenantId: string, projectId: string | null) {
  const taskKey = text(input.task_key, 256);
  const decisionKey = text(input.decision_key, 160).toLocaleLowerCase().replace(/[^a-z0-9._:-]+/gu, "_");
  const question = screenMemoryWriteText(text(input.question, 1_000), "task_commitment.question");
  const label = screenMemoryWriteText(text(input.answer?.label ?? input.answer?.raw, 500), "task_commitment.answer");
  if (!taskKey || !decisionKey || !question || !label) throw new HttpError(400, "invalid_task_commitment", "task commitment identity and answer are required");
  if (!/^sha256:[a-f0-9]{64}$/iu.test(text(input.question_fingerprint, 80))) throw new HttpError(400, "invalid_question_fingerprint", "question_fingerprint must be sha256");
  if (!/^sha256:[a-f0-9]{64}$/iu.test(text(input.evidence?.digest, 80))) throw new HttpError(400, "invalid_evidence_digest", "evidence.digest must be sha256");
  return {
    tenantId,
    projectId,
    taskKey,
    decisionKey,
    questionFingerprint: text(input.question_fingerprint, 80).toLowerCase(),
    question,
    answer: { option_id: input.answer?.option_id ?? null, label, raw: input.answer?.raw ? screenMemoryWriteText(text(input.answer.raw, 500), "task_commitment.answer_raw") : null },
    evidenceDigest: text(input.evidence.digest, 80).toLowerCase(),
    createdAt: Number.isFinite(input.created_at) ? Number(input.created_at) : Date.now(),
    expiresAt: input.expires_at === null ? null : (Number.isFinite(input.expires_at) ? Number(input.expires_at) : Date.now() + COMMITMENT_TTL_MS),
    confirmationState: input.confirmation_state === "user_corrected" ? "user_corrected" : "user_confirmed"
  };
}

export async function upsertTaskCommitment(env: Env, input: CommitmentInput, options: { tenantId?: string } = {}) {
  const tenantId = options.tenantId ?? tenantIdFrom(input);
  const projectId = projectScope(input);
  const normalized = normalizedCommitment(input, tenantId, projectId);
  const now = Date.now();
  const existing = await env.OPEN_BRAIN_DB.prepare(
    `SELECT * FROM task_commitments
     WHERE tenant_id = ? AND task_key = ? AND decision_key = ? AND superseded_at IS NULL
     ORDER BY version DESC LIMIT 1`
  ).bind(tenantId, normalized.taskKey, normalized.decisionKey).first<Record<string, unknown>>();
  const answerJson = JSON.stringify(normalized.answer);
  if (existing && existing.question_fingerprint === normalized.questionFingerprint && existing.answer_json === answerJson && (!existing.expires_at || Number(existing.expires_at) > now)) {
    return { created: false, changed: false, commitment: commitmentJson(existing) };
  }
  const versionRow = await env.OPEN_BRAIN_DB.prepare(
    "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM task_commitments WHERE tenant_id = ? AND task_key = ? AND decision_key = ?"
  ).bind(tenantId, normalized.taskKey, normalized.decisionKey).first<{ version: number }>();
  const version = Number(versionRow?.version ?? 1);
  const id = `commitment:${(await sha256(`${tenantId}\0${normalized.taskKey}\0${normalized.decisionKey}\0${version}\0${answerJson}`)).slice(0, 40)}`;
  const statements = [];
  if (existing) statements.push(env.OPEN_BRAIN_DB.prepare("UPDATE task_commitments SET superseded_at = ?, updated_at = ? WHERE id = ?").bind(now, now, existing.id));
  statements.push(env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO task_commitments(
      id, tenant_id, project_id, task_key, decision_key, question_fingerprint,
      question, answer_json, authority, confirmation_state, ask_policy,
      evidence_type, evidence_digest, version, created_at, updated_at, expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, tenantId, normalized.projectId, normalized.taskKey, normalized.decisionKey,
    normalized.questionFingerprint, normalized.question, answerJson, "explicit_user",
    normalized.confirmationState, "reuse_until_superseded", "request_user_input_result",
    normalized.evidenceDigest, version, normalized.createdAt, now, normalized.expiresAt
  ));
  await env.OPEN_BRAIN_DB.batch(statements);
  const created = await env.OPEN_BRAIN_DB.prepare("SELECT * FROM task_commitments WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return { created: true, changed: Boolean(existing), commitment: commitmentJson(created ?? {}) };
}

export async function saveTaskCommitmentSemanticAlias(
  env: Env,
  input: {
    tenant_id?: string;
    project_id?: string | null;
    task_key: string;
    decision_key: string;
    question: string;
    ai_certification: string;
    judge_consensus: Record<string, unknown>;
  },
  options: { tenantId?: string } = {}
) {
  const tenantId = options.tenantId ?? tenantIdFrom(input);
  if (!isAiConsensusCertified({ ai_certification: input.ai_certification, judge_consensus: input.judge_consensus })) {
    throw new HttpError(409, "semantic_alias_ai_consensus_required", "semantic aliases require unanimous certified judges");
  }
  const projectId = projectScope(input);
  const taskKey = text(input.task_key, 256);
  const decisionKey = text(input.decision_key, 160).toLocaleLowerCase().replace(/[^a-z0-9._:-]+/gu, "_");
  const question = screenMemoryWriteText(text(input.question, 1_000), "task_commitment.semantic_alias");
  if (!taskKey || !decisionKey || !question) throw new HttpError(400, "semantic_alias_identity_missing", "semantic alias identity is required");
  const now = Date.now();
  const active = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id FROM task_commitments
     WHERE tenant_id = ? AND task_key = ? AND decision_key = ? AND superseded_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
       AND ((project_id IS NULL AND ? IS NULL) OR (project_id = ?))
     ORDER BY version DESC LIMIT 1`
  ).bind(tenantId, taskKey, decisionKey, now, projectId, projectId).first<{ id: string }>();
  if (!active?.id) throw new HttpError(404, "task_commitment_not_found", "no active task commitment exists for the semantic alias");
  const aliasFingerprint = `sha256:${await sha256(question.toLocaleLowerCase().replace(/\s+/gu, " ").trim())}`;
  const promptHash = String((input.judge_consensus.judgments as Array<Record<string, unknown>>)[0].prompt_hash);
  const id = `commitment-alias:${await sha256(`${tenantId}\0${taskKey}\0${decisionKey}\0${aliasFingerprint}`)}`.slice(0, 64);
  await env.OPEN_BRAIN_DB.prepare(
    `INSERT INTO task_commitment_semantic_aliases(
      id, tenant_id, project_id, task_key, decision_key, commitment_id,
      alias_fingerprint, alias_question, certification, prompt_hash,
      verifier_version, created_at, expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id, task_key, decision_key, alias_fingerprint) DO UPDATE SET
      commitment_id = excluded.commitment_id,
      alias_question = excluded.alias_question,
      certification = excluded.certification,
      prompt_hash = excluded.prompt_hash,
      verifier_version = excluded.verifier_version,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at`
  ).bind(
    id, tenantId, projectId, taskKey, decisionKey, active.id,
    aliasFingerprint, question, input.ai_certification, promptHash,
    MEMORY_CONTRACT_V2_VERIFIER_VERSION, now, now + COMMITMENT_TTL_MS
  ).run();
  return { saved: true, id, alias_fingerprint: aliasFingerprint };
}

export async function getTaskCommitmentContext(env: Env, input: { tenant_id?: string; project_id?: string | null; task_key?: string; query?: string }) {
  const tenantId = tenantIdFrom(input);
  const projectId = projectScope(input);
  const taskKey = text(input.task_key, 256);
  if (!taskKey) throw new HttpError(400, "task_key_required", "task_key is required");
  const now = Date.now();
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT * FROM task_commitments
     WHERE tenant_id = ? AND task_key = ? AND superseded_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
       AND ((? IS NULL AND project_id IS NULL) OR (? IS NOT NULL AND project_id = ?))
     ORDER BY updated_at DESC, decision_key ASC LIMIT 64`
  ).bind(tenantId, taskKey, now, projectId, projectId, projectId).all<Record<string, unknown>>();
  let aliasRows: Array<Record<string, unknown>> = [];
  try {
    const aliases = await env.OPEN_BRAIN_DB.prepare(
      `SELECT a.alias_fingerprint, a.alias_question, a.certification,
              a.prompt_hash, a.verifier_version, a.created_at, a.expires_at,
              a.decision_key, a.task_key
       FROM task_commitment_semantic_aliases a
       JOIN task_commitments c ON c.id = a.commitment_id
       WHERE a.tenant_id = ? AND a.task_key = ? AND a.expires_at > ?
         AND c.superseded_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?)
         AND ((a.project_id IS NULL AND ? IS NULL) OR (a.project_id = ?))
       ORDER BY a.created_at ASC`
    ).bind(tenantId, taskKey, now, now, projectId, projectId).all<Record<string, unknown>>();
    aliasRows = aliases.results ?? [];
  } catch {
    // Keep old deployments readable while migration 0031 is rolling out.
  }
  const aliasesByKey = new Map<string, Array<Record<string, unknown>>>();
  for (const alias of aliasRows) {
    const key = `${alias.task_key}\0${alias.decision_key}`;
    const list = aliasesByKey.get(key) ?? [];
    list.push({
      alias_fingerprint: alias.alias_fingerprint,
      question: alias.alias_question,
      certification: alias.certification,
      prompt_hash: alias.prompt_hash,
      verifier_version: alias.verifier_version,
      created_at: alias.created_at,
      expires_at: alias.expires_at
    });
    aliasesByKey.set(key, list);
  }
  return {
    task_key: taskKey,
    project_id: projectId,
    commitments: (rows.results ?? []).map((row) => commitmentJson(row, aliasesByKey.get(`${row.task_key}\0${row.decision_key}`) ?? [])),
    generated_at: now
  };
}

async function candidateExternalKey(candidate: Record<string, unknown>) {
  return text(candidate.external_key ?? `learning-review:${await sha256(JSON.stringify(stableValue(candidate)))}`, 256);
}

function candidateEvidence(candidate: Record<string, unknown>) {
  const observation = candidate.observation && typeof candidate.observation === "object"
    ? candidate.observation as Record<string, unknown>
    : {};
  const verification = candidate.verification && typeof candidate.verification === "object"
    ? candidate.verification as Record<string, unknown>
    : {};
  const item = candidate.item && typeof candidate.item === "object" ? candidate.item as Record<string, unknown> : {};
  const selectors = Array.isArray(observation.evidence_selectors) ? observation.evidence_selectors : [];
  const verified = Array.isArray(verification.evidence) ? verification.evidence : [];
  const itemEvidence = Array.isArray(item.evidence) ? item.evidence : [];
  const source = verified.length > 0 ? verified : itemEvidence.length > 0 ? itemEvidence : selectors;
  return source.slice(0, 16).map((entry) => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return {
      evidenceType: text(item.evidence_type ?? item.type ?? "external", 64),
      evidenceRef: text(item.evidence_ref ?? item.ref, 512) || null,
      digest: text(item.content_hash ?? item.digest ?? item.command_hash, 128) || null,
      diffHash: text(item.diff_hash ?? item.diffHash, 128) || null,
      supports: Array.isArray(item.supports) ? item.supports.map((value) => text(value, 128)).filter(Boolean).slice(0, 12) : [],
      verificationState: text(item.verification_state ?? item.state ?? verification.verification_state ?? verification.state ?? "unverified", 64) || "unverified"
    };
  });
}

function assertVerifiedItem(item: Record<string, unknown>, index: number) {
  const verification = item.verification && typeof item.verification === "object"
    ? item.verification as Record<string, unknown>
    : {};
  if (verification.state !== "verified") {
    throw new HttpError(400, "verified_item_not_verified", `verified_items[${index}] is not deterministically verified`);
  }
  if (!isAiConsensusCertified(item)) {
    throw new HttpError(409, "ai_consensus_required", `verified_items[${index}] requires unanimous ai_consensus_certified judges`);
  }
  if (!candidateIdFrom(item)) {
    throw new HttpError(409, "candidate_backing_required", `verified_items[${index}] must reference a stored learning candidate`);
  }
  const evidence = item.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new HttpError(400, "verified_item_evidence_missing", `verified_items[${index}] has no admissible evidence`);
  }
  const learning = item.learning && typeof item.learning === "object"
    ? item.learning as Record<string, unknown>
    : null;
  if (learning?.schema_version !== 2) {
    throw new HttpError(409, "legacy_learning_candidate_only", `verified_items[${index}] must use LearningObservationV2; legacy observations remain review-only`);
  }
  if (learning.capture_intent !== "verify") {
    throw new HttpError(400, "verified_item_intent_invalid", `verified_items[${index}] is not a verify observation`);
  }
  if (learning.lesson_type === "decision" && ["user_choice", "preference"].includes(String(learning.decision_type))) {
    throw new HttpError(409, "task_commitment_required", `verified_items[${index}] is a task commitment, not active project knowledge`);
  }
}

function candidateIdFrom(item: Record<string, unknown>) {
  const learning = item.learning && typeof item.learning === "object" ? item.learning as Record<string, unknown> : {};
  const metadata = learning.contract_metadata && typeof learning.contract_metadata === "object" ? learning.contract_metadata as Record<string, unknown> : {};
  return text(item.candidate_id ?? metadata.candidate_id, 256);
}

async function assertCandidateBacked(env: Env, tenantId: string, projectId: string | null, item: Record<string, unknown>, index: number) {
  const candidateId = candidateIdFrom(item);
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT project_id, status, payload_json FROM memory_learning_candidates WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, candidateId).first<{ project_id: string | null; status: string; payload_json: string }>();
  if (!row || !["review", "verified"].includes(row.status)) {
    throw new HttpError(409, "candidate_backing_missing", `verified_items[${index}] does not reference an active review candidate`);
  }
  const itemProjectId = projectScope({ project_id: typeof item.project_id === "string" ? item.project_id : null });
  const expectedProjectId = projectId ?? itemProjectId;
  if ((row.project_id ?? null) !== expectedProjectId) {
    throw new HttpError(409, "candidate_scope_mismatch", `verified_items[${index}] does not match its stored project scope`);
  }
  const stored = parseJson<Record<string, unknown>>(row.payload_json, {});
  const storedItem = stored.item && typeof stored.item === "object" ? stored.item as Record<string, unknown> : stored;
  const submittedExternalKey = text(item.external_key, 256);
  const storedExternalKey = text(storedItem.external_key, 256);
  if (submittedExternalKey && storedExternalKey && submittedExternalKey !== storedExternalKey) {
    throw new HttpError(409, "candidate_backing_mismatch", `verified_items[${index}] does not match its stored candidate`);
  }
  const storedLearning = storedItem.learning ?? stored.observation;
  const submittedLearning = item.learning;
  if (!storedLearning || !submittedLearning || JSON.stringify(contractLearningProjection(storedLearning)) !== JSON.stringify(contractLearningProjection(submittedLearning))) {
    throw new HttpError(409, "candidate_learning_mismatch", `verified_items[${index}] changed the candidate semantic claim before promotion`);
  }
}

function isFormalContractDecision(item: Record<string, unknown>) {
  const learning = item.learning && typeof item.learning === "object" ? item.learning as Record<string, unknown> : {};
  return learning.schema_version === 2 && learning.lesson_type === "decision" && ["implementation", "governance"].includes(String(learning.decision_type));
}

function contractDecisionEvidence(item: Record<string, unknown>, candidateId: string) {
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  return [
    ...evidence.slice(0, 16).map((entry) => {
      const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const ref = text(row.evidence_ref ?? row.ref, 512);
      return {
        type: text(row.evidence_type ?? row.type ?? "external", 64),
        ref,
        title: text(row.note, 240) || undefined,
        ...(row.content_hash ? { id: text(row.content_hash, 128) } : {})
      };
    }),
    { type: "learning_candidate", ref: candidateId, title: "source candidate" }
  ].filter((entry) => entry.ref);
}

async function captureFormalContractDecision(env: Env, tenantId: string, item: Record<string, unknown>, principal: string | undefined) {
  const learning = item.learning as Record<string, unknown>;
  const metadata = learning.contract_metadata && typeof learning.contract_metadata === "object" ? learning.contract_metadata as Record<string, unknown> : {};
  const candidateId = text(item.candidate_id ?? metadata.candidate_id, 256);
  const decision = text(learning.selected_value ?? learning.decision, 1_000);
  const rationale = text(learning.rationale, 2_000);
  if (!decision || !rationale) throw new HttpError(400, "formal_decision_fields_missing", "a formal contract decision requires decision and rationale");
  const alternatives = Array.isArray(learning.alternatives) ? learning.alternatives : [];
  const constraints = Array.isArray(learning.constraints) ? learning.constraints.map((value) => text(value, 500)).filter(Boolean) : [];
  const result = await upsertAutoDecisionMemory(env, {
    tenantId,
    memoryId: null,
    source: "orgbrain-learning-contract",
    externalKey: candidateId,
    projectId: typeof item.project_id === "string" ? item.project_id : null,
    businessCategoryId: typeof item.business_category_id === "string" ? item.business_category_id : null,
    workType: typeof item.work_type === "string" ? item.work_type as MemoryWorkType : "other",
    kind: "decision",
    title: text(learning.question ?? learning.decision_key ?? decision, 240),
    decision,
    rationale,
    evidence: contractDecisionEvidence(item, candidateId).map((entry) => ({ evidence_type: entry.type, evidence_ref: entry.ref, note: entry.title ?? null })),
    sourceReferences: alternatives.slice(0, 16).map((entry) => ({
      type: "rejected_alternative",
      ref: text(entry && typeof entry === "object" ? (entry as Record<string, unknown>).alternative : entry, 512),
      title: text(entry && typeof entry === "object" ? (entry as Record<string, unknown>).reason_rejected : "", 240) || undefined
    })).filter((entry) => entry.ref),
    validFrom: Number(item.created_at) || Date.now(),
    validUntil: Number(item.valid_until) || null,
    confidence: 0.95,
    visibility: item.visibility === "restricted" ? "restricted" : item.project_id ? "project" : "tenant",
    allowedPrincipals: Array.isArray(item.allowed_principals) ? item.allowed_principals.map((value) => text(value, 128)).filter(Boolean) : [],
    principal: principal ?? null,
    certified: true
  });
  return result;
}

async function persistJudgeResults(env: Env, tenantId: string, item: Record<string, unknown>) {
  const consensus = item.judge_consensus && typeof item.judge_consensus === "object"
    ? item.judge_consensus as Record<string, unknown>
    : item.learning && typeof item.learning === "object" && (item.learning as Record<string, unknown>).contract_metadata && typeof (item.learning as Record<string, unknown>).contract_metadata === "object"
      ? ((item.learning as Record<string, unknown>).contract_metadata as Record<string, unknown>).judge_consensus as Record<string, unknown> | undefined
      : undefined;
  const candidateMetadata = item.learning && typeof item.learning === "object" && (item.learning as Record<string, unknown>).contract_metadata && typeof (item.learning as Record<string, unknown>).contract_metadata === "object"
    ? (item.learning as Record<string, unknown>).contract_metadata as Record<string, unknown>
    : {};
  const candidateId = text(item.candidate_id ?? candidateMetadata.candidate_id ?? "", 256);
  const judgments = Array.isArray(consensus?.judgments) ? consensus.judgments : [];
  if (!candidateId || judgments.length === 0) return;
  const certified = isAiConsensusCertified(item);
  const now = Date.now();
  for (const judgment of judgments.slice(0, 3)) {
    const row = judgment && typeof judgment === "object" ? judgment as Record<string, unknown> : {};
    const judgeName = text(row.judge_name, 128);
    const promptHash = text(row.prompt_hash ?? MEMORY_CONTRACT_V2_PROMPT_HASH, 80).toLowerCase();
    if (!judgeName || promptHash !== MEMORY_CONTRACT_V2_PROMPT_HASH) throw new HttpError(409, "judge_prompt_hash_mismatch", "judge result prompt hash does not match the deployed contract");
    const id = `judge:${(await sha256(`${tenantId}\0${candidateId}\0${judgeName}\0${promptHash}`)).slice(0, 40)}`;
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_learning_judgments(
        id, tenant_id, candidate_id, judge_name, judge_model, prompt_hash,
        verdict, reason_codes_json, support_json, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        judge_model = excluded.judge_model,
        verdict = excluded.verdict,
        reason_codes_json = excluded.reason_codes_json,
        support_json = excluded.support_json,
        created_at = excluded.created_at`
    ).bind(
      id,
      tenantId,
      candidateId,
      judgeName,
      text(row.judge_model ?? row.model_family, 128) || "unknown",
      promptHash,
      row.verdict === "pass" ? "pass" : row.verdict === "fail" ? "fail" : "error",
      JSON.stringify(Array.isArray(row.reason_codes) ? row.reason_codes.slice(0, 16) : []),
      JSON.stringify(Array.isArray(row.support) ? row.support.slice(0, 16) : []),
      now
    ).run();
  }
  await env.OPEN_BRAIN_DB.prepare(
    "UPDATE memory_learning_candidates SET status = 'verified', reviewed_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND ? = 'ai_consensus_certified'"
  ).bind(now, now, tenantId, candidateId, certified ? "ai_consensus_certified" : "").run();
}

function learningObservationFromCandidate(candidate: Record<string, unknown>) {
  const item = candidate.item && typeof candidate.item === "object" ? candidate.item as Record<string, unknown> : {};
  const learning = candidate.observation ?? candidate.learning ?? item.learning ?? item.observation;
  if (!learning || typeof learning !== "object" || Array.isArray(learning)) return null;
  const semantic = { ...(learning as Record<string, unknown>) };
  delete semantic.contract_metadata;
  // These are derived legacy projections added by the hook after the AI
  // observation is normalized; they are not producer-owned v2 input fields.
  delete semantic.kind;
  delete semantic.conclusion;
  delete semantic.reuse_rule;
  delete semantic.outcome;
  return semantic;
}

async function validateReviewCandidate(candidate: Record<string, unknown>, index: number) {
  const observation = learningObservationFromCandidate(candidate);
  if (!observation || observation.schema_version !== 2) return;
  const normalized = await normalizeMemoryContractV2Event(observation, {
    sensitivePolicy: { mode: "deny", allowed_principals: [] }
  });
  if (!normalized.accepted) {
    throw new HttpError(400, "learning_candidate_contract_invalid", `review_candidates[${index}] is not a valid LearningObservationV2: ${normalized.reason_codes.join(",")}`);
  }
}

export async function ingestLearningContractBatch(env: Env, input: LearningBatchInput, options: { tenantId?: string; principal?: string } = {}) {
  const tenantId = options.tenantId ?? tenantIdFrom(input);
  const projectId = projectScope(input);
  const source = text(input.source ?? "hook", 64) || "hook";
  const expectedPromptHash = MEMORY_CONTRACT_V2_PROMPT_HASH;
  const promptContractId = text(input.prompt_contract_id ?? MEMORY_CONTRACT_V2_PROMPT_ID, 128);
  const promptHash = text(input.prompt_hash ?? expectedPromptHash, 80).toLowerCase();
  const contractHash = text(input.contract_hash ?? MEMORY_CONTRACT_V2_CONTRACT_HASH, 80).toLowerCase();
  const verifierVersion = text(input.verifier_version ?? MEMORY_CONTRACT_V2_VERIFIER_VERSION, 128);
  if (promptContractId !== MEMORY_CONTRACT_V2_PROMPT_ID || promptHash !== expectedPromptHash || contractHash !== MEMORY_CONTRACT_V2_CONTRACT_HASH || verifierVersion !== MEMORY_CONTRACT_V2_VERIFIER_VERSION) {
    throw new HttpError(409, "memory_contract_hash_mismatch", "memory contract prompt or verifier hash does not match the deployed contract");
  }
  const commitments = [];
  for (const commitment of (input.commitments ?? []).slice(0, 16)) {
    commitments.push(await upsertTaskCommitment(env, { ...commitment, tenant_id: tenantId, project_id: projectId }, { tenantId }));
  }
  const semanticAliases = [];
  for (const alias of (input.semantic_aliases ?? []).slice(0, 16)) {
    semanticAliases.push(await saveTaskCommitmentSemanticAlias(env, {
      ...alias,
      tenant_id: tenantId,
      project_id: projectId
    } as {
      tenant_id: string;
      project_id: string | null;
      task_key: string;
      decision_key: string;
      question: string;
      ai_certification: string;
      judge_consensus: Record<string, unknown>;
    }, { tenantId }));
  }
  let verifiedInserted = 0;
  const verifiedItemsInput = input.verified_items ?? [];
  if (verifiedItemsInput.length > 0) {
    const verifiedItems = verifiedItemsInput.slice(0, 3).map((item) => ({
      ...item,
      learning: item.learning && typeof item.learning === "object"
        ? {
          ...(item.learning as Record<string, unknown>),
          contract_metadata: {
            ...((item.learning as Record<string, unknown>).contract_metadata && typeof (item.learning as Record<string, unknown>).contract_metadata === "object"
              ? (item.learning as Record<string, unknown>).contract_metadata as Record<string, unknown>
            : {}),
            prompt_contract_id: promptContractId,
            prompt_hash: promptHash,
            contract_hash: contractHash,
            verifier_version: verifierVersion,
            producer_agent: source,
            producer_model: null
          }
        }
        : item.learning
    }));
    verifiedItems.forEach(assertVerifiedItem);
    for (const [index, item] of verifiedItems.entries()) await assertCandidateBacked(env, tenantId, projectId, item, index);
    const formalDecisions = verifiedItems.filter(isFormalContractDecision);
    const ordinaryItems = verifiedItems.filter((item) => !isFormalContractDecision(item));
    const result = ordinaryItems.length > 0
      ? await captureMemoryWithInferredRationale(env, {
        tenant_id: tenantId,
        source,
        actor_type: "system",
        actor_id: options.principal ?? "hook:codex",
        items: ordinaryItems
      }, { canAttest: true })
      : { inserted: 0 };
    for (const item of formalDecisions) await captureFormalContractDecision(env, tenantId, item, options.principal);
    for (const item of verifiedItems) await persistJudgeResults(env, tenantId, item);
    verifiedInserted = Number(result.inserted ?? 0) + formalDecisions.length;
  }
  const reviewCandidates = [...(input.review_candidates ?? [])];
  for (const [index, item] of (input.deterministically_verified_items ?? []).slice(0, 3).entries()) {
    reviewCandidates.push({
      external_key: text(item.external_key ?? `learning-deterministic-review:${index}`, 256),
      item,
      observation: item.learning ?? null,
      verification: item.verification ?? null,
      evidence: item.evidence ?? [],
      reason_codes: ["ai_consensus_pending"],
      capture_intent: "verify",
      contract_hash: contractHash,
      created_at: Number(item.created_at) || Date.now(),
      expires_at: Number(item.expires_at ?? item.valid_until) || Date.now() + COMMITMENT_TTL_MS
    });
  }
  const reviewInserted = [];
  const now = Date.now();
  for (const [index, rawCandidate] of reviewCandidates.slice(0, 3).entries()) {
    const candidate = sanitizeCandidate({ ...rawCandidate, contract_hash: contractHash });
    await validateReviewCandidate(candidate, index);
    const externalKey = await candidateExternalKey(candidate);
    const payload = JSON.stringify(candidate);
    screenMemoryWriteText(payload, "memory_learning_candidate");
    const id = `learning-candidate:${(await sha256(`${tenantId}\0${externalKey}`)).slice(0, 40)}`;
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO memory_learning_candidates(
        id, tenant_id, project_id, task_key, external_key, payload_json, status,
        reason_codes_json, prompt_contract_id, prompt_hash, verifier_version, created_at, updated_at, expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, external_key) DO UPDATE SET
      payload_json = excluded.payload_json,
        status = CASE
          WHEN memory_learning_candidates.status = 'verified' THEN 'verified'
          ELSE 'review'
        END,
        reason_codes_json = excluded.reason_codes_json,
        prompt_contract_id = excluded.prompt_contract_id,
        prompt_hash = excluded.prompt_hash,
        verifier_version = excluded.verifier_version,
        updated_at = excluded.created_at,
        expires_at = excluded.expires_at`
    ).bind(
      id, tenantId, projectId, text(input.task_key, 256) || null, externalKey, payload,
      "review", JSON.stringify(candidate.reason_codes ?? []),
      promptContractId, promptHash, verifierVersion,
      now, now, now + COMMITMENT_TTL_MS
    ).run();
    for (const [index, evidence] of candidateEvidence(candidate).entries()) {
      await env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO memory_learning_candidate_evidence(
          id, tenant_id, candidate_id, evidence_type, evidence_ref, digest, diff_hash,
          supports_json, verification_state, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          evidence_type = excluded.evidence_type,
          evidence_ref = excluded.evidence_ref,
          digest = excluded.digest,
          diff_hash = excluded.diff_hash,
          supports_json = excluded.supports_json,
          verification_state = excluded.verification_state`
      ).bind(
        `${id}:evidence:${index}`,
        tenantId,
        id,
        evidence.evidenceType,
        evidence.evidenceRef,
        evidence.digest,
        evidence.diffHash,
        JSON.stringify(evidence.supports),
        evidence.verificationState,
        now
      ).run();
    }
    const candidateItem = candidate.item && typeof candidate.item === "object"
      ? candidate.item as Record<string, unknown>
      : candidate;
    const candidateJudgeItem = {
      ...candidateItem,
      candidate_id: id,
      learning: candidateItem.learning ?? candidate.observation,
      judge_consensus: candidate.judge_consensus ?? candidateItem.judge_consensus,
      ai_certification: candidate.ai_certification ?? candidateItem.ai_certification
    };
    if (candidateJudgeItem.judge_consensus || (candidateJudgeItem.learning && typeof candidateJudgeItem.learning === "object" && (candidateJudgeItem.learning as Record<string, unknown>).contract_metadata)) {
      await persistJudgeResults(env, tenantId, candidateJudgeItem);
    }
    reviewInserted.push({ id, external_key: externalKey, status: "review" });
  }
  return {
    ok: true,
    verified_inserted: verifiedInserted,
    review_inserted: reviewInserted.length,
    review_candidates: reviewInserted,
    commitments: commitments.map((item) => item.commitment),
    semantic_aliases: semanticAliases
  };
}
