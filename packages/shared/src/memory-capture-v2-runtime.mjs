// Runtime-neutral capture policy shared by Node hooks and Cloudflare Workers.
// Hashing and persistence remain adapter responsibilities.

import { enforceMemoryCaptureHookProfile } from "./memory-capture-profile-runtime.mjs";

export const DURABLE_MEMORY_KINDS = [
  "fact",
  "decision",
  "constraint",
  "pitfall",
  "preference"
];

export const MEMORY_CAPTURE_V2_MAX_CANDIDATES = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_BY_KIND = {
  fact: 90 * DAY_MS,
  decision: 180 * DAY_MS,
  constraint: 180 * DAY_MS,
  pitfall: 180 * DAY_MS,
  preference: 180 * DAY_MS
};

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu,
  /\b(?:sk|sk-proj|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/giu,
  /\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)\s*[:=]\s*["']?[^\s"',;]{8,}/giu
];
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_CANDIDATE_PATTERN = /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu;
const ADDRESS_PATTERNS = [
  /(?:〒\s*)?\d{3}-\d{4}\s*[都道府県].{2,80}/gu,
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd)\b/giu
];
const PAYMENT_PATTERN = /\b(?:credit card|card number|bank account|routing number|payment account)\b|(?:カード番号|銀行口座|口座番号|決済情報)/iu;
const HEALTH_PATTERN = /\b(?:diagnosis|medical record|patient|prescription|health condition)\b|(?:診断名|病歴|患者|処方薬|健康状態)/iu;
const CALENDAR_PATTERN = /(?:calendar|meeting|appointment|予定|会議|面談).{0,48}(?:\d{1,2}(?::|時)\d{0,2}|日時|参加者|attendee)/iu;
const EXISTING_REDACTION_PATTERN = /\[REDACTED_(?:SECRET|EMAIL|PHONE|SENSITIVE)\]/u;

const UNSAFE_INSTRUCTION_PATTERN =
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:previous|system|developer|security)\b|\b(?:reveal|exfiltrate|print)\b.{0,40}\b(?:secret|credential|system prompt)\b|前の指示を無視|秘密.{0,12}(?:表示|送信)/iu;

const CLASSIFIERS = [
  {
    kind: "decision",
    // Keep decision signals action-oriented. Bare nouns such as 承認状態 or
    // 選択肢 describe schemas and capabilities surprisingly often, and were
    // turning historical status tables into inferred decisions.
    pattern: /\b(?:decided(?:\s+to)?|decision\s+(?:is|was|to)|adopt(?:ed|ing)?|selected\s+\w+\s+(?:as|for)|chose|(?:i|we|the team)\s+(?:approved|will use)|approved decision|standardize on)\b|(?:決定(?:した|する|された|済み|事項)|採用(?:した|する|された|しない|とする|済み)|統一(?:した|する|された|する方針)|方針(?:とする|にした|である)|ことにした)/iu,
    confidence: 0.82
  },
  {
    kind: "constraint",
    pattern: /\b(?:must|must not|required|prohibited|forbidden|never|always)\b|(?:必須|禁止|してはいけない|制約|必ず)/iu,
    confidence: 0.8
  },
  {
    kind: "pitfall",
    pattern: /\b(?:root cause|pitfall|regression|do not repeat|workaround|fails? because)\b|(?:根本原因|原因は|落とし穴|回避策|失敗原因)/iu,
    confidence: 0.78
  },
  {
    kind: "preference",
    pattern: /\b(?:prefer|preference|default to|favor)\b|(?:好む|優先する|既定とする|デフォルトとする)/iu,
    confidence: 0.75
  },
  {
    kind: "fact",
    pattern: /\b(?:uses|is located|lives in|supports|requires version|configured as|canonical (?:path|variable)|source of truth)\b|(?:を使用する|に配置されている|が正規|が唯一の|対応している|仕様である|参照元である)/iu,
    confidence: 0.72
  }
];

const TRANSIENT_PATTERNS = [
  /^(?:done|completed|finished|success|完了|実装完了|修正完了|対応完了)[.!。]?$/iu,
  /(?:commit|push|pull request|PR|CI|build).{0,40}(?:completed|succeeded|passed|完了|成功|通り)/iu,
  /(?:現在|いま|today|currently|現時点).{0,50}(?:件|%|ms|秒|分|時|status|状態)/iu,
  /(?:draft|下書き|返信案|投稿案|ツイート案)/iu,
  /(?:必要な作業は終わっています|ほかに進める内容があれば)/u
];
const CAUSE_PATTERN = /\b(?:because|root cause|caused by|reason)\b|(?:原因|理由|なぜなら)/iu;
const FIX_PATTERN = /\b(?:fix|fixed|resolve|resolved|workaround|prevent)\b|(?:対処|修正|解消|回避|再発防止)/iu;
const RESULT_PATTERN = /\b(?:passed|succeeded|success|0 failures|verified)\b|(?:成功|通った|確認済み|検証済み|0件)/iu;
const URL_PATTERN = /https?:\/\/[^\s)>]+/gu;
const FILE_PATTERN = /(?:^|[\s`(])((?:apps|packages|scripts|docs|src|test|tests|config|migrations)\/[A-Za-z0-9._@/+:-]{2,260})/gu;
const DOCUMENT_REF_PATTERN = /\b(?:ADR[-_ ]?\d+|PR\s*#?\d+|[a-f0-9]{7,40})\b/giu;
const REUSE_PATTERN = /(?:\b(?:if|when|whenever)\b|(?:再発時|次回|同じ症状|場合は)).{8,500}/iu;
const MARKDOWN_TABLE_ROW_PATTERN = /^\|(?:[^|]*\|){2,}$/u;
const MARKDOWN_TABLE_DIVIDER_PATTERN = /^\|?(?:\s*:?-{3,}:?\s*\|){2,}\s*$/u;
const SCHEMA_FRAGMENT_PATTERN = /^(?:`?[A-Za-z_][A-Za-z0-9_.-]{1,63}`?|[A-Z][A-Za-z0-9 _-]{0,31})\s*[:：]\s*[^。.!?]{1,180}$/u;

function collapseWhitespace(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function clip(value, limit) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripMemoryUiDirectives(value) {
  return String(value ?? "")
    .split(/\r?\n/u)
    .filter((line) => !/^\s*::[a-z][a-z0-9-]*(?:\{|$)/iu.test(line))
    .join("\n");
}

export function normalizeMemoryPaths(value, workspaceRoot = null) {
  let normalized = stripMemoryUiDirectives(value);
  const root = typeof workspaceRoot === "string" ? workspaceRoot.replace(/\\/gu, "/").replace(/\/$/u, "") : "";
  if (root) {
    normalized = normalized.replace(new RegExp(`${escapeRegExp(root)}\/`, "gu"), "");
  }
  normalized = normalized
    .replace(/\/Users\/[^/\s]+\/(?:[^\s`'"),:]+\/?)+/gu, "[external-path]")
    .replace(/\/(?:home|private|tmp|var|opt|etc|workspace|workspaces)\/(?:[^\s`'"),:]+\/?)+/gu, "[external-path]")
    .replace(/\b[A-Za-z]:\\Users\\[^\s`'"),:]+/gu, "[external-path]");
  return normalized.replace(/\n{3,}/gu, "\n\n").trim();
}

function phoneMatches(text) {
  const matches = [];
  for (const match of text.matchAll(PHONE_CANDIDATE_PATTERN)) {
    const candidate = match[0];
    const digits = candidate.replace(/\D/gu, "");
    const formatted = /[+() -]/u.test(candidate);
    if (digits.length < 10 || digits.length > 15 || !formatted) continue;
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/u.test(candidate)) continue;
    matches.push(candidate);
  }
  return matches;
}

function replacePhones(text, replacement) {
  let result = text;
  for (const phone of phoneMatches(text)) result = result.split(phone).join(replacement);
  return result;
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

export function screenSensitiveMemory(value, policy = { mode: "deny", allowed_principals: [] }) {
  const original = String(value ?? "");
  const secretCount = SECRET_PATTERNS.reduce((sum, pattern) => sum + countMatches(original, pattern), 0);
  const emailCount = countMatches(original, EMAIL_PATTERN);
  const phoneCount = phoneMatches(original).length;
  const addressCount = ADDRESS_PATTERNS.reduce((sum, pattern) => sum + countMatches(original, pattern), 0);
  const domainSensitive = [PAYMENT_PATTERN, HEALTH_PATTERN, CALENDAR_PATTERN].filter((pattern) => pattern.test(original)).length;
  const counts = {
    secrets: secretCount,
    email_addresses: emailCount,
    phone_numbers: phoneCount,
    addresses: addressCount,
    sensitive_domains: domainSensitive
  };

  if (secretCount > 0) {
    return { allowed: false, hard_reject: true, reason: "credential_detected", text: "", counts, restricted: false };
  }

  const hasPii = emailCount + phoneCount + addressCount + domainSensitive > 0;
  if (!hasPii) {
    return { allowed: true, hard_reject: false, reason: null, text: original, counts, restricted: false };
  }

  const principals = Array.isArray(policy?.allowed_principals)
    ? [...new Set(policy.allowed_principals.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))]
    : [];
  if (policy?.mode !== "restricted_7d" || principals.length === 0) {
    return { allowed: false, hard_reject: false, reason: "sensitive_default_deny", text: "", counts, restricted: false };
  }

  let redacted = original;
  redacted = redacted.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  redacted = replacePhones(redacted, "[REDACTED_PHONE]");
  for (const pattern of ADDRESS_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED_SENSITIVE]");
  redacted = redacted
    .replace(PAYMENT_PATTERN, "[REDACTED_SENSITIVE]")
    .replace(HEALTH_PATTERN, "[REDACTED_SENSITIVE]")
    .replace(CALENDAR_PATTERN, "[REDACTED_SENSITIVE]");
  return {
    allowed: true,
    hard_reject: false,
    reason: "restricted_redaction",
    text: redacted,
    counts,
    restricted: true,
    allowed_principals: principals
  };
}

function section(text, names) {
  const alternatives = names.map(escapeRegExp).join("|");
  const pattern = new RegExp(`(?:^|\\n)#{1,4}\\s*(?:${alternatives})\\s*\\n([\\s\\S]*?)(?=\\n#{1,4}\\s+|$)`, "iu");
  return text.match(pattern)?.[1]?.trim() ?? "";
}

function splitBlocks(text) {
  const blocks = text
    .replace(/\r\n/gu, "\n")
    .split(/\n+|(?<=[。.!?])\s+(?=[A-Z0-9\p{L}])/gu)
    .map((item) => item.replace(/^\s*[-*]\s+/u, "").trim())
    .filter(Boolean);
  const result = [];
  for (const block of blocks) {
    if (block.length <= 900) {
      result.push(block);
      continue;
    }
    result.push(...block.split(/(?<=[。.!?])\s+/u));
  }
  return result.map(collapseWhitespace).filter(Boolean);
}

function normalizeCanonical(value) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/\[external-path\]/gu, "path")
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function classify(block, wholeText) {
  const direct = CLASSIFIERS.find((item) => item.pattern.test(block));
  if (direct) return direct;
  if (CAUSE_PATTERN.test(block) && FIX_PATTERN.test(wholeText)) return CLASSIFIERS.find((item) => item.kind === "pitfall");
  return null;
}

function isTransient(block, wholeText) {
  if (block.length < 20 || TRANSIENT_PATTERNS.some((pattern) => pattern.test(block))) return true;
  const hasCommand = /`[^`\n]+`/u.test(block);
  const commandResultOnly = hasCommand && RESULT_PATTERN.test(block) && !CAUSE_PATTERN.test(wholeText) && !FIX_PATTERN.test(wholeText);
  return commandResultOnly;
}

function isStructuralFragment(block) {
  return MARKDOWN_TABLE_ROW_PATTERN.test(block) ||
    MARKDOWN_TABLE_DIVIDER_PATTERN.test(block) ||
    SCHEMA_FRAGMENT_PATTERN.test(block);
}

function evidenceFromText(text) {
  const evidence = [];
  const seen = new Set();
  const add = (type, ref, note = null) => {
    const key = `${type}:${ref}`;
    if (!ref || seen.has(key) || evidence.length >= 8) return;
    seen.add(key);
    evidence.push({ type, ref: clip(ref, 512), ...(note ? { note: clip(note, 500) } : {}) });
  };
  for (const match of text.matchAll(URL_PATTERN)) add("doc", match[0]);
  for (const match of text.matchAll(FILE_PATTERN)) add("file", match[1]);
  for (const match of text.matchAll(DOCUMENT_REF_PATTERN)) add("external", match[0]);
  // A final answer is an assertion, not an execution record. Command evidence
  // is attached only by the current-turn transcript verifier after it matches a
  // real tool result (or a signed `orgbrain evidence run` attestation).
  return evidence;
}

function rationaleFromText(block, wholeText, explicitReason) {
  if (explicitReason) return clip(collapseWhitespace(explicitReason), 1000);
  const reasonClause = (value) => {
    const match = collapseWhitespace(value).match(
      /(?:\bbecause\b|\bsince\b|理由(?:は|:)|なぜなら|原因(?:は|:))\s*([^。.!?;；]{4,900}[。.!?]?)/iu
    );
    return match?.[1] ? collapseWhitespace(match[1]) : null;
  };
  const directReason = reasonClause(block);
  if (directReason) return clip(directReason, 1000);
  const sentence = splitBlocks(wholeText).find((item) => CAUSE_PATTERN.test(item));
  const contextualReason = sentence ? reasonClause(sentence) : null;
  if (contextualReason && normalizeCanonical(contextualReason) !== normalizeCanonical(block)) {
    return clip(contextualReason, 1000);
  }
  return null;
}

function conclusionFromText(block) {
  const normalized = collapseWhitespace(block);
  const marker = /\s+because\s+|[。;；]?\s*(?:理由(?:は|:)|なぜなら|原因(?:は|:))\s*/iu.exec(normalized);
  if (!marker || marker.index < 8) return normalized;
  const conclusion = normalized.slice(0, marker.index).replace(/[。.!?;；\s]+$/gu, "").trim();
  const reasonAndRemainder = normalized.slice(marker.index + marker[0].length);
  const separator = reasonAndRemainder.search(/[;；]/u);
  const durableRemainder = separator >= 0
    ? reasonAndRemainder.slice(separator + 1).trim()
    : "";
  return collapseWhitespace([conclusion, durableRemainder].filter(Boolean).join("; ")) || normalized;
}

function reuseRuleFromText(wholeText, explicitReuseRule = null) {
  if (explicitReuseRule) return clip(collapseWhitespace(explicitReuseRule), 500);
  const candidate = splitBlocks(wholeText).find((item) => REUSE_PATTERN.test(item));
  return candidate ? clip(candidate, 500) : null;
}

function ordinaryCandidateContext(blocks, index, wholeText) {
  const scoped = [blocks[index]];
  for (let cursor = index + 1; cursor < blocks.length && scoped.length < 4; cursor += 1) {
    if (classify(blocks[cursor], wholeText)) break;
    scoped.push(blocks[cursor]);
  }
  return scoped.join("\n");
}

function summaryFromConclusion(conclusion, kind) {
  const title = collapseWhitespace(conclusion)
    .replace(/[。.!?]+$/gu, "")
    .split(/[;；]/u, 1)[0]
    .trim();
  const labels = {
    decision: "Decision",
    constraint: "Constraint",
    pitfall: "Pitfall",
    preference: "Preference",
    fact: "Fact"
  };
  return clip(`${labels[kind] ?? "Memory"}: ${title}`, 120);
}

function hasDurableEvidence(item) {
  if (item.type === "file") return !item.ref.startsWith("[external-path]");
  if (item.type === "doc" || item.type === "external") return true;
  return item.type === "command" && /exit_code=0/u.test(item.note ?? "");
}

function confidenceFor({ classification, rationale, evidence, projectId, gaps, explicit }) {
  const durableCount = evidence.filter(hasDurableEvidence).length;
  let confidence = classification.confidence + (rationale ? 0.04 : 0) + Math.min(0.08, durableCount * 0.04);
  if (gaps) confidence -= 0.15;
  if (classification.kind === "decision" || classification.kind === "constraint") {
    if (explicit && rationale && projectId && durableCount >= 2 && !gaps) confidence = 0.95;
    else if (explicit && rationale && projectId && durableCount >= 1 && !gaps) confidence = 0.9;
    else confidence = Math.min(confidence, 0.89);
  }
  return Number(Math.max(0.05, Math.min(0.95, confidence)).toFixed(2));
}

export function buildProjectCategoryIdentity(tenantId, projectId, digestHex) {
  const normalizedProject = collapseWhitespace(projectId || "global");
  const slugBase = normalizedProject
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || (projectId ? "project" : "global");
  const hash = String(digestHex ?? "").toLowerCase().replace(/[^a-f0-9]/gu, "").padEnd(24, "0");
  const suffix = hash.slice(0, 8);
  return {
    id: `bc_prj_${hash.slice(0, 24)}`,
    slug: `project-${slugBase.slice(0, 46)}-${suffix}`.slice(0, 64),
    label: projectId || "Global",
    description: `Deterministic project category for ${projectId || "global tenant scope"}`,
    source_key: `${tenantId}\0${projectId || "global"}`
  };
}

export function buildMemoryCaptureCandidateJson(record) {
  const value = (camel, snake, fallback = null) => record?.[camel] ?? record?.[snake] ?? fallback;
  const canonicalEvidence = (Array.isArray(record?.evidence) ? record.evidence : []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const ref = collapseWhitespace(item.ref ?? item.evidence_ref);
    if (!ref) return [];
    const type = collapseWhitespace(item.type ?? item.evidence_type ?? "external");
    const note = collapseWhitespace(item.note);
    const rawWeight = item.weight ?? item.weight_score;
    return [{
      type,
      ref: clip(ref, 512),
      ...(note ? { note: clip(note, 500) } : {}),
      ...(Number.isFinite(rawWeight) ? { weight: Number(rawWeight) } : {})
    }];
  });
  const createdAt = value("createdAt", "created_at");
  const validFrom = value("validFrom", "valid_from", createdAt);
  const validUntil = value("validUntil", "valid_until");
  const sourceReferences = value("sourceReferences", "source_references", value("sourceRefs", "source_refs"));
  const allowedPrincipals = value("allowedPrincipals", "allowed_principals");
  const candidate = {
    external_key: value("externalKey", "external_key"),
    content: clip(value("content", "content", ""), 20_000),
    summary: clip(value("summary", "summary", ""), 1_000),
    tags: Array.isArray(record?.tags) ? record.tags : [],
    created_at: createdAt,
    project_id: value("projectId", "project_id"),
    business_category_id: value("businessCategoryId", "business_category_id"),
    work_type: value("workType", "work_type", "other") ?? "other",
    ...(value("canonicalKey", "canonical_key") ? { canonical_key: value("canonicalKey", "canonical_key") } : {}),
    ...(value("kind", "kind") ? { kind: value("kind", "kind") } : {}),
    ...(value("rationale", "rationale") ? { rationale: clip(value("rationale", "rationale"), 4_000) } : {}),
    ...(value("reuseRule", "reuse_rule") ? { reuse_rule: clip(value("reuseRule", "reuse_rule"), 1_000) } : {}),
    ...(canonicalEvidence.length ? { evidence: canonicalEvidence } : {}),
    ...(Array.isArray(sourceReferences) ? { source_references: sourceReferences } : {}),
    valid_from: validFrom,
    ...(validUntil !== undefined && validUntil !== null ? { valid_until: validUntil } : {}),
    ...(value("confidenceScore", "confidence_score") !== null
      ? { confidence_score: value("confidenceScore", "confidence_score") }
      : {}),
    ...(value("utilityScore", "utility_score") !== null
      ? { utility_score: value("utilityScore", "utility_score") }
      : {}),
    ...(value("visibility", "visibility") ? { visibility: value("visibility", "visibility") } : {}),
    ...(Array.isArray(allowedPrincipals) ? { allowed_principals: allowedPrincipals } : {})
  };
  return candidate;
}

export function extractDurableMemoryDrafts(input, options = {}) {
  const occurredAt = Number.isFinite(input?.occurred_at) ? Math.floor(input.occurred_at) : Date.now();
  const workspaceRoot = options.workspace_root ?? null;
  const normalized = normalizeMemoryPaths(input?.text ?? "", workspaceRoot);
  const screened = screenSensitiveMemory(normalized, options.sensitive_policy);
  const excluded = [];
  if (!screened.allowed) {
    return {
      drafts: [],
      excluded: [{ reason: screened.reason, candidate_hash: null }],
      sensitivity: screened,
      raw_transcript_persisted: false
    };
  }
  if (UNSAFE_INSTRUCTION_PATTERN.test(screened.text)) {
    return {
      drafts: [],
      excluded: [{ reason: "unsafe_instruction", candidate_hash: null }],
      sensitivity: screened,
      raw_transcript_persisted: false
    };
  }

  const conclusionSection = section(screened.text, ["Conclusion", "結論"]);
  const evidenceSection = section(screened.text, ["Evidence", "根拠"]);
  const gapsSection = section(screened.text, ["Gaps", "未解決", "不足"]);
  const reasonSection = section(screened.text, ["Reason", "Rationale", "理由"]);
  const reuseSection = section(screened.text, ["Reuse", "Reuse Rule", "再利用条件", "適用条件"]);
  const candidateSource = conclusionSection || screened.text;
  const structuredInput = Boolean(conclusionSection);
  const seen = new Set();
  const drafts = [];
  const candidateBlocks = splitBlocks(candidateSource);

  const maxCandidates = Math.min(
    options.max_candidates ?? MEMORY_CAPTURE_V2_MAX_CANDIDATES,
    options.capture_profile?.max_candidates ?? MEMORY_CAPTURE_V2_MAX_CANDIDATES
  );
  for (const [blockIndex, block] of candidateBlocks.entries()) {
    if (/^#{1,6}\s/u.test(block) || EXISTING_REDACTION_PATTERN.test(block) && block.length < 40) {
      excluded.push({ reason: "low_signal", preview: clip(block, 80) });
      continue;
    }
    if (isStructuralFragment(block)) {
      excluded.push({ reason: "low_signal", preview: clip(block, 80) });
      continue;
    }
    if (isTransient(block, screened.text)) {
      excluded.push({ reason: "transient", preview: clip(block, 80) });
      continue;
    }
    const classification = classify(block, screened.text);
    if (!classification) {
      excluded.push({ reason: "low_signal", preview: clip(block, 80) });
      continue;
    }
    const conclusion = conclusionFromText(block);
    const canonicalText = normalizeCanonical(conclusion);
    if (!canonicalText || seen.has(`${classification.kind}:${canonicalText}`)) {
      excluded.push({ reason: "duplicate", preview: clip(block, 80) });
      continue;
    }
    seen.add(`${classification.kind}:${canonicalText}`);
    if (drafts.length >= maxCandidates) {
      excluded.push({ reason: "candidate_limit", preview: clip(block, 80) });
      continue;
    }
    const candidateContext = structuredInput
      ? `${evidenceSection}\n${block}`
      : ordinaryCandidateContext(candidateBlocks, blockIndex, screened.text);
    const evidence = evidenceFromText(candidateContext, occurredAt);
    const reuseRule = reuseRuleFromText(candidateContext, reuseSection);
    const rationale = rationaleFromText(block, structuredInput ? screened.text : block, reasonSection);
    const explicit = CLASSIFIERS.find((item) => item.kind === classification.kind)?.pattern.test(block) ?? false;
    const confidence = confidenceFor({
      classification,
      rationale,
      evidence,
      projectId: input.project_id ?? null,
      gaps: gapsSection,
      explicit
    });
    const ttl = screened.restricted ? 7 * DAY_MS : TTL_BY_KIND[classification.kind];
    const validUntil = occurredAt + ttl;
    drafts.push({
      kind: classification.kind,
      content: clip(conclusion, 1000),
      summary: summaryFromConclusion(conclusion, classification.kind),
      rationale,
      reuse_rule: reuseRule,
      evidence,
      source_references: [{ type: "event", ref: input.event_id, captured_at: occurredAt }],
      tags: ["auto-extracted", "capture-v2", classification.kind, `source:${input.source}`],
      valid_from: occurredAt,
      valid_until: validUntil,
      confidence_score: confidence,
      utility_score: Number(Math.min(0.95, 0.62 + evidence.length * 0.04 + (reuseRule ? 0.08 : 0)).toFixed(2)),
      canonical_text: canonicalText,
      visibility: screened.restricted ? "restricted" : input.project_id ? "project" : "tenant",
      allowed_principals: screened.restricted ? screened.allowed_principals : [],
      sensitive: screened.restricted,
      gaps: gapsSection ? clip(collapseWhitespace(gapsSection), 500) : null
    });
  }

  const result = { drafts, excluded, sensitivity: screened, raw_transcript_persisted: false };
  return options.capture_profile
    ? enforceMemoryCaptureHookProfile(result, options.capture_profile)
    : result;
}
