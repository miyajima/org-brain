import type { MemoryContractV2Event } from "./memory-contract-v2";
export type VerifiedExtractionCandidate = {
  external_key: string;
  observation: MemoryContractV2Event;
  persistence: string;
  memory_kind: string;
  action: string;
  target_memory_id: string | null;
  support_span_ids: string[];
  gaps: string[];
  reason_codes: string[];
};
export function verifiedCandidates(input: any, candidates: any[]): Promise<{
  candidates: VerifiedExtractionCandidate[];
  rejections: Array<{ candidate_index: number; reason_codes: string[] }>;
  accepted_indices: number[];
}>;
