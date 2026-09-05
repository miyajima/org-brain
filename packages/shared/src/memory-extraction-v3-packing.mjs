// Local-only tokenizer. Server validation never imports these encoding tables.
import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";
import { buildMemoryExtractionPrompt, MEMORY_EXTRACTION_OUTPUT_SCHEMA } from "./memory-extraction-provider-contract-runtime.mjs";
let encoder;
export const V3_TOKEN_PROFILE = "local-o200k-estimate/v1";
export function estimateV3Input(packet) {
  encoder ??= new Tiktoken(ranks);
  return encoder.encode(buildMemoryExtractionPrompt(packet)).length
    + encoder.encode(JSON.stringify(MEMORY_EXTRACTION_OUTPUT_SCHEMA)).length
    + encoder.encode("orgbrain_memory_extraction").length + 256;
}
export function packV3Evidence(packet, groups) {
  const selected = [];
  const omitted = [];
  for (const group of groups) {
    const additions = group.filter((span) => !selected.some((item) => item.span_id === span.span_id));
    if (selected.length + additions.length > 8
      || estimateV3Input({ ...packet, snippets: [...selected, ...additions] }) + 512 > 2000) {
      omitted.push(...additions.map((span) => span.span_id));
      continue;
    }
    selected.push(...additions);
  }
  if (!selected.length) throw new Error("evidence_budget_exhausted");
  const snippets = selected.sort((a, b) => a.order - b.order);
  const result = { ...packet, snippets, token_profile_id: V3_TOKEN_PROFILE, token_profile_verified: false };
  return { packet: result, estimated_input_tokens: estimateV3Input(result), omitted_span_ids: omitted };
}
