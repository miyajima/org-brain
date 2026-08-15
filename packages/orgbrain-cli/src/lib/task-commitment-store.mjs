import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { isAiConsensusCertified } from "../../../shared/src/memory-contract-judge.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const DAY_MS = 24 * 60 * 60 * 1000;
const COMMITMENT_TTL_MS = 180 * DAY_MS;
const CHECKPOINT_TTL_MS = 7 * DAY_MS;
const OUTBOX_TTL_MS = 7 * DAY_MS;
const FORBIDDEN_CANDIDATE_KEYS = new Set([
  "rawtranscript", "transcript", "prompttext", "responsetext", "reasoning", "rawreasoning",
  "privatereasoning", "chainofthought", "analysis"
]);

function isForbiddenCandidateKey(key) {
  return FORBIDDEN_CANDIDATE_KEYS.has(String(key).replace(/[_-]/gu, "").toLocaleLowerCase());
}

function hash(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function contractLearningProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const projection = { ...value };
  delete projection.contract_metadata;
  return projection;
}

function text(value, limit = 2_000) {
  if (value === null || value === undefined) return "";
  const normalized = String(value).normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized.slice(0, limit);
}

function slug(value, fallback = "decision") {
  const normalized = text(value, 160).toLocaleLowerCase().replace(/[^a-z0-9._:-]+/gu, "_").replace(/^[_:.]+|[_:.]+$/gu, "");
  return (normalized || fallback).slice(0, 160);
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function unwrap(value) {
  let current = value;
  for (let index = 0; index < 3; index += 1) {
    const object = parseObject(current);
    if (!object) return current && typeof current === "object" ? current : null;
    if (object.result && typeof object.result === "object") {
      current = object.result;
      continue;
    }
    if (object.output && typeof object.output === "object") {
      current = object.output;
      continue;
    }
    if (object.Ok && typeof object.Ok === "object") {
      current = object.Ok;
      continue;
    }
    if (object.data && typeof object.data === "object") {
      current = object.data;
      continue;
    }
    return object;
  }
  return parseObject(current);
}

function redact(value) {
  return text(value, 20_000)
    .replace(/\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)\s*[:=]\s*[^\s,;]+/giu, "[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED_SECRET]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu, "[REDACTED_PHONE]")
    .replace(/\/Users\/[^/\s]+(?:\/[^\s`'"),:]+)+/gu, "[REDACTED_PATH]");
}

function redactedValue(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactedValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isForbiddenCandidateKey(key))
    .map(([key, item]) => [key, redactedValue(item)]));
}

function redactedJson(value) {
  return JSON.stringify(redactedValue(stableValue(value)));
}

async function secureDatabaseFiles(dbPath) {
  await Promise.all([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((file) => chmod(file, 0o600).catch(() => undefined)));
}

function normalizeAnswer(raw, options) {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  const value = candidate && typeof candidate === "object"
    ? candidate.answer ?? candidate.value ?? candidate.label ?? candidate.option_id ?? candidate.id ?? candidate.answers?.[0]
    : candidate;
  const label = redact(value);
  if (!label) return null;
  const normalized = label.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
  const option = options.find((item) => {
    const optionLabel = text(item?.label ?? item?.value ?? item, 500);
    const optionId = text(item?.id ?? item?.option_id, 160).toLocaleLowerCase();
    return (optionLabel && optionLabel.toLocaleLowerCase().replace(/\s+/gu, " ").trim() === normalized) ||
      (optionId && optionId === normalized);
  });
  const optionLabel = option ? text(option.label ?? option.value ?? option, 500) : null;
  return {
    option_id: option ? slug(option.id ?? optionLabel, "option") : null,
    label: optionLabel || label,
    raw: label
  };
}

function answersFromResult(result) {
  let object = unwrap(result) ?? {};
  if (Array.isArray(object.content)) {
    const textContent = object.content.find((item) => item?.type === "text" && typeof item.text === "string")?.text;
    object = unwrap(textContent) ?? object;
  }
  const answers = object.answers ?? object.answer ?? object.responses ?? object;
  return answers && typeof answers === "object" ? answers : {};
}

function answerFor(answers, question, index) {
  const direct = answers[question.id] ?? answers[question.header] ?? answers[String(index)];
  if (direct !== undefined) return direct;
  if (Array.isArray(answers)) return answers[index];
  return null;
}

function questionList(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (questions.length > 0) return questions;
  if (typeof input?.question === "string" && input.question.trim()) return [{
    id: input.id ?? input.header ?? "decision",
    question: input.question,
    options: input.options ?? []
  }];
  return [];
}

function questionFingerprint(question) {
  const questionText = text(question?.question ?? question?.prompt ?? question?.label, 1_000);
  const options = Array.isArray(question?.options) ? question.options : [];
  return `sha256:${hash(stableJson({
    question: normalizeCommitmentText(questionText),
    options: options.map((item) => normalizeCommitmentText(item?.label ?? item?.value ?? item))
  }))}`;
}

function toolInputFromPayload(payloadInput) {
  const payload = unwrap(payloadInput) ?? {};
  return {
    payload,
    input: unwrap(payload.tool_input ?? payload.input ?? payload.arguments ?? payload.invocation?.arguments) ?? {},
    toolName: text(payload.tool_name ?? payload.name ?? payload.tool ?? payload.invocation?.tool, 128)
  };
}

export function taskKeyFromHookPayload(payloadInput) {
  const payload = unwrap(payloadInput) ?? {};
  const sessionId = text(
    payload.task_key ?? payload.task_id ?? payload.session_id ?? payload.thread_id ?? payload["thread-id"] ??
    payload["session-id"] ?? payload["turn-id"] ?? payload.sessionId ?? payload.threadId ?? payload.metadata?.sessionId ?? payload.metadata?.turnId ??
    payload.turn_id ?? payload.turnId,
    256
  );
  return `codex:${sessionId || `workspace:${slug(payload.cwd ?? payload.project_id ?? "unknown", "unknown")}`}`.slice(0, 256);
}

export function hasTaskIdentity(payloadInput) {
  const payload = unwrap(payloadInput) ?? {};
  return Boolean(text(
    payload.task_key ?? payload.task_id ?? payload.session_id ?? payload.thread_id ?? payload["thread-id"] ??
    payload["session-id"] ?? payload["turn-id"] ?? payload.sessionId ?? payload.threadId ?? payload.metadata?.sessionId ?? payload.metadata?.turnId ??
    payload.turn_id ?? payload.turnId,
    256
  ));
}

export function normalizeCommitmentText(value) {
  return text(value, 1_000).toLocaleLowerCase().replace(/[「」『』"'`]/gu, "").replace(/\s+/gu, " ").trim();
}

function characterNgrams(value, size = 3) {
  const normalized = normalizeCommitmentText(value).replace(/[\s。、，！？!?：:；;]/gu, "");
  if (normalized.length < size) return new Set(normalized ? [normalized] : []);
  return new Set(Array.from({ length: normalized.length - size + 1 }, (_, index) => normalized.slice(index, index + size)));
}

function questionSimilarity(left, right) {
  const a = normalizeCommitmentText(left);
  const b = normalizeCommitmentText(right);
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) >= 8 ? 0.9 : 0;
  const leftNgrams = characterNgrams(a);
  const rightNgrams = characterNgrams(b);
  if (leftNgrams.size === 0 || rightNgrams.size === 0) return 0;
  const intersection = [...leftNgrams].filter((item) => rightNgrams.has(item)).length;
  return intersection / (leftNgrams.size + rightNgrams.size - intersection);
}

export function requestUserInputEvidenceDigest(input, result) {
  return `sha256:${hash(stableJson({ input: unwrap(input) ?? input, result: unwrap(result) ?? result }))}`;
}

export function semanticQuestionFingerprint(value) {
  const question = typeof value === "object"
    ? value?.question ?? value?.prompt ?? value?.label
    : value;
  return `sha256:${hash(normalizeCommitmentText(question))}`;
}

export function extractTaskCommitments(payloadInput) {
  const { payload, input, toolName } = toolInputFromPayload(payloadInput);
  if (toolName && !/(?:^|[.:/])request_user_input$/u.test(toolName) && toolName !== "request_user_input") return [];
  if (!hasTaskIdentity(payload)) return [];
  const questions = questionList(input);
  if (questions.length === 0) return [];
  const result = payload.tool_result ?? payload.tool_response ?? payload.result ?? payload.output ?? payload.tool_output ?? payload.response;
  const answers = answersFromResult(result);
  const taskKey = taskKeyFromHookPayload(payload);
  const projectId = text(payload.project_id ?? payload.projectId ?? (typeof payload.cwd === "string" ? payload.cwd.split(/[\\/]/u).filter(Boolean).at(-1) : ""), 128) || null;
  const evidenceDigest = requestUserInputEvidenceDigest(input, result);
  return questions.slice(0, 16).flatMap((question, index) => {
    const questionText = text(question?.question ?? question?.prompt ?? question?.label, 1_000);
    if (!questionText) return [];
    const decisionKey = slug(question?.id ?? question?.header ?? questionText);
    const options = Array.isArray(question?.options) ? question.options : [];
    const answer = normalizeAnswer(answerFor(answers, { id: text(question?.id ?? question?.header, 160) }, index), options);
    if (!answer) return [];
    return [{
      record_type: "task_commitment",
      schema_version: 1,
      task_key: taskKey,
      decision_key: decisionKey,
      question_fingerprint: questionFingerprint(question),
      question: redact(questionText),
      answer,
      authority: "explicit_user",
      confirmation_state: "user_confirmed",
      ask_policy: "reuse_until_superseded",
      scope: { level: "task", project_id: projectId },
      evidence: { type: "request_user_input_result", digest: evidenceDigest },
      created_at: Date.now(),
      expires_at: Date.now() + COMMITMENT_TTL_MS
    }];
  });
}

export async function guardCodexQuestion(payloadInput, store, tenantId = "default") {
  const { payload, input, toolName } = toolInputFromPayload(payloadInput);
  if (toolName && !/(?:^|[.:/])request_user_input$/u.test(toolName) && toolName !== "request_user_input") {
    return { allow: true, commitments: [] };
  }
  const questions = questionList(input);
  if (questions.length === 0) return { allow: true, commitments: [] };
  if (!hasTaskIdentity(payload)) return { allow: true, commitments: [], reason: "task_identity_missing" };
  const taskKey = taskKeyFromHookPayload(payload);
  const projectId = text(payload.project_id ?? payload.projectId ?? (typeof payload.cwd === "string" ? payload.cwd.split(/[\\/]/u).filter(Boolean).at(-1) : ""), 128) || null;
  const commitments = await store.list({ tenantId, projectId, taskKey });
  const changeText = normalizeCommitmentText(payload.user_prompt ?? payload.prompt ?? payload.last_user_message ?? "");
  const explicitChange = /(?:変更|更新|上書き|やり直|change|update|override|replace|revise|supersede)/iu.test(changeText) || payload.allow_change === true;
  const evidenceConflict = payload.current_evidence_conflict === true || payload.evidence_conflict === true || payload.conflict === true;
  if (explicitChange || evidenceConflict) return { allow: true, commitments, reason: explicitChange ? "explicit_change_requested" : "current_evidence_conflict" };
  for (const question of questions) {
    const key = slug(question?.id ?? question?.header ?? question?.question);
    const fingerprint = questionFingerprint(question);
    const match = commitments.find((item) => item.decision_key === key || item.question_fingerprint === fingerprint);
    if (match) {
      return {
        allow: false,
        commitments,
        reason: "task_commitment_already_answered",
        commitment: match
      };
    }
  }
  for (const question of questions) {
    const fingerprint = semanticQuestionFingerprint(question);
    const match = commitments.find((item) => item.semantic_aliases?.some((alias) => alias.alias_fingerprint === fingerprint));
    if (match) {
      return {
        allow: false,
        commitments,
        reason: "ai_semantic_alias_already_answered",
        commitment: match,
        alias: match.semantic_aliases.find((item) => item.alias_fingerprint === fingerprint)
      };
    }
  }
  for (const question of questions) {
    const questionText = question?.question ?? question?.prompt ?? question?.label;
    const similar = commitments
      .map((commitment) => ({ commitment, score: questionSimilarity(questionText, commitment.question) }))
      .sort((left, right) => right.score - left.score)[0];
    if (similar?.score >= 0.45) {
      return {
        allow: true,
        commitments,
        reason: "similar_task_commitment_warning",
        warning: similar.commitment
      };
    }
  }
  return { allow: true, commitments };
}

function rowToCommitment(row, semanticAliases = []) {
  if (!row) return null;
  let answer = {};
  try { answer = JSON.parse(row.answer_json); } catch { answer = { label: "[invalid]" }; }
  return {
    record_type: "task_commitment",
    schema_version: 1,
    id: row.id,
    task_key: row.task_key,
    decision_key: row.decision_key,
    question_fingerprint: row.question_fingerprint,
    question: row.question,
    answer,
    authority: row.authority,
    confirmation_state: row.confirmation_state,
    ask_policy: row.ask_policy,
    scope: { level: "task", project_id: row.project_id },
    evidence: { type: row.evidence_type, digest: row.evidence_digest },
    semantic_aliases: semanticAliases,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    superseded_at: row.superseded_at
  };
}

export class TaskCommitmentStore {
  constructor(dbPath) {
    this.dbPath = resolve(dbPath);
    this.initialization = null;
  }

  async init() {
    if (!this.initialization) {
      this.initialization = this.initialize().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    await this.initialization;
    return this;
  }

  async initialize() {
    await mkdir(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.dbPath)) await chmod(this.dbPath, 0o600);
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS task_commitments (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          project_id TEXT,
          task_key TEXT NOT NULL,
          decision_key TEXT NOT NULL,
          question_fingerprint TEXT NOT NULL,
          question TEXT NOT NULL,
          answer_json TEXT NOT NULL,
          authority TEXT NOT NULL CHECK(authority = 'explicit_user'),
          confirmation_state TEXT NOT NULL CHECK(confirmation_state IN ('user_confirmed', 'user_corrected')),
          ask_policy TEXT NOT NULL CHECK(ask_policy = 'reuse_until_superseded'),
          evidence_type TEXT NOT NULL,
          evidence_digest TEXT NOT NULL,
          version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER,
          superseded_at INTEGER,
          UNIQUE(tenant_id, task_key, decision_key, version)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_commitments_active
          ON task_commitments(tenant_id, task_key, decision_key)
          WHERE superseded_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_task_commitments_context
          ON task_commitments(tenant_id, project_id, task_key, expires_at);
        CREATE TABLE IF NOT EXISTS task_commitment_semantic_aliases (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          project_id TEXT,
          task_key TEXT NOT NULL,
          decision_key TEXT NOT NULL,
          commitment_id TEXT NOT NULL,
          alias_fingerprint TEXT NOT NULL,
          alias_question TEXT NOT NULL,
          certification TEXT NOT NULL CHECK(certification = 'ai_consensus_certified'),
          prompt_hash TEXT NOT NULL,
          verifier_version TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          UNIQUE(tenant_id, task_key, decision_key, alias_fingerprint)
        );
        CREATE INDEX IF NOT EXISTS idx_task_commitment_aliases_context
          ON task_commitment_semantic_aliases(tenant_id, project_id, task_key, expires_at);
        CREATE TABLE IF NOT EXISTS task_context_checkpoints (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          project_id TEXT,
          task_key TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_learning_candidates (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          project_id TEXT,
          task_key TEXT,
          external_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('review', 'quarantine', 'verified', 'rejected', 'expired')),
          reason_codes_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          reviewed_at INTEGER,
          UNIQUE(tenant_id, external_key)
        );
        CREATE INDEX IF NOT EXISTS idx_learning_candidates_review
          ON memory_learning_candidates(tenant_id, project_id, status, expires_at);
        CREATE TABLE IF NOT EXISTS memory_learning_outbox (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          external_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          UNIQUE(tenant_id, external_key)
        );
        CREATE INDEX IF NOT EXISTS idx_learning_outbox_expiry
          ON memory_learning_outbox(tenant_id, expires_at);
      `);
      const checkpointColumns = db.prepare("PRAGMA table_info(task_context_checkpoints)").all();
      if (!checkpointColumns.some((column) => column.name === "payload_json")) {
        db.exec("ALTER TABLE task_context_checkpoints ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'");
      }
      const candidateTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_learning_candidates'").get();
      if (candidateTable?.sql && !String(candidateTable.sql).includes("'quarantine'")) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec("DROP INDEX IF EXISTS idx_learning_candidates_review");
          db.exec("ALTER TABLE memory_learning_candidates RENAME TO memory_learning_candidates_legacy");
          db.exec(`CREATE TABLE memory_learning_candidates (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            project_id TEXT,
            task_key TEXT,
            external_key TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('review', 'quarantine', 'verified', 'rejected', 'expired')),
            reason_codes_json TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            reviewed_at INTEGER,
            UNIQUE(tenant_id, external_key)
          )`);
          db.exec("INSERT INTO memory_learning_candidates SELECT * FROM memory_learning_candidates_legacy");
          db.exec("DROP TABLE memory_learning_candidates_legacy");
          db.exec("CREATE INDEX idx_learning_candidates_review ON memory_learning_candidates(tenant_id, project_id, status, expires_at)");
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
    } finally {
      db.close();
    }
    await secureDatabaseFiles(this.dbPath);
  }

  open() {
    return new DatabaseSync(this.dbPath);
  }

  async upsert(commitment) {
    await this.init();
    const now = Number.isFinite(commitment.created_at) ? commitment.created_at : Date.now();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const active = db.prepare(
        `SELECT * FROM task_commitments
         WHERE tenant_id = ? AND task_key = ? AND decision_key = ? AND superseded_at IS NULL
         ORDER BY version DESC LIMIT 1`
      ).get(commitment.tenant_id, commitment.task_key, commitment.decision_key);
      const answerJson = stableJson(commitment.answer);
      if (
        active &&
        active.question_fingerprint === commitment.question_fingerprint &&
        active.answer_json === answerJson &&
        (!active.expires_at || active.expires_at > now)
      ) {
        db.exec("COMMIT");
        return { created: false, changed: false, commitment: rowToCommitment(active) };
      }
      if (active) db.prepare("UPDATE task_commitments SET superseded_at = ?, updated_at = ? WHERE id = ?").run(now, now, active.id);
      const version = Number(db.prepare(
        "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM task_commitments WHERE tenant_id = ? AND task_key = ? AND decision_key = ?"
      ).get(commitment.tenant_id, commitment.task_key, commitment.decision_key).version);
      const id = `commitment:${hash(stableJson({ ...commitment, version })).slice(0, 40)}`;
      db.prepare(
        `INSERT INTO task_commitments(
          id, tenant_id, project_id, task_key, decision_key, question_fingerprint,
          question, answer_json, authority, confirmation_state, ask_policy,
          evidence_type, evidence_digest, version, created_at, updated_at, expires_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        commitment.tenant_id,
        commitment.scope?.project_id ?? commitment.project_id ?? null,
        commitment.task_key,
        commitment.decision_key,
        commitment.question_fingerprint,
        redact(commitment.question),
        answerJson,
        "explicit_user",
        commitment.confirmation_state === "user_corrected" ? "user_corrected" : "user_confirmed",
        "reuse_until_superseded",
        "request_user_input_result",
        commitment.evidence?.digest ?? `sha256:${hash(answerJson)}`,
        version,
        now,
        now,
        commitment.expires_at ?? now + COMMITMENT_TTL_MS
      );
      db.exec("COMMIT");
      const row = db.prepare("SELECT * FROM task_commitments WHERE id = ?").get(id);
      return { created: true, changed: Boolean(active), commitment: rowToCommitment(row) };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
      await secureDatabaseFiles(this.dbPath);
    }
  }

  async ingestToolResult(payload, tenantId = "default") {
    const commitments = extractTaskCommitments(payload);
    const results = [];
    for (const commitment of commitments) {
      results.push(await this.upsert({ ...commitment, tenant_id: tenantId }));
    }
    return { commitments: results, count: results.length };
  }

  async list({ tenantId = "default", projectId = null, taskKey = null, now = Date.now() } = {}) {
    await this.init();
    if (!taskKey) return [];
    const db = this.open();
    try {
      const rows = db.prepare(
        `SELECT * FROM task_commitments
         WHERE tenant_id = ?
           AND superseded_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND (? IS NULL OR task_key = ?)
           AND ((? IS NULL AND project_id IS NULL) OR (? IS NOT NULL AND project_id = ?))
         ORDER BY updated_at DESC, decision_key ASC
         LIMIT 64`
      ).all(tenantId, now, taskKey, taskKey, projectId, projectId, projectId);
      const aliasRows = db.prepare(
        `SELECT a.* FROM task_commitment_semantic_aliases a
         JOIN task_commitments c ON c.id = a.commitment_id
         WHERE a.tenant_id = ? AND a.expires_at > ?
           AND c.superseded_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?)
           AND (? IS NULL OR a.task_key = ?)
           AND ((? IS NULL AND a.project_id IS NULL) OR (? IS NOT NULL AND a.project_id = ?))
         ORDER BY a.created_at ASC`
      ).all(tenantId, now, now, taskKey, taskKey, projectId, projectId, projectId);
      const aliasesByKey = new Map();
      for (const alias of aliasRows) {
        const key = `${alias.task_key}\0${alias.decision_key}`;
        const aliases = aliasesByKey.get(key) ?? [];
        aliases.push({
          alias_fingerprint: alias.alias_fingerprint,
          question: alias.alias_question,
          certification: alias.certification,
          prompt_hash: alias.prompt_hash,
          verifier_version: alias.verifier_version,
          created_at: alias.created_at,
          expires_at: alias.expires_at
        });
        aliasesByKey.set(key, aliases);
      }
      return rows.map((row) => rowToCommitment(row, aliasesByKey.get(`${row.task_key}\0${row.decision_key}`) ?? []));
    } finally {
      db.close();
      await secureDatabaseFiles(this.dbPath);
    }
  }

  async checkpoint({ tenantId = "default", projectId = null, taskKey, payload = {} }) {
    await this.init();
    if (!taskKey) return { saved: false, reason: "task_key_missing" };
    const now = Date.now();
    const db = this.open();
    try {
      const id = `checkpoint:${randomUUID()}`;
      const payloadJson = redactedJson(payload);
      db.prepare(
        `INSERT INTO task_context_checkpoints(id, tenant_id, project_id, task_key, payload_digest, payload_json, created_at, expires_at)
         VALUES(?,?,?,?,?,?,?,?)`
      ).run(id, tenantId, projectId, taskKey, `sha256:${hash(payloadJson)}`, payloadJson, now, now + CHECKPOINT_TTL_MS);
      db.prepare("DELETE FROM task_context_checkpoints WHERE expires_at <= ?").run(now);
      return { saved: true, id };
    } finally {
      db.close();
      await secureDatabaseFiles(this.dbPath);
    }
  }

  async latestCheckpoint({ tenantId = "default", projectId = null, taskKey, now = Date.now() } = {}) {
    await this.init();
    if (!taskKey) return null;
    const db = this.open();
    try {
      const row = db.prepare(
        `SELECT * FROM task_context_checkpoints
         WHERE tenant_id = ? AND task_key = ? AND expires_at > ?
           AND ((? IS NULL AND project_id IS NULL) OR (? IS NOT NULL AND project_id = ?))
         ORDER BY created_at DESC LIMIT 1`
      ).get(tenantId, taskKey, now, projectId, projectId, projectId);
      if (!row) return null;
      let payload = {};
      try { payload = JSON.parse(row.payload_json ?? "{}"); } catch { payload = {}; }
      return { ...row, payload };
    } finally {
      db.close();
    }
  }

  async saveSemanticAlias({
    tenantId = "default",
    projectId = null,
    taskKey,
    decisionKey,
    question,
    judgeConsensus,
    certification = "ai_consensus_certified"
  } = {}) {
    await this.init();
    if (!taskKey || !decisionKey || !question) return { saved: false, reason: "semantic_alias_identity_missing" };
    if (!isAiConsensusCertified({ ai_certification: certification, judge_consensus: judgeConsensus })) {
      return { saved: false, reason: "semantic_alias_ai_consensus_required" };
    }
    const now = Date.now();
    const aliasQuestion = redact(text(question, 1_000));
    const aliasFingerprint = semanticQuestionFingerprint(aliasQuestion);
    const normalizedDecisionKey = slug(decisionKey);
    const db = this.open();
    try {
      const commitment = db.prepare(
        `SELECT id FROM task_commitments
         WHERE tenant_id = ? AND task_key = ? AND decision_key = ? AND superseded_at IS NULL
           AND ((? IS NULL AND project_id IS NULL) OR (? IS NOT NULL AND project_id = ?))
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY version DESC LIMIT 1`
      ).get(tenantId, taskKey, normalizedDecisionKey, projectId, projectId, projectId, now);
      if (!commitment?.id) return { saved: false, reason: "task_commitment_not_found" };
      const promptHash = String(judgeConsensus.judgments[0].prompt_hash);
      const verifierVersion = "verifier-v2";
      const id = `commitment-alias:${hash(`${tenantId}\0${taskKey}\0${normalizedDecisionKey}\0${aliasFingerprint}`).slice(0, 40)}`;
      db.prepare(
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
      ).run(
        id, tenantId, projectId, taskKey, normalizedDecisionKey, commitment.id,
        aliasFingerprint, aliasQuestion, certification, promptHash,
        verifierVersion, now, now + COMMITMENT_TTL_MS
      );
      return { saved: true, id, alias_fingerprint: aliasFingerprint };
    } finally {
      db.close();
      await secureDatabaseFiles(this.dbPath);
    }
  }

  async assertCandidateBacked({ tenantId = "default", projectId = null, item = {} } = {}) {
    await this.init();
    const learning = item?.learning && typeof item.learning === "object" ? item.learning : {};
    const metadata = learning.contract_metadata && typeof learning.contract_metadata === "object"
      ? learning.contract_metadata
      : {};
    const candidateId = text(item?.candidate_id ?? metadata.candidate_id, 256);
    if (!candidateId) return { ok: false, reason: "candidate_backing_required" };
    const db = this.open();
    try {
      const row = db.prepare(
        "SELECT project_id, external_key, payload_json, status FROM memory_learning_candidates WHERE tenant_id = ? AND id = ?"
      ).get(tenantId, candidateId);
      if (!row || !["review", "quarantine", "verified"].includes(row.status)) {
        return { ok: false, reason: "candidate_backing_missing" };
      }
      if ((row.project_id ?? null) !== (projectId ?? item?.project_id ?? null)) {
        return { ok: false, reason: "candidate_scope_mismatch" };
      }
      const stored = parseObject(row.payload_json) ?? {};
      const storedItem = stored.item && typeof stored.item === "object" ? stored.item : stored;
      const submittedExternalKey = text(item?.external_key, 256);
      const storedExternalKey = text(storedItem.external_key ?? stored.external_key ?? row.external_key, 256);
      if (submittedExternalKey && storedExternalKey && submittedExternalKey !== storedExternalKey) {
        return { ok: false, reason: "candidate_backing_mismatch" };
      }
      const storedLearning = storedItem.learning ?? stored.observation;
      const submittedLearning = item?.learning;
      if (!storedLearning || !submittedLearning || stableJson(contractLearningProjection(storedLearning)) !== stableJson(contractLearningProjection(submittedLearning))) {
        return { ok: false, reason: "candidate_learning_mismatch" };
      }
      return { ok: true, candidate_id: candidateId, external_key: storedExternalKey || row.external_key };
    } finally {
      db.close();
      await secureDatabaseFiles(this.dbPath);
    }
  }

  async saveLearningCandidates({ tenantId = "default", projectId = null, taskKey = null, candidates = [], expireAfterDays = null }) {
    await this.init();
    const db = this.open();
    const now = Date.now();
    const ttlMs = Number.isInteger(Number(expireAfterDays)) && Number(expireAfterDays) > 0
      ? Number(expireAfterDays) * DAY_MS
      : COMMITMENT_TTL_MS;
    const results = [];
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const candidate of candidates.slice(0, 3)) {
        const payload = JSON.parse(redactedJson(candidate));
        const externalKey = text(candidate.external_key ?? `candidate:${hash(stableJson(candidate))}`, 256);
        const id = `learning-candidate:${hash(`${tenantId}\0${externalKey}`).slice(0, 40)}`;
        db.prepare(
          `INSERT INTO memory_learning_candidates(
            id, tenant_id, project_id, task_key, external_key, payload_json, status,
            reason_codes_json, created_at, expires_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id, external_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            reason_codes_json = excluded.reason_codes_json,
            status = CASE
              WHEN memory_learning_candidates.status = 'verified' THEN 'verified'
              ELSE 'quarantine'
            END,
            expires_at = excluded.expires_at`
        ).run(
          id,
          tenantId,
          projectId,
          taskKey,
          externalKey,
          JSON.stringify(payload),
          "quarantine",
          JSON.stringify(candidate.reason_codes ?? []),
          now,
          now + ttlMs
        );
        results.push({ id, external_key: externalKey, status: "quarantine" });
      }
      db.exec("COMMIT");
      return results;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
      await secureDatabaseFiles(this.dbPath);
    }
  }

  /**
   * Move legacy human-review rows into the autonomous quarantine state and
   * expire candidates whose retention window has elapsed.  No human queue is
   * left behind; callers can run the AI evaluator again on the remaining
   * quarantine rows in a later cycle.
   */
  async maintainLearningCandidates({ tenantId = "default", now = Date.now(), evaluate = null, promote = null, limit = 100, policyHash = null, expireAfterDays = null, reevaluateIntervalHours = null } = {}) {
    await this.init();
    const db = this.open();
    const ttlMs = Number.isInteger(Number(expireAfterDays)) && Number(expireAfterDays) > 0
      ? Number(expireAfterDays) * DAY_MS
      : COMMITMENT_TTL_MS;
    const reevaluateMs = Number.isInteger(Number(reevaluateIntervalHours)) && Number(reevaluateIntervalHours) > 0
      ? Number(reevaluateIntervalHours) * 60 * 60 * 1000
      : DAY_MS;
    const createdCutoff = now - ttlMs;
    let rows = [];
    try {
      db.exec("BEGIN IMMEDIATE");
      const normalized = db.prepare(
        "UPDATE memory_learning_candidates SET status = 'quarantine' WHERE tenant_id = ? AND status = 'review'"
      ).run(tenantId);
      const expired = db.prepare(
        "UPDATE memory_learning_candidates SET status = 'expired', reviewed_at = ? WHERE tenant_id = ? AND status = 'quarantine' AND (expires_at <= ? OR created_at <= ?)"
      ).run(now, tenantId, now, createdCutoff);
      const remaining = db.prepare(
        "SELECT COUNT(*) AS count FROM memory_learning_candidates WHERE tenant_id = ? AND status = 'quarantine'"
      ).get(tenantId);
      db.exec("COMMIT");
      rows = db.prepare(
        "SELECT id, project_id, task_key, external_key, payload_json, reason_codes_json, created_at, expires_at FROM memory_learning_candidates WHERE tenant_id = ? AND status = 'quarantine' ORDER BY created_at ASC LIMIT ?"
      ).all(tenantId, Math.max(0, Math.min(1000, Number(limit) || 100)));
      const base = {
        normalized_to_quarantine: Number(normalized.changes ?? 0),
        expired: Number(expired.changes ?? 0),
        quarantine_count: Number(remaining?.count ?? 0),
        reevaluated: 0,
        promoted: 0,
        rejected: 0,
        reevaluation_errors: 0,
        promotion_errors: 0,
        promoted_memory_count: 0,
        promoted_candidates: []
      };
      if (typeof evaluate !== "function" || rows.length === 0) return base;
      const due = rows.filter((row) => {
        const payload = parseObject(row.payload_json) ?? {};
        const autonomy = parseObject(payload.autonomy) ?? {};
        return (policyHash && autonomy.policy_hash && autonomy.policy_hash !== policyHash) ||
          Number(autonomy.next_evaluation_at ?? row.created_at) <= now;
      });
      const updates = [];
      for (const row of due) {
        let outcome;
        try {
          outcome = await evaluate({
            id: row.id,
            external_key: row.external_key,
            project_id: row.project_id,
            task_key: row.task_key,
            candidate: parseObject(row.payload_json) ?? {},
            reason_codes: (() => {
              try {
                const parsed = JSON.parse(row.reason_codes_json ?? "[]");
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            })()
          });
        } catch {
          base.reevaluation_errors += 1;
          continue;
        }
        const route = String(outcome?.route ?? outcome?.action ?? "quarantine");
        const candidate = parseObject(row.payload_json) ?? {};
        const autonomy = {
          ...(parseObject(candidate.autonomy) ?? {}),
          last_evaluated_at: now,
          next_evaluation_at: Number(outcome?.next_evaluation_at) > now
            ? Number(outcome.next_evaluation_at)
            : now + reevaluateMs,
          policy_hash: policyHash ?? (parseObject(candidate.autonomy)?.policy_hash ?? null)
        };
        candidate.autonomy = autonomy;
        const reasonCodes = [...new Set((outcome?.reason_codes ?? candidate.reason_codes ?? []).map(String))].slice(0, 32);
        let status = route === "active" && outcome?.verified === true && outcome?.consensus_pass === true
          ? "verified"
          : route === "excluded" ? "rejected" : "quarantine";
        let promotion = null;
        if (status === "verified" && typeof promote === "function") {
          try {
            promotion = await promote({
              id: row.id,
              external_key: row.external_key,
              project_id: row.project_id,
              task_key: row.task_key,
              candidate,
              outcome
            });
            if (!promotion || promotion.ok !== true) {
              status = "quarantine";
              base.promotion_errors += 1;
              reasonCodes.push("promotion_failed");
            }
          } catch {
            status = "quarantine";
            base.promotion_errors += 1;
            reasonCodes.push("promotion_failed");
          }
        }
        updates.push({ row, status, payload: candidate, reasonCodes });
        base.reevaluated += 1;
        if (status === "verified") base.promoted += 1;
        if (status === "rejected") base.rejected += 1;
        if (status === "verified") {
          base.promoted_memory_count += Number(promotion?.memory_count ?? promotion?.created_count ?? 0);
          base.promoted_candidates.push({
            id: row.id,
            external_key: row.external_key,
            project_id: row.project_id,
            task_key: row.task_key,
            promotion
          });
        }
      }
      if (updates.length > 0) {
        db.exec("BEGIN IMMEDIATE");
        for (const update of updates) {
          db.prepare(
            "UPDATE memory_learning_candidates SET payload_json = ?, status = ?, reason_codes_json = ?, reviewed_at = CASE WHEN ? IN ('verified', 'rejected') THEN ? ELSE reviewed_at END, expires_at = CASE WHEN ? = 'quarantine' THEN MAX(expires_at, ?) ELSE expires_at END WHERE tenant_id = ? AND id = ? AND status = 'quarantine'"
          ).run(
            redactedJson(update.payload),
            update.status,
            JSON.stringify(update.reasonCodes),
            update.status,
            now,
            update.status,
            now + ttlMs,
            tenantId,
            update.row.id
          );
        }
        db.exec("COMMIT");
      }
      base.quarantine_count = Math.max(0, base.quarantine_count - base.promoted - base.rejected);
      return base;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
      await secureDatabaseFiles(this.dbPath);
    }
  }

  async saveLearningOutbox({ tenantId = "default", payload = {} }) {
    await this.init();
    const now = Date.now();
    const externalKey = text(payload?.params?.id ?? payload?.id ?? `learning-outbox:${hash(stableJson(payload))}`, 256);
    const id = `learning-outbox:${hash(`${tenantId}\0${externalKey}`).slice(0, 40)}`;
    const db = this.open();
    try {
      db.prepare("DELETE FROM memory_learning_outbox WHERE expires_at <= ?").run(now);
      db.prepare(
        `INSERT INTO memory_learning_outbox(id, tenant_id, external_key, payload_json, created_at, expires_at, attempts)
         VALUES(?,?,?,?,?,?,0)
         ON CONFLICT(tenant_id, external_key) DO UPDATE SET payload_json = excluded.payload_json, expires_at = excluded.expires_at, attempts = memory_learning_outbox.attempts + 1`
      ).run(id, tenantId, externalKey, redactedJson(payload), now, now + OUTBOX_TTL_MS);
      return { saved: true, id, external_key: externalKey, expires_at: now + OUTBOX_TTL_MS };
    } finally {
      db.close();
      await secureDatabaseFiles(this.dbPath);
    }
  }
}
