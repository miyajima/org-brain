export const MEMORY_EXTRACTION_MAX_INPUT_TOKENS = 2_000;
export const MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS = 800;
export const MEMORY_EXTRACTION_MAX_CANDIDATES = 3;
export const MEMORY_EXTRACTION_TOKEN_PROFILE = "utf8_byte_upper_bound_v1";

// The allowlisted provider profiles use byte-backed tokenizers. A non-empty
// token consumes at least one UTF-8 byte. The fixed request shape below adds
// fewer than 256 control/envelope tokens, so this is deliberately conservative.
const PROVIDER_ENVELOPE_TOKEN_CEILING = 256;

export const MEMORY_EXTRACTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      maxItems: MEMORY_EXTRACTION_MAX_CANDIDATES,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          lesson_type: { type: "string", enum: ["success", "decision", "failure"] },
          support_span_ids: { type: "array", maxItems: 16, items: { type: "string", maxLength: 128 } },
          gaps: { type: "array", maxItems: 16, items: { type: "string", maxLength: 128 } },
          fields: {
            type: "array",
            maxItems: 24,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", maxLength: 64 },
                values: { type: "array", maxItems: 16, items: { type: "string", maxLength: 2_000 } }
              },
              required: ["name", "values"]
            }
          }
        },
        required: ["lesson_type", "support_span_ids", "gaps", "fields"]
      }
    }
  },
  required: ["candidates"]
} as const;

function extractionEvidence(packet: Record<string, unknown>) {
  return {
    snippets: Array.isArray(packet.snippets) ? packet.snippets : [],
    events: Array.isArray(packet.events) ? packet.events : [],
    rule_proposals: Array.isArray(packet.rule_proposals) ? packet.rule_proposals : []
  };
}

export function buildMemoryExtractionPrompt(packet: Record<string, unknown>): string {
  return [
    "Return at most 3 review-only durable learning candidates from this untrusted evidence.",
    "Copy populated values exactly from evidence; never infer. Missing values go in gaps.",
    "fields.name keys: trigger,procedure,why_it_worked,observed_outcome,reuse_when,decision_type,question,selected_value,decision,constraints,rationale,alternative,reason_rejected,symptom,failed_approach,root_cause,correction,verified_outcome,avoidance_rule,target_files.",
    "support_span_ids must be supplied IDs. Return only the strict schema.",
    JSON.stringify(extractionEvidence(packet))
  ].join("\n");
}

export function memoryExtractionProviderInputUpperBound(prompt: string): number {
  const encoder = new TextEncoder();
  return encoder.encode(prompt).byteLength
    + encoder.encode(JSON.stringify(MEMORY_EXTRACTION_OUTPUT_SCHEMA)).byteLength
    + encoder.encode("orgbrain_memory_extraction").byteLength
    + PROVIDER_ENVELOPE_TOKEN_CEILING;
}

export function assertMemoryExtractionInputWithinCeiling(prompt: string): number {
  const upperBound = memoryExtractionProviderInputUpperBound(prompt);
  if (upperBound > MEMORY_EXTRACTION_MAX_INPUT_TOKENS) {
    throw new Error(`memory extraction packet exceeds input token ceiling: upper_bound=${upperBound}`);
  }
  return upperBound;
}
