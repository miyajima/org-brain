import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";

let encoder;
// Complete pretty-printed MCP text, including receipts, metadata and framing.
// This is a deterministic local estimate, not provider billing or saved cost.
export function countContextTokens(value) {
  encoder ??= new Tiktoken(ranks);
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value, null, 2), [], []).length;
}

export function measureContextPayload(response, estimate, key = "estimated_tokens") {
  for (let i = 0; i < 8; i++) {
    const count = countContextTokens(response);
    if (estimate[key] === count) return response;
    estimate[key] = count;
  }
  // The caller also checks the actual encoded count at the budget boundary.
  return response;
}

export const USAGE_PURPOSES = ["task", "audit", "diagnostic", "test", "unclassified"];
export function normalizeUsagePurpose(value) {
  if (value === undefined || value === null) return "unclassified";
  if (!USAGE_PURPOSES.includes(value)) throw new Error("invalid_usage_purpose");
  return value;
}
