import { extractMemoryCandidatesV2 } from "./memory-capture-v2";
import type { MemoryKind, MemoryScopeType } from "./memory-lifecycle-types";
import type { MemoryEvidence, MemorySourceReference } from "./memory-store";

export type AgentMemoryEventV1 = {
  event_id: string;
  tenant_id: string;
  project_id?: string | null;
  source: "codex" | "claude" | "opencode" | "openclaw" | "cli" | string;
  actor_type?: string | null;
  actor_id?: string | null;
  occurred_at: number;
  text: string;
  source_references?: MemorySourceReference[];
  metadata?: Record<string, unknown>;
};

export type ExtractedMemoryCandidate = {
  candidate_id: string;
  tenant_id: string;
  project_id: string | null;
  kind: Extract<MemoryKind, "fact" | "decision" | "constraint" | "pitfall" | "preference">;
  scope_type: MemoryScopeType;
  scope_key: string;
  confirmation_state: "candidate" | "proposed";
  content: string;
  summary: string;
  tags: string[];
  entities: string[];
  source: string;
  source_references: MemorySourceReference[];
  actor_type: string | null;
  actor_id: string | null;
  valid_from: number | null;
  valid_until: number | null;
  confidence_score: number;
  rationale: string | null;
  evidence: MemoryEvidence[];
  canonical_key: string;
  content_hash: string;
  conflicts: string[];
};

export type MemoryExtractionResult = {
  event_id: string;
  extractor: string;
  candidates: ExtractedMemoryCandidate[];
  excluded: Array<{
    reason:
      | "low_signal"
      | "unsafe_instruction"
      | "duplicate"
      | "transient"
      | "candidate_limit"
      | "credential_detected"
      | "sensitive_default_deny";
    preview: string;
  }>;
  redactions: {
    secrets: number;
    email_addresses: number;
    phone_numbers: number;
  };
  raw_transcript_persisted: false;
};

export interface MemoryExtractor {
  extract(event: AgentMemoryEventV1): Promise<MemoryExtractionResult>;
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu,
  /\b(?:sk|sk-proj|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/giu,
  /\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)\s*[:=]\s*["']?[^\s"',;]{8,}/giu
];
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_PATTERN = /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu;
const UNSAFE_INSTRUCTION_PATTERN =
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:previous|system|developer|security)\b|\b(?:reveal|exfiltrate|print)\b.{0,40}\b(?:secret|credential|system prompt)\b|前の指示を無視|秘密.{0,12}(?:表示|送信)/iu;

export type MemoryTextScreening = {
  text: string;
  unsafe_instruction: boolean;
  redactions: MemoryExtractionResult["redactions"];
};

export function screenMemoryText(text: string): MemoryTextScreening {
  const result = redact(text);
  return {
    text: result.text,
    unsafe_instruction: UNSAFE_INSTRUCTION_PATTERN.test(result.text),
    redactions: result.counts
  };
}

function redact(
  text: string
): { text: string; counts: MemoryExtractionResult["redactions"] } {
  const counts = { secrets: 0, email_addresses: 0, phone_numbers: 0 };
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      counts.secrets += 1;
      return "[REDACTED_SECRET]";
    });
  }
  redacted = redacted.replace(EMAIL_PATTERN, () => {
    counts.email_addresses += 1;
    return "[REDACTED_EMAIL]";
  });
  redacted = redacted.replace(PHONE_PATTERN, (candidate) => {
    const digits = candidate.replace(/\D/gu, "");
    if (digits.length < 10 || digits.length > 15 || !/[+() -]/u.test(candidate)) return candidate;
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/u.test(candidate)) return candidate;
    counts.phone_numbers += 1;
    return "[REDACTED_PHONE]";
  });
  return { text: redacted, counts };
}

export class DurableRuleMemoryExtractor implements MemoryExtractor {
  async extract(event: AgentMemoryEventV1): Promise<MemoryExtractionResult> {
    if (!event || typeof event !== "object") throw new Error("event must be an object");
    if (!event.event_id?.trim()) throw new Error("event_id is required");
    if (!event.tenant_id?.trim()) throw new Error("tenant_id is required");
    if (!event.text?.trim()) throw new Error("text is required");
    return extractMemoryCandidatesV2(event);
  }
}
