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

function variants(term, literal = false, predicate = false) {
  // Alternatives stay in one required group, unlike the legacy expanded AND.
  // Identifiers, quoted subjects and acronyms must match literally.
  if (literal || !/^[a-z]+$/u.test(term) || term.length < 5) return [term];
  if (term.endsWith("ies")) return [term, `${term.slice(0, -3)}y`];
  if (term.endsWith("s") && !/(?:ss|us|is)$/u.test(term)) return [term, term.slice(0, -1)];
  // Productive suffixes only; never replace a subject with a related concept.
  if (term.endsWith("ily")) return [term, `${term.slice(0, -3)}y`];
  if (term.endsWith("ely")) return [term, term.slice(0, -2)];
  if (predicate) return [term, `${term}${term.endsWith("e") ? "d" : "ed"}`];
  return [term];
}

function literalSubjects(text, strict = false) {
  return [...new Set([
    ...(text.match(/\b(?:[A-Z][A-Z0-9]+|[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*|[A-Za-z]*\d[A-Za-z0-9]*|[A-Za-z0-9]+_[A-Za-z0-9_]+)\b/gu) ?? []).filter((term) => !strict || /[\d_]/u.test(term)),
    ...[...text.matchAll(/(?:"([^"\n]+)"|`([^`\n]+)`)/gu)].map((match) => match[1] ?? match[2])
  ].map(normalize))];
}

const groupsFts = (groups) => groups.map((group) =>
  `(${group.map((term) => `"${term}"`).join(" OR ")})`).join(" AND ");

export function localTaskQueryPlan(query) {
  if (typeof query !== "string" || query.length > 8192) return null;
  const original = query.normalize("NFKC");
  // Preserve scope-bearing acronyms before case folding: US is a region and IT
  // may be a department. Also preserve code identifiers and quoted subjects.
  const literals = new Set(literalSubjects(original).flatMap(words));
  // Only repeated, explicit questions form separate information needs. An
  // ordinary noun conjunction (including an unknown topic) remains all-subject.
  const unquoted = original.replace(/(?:"[^"\n]*"|`[^`\n]*`)/gu, (value) => " ".repeat(value.length));
  const parts = [];
  let start = 0;
  for (const separator of unquoted.matchAll(/\s+and\s+(?=(?:what|which|how|why|when|where)\b)/giu)) {
    parts.push(original.slice(start, separator.index));
    start = separator.index + separator[0].length;
  }
  parts.push(original.slice(start));
  if (parts.length > 3 || (parts.length > 1 && !/^\s*(?:what|which|how|why|when|where)\b/iu.test(parts[0]))) return null;
  const clauses = [];
  for (const part of parts) {
    const subject = normalize(part)
      .replace(/\b(?:in|for|from|within|on)\s+(?:this|our|the current)\s+(?:project|repository|repo|codebase)\b/gu, " ")
      .replace(/(?:この|現在の)(?:プロジェクト|リポジトリ|ソース|コード)(?:で|の|に)?/gu, " ")
      .replace(/について|に関して/gu, " ")
      // A bounded question suffix is a retrieval instruction, not a subject.
      // Keep negation, current-state claims, and verbs elsewhere in the query.
      .replace(/\b(?:should|could|can|must|would)\s+(?:i|we|you)\s+(?:avoid|use|follow|consider|remember|review)\s*[?.!]*$/u, " ");
    const terms = [...new Set(words(subject).filter((term) => !stopWords.has(term) || literals.has(term)))];
    // Never truncate a subject or silently omit an unrecognized clause.
    if (terms.length < 2 || terms.length > 16) return null;
    const predicate = /^\s*(?:what|which|how|why|when|where)\b/iu.test(part)
      && /\b(?:do|does|did)\b/iu.test(part) ? words(part).at(-1) : null;
    const groups = terms.map((term) => variants(term, literals.has(term), term === predicate));
    clauses.push({ groups, fts: groupsFts(groups), literal_subjects: literalSubjects(part),
      strict_literal_subjects: literalSubjects(part, true) });
  }
  const groups = [...new Map(clauses.flatMap((clause) => clause.groups).map((group) => [group[0], group])).values()];
  if (groups.length > 16) return null;
  return { groups, clauses, fts: clauses.length === 1 ? clauses[0].fts
    : clauses.map((clause) => `(${clause.fts})`).join(" OR ") };
}

const memoryText = (memory) => normalize([memory.content, memory.summary, memory.rationale, memory.reuse_rule]
  .filter(Boolean).join("\n"));
const matchesLiterals = (text, clause, strict = false) =>
  ((strict ? clause.strict_literal_subjects : clause.literal_subjects) ?? []).every((subject) => {
    const escaped = subject.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    // ASCII boundaries preserve code identifiers while permitting Japanese particles.
    return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, "u").test(text);
  });

// Numeric/composite code IDs and quoted spans constrain every retrieval channel.
// Entity names also remain literal subjects in the all-subject task lane.
export function matchesLocalTaskQueryLiterals(memory, plan) {
  if (!plan) return true;
  const text = memoryText(memory);
  return (plan.clauses ?? [plan]).some((clause) => matchesLiterals(text, clause, true));
}

export function matchesLocalTaskQuery(memory, plan) {
  if (!plan) return false;
  const text = memoryText(memory);
  const tokens = new Set(words(text));
  return (plan.clauses ?? [plan]).some((clause) => clause.groups.every((group) => group.some((term) => tokens.has(term)))
    && matchesLiterals(text, clause));
}

// Coverage means lexical relevance to every question, never answerability or
// applicability. Callers must still enforce source, permission and evidence gates.
export function coversLocalTaskQuery(memories, plan) {
  return Boolean(plan) && (plan.clauses ?? [plan]).every((clause) =>
    memories.some((memory) => matchesLocalTaskQuery(memory, clause)));
}
