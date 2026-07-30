import {
  DurableRuleMemoryExtractor,
  type AgentMemoryEventV1,
  type ExtractedMemoryCandidate,
  type MemoryExtractionResult
} from "@org-brain/shared";
import type { Env } from "./types";

const extractor = new DurableRuleMemoryExtractor();

type ExistingCandidateRow = {
  id: string;
  content: string;
  content_hash: string;
  canonical_key: string | null;
  valid_until: number | null;
};

type CandidateReview = {
  action: "create" | "duplicate" | "update_candidate" | "conflict_candidate";
  existing_memory_ids: string[];
  reason: string;
};

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length >= 2)
  );
}

function similarity(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function negative(value: string): boolean {
  return /\b(?:not|never|no longer|prohibited|deprecated)\b|(?:ない|禁止|廃止|非推奨)/iu.test(value);
}

async function reviewCandidate(
  env: Env,
  candidate: ExtractedMemoryCandidate
): Promise<CandidateReview> {
  const rows = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, content, content_hash, canonical_key, valid_until
     FROM memories
     WHERE tenant_id = ?
       AND (? IS NULL OR project_id = ?)
       AND kind = ?
       AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
     ORDER BY updated_at DESC
     LIMIT 32`
  )
    .bind(candidate.tenant_id, candidate.project_id, candidate.project_id, candidate.kind)
    .all<ExistingCandidateRow>();
  const exact = rows.results.filter(
    (row) =>
      row.content_hash === candidate.content_hash ||
      (row.canonical_key !== null && row.canonical_key === candidate.canonical_key)
  );
  if (exact.length > 0) {
    return {
      action: "duplicate",
      existing_memory_ids: exact.map((row) => row.id),
      reason: "same canonical key or content hash already exists"
    };
  }
  const related = rows.results
    .map((row) => ({ row, similarity: similarity(candidate.content, row.content) }))
    .filter((item) => item.similarity >= 0.45)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 5);
  const conflicting = related.filter((item) => negative(item.row.content) !== negative(candidate.content));
  if (conflicting.length > 0) {
    return {
      action: "conflict_candidate",
      existing_memory_ids: conflicting.map((item) => item.row.id),
      reason: "similar durable statement has opposite polarity"
    };
  }
  if (related.length > 0) {
    return {
      action: "update_candidate",
      existing_memory_ids: related.map((item) => item.row.id),
      reason: "similar durable statement may supersede or refine existing memory"
    };
  }
  return { action: "create", existing_memory_ids: [], reason: "no related durable memory found" };
}

export async function extractMemoryCandidates(
  env: Env,
  event: AgentMemoryEventV1
): Promise<MemoryExtractionResult & {
  candidates: Array<ExtractedMemoryCandidate & { review: CandidateReview }>;
  expiry_candidates: string[];
}> {
  const result = await extractor.extract(event);
  const candidates = await Promise.all(
    result.candidates.map(async (candidate) => ({
      ...candidate,
      review: await reviewCandidate(env, candidate)
    }))
  );
  const expiry = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id FROM memories
     WHERE tenant_id = ? AND valid_until IS NOT NULL AND valid_until <= ?
       AND (lifecycle_state IS NULL OR lifecycle_state != 'suppressed')
     ORDER BY valid_until
     LIMIT 100`
  ).bind(event.tenant_id, Date.now()).all<{ id: string }>();
  return {
    ...result,
    candidates,
    expiry_candidates: expiry.results.map((row) => row.id)
  };
}
