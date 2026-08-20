import type { RecallProfileV1 } from "@org-brain/contracts";

export type DomainRecallQuery = {
  tenant_id: string;
  project_id?: string | null;
  prompt: string;
  object_type_key?: string | null;
  object_id?: string | null;
  scope?: Record<string, string>;
};

export type DomainRecallRankingCandidate = {
  id: string;
  tenant_id: string;
  project_id?: string | null;
  object_type_key: string;
  object_id?: string | null;
  intent_aliases?: string[];
  scope?: Record<string, string>;
  relation: "primary" | "supporting" | "conflict";
  has_decision_link: boolean;
  decision_state: "proposal" | "confirmed" | "superseded" | "conflict";
  evidence_verified: boolean;
  metric_fresh: boolean;
  acl_allowed: boolean;
  personally_suppressed?: boolean;
};

export type RankedDomainRecallCandidate = DomainRecallRankingCandidate & {
  score: {
    object_match: number;
    intent_match: number;
    scope_match: number;
    decision_link: number;
    active_confirmed: number;
    verified_evidence: number;
    fresh_metric: number;
    total: number;
  };
  why_recalled: string[];
};

const normalized = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase();
const rounded = (value: number): number => Number(value.toFixed(4));

function phraseMatches(prompt: string, phrases: string[]): boolean {
  const haystack = normalized(prompt);
  return phrases.some((phrase) => haystack.includes(normalized(phrase)));
}

function exactScopeMatch(requiredKeys: string[], query: Record<string, string>, candidate: Record<string, string>): boolean {
  return requiredKeys.every((key) => query[key] !== undefined && candidate[key] === query[key]);
}

export function rankDomainRecallCandidates(
  profile: RecallProfileV1,
  query: DomainRecallQuery,
  candidates: DomainRecallRankingCandidate[]
): RankedDomainRecallCandidate[] {
  const queryScope = query.scope ?? {};
  return candidates.flatMap((candidate): RankedDomainRecallCandidate[] => {
    if (!candidate.acl_allowed || candidate.personally_suppressed) return [];
    if (candidate.tenant_id !== query.tenant_id) return [];
    if (query.project_id && candidate.project_id !== query.project_id) return [];
    if (query.object_id && candidate.object_id !== query.object_id) return [];
    if (query.object_type_key && candidate.object_type_key !== query.object_type_key) return [];
    const candidateScope = candidate.scope ?? {};
    if (profile.required_scope_keys.length > 0 && !exactScopeMatch(profile.required_scope_keys, queryScope, candidateScope)) return [];

    const objectMatched = profile.object_type_keys.includes(candidate.object_type_key) &&
      (!query.object_id || candidate.object_id === query.object_id);
    const intentMatched = phraseMatches(query.prompt, [...profile.intent_aliases, ...(candidate.intent_aliases ?? [])]);
    const comparableScopeKeys = Object.keys(queryScope);
    const scopeMatched = comparableScopeKeys.length > 0 && comparableScopeKeys.every((key) => candidateScope[key] === queryScope[key]);
    const score = {
      object_match: objectMatched ? 0.35 : 0,
      intent_match: intentMatched ? 0.2 : 0,
      scope_match: scopeMatched || (query.project_id !== undefined && candidate.project_id === query.project_id) ? 0.15 : 0,
      decision_link: candidate.has_decision_link ? 0.1 : 0,
      active_confirmed: candidate.decision_state === "confirmed" ? 0.08 : 0,
      verified_evidence: candidate.evidence_verified ? 0.07 : 0,
      fresh_metric: candidate.metric_fresh ? 0.05 : 0,
      total: 0
    };
    score.total = rounded(Object.entries(score).filter(([key]) => key !== "total").reduce((sum, [, value]) => sum + value, 0));
    if (score.total < profile.auto_recall_threshold) return [];
    const why = [
      objectMatched ? `object:${candidate.object_type_key}` : null,
      intentMatched ? "intent" : null,
      scopeMatched ? "scope" : null,
      candidate.has_decision_link ? "decision_link" : null,
      candidate.decision_state === "confirmed" ? "active_confirmed" : `decision_state:${candidate.decision_state}`,
      candidate.evidence_verified ? "verified_evidence" : null,
      candidate.metric_fresh ? "fresh_metric" : null
    ].filter((value): value is string => value !== null);
    return [{ ...candidate, score, why_recalled: why }];
  }).sort((left, right) => right.score.total - left.score.total || left.id.localeCompare(right.id));
}

export function selectDomainRecallCandidates(profile: RecallProfileV1, query: DomainRecallQuery, candidates: DomainRecallRankingCandidate[]) {
  const ranked = rankDomainRecallCandidates(profile, query, candidates);
  const nonConflicts = ranked.filter((candidate) => candidate.relation !== "conflict");
  return {
    primary: nonConflicts[0] ?? null,
    supporting: nonConflicts.slice(1, 3),
    conflicts: ranked.filter((candidate) => candidate.relation === "conflict").slice(0, 2)
  };
}
