// A bounded, deterministic lexical lane for task-shaped queries. This is not a
// semantic rewrite: unknown subjects remain mandatory and no synonym is added.
const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
const stopWords = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "with", "about",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those",
  "i", "we", "me", "us", "you", "my", "our", "your", "could", "would", "can", "do", "does",
  "please", "help", "investigate", "inspect", "explain", "check", "tell", "show", "summarize",
  "what", "how", "why", "when", "where", "which",
  "の", "と", "を", "が", "は", "で", "に", "も", "へ", "から", "まで", "や",
  "この", "その", "これ", "それ", "です", "ます", "し", "して", "て", "ください",
  "くだ", "さい", "調査", "確認", "説明"
]);
const normalize = (text) => String(text ?? "").normalize("NFKC").toLowerCase();

function words(text) {
  return [...segmenter.segment(normalize(text))].filter((part) => part.isWordLike)
    .flatMap((part) => part.segment.match(/[\p{L}\p{N}]+/gu) ?? []);
}

function variants(term) {
  // Alternatives stay in one required group, unlike the legacy expanded AND.
  if (!/^[a-z]+$/u.test(term) || term.length < 5) return [term];
  if (term.endsWith("ies")) return [term, `${term.slice(0, -3)}y`];
  if (term.endsWith("s") && !/(?:ss|us|is)$/u.test(term)) return [term, term.slice(0, -1)];
  return [term];
}

export function localTaskQueryPlan(query) {
  if (typeof query !== "string" || query.length > 8192) return null;
  // Preserve scope-bearing acronyms before case folding: US is a region and IT
  // may be a department. Treating them as pronouns can retrieve another scope.
  const acronyms = new Set((query.normalize("NFKC").match(/\b[A-Z][A-Z0-9]+\b/gu) ?? [])
    .map((term) => term.toLowerCase()));
  const subject = normalize(query)
    .replace(/\b(?:in|for|from|within|on)\s+(?:this|our|the current)\s+(?:project|repository|repo|codebase)\b/gu, " ")
    .replace(/(?:この|現在の)(?:プロジェクト|リポジトリ|ソース|コード)(?:で|の|に)?/gu, " ")
    .replace(/について|に関して/gu, " ");
  const terms = [...new Set(words(subject).filter((term) => !stopWords.has(term) || acronyms.has(term)))];
  // Never truncate the remaining subject: a later topic must not disappear.
  if (terms.length < 2 || terms.length > 16) return null;
  const groups = terms.map(variants);
  return { groups, fts: groups.map((group) => `(${group.map((term) => `"${term}"`).join(" OR ")})`).join(" AND ") };
}

export function matchesLocalTaskQuery(memory, plan) {
  if (!plan) return false;
  const tokens = new Set(words([memory.content, memory.summary, memory.rationale, memory.reuse_rule]
    .filter(Boolean).join("\n")));
  return plan.groups.every((group) => group.some((term) => tokens.has(term)));
}
