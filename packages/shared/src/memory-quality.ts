const DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_LIMIT = 240;

export type MemoryQualityInput = {
  id?: string | null;
  project_id?: string | null;
  source?: string | null;
  summary?: string | null;
  content?: string | null;
  tags?: string[] | null;
  tags_json?: string | null;
  created_at?: number | null;
  utility_score?: number | null;
  confidence_score?: number | null;
  expires_at?: number | null;
};

export type MemoryQualityAssessment = {
  summary: string;
  utility_score: number;
  confidence_score: number;
  expires_at: number | null;
  category: string;
  reason: string;
  expires_reason: string | null;
  risky_low_signal: boolean;
  suppression_candidate: boolean;
  short_summary_candidate: boolean;
  artifact_expiry_candidate: boolean;
};

function collapseWhitespace(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function clip(value: unknown, limit = SUMMARY_LIMIT): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, Math.max(0, limit - 1)).trimEnd();
}

function parseTags(input: Pick<MemoryQualityInput, "tags" | "tags_json">): string[] {
  if (Array.isArray(input.tags)) {
    return [...new Set(input.tags.map((tag) => collapseWhitespace(tag)).filter(Boolean))];
  }
  if (!input.tags_json) return [];
  try {
    const parsed = JSON.parse(input.tags_json);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((tag) => collapseWhitespace(tag)).filter(Boolean))];
  } catch {
    return [];
  }
}

function stripMarkdownNoise(value: string): string {
  return collapseWhitespace(value)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\/Users\/\S+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSummaryPrefix(value: string): string {
  return collapseWhitespace(value)
    .replace(/^.*?\|\s*(?:promoted-memory|agent-turn-complete|project-fact|memory-digest|canonical-memory)\s*\|\s*/u, "")
    .replace(/^(?:実施しました|通りました|原因は特定して修正しました|原因は確定して対処済み)[。．.!！?？\s]*/u, "")
    .trim();
}

function isWeakSummary(value: string): boolean {
  const normalized = stripMarkdownNoise(stripSummaryPrefix(value)).replace(/[。．.!！?？]+$/u, "");
  if (!normalized || normalized.length < 18) return true;
  if (/::git-(?:stage|commit|push|create-branch|create-pr)\{/u.test(value)) return true;
  if (/^(?:実施しました|通りました|修正しました|実装しました|変更しました|完了しました|原因は特定して修正しました)$/u.test(normalized)) {
    return true;
  }
  if (/^route=inline\/current[- ]agent$/i.test(normalized)) return true;
  if (/^(?:\{|\[).*(?:\}|\])$/s.test(normalized) && normalized.length < 160) return true;
  return /^(?:P\d|1|理由[:：]?\s*\d+)$/u.test(normalized);
}

function inferProject(input: MemoryQualityInput, tags: string[]): string {
  const explicit = collapseWhitespace(input.project_id);
  if (explicit) return explicit;
  const projectTag = tags.find((tag) => /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(tag) && !GENERIC_TAGS.has(tag));
  return projectTag || "(none)";
}

const GENERIC_TAGS = new Set([
  "hook",
  "promoted",
  "compacted",
  "agent-turn-complete",
  "curated-memory",
  "canonical-memory",
  "memory-digest",
  "org-brain",
  "maintenance",
  "quality-v2",
  "project-health"
]);

function inferCategory(tags: string[], text: string): string {
  const ordered = [
    "project-current-state",
    "policy",
    "workaround",
    "diagnosis",
    "command-result",
    "success",
    "failure",
    "preference",
    "artifact",
    "project-fact"
  ];
  for (const tag of ordered) {
    if (tags.includes(tag)) return tag;
  }
  if (/(?:原因|root cause|diagnosis|failed|failure|エラー|失敗)/i.test(text)) return "diagnosis";
  if (/(?:pnpm|npm|wrangler|git|bundle|rails|pytest|vitest|rspec|playwright)/i.test(text)) return "command-result";
  if (/(?:\/tmp|artifact|成果物|ログ|log)/i.test(text)) return "artifact";
  return "general";
}

function candidateLines(content: string, summary: string): string[] {
  return [...content.split(/\r?\n/), summary]
    .map((line) => stripMarkdownNoise(line.replace(/^[-*]\s+/, "")))
    .map(stripSummaryPrefix)
    .filter(Boolean)
    .filter((line) => !/^(?:Source|Event|Project|RecordedAt|Tenant|Category|TopTags):/i.test(line));
}

function hasConcreteSignal(value: string): boolean {
  return (
    /\b(?:apps|scripts|docs|src|packages|backend|frontend|test|tests)\//i.test(value) ||
    /\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|rb|erb|astro|md|yml|yaml|json|sql|rs)\b/.test(value) ||
    /\b(?:pnpm|npm|wrangler|git|bundle|rails|cargo|pytest|vitest|rspec|playwright|curl)\b/i.test(value) ||
    /\b\d+\s*(?:件|rows|tests|failures|ms|tokens)\b/i.test(value)
  );
}

function selectTitle(summary: string, content: string): string {
  const lines = candidateLines(content, summary).filter((line) => !isWeakSummary(line));
  return (
    lines.find((line) => /(?:Takeaway|原因|対応|検証|confirmed|success|failed|fix|deploy|snapshot)/i.test(line) && hasConcreteSignal(line)) ||
    lines.find(hasConcreteSignal) ||
    lines.find((line) => line.length >= 24) ||
    stripSummaryPrefix(summary) ||
    stripMarkdownNoise(content) ||
    "memory item"
  );
}

function scoreUtility(tags: string[], text: string, category: string): number {
  let score = 0.48;
  if (["policy", "workaround", "diagnosis", "project-current-state", "project-fact"].includes(category)) score += 0.22;
  if (tags.some((tag) => ["canonical-memory", "curated-memory", "project-fact", "quality-v2"].includes(tag))) score += 0.14;
  if (hasConcreteSignal(text)) score += 0.1;
  if (/(?:再発時|runbook|手順|policy|方針|復旧|workaround|decision|決定)/i.test(text)) score += 0.08;
  if (/(?:実施しました|完了しました|通りました|route=inline|::git-)/i.test(text)) score -= 0.18;
  if (/(?:\/tmp|localhost|127\.0\.0\.1|ログイン中|未コミット|dirty|artifact)/i.test(text)) score -= 0.12;
  return Number(Math.min(0.95, Math.max(0.15, score)).toFixed(3));
}

function scoreConfidence(text: string): number {
  let score = 0.42;
  if (/(?:pnpm|npm|wrangler|git|bundle|rails|pytest|vitest|rspec|playwright|curl)\b/i.test(text)) score += 0.16;
  if (/(?:成功|success|succeeded|passed|通った|0 failures|確認済み|confirmed|smoke)/i.test(text)) score += 0.15;
  if (/(?:failed|failure|失敗|blocked|未確認|推測|plan only|予定)/i.test(text)) score -= 0.12;
  if (/\b(?:apps|scripts|docs|src|packages)\//i.test(text) || /\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|rb|md|json|sql)\b/.test(text)) score += 0.1;
  if (/(?:原因|root cause|対応|fix|修正|deploy|test|検証)/i.test(text)) score += 0.08;
  return Number(Math.min(0.95, Math.max(0.2, score)).toFixed(3));
}

function inferExpiry(input: MemoryQualityInput, tags: string[], text: string): { value: number | null; reason: string | null } {
  if (tags.includes("canonical-memory") || tags.includes("project-current-state") || tags.includes("policy") || tags.includes("workaround")) {
    if (!/(?:\/tmp|localhost|127\.0\.0\.1|ログイン中|未コミット|dirty|artifact)/i.test(text)) return { value: null, reason: null };
  }
  const createdAt = typeof input.created_at === "number" && Number.isFinite(input.created_at) ? input.created_at : Date.now();
  if (/(?:\/tmp|artifact|ログ|log|localhost|127\.0\.0\.1|dev server|起動中)/i.test(text)) {
    return { value: createdAt + 14 * DAY_MS, reason: "temporary-artifact-or-runtime-state" };
  }
  if (/(?:ログイン中|未コミット|dirty|一時|temporary)/i.test(text)) {
    return { value: createdAt + 7 * DAY_MS, reason: "temporary-local-state" };
  }
  if (tags.includes("memory-digest") || tags.includes("compacted")) {
    return { value: createdAt + 180 * DAY_MS, reason: "derived-maintenance-record" };
  }
  return { value: null, reason: null };
}

export function assessMemoryUsefulness(input: MemoryQualityInput): MemoryQualityAssessment {
  const tags = parseTags(input);
  const summary = collapseWhitespace(input.summary);
  const content = collapseWhitespace(input.content);
  const text = `${summary}\n${content}`;
  const project = inferProject(input, tags);
  const category = inferCategory(tags, text);
  const title = clip(selectTitle(summary, content), 180);
  const normalizedSummary = clip(`${project} | ${category} | ${title}`, SUMMARY_LIMIT);
  const utilityScore = scoreUtility(tags, text, category);
  const confidenceScore = scoreConfidence(text);
  const expiry = inferExpiry(input, tags, text);
  const riskyLowSignal = isWeakSummary(summary) && !hasConcreteSignal(text) && utilityScore < 0.45;
  const shortSummaryCandidate = summary.length > 0 && summary.length < 80 && stripMarkdownNoise(summary) !== stripMarkdownNoise(normalizedSummary);
  const artifactExpiryCandidate = expiry.value !== null && (category === "artifact" || /(?:\/tmp|artifact|成果物|ログ|log)/i.test(text));

  return {
    summary: normalizedSummary,
    utility_score: utilityScore,
    confidence_score: confidenceScore,
    expires_at: expiry.value,
    category,
    reason: riskyLowSignal ? "low-signal-memory" : "quality-assessed",
    expires_reason: expiry.reason,
    risky_low_signal: riskyLowSignal,
    suppression_candidate: riskyLowSignal,
    short_summary_candidate: shortSummaryCandidate,
    artifact_expiry_candidate: artifactExpiryCandidate
  };
}
