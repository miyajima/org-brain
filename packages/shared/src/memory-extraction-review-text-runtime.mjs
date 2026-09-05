export const MEMORY_EXTRACTION_REVIEW_TEXT_CONTRACT = "orgbrain-memory-extraction-review-text/v1";

const URL_REFERENCE = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const PATH_REFERENCE = /(?:[A-Za-z]:[\\/][A-Za-z0-9_@.-]+(?:[\\/][A-Za-z0-9_@.-]+)*|(?:~|\.{1,2})[\\/][A-Za-z0-9_@.-]+(?:[\\/][A-Za-z0-9_@.-]+)*|[\\/](?:[A-Za-z0-9_@.-]+[\\/])+[A-Za-z0-9_@.-]+|(?:[A-Za-z0-9_@.-]+[\\/])+[A-Za-z0-9_@.-]+)/giu;
const FILE_NAME_REFERENCE = /(?<![A-Za-z0-9_@.-])(?:\.[A-Za-z0-9][A-Za-z0-9_.-]*|(?:Dockerfile|Gemfile|Justfile|LICENSE|Makefile|Procfile|README|Rakefile|Taskfile|Vagrantfile)(?:\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_@-]+\.[A-Za-z][A-Za-z0-9]{0,11})(?![A-Za-z0-9_@.-])/giu;
const FILE_ONLY_LINE = /^(?:(?:[-*+]\s+)|(?:\d+[.)]\s+))?(?:既存資料|対象ファイル)(?:\s*[（(][^）)]*[）)])?\s*$/u;
const EMPTY_LABEL_LINE = /^(?:(?:[-*+]\s+)|(?:\d+[.)]\s+))?(?:対象|対象ファイル|files?|paths?)\s*:?\s*$/iu;

function matches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function stripMemoryCitationBlocks(content) {
  return String(content ?? "")
    .replace(/<oai-mem-citation\b[^>]*>[\s\S]*?<\/oai-mem-citation>/giu, "")
    .replace(/<(?:citation_entries|rollout_ids)\b[^>]*>[\s\S]*?<\/(?:citation_entries|rollout_ids)>/giu, "");
}

export function looksLikeMemoryExtractionFileReference(value) {
  const normalized = String(value ?? "").trim();
  return matches(URL_REFERENCE, normalized)
    || matches(PATH_REFERENCE, normalized)
    || matches(FILE_NAME_REFERENCE, normalized)
    || /^(?!https?:\/\/).+[\\/].+$/iu.test(normalized);
}

function replaceFileReferences(value) {
  return value
    .replace(URL_REFERENCE, "外部参照")
    .replace(PATH_REFERENCE, "対象ファイル")
    .replace(FILE_NAME_REFERENCE, "対象ファイル");
}

export function sanitizeMemoryExtractionReviewText(content) {
  const withoutMarkup = stripMemoryCitationBlocks(content)
    .replace(/<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[^<>\n]{0,200})?\s*\/?>/gu, "")
    .replace(/^\s*(?:```|~~~)[^\n]*$/gmu, "")
    .replace(/(?:```|~~~)(?:[A-Za-z0-9_-]+)?\s*/gu, "")
    .replace(/\[([^\]]+)\]\(\s*<([^>]+)>(?:\s+["'][^"']*["'])?\s*\)/gu, (_match, label, target) =>
      looksLikeMemoryExtractionFileReference(label) || looksLikeMemoryExtractionFileReference(target) ? "既存資料" : label)
    .replace(/\[([^\]]+)\]\(\s*([^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gu, (_match, label, target) =>
      looksLikeMemoryExtractionFileReference(label) || looksLikeMemoryExtractionFileReference(target) ? "既存資料" : label)
    .replace(/`([^`\n]+)`/gu, (_match, value) =>
      looksLikeMemoryExtractionFileReference(value) ? "対象ファイル" : value)
    .replace(/`+/gu, "");
  const withoutFileReferences = replaceFileReferences(withoutMarkup)
    .replace(/(?:主な変更|対象ファイル|files?)\s*:\s*(?:(?:既存資料|対象ファイル)\s*[、,]?\s*)+/giu, "")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "");
  const lines = withoutFileReferences.split(/\r?\n/u)
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .filter((line) => {
      const compact = line.trim();
      return !compact || (!FILE_ONLY_LINE.test(compact) && !EMPTY_LABEL_LINE.test(compact));
    });
  const sanitized = lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return sanitized || "（ファイル参照・構造タグのみのため評価本文なし）";
}

export function sanitizeMemoryExtractionReviewCase(evaluationCase) {
  return {
    ...evaluationCase,
    turns: (evaluationCase.turns ?? []).map((turn) => ({
      ...turn,
      content: sanitizeMemoryExtractionReviewText(turn.content)
    }))
  };
}

export function isSanitizedMemoryExtractionReviewText(content) {
  return sanitizeMemoryExtractionReviewText(content) === content;
}
