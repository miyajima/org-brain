import { sha256 } from "./hash";
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
  excluded: Array<{ reason: "low_signal" | "unsafe_instruction" | "duplicate"; preview: string }>;
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
const PHONE_PATTERN = /(?<!\d)(?:\+?\d[\d ()-]{8,}\d)(?!\d)/gu;
const UNSAFE_INSTRUCTION_PATTERN =
  /\b(?:ignore|disregard|override)\b.{0,40}\b(?:previous|system|developer|security)\b|\b(?:reveal|exfiltrate|print)\b.{0,40}\b(?:secret|credential|system prompt)\b|前の指示を無視|秘密.{0,12}(?:表示|送信)/iu;

const CLASSIFIERS: Array<{
  kind: ExtractedMemoryCandidate["kind"];
  pattern: RegExp;
  confidence: number;
}> = [
  {
    kind: "decision",
    pattern: /\b(?:decided|decision|adopt(?:ed)?|selected|chose|approved)\b|(?:決定|採用|選択|承認)した/u,
    confidence: 0.9
  },
  {
    kind: "constraint",
    pattern: /\b(?:must|must not|required|prohibited|never|always|constraint)\b|(?:必須|禁止|してはいけない|制約)/u,
    confidence: 0.88
  },
  {
    kind: "pitfall",
    pattern: /\b(?:failed|failure|pitfall|root cause|regression|do not repeat|workaround)\b|(?:失敗|原因|再発|落とし穴|回避策)/u,
    confidence: 0.84
  },
  {
    kind: "preference",
    pattern: /\b(?:prefer|preference|default to|favor)\b|(?:好む|優先する|既定とする)/u,
    confidence: 0.82
  },
  {
    kind: "fact",
    pattern: /\b(?:is|are|uses|runs|supports|located|version|result)\b|(?:である|です|使う|対応|結果)/u,
    confidence: 0.68
  }
];

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`;
}

function normalizeCanonical(value: string): string {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
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
  redacted = redacted.replace(PHONE_PATTERN, () => {
    counts.phone_numbers += 1;
    return "[REDACTED_PHONE]";
  });
  return { text: redacted, counts };
}

function sentences(text: string): string[] {
  return text
    .split(/(?:\r?\n)+|(?<=[。！？.!?])\s+/u)
    .map(collapseWhitespace)
    .filter(Boolean);
}

function classify(value: string) {
  const normalized = value.toLowerCase();
  return CLASSIFIERS.find((classifier) => classifier.pattern.test(normalized)) ?? null;
}

function extractEntities(value: string): string[] {
  const entities = [
    ...value.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)+\b/gu),
    ...value.matchAll(/`([^`\n]{2,80})`/gu)
  ].map((match) => collapseWhitespace(match[1] ?? match[0]));
  return [...new Set(entities)].slice(0, 16);
}

function candidateId(eventId: string, index: number): string {
  return `${eventId}:candidate:${index + 1}`;
}

export class DurableRuleMemoryExtractor implements MemoryExtractor {
  async extract(event: AgentMemoryEventV1): Promise<MemoryExtractionResult> {
    if (!event || typeof event !== "object") throw new Error("event must be an object");
    if (!event.event_id?.trim()) throw new Error("event_id is required");
    if (!event.tenant_id?.trim()) throw new Error("tenant_id is required");
    if (!event.text?.trim()) throw new Error("text is required");
    const redacted = redact(event.text);
    const excluded: MemoryExtractionResult["excluded"] = [];
    const candidates: ExtractedMemoryCandidate[] = [];
    const seen = new Set<string>();
    for (const sentence of sentences(redacted.text)) {
      const preview = clip(sentence, 120);
      if (sentence.length < 20 || /^(?:ok|done|thanks|heartbeat|success|完了|了解)[.!。]?$/iu.test(sentence)) {
        excluded.push({ reason: "low_signal", preview });
        continue;
      }
      if (UNSAFE_INSTRUCTION_PATTERN.test(sentence)) {
        excluded.push({ reason: "unsafe_instruction", preview });
        continue;
      }
      const classification = classify(sentence);
      if (!classification) {
        excluded.push({ reason: "low_signal", preview });
        continue;
      }
      const canonicalText = normalizeCanonical(sentence);
      if (seen.has(canonicalText)) {
        excluded.push({ reason: "duplicate", preview });
        continue;
      }
      seen.add(canonicalText);
      const projectId = event.project_id?.trim() || null;
      const scopeType: MemoryScopeType = projectId ? "project" : "tenant";
      const canonicalKey = `${scopeType}:${projectId ?? event.tenant_id}:${classification.kind}:${clip(canonicalText, 160)}`;
      const sourceReferences = event.source_references?.length
        ? event.source_references.slice(0, 32)
        : [{ type: "event", ref: event.event_id, captured_at: event.occurred_at }];
      const candidate: ExtractedMemoryCandidate = {
        candidate_id: candidateId(event.event_id, candidates.length),
        tenant_id: event.tenant_id,
        project_id: projectId,
        kind: classification.kind,
        scope_type: scopeType,
        scope_key: projectId ?? event.tenant_id,
        confirmation_state:
          classification.kind === "decision" || scopeType !== "project" ? "proposed" : "candidate",
        content: sentence,
        summary: clip(sentence, 240),
        tags: ["auto-extracted", classification.kind, `source:${event.source}`],
        entities: extractEntities(sentence),
        source: event.source,
        source_references: sourceReferences,
        actor_type: event.actor_type?.trim() || "agent",
        actor_id: event.actor_id?.trim() || event.source,
        valid_from: event.occurred_at,
        valid_until: null,
        confidence_score: classification.confidence,
        rationale:
          classification.kind === "decision" || classification.kind === "pitfall"
            ? "Extracted from an explicit durable statement; confirmation is still required."
            : null,
        evidence: sourceReferences.map((reference) => ({
          type: reference.type,
          ref: reference.ref,
          note: reference.title
        })),
        canonical_key: canonicalKey,
        content_hash: await sha256(sentence),
        conflicts: []
      };
      candidates.push(candidate);
    }
    const byKey = new Map<string, ExtractedMemoryCandidate[]>();
    for (const candidate of candidates) {
      const key = candidate.canonical_key.split(":").slice(0, 4).join(":");
      byKey.set(key, [...(byKey.get(key) ?? []), candidate]);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      for (const candidate of group) {
        candidate.conflicts = group
          .filter((other) => other.content_hash !== candidate.content_hash)
          .map((other) => other.candidate_id);
      }
    }
    return {
      event_id: event.event_id,
      extractor: "durable-rules-v1",
      candidates,
      excluded,
      redactions: redacted.counts,
      raw_transcript_persisted: false
    };
  }
}
