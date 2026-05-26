const LOW_SIGNAL_PREFIXES = [
  "必要な作業は終わっています",
  "ほかに進める内容があれば",
  "route=inline/current-agent",
  "route=inline/current agent"
];

const LOW_SIGNAL_EXACT_TITLES = new Set([
  "起動",
  "修正",
  "削除",
  "空け",
  "実装完了",
  "修正完了",
  "実行結果です",
  "変更しました",
  "改善は実施",
  "1"
]);

const LOW_INFORMATION_TITLE_PATTERNS = [
  /^実行結果(?:です)?$/u,
  /^原因は(?:特定|確定)(?:して)?(?:修正|対処)?(?:済み)?(?:です)?$/u,
  /^修正しました/u,
  /^実装しました/u,
  /^変更しました/u,
  /^改善まで入れて/u,
  /^指摘\s*\d+\s*件/u,
  /^はい[、,]\s*(?:まだ|あります|現状)/u,
  /^コミットまで/u,
  /^残り\s*\d+\s*点/u,
  /^P\d/u,
  /^\{[\s\S]{0,200}\}$/u,
  /^\[[\s\S]{0,200}\]$/u
];

const CAUSE_KEYWORDS = ["原因", "理由", "root cause", "because", "why"];
const FIX_KEYWORDS = ["対処", "再発防止", "fix", "fixed", "workaround", "resolve", "resolved", "solution", "対応"];
const POLICY_KEYWORDS = ["always", "never", "must", "方針", "ルール", "前提", "原則", "recommend", "recommended"];
const RESULT_KEYWORDS = ["成功", "failed", "failure", "succeeded", "success", "通った", "完了", "確認", "restored", "回復", "freed", "0 failures"];
const COMMAND_WORDS = ["pnpm", "npm", "yarn", "bun", "wrangler", "git", "bundle", "rails", "cargo", "pytest", "vitest", "rspec", "curl", "df", "du"];
const STRUCTURED_TAGS = ["project-fact", "failure", "success", "preference", "learning-loop"];
const TEMPORARY_PATTERNS = [
  /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/i,
  /\b(?:localhost|127\.0\.0\.1):\d+\b/i,
  /(?:起動中|ログインした|完了したら|操作してください|未コミット|コミットしていません|Plan mode|まだ未着手)/i,
  /(?:\/tmp\/|tmp\/|\.tmp\b|一時成果物|temporary artifact)/i
];
const VALIDATION_PATTERNS = [
  /\b(?:0 failures|PASS|passed|succeeded|successfully completed)\b/i,
  /(?:確認しました|確認済み|検証|通りました|成功)/u
];
const NEGATIVE_CONFIDENCE_PATTERNS = [/(?:未達|未完了|未確認|代替|推測|まだ|できませんでした|失敗)/u];
const GENERIC_TITLE_PATTERNS = [
  ...LOW_INFORMATION_TITLE_PATTERNS,
  /^実施しました/u,
  /^通りました/u,
  /^完了しています/u,
  /^追加で/u,
  /^追加で/u,
  /^分けて進めました/u
];
const SUMMARY_LIMIT = 240;
const SHORT_LIVED_MS = 14 * 24 * 60 * 60 * 1000;
const MEDIUM_LIVED_MS = 30 * 24 * 60 * 60 * 1000;

export function collapseWhitespace(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function parseTagsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

export function addTags(existing, extra) {
  return [...new Set([...existing, ...extra].filter(Boolean))].slice(0, 16);
}

export function normalizeQualityText(value) {
  return collapseWhitespace(value)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\/Users\/\S+/g, "[path]")
    .replace(/[。．.!！?？]+$/u, "")
    .trim();
}

function extractMemoryTitle(summary) {
  const normalized = normalizeQualityText(summary);
  const markerMatch = normalized.match(/\|\s*(?:promoted-memory|agent-turn-complete|project-fact)\s*\|\s*(.+)$/u);
  return collapseWhitespace(markerMatch?.[1] ?? normalized).replace(/^[*-]\s+/, "");
}

function clip(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function containsAny(text, keywords) {
  const lowered = text.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

function hasCommandSignal(text) {
  if (/`[^`\n]+`/.test(text)) return true;
  const lowered = text.toLowerCase();
  return COMMAND_WORDS.some((word) => lowered.includes(word));
}

function hasReusableStructure(text) {
  return /##\s*(Reuse Rule|Result|Action|Evidence|Takeaway)/i.test(text);
}

function hasActionableList(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)).length >= 2;
}

function isMetaOnly(title, fullText) {
  if (!title) return true;
  if (LOW_SIGNAL_PREFIXES.some((prefix) => title.startsWith(prefix) || fullText.startsWith(prefix))) return true;
  if (LOW_SIGNAL_EXACT_TITLES.has(title.replace(/[。．.!！?？]+$/u, ""))) return true;
  if (/^route=inline\/current[- ]agent$/i.test(title)) return true;
  if (/^実行結果(?:です)?$/u.test(title)) return true;
  if (LOW_INFORMATION_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return true;
  if (/^理由[:：]?\s*\d+$/u.test(title)) return true;
  return false;
}

function hasConcreteDetail(text) {
  if (/`[^`\n]+`/.test(text)) return true;
  if (/\b(?:app|apps|scripts|docs|src|spec|test|tests|config|web|engine|backend|frontend)\//i.test(text)) return true;
  if (/\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|rb|erb|astro|md|yml|yaml|json|sql|rs)\b/.test(text)) return true;
  if (/\b(?:pnpm|npm|yarn|bun|wrangler|git|bundle|rails|cargo|pytest|vitest|rspec|playwright|ffmpeg)\b/i.test(text)) return true;
  if (/\b\d+\s*(?:examples|failures|tests|件|rows|PDFs|ms|tokens)\b/i.test(text)) return true;
  return false;
}

function extractSection(content, heading) {
  const pattern = new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  return String(content ?? "").match(pattern)?.[1]?.trim() ?? "";
}

function splitGuidanceLines(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n+|(?<=[。.!?])\s+/u)
    .map((line) => line.trim().replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""))
    .filter(Boolean);
}

function isGenericTitle(title) {
  const normalized = normalizeQualityText(title).replace(/[。．.!！?？]+$/u, "");
  return (
    LOW_SIGNAL_EXACT_TITLES.has(normalized) ||
    GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    normalized.length < 12
  );
}

function reusableLineScore(line) {
  const normalized = normalizeQualityText(line);
  let score = 0;
  if (containsAny(normalized, CAUSE_KEYWORDS)) score += 3;
  if (containsAny(normalized, FIX_KEYWORDS)) score += 3;
  if (containsAny(normalized, POLICY_KEYWORDS)) score += 2;
  if (containsAny(normalized, RESULT_KEYWORDS)) score += 2;
  if (hasConcreteDetail(normalized)) score += 3;
  if (hasCommandSignal(normalized)) score += 2;
  if (isGenericTitle(normalized)) score -= 4;
  if (normalized.length < 18) score -= 2;
  return score;
}

function inferProjectId(input, tags) {
  if (Object.prototype.hasOwnProperty.call(input, "project_id") && input.project_id === null) return null;
  if (typeof input.project_id === "string" && input.project_id.trim()) return input.project_id.trim();
  const summary = collapseWhitespace(input.summary ?? "");
  const prefix = summary.match(/^([^|]+)\s*\|/)?.[1]?.trim();
  if (prefix && prefix !== "(none)" && prefix !== "(global)") return prefix;
  return tags.find((tag) => !["codex", "hook", "promoted", "curated-memory", "canonical-memory", "memory-digest", "quality-v2", "agent-turn-complete", "global-scope"].includes(tag)) ?? null;
}

function inferCategory(tags, fullText) {
  if (tags.includes("project-fact")) return "project-fact";
  if (tags.includes("project-current-state") || tags.includes("project-health")) return "project-current-state";
  if (tags.includes("artifact") || /(?:\/tmp\/|tmp\/|一時成果物|temporary artifact)/i.test(fullText)) return "artifact";
  if (tags.includes("canonical-memory")) return tags.find((tag) => ["policy", "diagnosis", "command-result", "workaround"].includes(tag)) ?? "canonical";
  if (tags.includes("policy") || containsAny(fullText, POLICY_KEYWORDS)) return "policy";
  if (tags.includes("diagnosis") || (containsAny(fullText, CAUSE_KEYWORDS) && containsAny(fullText, FIX_KEYWORDS))) return "diagnosis";
  if (tags.includes("command-result") || (hasCommandSignal(fullText) && containsAny(fullText, RESULT_KEYWORDS))) return "command-result";
  if (tags.includes("success")) return "success";
  if (tags.includes("failure")) return "failure";
  return "workaround";
}

function chooseUsefulTitle(input, tags, fullText) {
  const summaryTitle = extractMemoryTitle(input.summary ?? "");
  const takeaway = extractSection(input.content, "Takeaway");
  const reuseRule = extractSection(input.content, "Reuse Rule");
  const evidence = extractSection(input.content, "Evidence");
  const takeawayLines = splitGuidanceLines(takeaway).map((line) => normalizeQualityText(line)).filter(Boolean);
  const preferredTakeaway = takeawayLines.find(
    (line) => !isGenericTitle(line) && !VALIDATION_PATTERNS.some((pattern) => pattern.test(line))
  );
  if (preferredTakeaway) return clip(preferredTakeaway, 180);

  const candidates = [
    ...takeawayLines,
    ...splitGuidanceLines(reuseRule),
    ...splitGuidanceLines(evidence).slice(0, 8),
    ...splitGuidanceLines(summaryTitle),
    ...splitGuidanceLines(input.content).slice(0, 12),
    ...splitGuidanceLines(fullText).slice(0, 12)
  ]
    .map((line) => normalizeQualityText(line))
    .filter((line) => line && !/^#/.test(line));

  const firstActionableLine = candidates
    .slice(0, 8)
    .find((line) => !isGenericTitle(line) && !VALIDATION_PATTERNS.some((pattern) => pattern.test(line)) && line.length >= 18);
  if (firstActionableLine) return clip(firstActionableLine, 180);

  const selected = candidates
    .map((line, index) => ({ line, index, score: reusableLineScore(line) }))
    .filter((item) => item.score > -2)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.line;

  const fallback = isGenericTitle(summaryTitle) ? candidates.find((line) => !isGenericTitle(line)) : summaryTitle;
  return clip(collapseWhitespace(selected || fallback || "reusable memory"), 180);
}

function hasTemporarySignal(fullText) {
  return TEMPORARY_PATTERNS.some((pattern) => pattern.test(fullText));
}

function inferExpiry(input, fullText) {
  const tags = Array.isArray(input.tags) ? input.tags : parseTagsJson(input.tags_json);
  if (tags.includes("canonical-memory") || tags.includes("memory-digest")) return { expires_at: null, reason: null };
  if (!hasTemporarySignal(fullText)) return { expires_at: null, reason: null };
  const createdAt = Number(input.created_at);
  const base = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Date.now();
  const ttl = /(?:\/tmp\/|tmp\/|未コミット|コミットしていません|一時成果物|temporary artifact)/i.test(fullText)
    ? MEDIUM_LIVED_MS
    : SHORT_LIVED_MS;
  return { expires_at: base + ttl, reason: ttl === MEDIUM_LIVED_MS ? "temporary-artifact-or-uncommitted" : "session-or-local-state" };
}

function stripSummaryPrefix(title, projectId, category) {
  let result = collapseWhitespace(title);
  const projectPattern = projectId ? projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "\\(global\\)|\\(none\\)";
  result = result.replace(new RegExp(`^(?:${projectPattern})\\s*\\|\\s*`, "u"), "");
  result = result.replace(new RegExp(`^(?:${category}|promoted-memory|agent-turn-complete|project-fact)\\s*\\|\\s*`, "u"), "");
  return result;
}

function clampScore(value) {
  return Number(Math.max(0.05, Math.min(0.95, value)).toFixed(2));
}

function scoreUsefulness(input, tags, category, fullText, action) {
  let utility = action === "delete" ? 0.12 : 0.45;
  let confidence = action === "delete" ? 0.25 : 0.45;

  if (["policy", "project-fact", "canonical", "project-current-state"].includes(category)) utility += 0.25;
  if (category === "diagnosis") utility += 0.2;
  if (category === "command-result") utility += 0.15;
  if (tags.includes("canonical-memory") || tags.includes("curated-memory")) utility += 0.08;
  if (hasConcreteDetail(fullText)) utility += 0.1;
  if (hasCommandSignal(fullText)) utility += 0.08;
  if (hasTemporarySignal(fullText)) utility -= 0.25;
  if (isGenericTitle(extractMemoryTitle(input.summary ?? ""))) utility -= 0.08;

  if (VALIDATION_PATTERNS.some((pattern) => pattern.test(fullText))) confidence += 0.17;
  if (hasCommandSignal(fullText)) confidence += 0.1;
  if (containsAny(fullText, CAUSE_KEYWORDS) && containsAny(fullText, FIX_KEYWORDS)) confidence += 0.1;
  if (hasConcreteDetail(fullText)) confidence += 0.08;
  if (NEGATIVE_CONFIDENCE_PATTERNS.some((pattern) => pattern.test(fullText))) confidence -= 0.18;
  if (hasTemporarySignal(fullText)) confidence -= 0.08;

  return {
    utility_score: clampScore(utility),
    confidence_score: clampScore(confidence)
  };
}

export function assessMemoryUsefulness(input, options = {}) {
  const tags = Array.isArray(input.tags) ? input.tags : parseTagsJson(input.tags_json);
  const quality = classifyMemoryQuality(input, options);
  const fullText = normalizeQualityText(`${input.summary ?? ""}\n${input.content ?? input.assistantText ?? ""}`);
  const projectId = inferProjectId(input, tags);
  const category = inferCategory(tags, fullText);
  const title = stripSummaryPrefix(chooseUsefulTitle(input, tags, fullText), projectId, category);
  const summary = clip(`${projectId || "(global)"} | ${category} | ${title}`, SUMMARY_LIMIT);
  const expiry = inferExpiry(input, fullText);
  const scores = scoreUsefulness(input, tags, category, fullText, quality.action);
  const originalSummary = collapseWhitespace(input.summary ?? "");
  const shortSummaryCandidate = originalSummary.length > 0 && originalSummary.length < 80 && normalizeQualityText(originalSummary) !== normalizeQualityText(summary);
  const suppressionCandidate = quality.action === "delete";
  const artifactExpiryCandidate = expiry.expires_at !== null && (category === "artifact" || /(?:\/tmp\/|tmp\/|一時成果物|temporary artifact)/i.test(fullText));

  return {
    ...quality,
    category,
    summary,
    utility_score: scores.utility_score,
    confidence_score: scores.confidence_score,
    expires_at: expiry.expires_at,
    expires_reason: expiry.reason,
    risky_low_signal: suppressionCandidate,
    suppression_candidate: suppressionCandidate,
    short_summary_candidate: shortSummaryCandidate,
    artifact_expiry_candidate: artifactExpiryCandidate,
    temporary: expiry.expires_at !== null
  };
}

export function classifyMemoryQuality(input, options = {}) {
  const tags = Array.isArray(input.tags) ? input.tags : parseTagsJson(input.tags_json);
  const summary = collapseWhitespace(input.summary ?? "");
  const content = collapseWhitespace(input.content ?? input.assistantText ?? "");
  const fullText = normalizeQualityText(`${summary}\n${content}`);
  const title = extractMemoryTitle(summary || content);
  const keepProjectFacts = options.keepProjectFacts ?? true;

  if (
    (tags.includes("canonical-memory") || tags.includes("memory-digest")) &&
    tags.includes("quality-v2") &&
    /(?:stable summaries|reusable rules)/i.test(summary)
  ) {
    return { action: "delete", quality: "generated-rollup", reason: "count-only-rollup" };
  }

  if ((tags.includes("canonical-memory") || tags.includes("memory-digest")) && tags.includes("quality-v2")) {
    return { action: "keep", quality: "generated-rollup", reason: "quality-v2-rollup" };
  }

  if (tags.includes("canonical-memory") || tags.includes("memory-digest")) {
    return { action: "delete", quality: "generated-rollup", reason: "generated-rollup" };
  }

  if (tags.includes("compacted") || input.lifecycle_state === "suppressed") {
    return { action: "delete", quality: "already-suppressed", reason: "already-suppressed" };
  }

  if (tags.includes("message") || tags.includes("preprocessed") || /heartbeat/i.test(fullText)) {
    return { action: "delete", quality: "meta-only", reason: "preprocessed-or-heartbeat" };
  }

  if (
    keepProjectFacts &&
    (tags.includes("project-fact") || /^#\s*Project Fact/im.test(content)) &&
    tags.includes("curated-memory") &&
    input.kind === "semantic" &&
    (!input.lifecycle_state || input.lifecycle_state === "active")
  ) {
    return { action: "keep", quality: "project-fact", reason: "structured-project-fact-ready" };
  }

  if (keepProjectFacts && (tags.includes("project-fact") || /^#\s*Project Fact/im.test(content))) {
    return { action: "promote", quality: "project-fact", reason: "structured-project-fact" };
  }

  if (tags.some((tag) => STRUCTURED_TAGS.includes(tag)) || /^#\s*Learning Entry/im.test(content)) {
    return { action: "promote", quality: "structured-learning", reason: "structured-learning" };
  }

  if (isMetaOnly(title, fullText)) {
    return { action: "delete", quality: "low-signal", reason: "meta-only-title" };
  }

  const hasDetails = hasConcreteDetail(fullText);
  const hasCauseAndFix = containsAny(fullText, CAUSE_KEYWORDS) && containsAny(fullText, FIX_KEYWORDS) && hasDetails;
  const hasCommandAndResult = hasCommandSignal(fullText) && containsAny(fullText, RESULT_KEYWORDS);
  const hasReusableContent = hasReusableStructure(content) && (hasCauseAndFix || hasCommandAndResult || hasActionableList(content));

  if (hasCauseAndFix || hasCommandAndResult || hasReusableContent) {
    return { action: "keep", quality: "reusable", reason: hasCauseAndFix ? "cause-and-fix" : "command-and-result" };
  }

  if (tags.includes("promoted") || tags.includes("curated-memory")) {
    return { action: "delete", quality: "thin-promoted", reason: "promoted-without-reuse-signal" };
  }

  return { action: "delete", quality: "low-signal", reason: "no-reuse-signal" };
}

export function isLowSignalMemory(input, options = {}) {
  return classifyMemoryQuality(input, options).action === "delete";
}
