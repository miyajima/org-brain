// Keep the existing local import path compatible. The planner is shared with Cloud.
export { localTaskQueryPlan, matchesLocalTaskQuery, coversLocalTaskQuery, matchesLocalTaskQueryLiterals } from "@org-brain/shared/runtime/task-query-runtime";

const equivalentPhrases = new Map([
  ["投稿許可", "投稿承認"], ["投稿承認", "投稿許可"],
  ["発信元電話番号", "発信元番号"], ["発信元番号", "発信元電話番号"],
  ["応答の遅れ", "応答遅延"], ["応答遅延", "応答の遅れ"]
]);
const literalOrPhrase = new RegExp(`"[^"\\n]*"|\x60[^\x60\\n]*\x60|「[^」\\n]*」|『[^』\\n]*』|(?:${[...equivalentPhrases.keys()].join("|")})(?![\\p{Script=Han}a-zA-Z0-9_])`, "gu");

export function localAliasQuery(query) {
  if (typeof query !== "string" || query.length > 8192) return null;
  const normalized = query.normalize("NFKC");
  const rewritten = normalized.replace(literalOrPhrase, (value) => equivalentPhrases.get(value) ?? value);
  return rewritten === normalized ? null : rewritten;
}
