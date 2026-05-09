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
  /^P\d/u
];

const CAUSE_KEYWORDS = ["原因", "理由", "root cause", "because", "why"];
const FIX_KEYWORDS = ["対処", "再発防止", "fix", "fixed", "workaround", "resolve", "resolved", "solution", "対応"];
const RESULT_KEYWORDS = ["成功", "failed", "failure", "succeeded", "success", "通った", "完了", "確認", "restored", "回復", "freed", "0 failures"];
const COMMAND_WORDS = ["pnpm", "npm", "yarn", "bun", "wrangler", "git", "bundle", "rails", "cargo", "pytest", "vitest", "rspec", "df", "du"];
const STRUCTURED_TAGS = ["project-fact", "failure", "success", "preference", "learning-loop"];

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
