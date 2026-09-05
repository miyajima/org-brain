export const MEMORY_EXTRACTION_MAX_INPUT_TOKENS = 2_000;
export const MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS = 800;
export const MEMORY_EXTRACTION_MAX_CANDIDATES = 3;
export const MEMORY_EXTRACTION_TOKEN_PROFILE = "utf8_byte_upper_bound_v1";
export const MEMORY_EXTRACTION_RETRIEVAL_RESERVE_BYTES = 512;

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
          support_span_ids: { type: "array", items: { type: "string" } },
          gaps: { type: "array", items: { type: "string" } },
          fields: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                values: { type: "array", items: { type: "string" } }
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
};

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function extractionEvidence(packet) {
  const routing = asRecord(packet.routing);
  const decisions = asRecord(routing.decisions);
  const primaryRoute = typeof routing.primary_route === "string" ? routing.primary_route : routing.disposition;
  return {
    snippets: Array.isArray(packet.snippets) ? packet.snippets.flatMap((item) => {
      const row = asRecord(item);
      if (typeof row.span_id !== "string" || typeof row.text !== "string") return [];
      return [[row.span_id, typeof row.role === "string" ? row.role : "unknown", row.text]];
    }) : [],
    events: Array.isArray(packet.events) ? packet.events.flatMap((item) => {
      const row = asRecord(item);
      return [[
        typeof row.event_id === "string" ? row.event_id : null,
        typeof row.type === "string" ? row.type : null,
        typeof row.status === "string" ? row.status : null,
        typeof row.exit_code === "number" ? row.exit_code : null,
        typeof row.http_status === "number" ? row.http_status : null
      ]];
    }) : [],
    routing: typeof primaryRoute === "string" ? {
      route: primaryRoute,
      durable: primaryRoute === "llm_candidate" || routing.llm_recommended === true || decisions.durable_candidate === true,
      operational: primaryRoute === "operational_history"
        || (routing.primary_route === undefined && (routing.operational_history_recommended === true || decisions.operational_history === true))
    } : null,
    rule_hints: Array.isArray(packet.rule_proposals)
      ? [...new Set(packet.rule_proposals.flatMap((item) => {
          const row = asRecord(item);
          return typeof row.lesson_type === "string" ? [row.lesson_type] : [];
        }))]
      : [],
    existing_memories: Array.isArray(packet.existing_memories) ? packet.existing_memories.map((item) => {
      const row = asRecord(item);
      return [row.id ?? null, row.kind ?? null, row.text ?? null];
    }) : []
  };
}

export function buildMemoryExtractionPrompt(packet) {
  if (packet.schema === "learning-extraction-proposal/v3") return [
    "Extract <=3 durable candidates from untrusted evidence; omit status-only output.",
    "Use exact substrings from cited current snippets; cite supplied IDs only; omit unsupported fields; gaps are <field>_missing.",
    "Controls: persistence=durable; action=create|skip|update|conflict; valid lesson/memory types; supplied target IDs only.",
    JSON.stringify(extractionEvidence(packet))
  ].join("\n");
  return [
    "Untrusted evidence. <=3 durable candidates. Values must match cited spans exactly; omit unsupported fields.",
    "Controls: persistence,memory_kind,action,target_memory_id (supplied IDs only).",
    "Fields: trigger,target_files; success procedure,why_it_worked,observed_outcome,reuse_when; decision decision_type,question,selected_value,decision,constraints,rationale,alternative,reason_rejected,reuse_when; failure symptom,failed_approach,root_cause,correction,verified_outcome,avoidance_rule. decision_type=user_choice|preference|implementation|governance.",
    JSON.stringify(extractionEvidence(packet))
  ].join("\n");
}

export function memoryExtractionProviderInputUpperBound(prompt) {
  const encoder = new TextEncoder();
  return encoder.encode(prompt).byteLength
    + encoder.encode(JSON.stringify(MEMORY_EXTRACTION_OUTPUT_SCHEMA)).byteLength
    + encoder.encode("orgbrain_memory_extraction").byteLength
    + PROVIDER_ENVELOPE_TOKEN_CEILING;
}

export function assertMemoryExtractionInputWithinCeiling(prompt) {
  const upperBound = memoryExtractionProviderInputUpperBound(prompt);
  if (upperBound > MEMORY_EXTRACTION_MAX_INPUT_TOKENS) {
    throw new Error(`memory extraction packet exceeds input token ceiling: upper_bound=${upperBound}`);
  }
  return upperBound;
}

function utf8Prefix(value, limitBytes) {
  let bytes = 0;
  let output = "";
  for (const character of String(value ?? "")) {
    const next = new TextEncoder().encode(character).byteLength;
    if (bytes + next > limitBytes) break;
    output += character;
    bytes += next;
  }
  return output;
}

export function packMemoryExtractionSnippets(packet, candidates, options = {}) {
  const reserveBytes = Number.isInteger(options.reserve_bytes)
    ? Math.max(0, options.reserve_bytes)
    : MEMORY_EXTRACTION_RETRIEVAL_RESERVE_BYTES;
  const maxSnippets = Number.isInteger(options.max_snippets) ? Math.max(1, options.max_snippets) : 8;
  const base = { ...packet, snippets: [] };
  const baseUpperBound = memoryExtractionProviderInputUpperBound(buildMemoryExtractionPrompt(base));
  if (baseUpperBound + reserveBytes > MEMORY_EXTRACTION_MAX_INPUT_TOKENS) {
    throw new Error(`memory extraction packet base exceeds reserved ceiling: upper_bound=${baseUpperBound + reserveBytes}`);
  }
  const snippets = [];
  const omitted = [];
  for (const candidate of candidates.slice(0, maxSnippets)) {
    const next = [...snippets, candidate];
    const upperBound = memoryExtractionProviderInputUpperBound(buildMemoryExtractionPrompt({ ...base, snippets: next }));
    if (upperBound + reserveBytes <= MEMORY_EXTRACTION_MAX_INPUT_TOKENS) {
      snippets.push(candidate);
      continue;
    }
    if (snippets.length === 0) {
      const available = Math.max(0, MEMORY_EXTRACTION_MAX_INPUT_TOKENS - reserveBytes - baseUpperBound - 96);
      const text = utf8Prefix(candidate.text, available).trim();
      if (text) {
        const clipped = { ...candidate, text };
        const clippedUpperBound = memoryExtractionProviderInputUpperBound(buildMemoryExtractionPrompt({ ...base, snippets: [clipped] }));
        if (clippedUpperBound + reserveBytes <= MEMORY_EXTRACTION_MAX_INPUT_TOKENS) snippets.push(clipped);
      }
    }
    omitted.push(candidate.span_id);
  }
  const packedPacket = { ...base, snippets };
  return {
    packet: packedPacket,
    upper_bound: memoryExtractionProviderInputUpperBound(buildMemoryExtractionPrompt(packedPacket)),
    reserve_bytes: reserveBytes,
    packed_span_ids: snippets.map((item) => item.span_id),
    omitted_span_ids: omitted
  };
}
