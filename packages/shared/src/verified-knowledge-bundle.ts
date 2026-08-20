import {
  EXTRACTION_PROFILE_CONTRACT_VERSION,
  VERIFIED_CANDIDATE_TYPES,
  VERIFIED_EDGE_RELATIONS,
  VERIFIED_EVIDENCE_TYPES,
  VERIFIED_KNOWLEDGE_BUNDLE_CONTRACT_VERSION,
  extractionProfileV1Schema,
  verifiedKnowledgeBundleV1Schema,
  type ExtractionProfileV1,
  type VerifiedEdgeBinding,
  type VerifiedEvidenceReceipt,
  type VerifiedKnowledgeBundleV1,
  type VerifiedKnowledgeCandidate,
  type VerifiedSourceSpan
} from "@org-brain/contracts";
import { screenMemoryText } from "./memory-extractor";
import { sha256 } from "./hash";

export const VERIFIED_EXTRACTOR_SCHEMA_VERSION = "rules/v1" as const;
export const VERIFIED_POLICY_VERSION = "active-gate/v1" as const;
export const VERIFIED_BATCH_MAX_NEW_INPUTS = 10;
export const VERIFIED_BATCH_MAX_BACKGROUND_INPUTS = 5;
export const VERIFIED_BATCH_MAX_BYTES = 24 * 1024;

export type LocalSessionEventV1 = {
  event_id: string;
  turn_id?: string | null;
  tenant_id: string;
  project_id?: string | null;
  task_id?: string | null;
  decision_thread_id?: string | null;
  source?: string;
  role?: "user" | "assistant" | "tool" | "system" | "principal";
  actor_type?: "human" | "principal" | "agent" | "tool" | "system" | null;
  actor_id?: string | null;
  occurred_at: number;
  text: string;
  is_new_input?: boolean;
  evidence_type?: (typeof VERIFIED_EVIDENCE_TYPES)[number];
  signed_tool_event?: boolean;
  tool_result?: string | null;
  command_result?: string | null;
  file_change?: { path: string; content_hash?: string | null; operation?: string } | null;
  resource_snapshot?: { uri: string; content_hash?: string | null } | null;
  metadata?: Record<string, unknown>;
};

export type LocalSessionV1 = {
  tenant_id: string;
  project_id?: string | null;
  task_id?: string | null;
  decision_thread_id?: string | null;
  events: LocalSessionEventV1[];
};

export type ExtractionProfileResolver = {
  agent?: ExtractionProfileV1 | null;
  project?: ExtractionProfileV1 | null;
  tenant?: ExtractionProfileV1 | null;
  built_in?: ExtractionProfileV1 | null;
};

export type LocalCandidateModel = (input: {
  events: LocalSessionEventV1[];
  background: LocalSessionEventV1[];
  profile: ExtractionProfileV1;
  schema_version: typeof VERIFIED_EXTRACTOR_SCHEMA_VERSION;
}) => Promise<unknown>;

export type VerifiedBundleBuildOptions = {
  profile?: ExtractionProfileV1 | null;
  profile_resolver?: ExtractionProfileResolver;
  agent_profile?: ExtractionProfileV1 | null;
  project_profile?: ExtractionProfileV1 | null;
  tenant_profile?: ExtractionProfileV1 | null;
  built_in_profile?: ExtractionProfileV1 | null;
  model_id?: string;
  local_llm?: LocalCandidateModel;
  collector_key_id?: string;
  now?: number;
  bundle_index?: number;
};

export type SessionBatch = {
  scene_key: string;
  events: LocalSessionEventV1[];
  background: LocalSessionEventV1[];
};

export type VerifiedBundleEvaluation = {
  state: "active" | "verified_draft" | "quarantined" | "extractor_disagreement";
  reasons: string[];
  missing_stages: string[];
  provenance_coverage: number;
  evidence_count: number;
  candidate_count: number;
  edge_count: number;
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeText(value: string): string {
  return screenMemoryText(value).text.slice(0, 20_000);
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_json_non_finite_number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    return "{" + Object.keys(input)
      .filter((key) => input[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(input[key]))
      .join(",") + "}";
  }
  throw new Error("canonical_json_unsupported_value");
}

export async function digestCanonical(value: unknown): Promise<string> {
  return sha256(canonicalJson(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    result += alphabet[(triple >>> 18) & 63] + alphabet[(triple >>> 12) & 63]
      + (index + 1 < bytes.length ? alphabet[(triple >>> 6) & 63] : "=")
      + (index + 2 < bytes.length ? alphabet[triple & 63] : "=");
  }
  return result.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const result: number[] = [];
  for (let index = 0; index < padded.length; index += 4) {
    const a = alphabet.indexOf(padded[index] ?? "=");
    const b = alphabet.indexOf(padded[index + 1] ?? "=");
    const c = padded[index + 2] === "=" ? 0 : alphabet.indexOf(padded[index + 2] ?? "=");
    const d = padded[index + 3] === "=" ? 0 : alphabet.indexOf(padded[index + 3] ?? "=");
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("invalid_base64url");
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    result.push((triple >>> 16) & 255);
    if (padded[index + 2] !== "=") result.push((triple >>> 8) & 255);
    if (padded[index + 3] !== "=") result.push(triple & 255);
  }
  return new Uint8Array(result);
}

function unsignedPayload(bundle: RecordValue): RecordValue {
  const { bundle_digest: _digest, signature: _signature, ...payload } = bundle;
  return payload;
}

export async function createSignedVerifiedKnowledgeBundle(
  input: Omit<VerifiedKnowledgeBundleV1, "bundle_digest" | "signature"> & { bundle_digest?: string; signature?: VerifiedKnowledgeBundleV1["signature"] },
  privateKey: CryptoKey,
  keyId: string
): Promise<VerifiedKnowledgeBundleV1> {
  const payload = unsignedPayload(input as unknown as RecordValue);
  const digest = await digestCanonical(payload);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(digest)
  );
  return verifiedKnowledgeBundleV1Schema.parse({
    ...payload,
    bundle_digest: digest,
    signature: {
      algorithm: "ECDSA-P256-SHA256",
      key_id: keyId,
      value: bytesToBase64Url(new Uint8Array(signature))
    }
  });
}

export async function verifySignedVerifiedKnowledgeBundle(
  bundle: unknown,
  publicKey: CryptoKey | JsonWebKey
): Promise<{ valid: boolean; digest_match: boolean; signature_valid: boolean; parsed: VerifiedKnowledgeBundleV1 | null }> {
  const parsed = verifiedKnowledgeBundleV1Schema.safeParse(bundle);
  if (!parsed.success) return { valid: false, digest_match: false, signature_valid: false, parsed: null };
  const value = parsed.data;
  const digest = await digestCanonical(unsignedPayload(value as unknown as RecordValue));
  const digestMatch = digest === value.bundle_digest;
  let key: CryptoKey;
  try {
    key = typeof CryptoKey !== "undefined" && publicKey instanceof CryptoKey
      ? publicKey
      : await crypto.subtle.importKey("jwk", publicKey as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return { valid: false, digest_match: digestMatch, signature_valid: false, parsed: value };
  }
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlToBytes(value.signature.value) as unknown as ArrayBuffer,
      new TextEncoder().encode(digest)
    );
  } catch {
    signatureValid = false;
  }
  return { valid: digestMatch && signatureValid, digest_match: digestMatch, signature_valid: signatureValid, parsed: value };
}

export async function resolveExtractionProfile(options: VerifiedBundleBuildOptions = {}): Promise<ExtractionProfileV1> {
  const profile = options.profile
    ?? options.profile_resolver?.agent
    ?? options.agent_profile
    ?? options.profile_resolver?.project
    ?? options.project_profile
    ?? options.profile_resolver?.tenant
    ?? options.tenant_profile
    ?? options.profile_resolver?.built_in
    ?? options.built_in_profile
    ?? {
      contract_version: EXTRACTION_PROFILE_CONTRACT_VERSION,
      profile_id: "built-in/default",
      version: 1,
      scope: "built_in" as const,
      terminology: {},
      priority_candidate_types: [],
      exclusions: [],
      few_shot_examples: [],
      scene_hints: []
    };
  const parsed = extractionProfileV1Schema.parse(profile);
  const computedHash = await digestCanonical({ ...parsed, profile_hash: undefined });
  if (parsed.profile_hash && parsed.profile_hash !== computedHash) throw new Error("extraction_profile_hash_mismatch");
  return { ...parsed, profile_hash: computedHash };
}

function sceneKey(event: LocalSessionEventV1): string {
  return [event.project_id ?? "global", event.task_id ?? "taskless", event.decision_thread_id ?? "threadless"].join("\0");
}

function isNew(event: LocalSessionEventV1): boolean {
  if (event.is_new_input !== undefined) return event.is_new_input;
  return event.role === "user" || event.actor_type === "human" || event.actor_type === "principal";
}

export function splitVerifiedSessionIntoBatches(session: LocalSessionV1): SessionBatch[] {
  const groups = new Map<string, LocalSessionEventV1[]>();
  for (const event of session.events) {
    if (!event?.event_id || !event.text) continue;
    const key = sceneKey(event);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  const result: SessionBatch[] = [];
  for (const [key, events] of groups) {
    let current: LocalSessionEventV1[] = [];
    let bytes = 0;
    let newCount = 0;
    let backgroundCount = 0;
    const flush = () => {
      if (!current.length) return;
      result.push({ scene_key: key, events: current.filter(isNew), background: current.filter((event) => !isNew(event)) });
      current = [];
      bytes = 0;
      newCount = 0;
      backgroundCount = 0;
    };
    for (const event of events) {
      const newInput = isNew(event);
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      const limitHit = (newInput && newCount >= VERIFIED_BATCH_MAX_NEW_INPUTS)
        || (!newInput && backgroundCount >= VERIFIED_BATCH_MAX_BACKGROUND_INPUTS)
        || (current.length > 0 && bytes + size > VERIFIED_BATCH_MAX_BYTES);
      const turnBoundary = current.length > 0 && (current.at(-1)?.turn_id ?? null) !== (event.turn_id ?? null);
      if (limitHit && turnBoundary) flush();
      if (limitHit && current.length > 0) flush();
      current.push(event);
      if (newInput) newCount += 1; else backgroundCount += 1;
      bytes += size;
      if (newInput && newCount >= VERIFIED_BATCH_MAX_NEW_INPUTS) flush();
      if (!newInput && backgroundCount >= VERIFIED_BATCH_MAX_BACKGROUND_INPUTS) flush();
    }
    flush();
  }
  return result;
}

function spans(textValue: string): Array<{ text: string; start: number; end: number }> {
  const result: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /[^.!?。！？\n]+(?:[.!?。！？]|\n|$)/gu;
  for (const match of textValue.matchAll(pattern)) {
    const value = match[0]?.trim();
    if (!value) continue;
    const rawStart = match.index ?? 0;
    const leading = (match[0]?.length ?? 0) - (match[0]?.trimStart().length ?? 0);
    const start = rawStart + leading;
    result.push({ text: value, start, end: start + value.length });
  }
  if (!result.length && textValue.trim()) {
    const value = textValue.trim();
    const start = Math.max(0, textValue.indexOf(value));
    result.push({ text: value, start, end: start + value.length });
  }
  return result;
}

function evidenceType(event: LocalSessionEventV1): (typeof VERIFIED_EVIDENCE_TYPES)[number] {
  if (event.evidence_type && VERIFIED_EVIDENCE_TYPES.includes(event.evidence_type)) return event.evidence_type;
  if (event.signed_tool_event || event.role === "tool") return "tool_result";
  if (event.command_result || (event.role === "assistant" && /^\s*(?:\$|>|command|実行結果)/iu.test(event.text))) return "command_result";
  if (event.file_change) return "file_change";
  if (event.resource_snapshot) return "resource_snapshot";
  if (event.role === "user" || event.actor_type === "human" || event.actor_type === "principal") return "user_statement";
  return "explicit_confirmation";
}

async function eventDigest(event: LocalSessionEventV1): Promise<string> {
  return sha256(canonicalJson({
    event_id: event.event_id,
    turn_id: event.turn_id ?? null,
    occurred_at: event.occurred_at,
    text: safeText(event.text),
    evidence_type: evidenceType(event),
    tool_result: event.tool_result ?? null,
    command_result: event.command_result ?? null,
    file_change: event.file_change ?? null,
    resource_snapshot: event.resource_snapshot ?? null
  }));
}

async function receipt(event: LocalSessionEventV1, newInput: boolean): Promise<VerifiedEvidenceReceipt> {
  const excerpt = safeText(event.text).slice(0, 2_000);
  const artifact = event.file_change?.path
    ? { artifact_ref: event.file_change.path, content_hash: event.file_change.content_hash ?? null }
    : event.resource_snapshot?.uri
      ? { artifact_ref: event.resource_snapshot.uri, content_hash: event.resource_snapshot.content_hash ?? null }
      : {};
  return {
    receipt_id: "receipt:" + event.event_id,
    event_id: event.event_id,
    evidence_type: evidenceType(event),
    source_span: { event_id: event.event_id, turn_id: event.turn_id ?? null, start: 0, end: excerpt.length, excerpt },
    digest: await eventDigest(event),
    is_new_input: newInput,
    signed_tool_event: Boolean(event.signed_tool_event),
    ...artifact,
    observed_at: event.occurred_at
  };
}

function metadata(event: LocalSessionEventV1): RecordValue {
  return record(event.metadata) ?? {};
}

function metadataText(event: LocalSessionEventV1, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(metadata(event)[key]);
    if (value) return value;
  }
  return null;
}

function spanFor(event: LocalSessionEventV1, value: string): { text: string; start: number; end: number } {
  const textSource = safeText(event.text);
  const normalizedValue = value.toLowerCase();
  const textIndex = textSource.toLowerCase().indexOf(normalizedValue);
  const externalSource = [event.tool_result, event.command_result, event.file_change?.path, event.resource_snapshot?.uri]
    .find((candidate) => typeof candidate === "string" && candidate.toLowerCase().includes(normalizedValue));
  const source = textIndex >= 0 ? textSource : externalSource ?? textSource;
  const index = textIndex >= 0 ? textIndex : Math.max(0, source.toLowerCase().indexOf(normalizedValue));
  const start = index >= 0 ? index : 0;
  const excerpt = index >= 0 ? source.slice(start, start + value.length) : source.slice(0, 2_000);
  return { text: excerpt, start, end: start + excerpt.length };
}

function makeCandidate(
  id: string,
  kind: VerifiedKnowledgeCandidate["candidate_type"],
  value: string,
  event: LocalSessionEventV1,
  sourceSpan: { text: string; start: number; end: number },
  extra: Partial<VerifiedKnowledgeCandidate> = {}
): VerifiedKnowledgeCandidate {
  const safe = safeText(value);
  const screened = screenMemoryText(value);
  const sourceScreened = screenMemoryText([
    event.text,
    event.tool_result ?? "",
    event.command_result ?? "",
    event.file_change?.path ?? "",
    event.resource_snapshot?.uri ?? ""
  ].join("\n"));
  const safetyFlags = [
    screened.unsafe_instruction || sourceScreened.unsafe_instruction ? "prompt_injection" : null,
    screened.redactions.secrets > 0 || sourceScreened.redactions.secrets > 0 ? "secret" : null,
    screened.redactions.email_addresses > 0 || screened.redactions.phone_numbers > 0
      || sourceScreened.redactions.email_addresses > 0 || sourceScreened.redactions.phone_numbers > 0 ? "pii" : null
  ].filter((flag): flag is "pii" | "secret" | "prompt_injection" => Boolean(flag));
  return {
    candidate_id: id,
    candidate_type: kind,
    value: safe,
    summary: safe.slice(0, 500),
    source_spans: [{ event_id: event.event_id, turn_id: event.turn_id ?? null, start: sourceSpan.start, end: sourceSpan.end, excerpt: safeText(sourceSpan.text).slice(0, 2_000) }],
    source_event_ids: [event.event_id],
    safety_flags: safetyFlags,
    actor_type: event.actor_type ?? (event.role === "user" ? "human" : event.role === "tool" ? "tool" : "agent"),
    actor_id: event.actor_id ?? null,
    ...extra
  };
}

const DECISION = /(?:決定|採用|選択|決め|方針|we\s+will|decided|choose|selected|adopt|the\s+decision\s+is)/iu;
const REASON = /(?:理由|なぜなら|because|due\s+to|so\s+that|reason(?:\s+is)?|背景)/iu;
const URL = /https?:\/\/[^\s)\]}>]+/giu;
const PATH = /(?:^|\s)(\/[^\s)\]}>]+|[\w./-]+\.(?:md|mdx|json|ya?ml|ts|tsx|js|jsx|sql|png|pdf|html|css))(?:$|\s|[),\]}])/giu;

export async function extractVerifiedRuleCandidates(batch: SessionBatch): Promise<{
  candidates: VerifiedKnowledgeCandidate[];
  field_bindings: VerifiedKnowledgeBundleV1["field_bindings"];
  edge_bindings: VerifiedEdgeBinding[];
  evidence_receipts: VerifiedEvidenceReceipt[];
}> {
  const all = [...batch.events, ...batch.background];
  const receipts = await Promise.all(all.map((event) => receipt(event, batch.events.includes(event))));
  const candidates: VerifiedKnowledgeCandidate[] = [];
  const fields: VerifiedKnowledgeBundleV1["field_bindings"] = [];
  const edges: VerifiedEdgeBinding[] = [];
  const byKind = new Map<string, VerifiedKnowledgeCandidate[]>();
  const add = (item: VerifiedKnowledgeCandidate, field: string) => {
    candidates.push(item);
    byKind.set(item.candidate_type, [...(byKind.get(item.candidate_type) ?? []), item]);
    fields.push({
      binding_id: "field:" + item.candidate_id + ":" + field,
      entity: item.candidate_type,
      field,
      candidate_id: item.candidate_id,
      source_span_index: 0,
      receipt_id: "receipt:" + item.source_event_ids[0]
    });
  };
  for (const event of batch.events) {
    const source = safeText(event.text);
    const sentenceList = spans(source);
    const decisionText = metadataText(event, ["decision", "selected_value", "conclusion"]);
    const reasonText = metadataText(event, ["reason", "reason_summary", "rationale"]);
    const decisionSpan = decisionText
      ? spanFor(event, decisionText)
      : DECISION.test(source)
        ? { text: source, start: 0, end: source.length }
        : sentenceList.find((item) => DECISION.test(item.text));
    const reasonSpan = reasonText
      ? spanFor(event, reasonText)
      : REASON.test(source)
        ? { text: source, start: 0, end: source.length }
        : sentenceList.find((item) => REASON.test(item.text));
    if (decisionSpan) add(makeCandidate("candidate:" + event.event_id + ":decision", "decision", decisionText ?? decisionSpan.text, event, decisionSpan, { semantic_key: metadataText(event, ["decision_key"]) }), "value");
    if (reasonSpan) add(makeCandidate("candidate:" + event.event_id + ":reason", "reason", reasonText ?? reasonSpan.text, event, reasonSpan), "value");
    const evidenceValues = [
      ...(source.match(URL) ?? []),
      ...(Array.from(source.matchAll(PATH)).map((match) => match[1]).filter((value): value is string => Boolean(value))),
      ...(event.tool_result ? [event.tool_result] : []),
      ...(event.command_result ? [event.command_result] : []),
      ...(event.resource_snapshot?.uri ? [event.resource_snapshot.uri] : []),
      ...(event.file_change?.path ? [event.file_change.path] : [])
    ].map((value) => value.trim()).filter(Boolean);
    for (const [index, value] of [...new Set(evidenceValues)].slice(0, 16).entries()) {
      const sourceSpan = spanFor(event, value);
      add(makeCandidate("candidate:" + event.event_id + ":evidence:" + (index + 1), "evidence", value, event, sourceSpan, {
        artifact_ref: event.file_change?.path ?? event.resource_snapshot?.uri ?? (value.startsWith("http") ? value : null),
        content_hash: event.file_change?.content_hash ?? event.resource_snapshot?.content_hash ?? null
      }), "value");
    }
    const artifactValues = [
      ...(Array.from(source.matchAll(PATH)).map((match) => match[1]).filter((value): value is string => Boolean(value))),
      ...(event.file_change?.path ? [event.file_change.path] : []),
      ...(event.resource_snapshot?.uri ? [event.resource_snapshot.uri] : [])
    ].map((value) => value.trim()).filter(Boolean);
    for (const [index, value] of [...new Set(artifactValues)].slice(0, 8).entries()) {
      add(makeCandidate("candidate:" + event.event_id + ":artifact:" + (index + 1), "artifact", value, event, spanFor(event, value), {
        artifact_ref: value,
        content_hash: event.file_change?.content_hash ?? event.resource_snapshot?.content_hash ?? null
      }), "ref");
    }
  }
  const decisions = byKind.get("decision") ?? [];
  const reasons = byKind.get("reason") ?? [];
  const evidence = byKind.get("evidence") ?? [];
  const artifacts = byKind.get("artifact") ?? [];
  if (decisions[0] && reasons[0]) edges.push({ binding_id: "edge:decision-reason:1", relation: "decision_reason", source_candidate_id: decisions[0].candidate_id, target_candidate_id: reasons[0].candidate_id, receipt_ids: ["receipt:" + reasons[0].source_event_ids[0]] });
  if (reasons[0]) {
    for (const item of evidence) edges.push({ binding_id: "edge:reason-evidence:" + item.candidate_id, relation: "reason_evidence", source_candidate_id: reasons[0].candidate_id, target_candidate_id: item.candidate_id, receipt_ids: ["receipt:" + item.source_event_ids[0]] });
    for (const item of artifacts) edges.push({ binding_id: "edge:reason-artifact:" + item.candidate_id, relation: "reason_artifact", source_candidate_id: reasons[0].candidate_id, target_candidate_id: item.candidate_id, receipt_ids: ["receipt:" + item.source_event_ids[0]] });
  }
  if (decisions[0]) for (const item of artifacts) edges.push({ binding_id: "edge:decision-artifact:" + item.candidate_id, relation: "decision_artifact", source_candidate_id: decisions[0].candidate_id, target_candidate_id: item.candidate_id, receipt_ids: ["receipt:" + item.source_event_ids[0]] });
  return { candidates: candidates.slice(0, 200), field_bindings: fields.slice(0, 1_000), edge_bindings: edges.slice(0, 1_000), evidence_receipts: receipts.slice(0, 500) };
}

const modelCache = new Map<string, unknown>();

async function supplement(
  batch: SessionBatch,
  profile: ExtractionProfileV1,
  rule: Awaited<ReturnType<typeof extractVerifiedRuleCandidates>>,
  options: VerifiedBundleBuildOptions
): Promise<Awaited<ReturnType<typeof extractVerifiedRuleCandidates>>> {
  if (!options.local_llm) return rule;
  const complete = rule.candidates.some((item) => item.candidate_type === "decision")
    && rule.candidates.some((item) => item.candidate_type === "reason")
    && rule.candidates.some((item) => item.candidate_type === "evidence" || item.candidate_type === "artifact");
  if (complete) return rule;
  const sourceDigest = await digestCanonical(batch.events.map((event) => ({ event_id: event.event_id, text: safeText(event.text) })));
  const profileHash = await digestCanonical({ ...profile, profile_hash: undefined });
  const cacheKey = await sha256(sourceDigest + "\0" + profileHash + "\0" + VERIFIED_EXTRACTOR_SCHEMA_VERSION + "\0" + (options.model_id ?? "local"));
  let output = modelCache.get(cacheKey);
  if (output === undefined) {
    output = await options.local_llm({ events: batch.events, background: batch.background, profile, schema_version: VERIFIED_EXTRACTOR_SCHEMA_VERSION });
    modelCache.set(cacheKey, output);
  }
  const raw = record(output);
  const values = Array.isArray(raw?.candidates) ? raw.candidates : [];
  for (const item of values.slice(0, 50)) {
    const candidateValue = record(item);
    const kind = text(candidateValue?.candidate_type);
    const value = text(candidateValue?.value);
    const eventId = text(candidateValue?.source_event_id);
    if (!kind || !value || !eventId || !VERIFIED_CANDIDATE_TYPES.includes(kind as (typeof VERIFIED_CANDIDATE_TYPES)[number])) continue;
    const event = batch.events.find((entry) => entry.event_id === eventId);
    if (!event) continue;
    const sourceSpan = spanFor(event, value);
    if (!sourceSpan.text || sourceSpan.text.toLowerCase().slice(0, value.length) !== value.toLowerCase().slice(0, sourceSpan.text.length)) continue;
    const itemCandidate = makeCandidate("candidate:" + event.event_id + ":local:" + (rule.candidates.length + 1), kind as VerifiedKnowledgeCandidate["candidate_type"], value, event, sourceSpan);
    rule.candidates.push(itemCandidate);
    rule.field_bindings.push({ binding_id: "field:" + itemCandidate.candidate_id + ":value", entity: itemCandidate.candidate_type, field: "value", candidate_id: itemCandidate.candidate_id, source_span_index: 0, receipt_id: "receipt:" + itemCandidate.source_event_ids[0] });
  }
  const decisions = rule.candidates.filter((item) => item.candidate_type === "decision");
  const reasons = rule.candidates.filter((item) => item.candidate_type === "reason");
  if (decisions[0] && reasons[0] && !rule.edge_bindings.some((edge) => edge.relation === "decision_reason")) rule.edge_bindings.push({ binding_id: "edge:decision-reason:local", relation: "decision_reason", source_candidate_id: decisions[0].candidate_id, target_candidate_id: reasons[0].candidate_id, receipt_ids: ["receipt:" + reasons[0].source_event_ids[0]] });
  return rule;
}

export async function buildVerifiedKnowledgeBundle(session: LocalSessionV1, options: VerifiedBundleBuildOptions = {}): Promise<VerifiedKnowledgeBundleV1> {
  if (!session?.events?.length) throw new Error("session_events_required");
  const batch = splitVerifiedSessionIntoBatches(session)[0];
  if (!batch?.events.length) throw new Error("new_input_events_required");
  const profile = await resolveExtractionProfile(options);
  const profileHash = profile.profile_hash ?? await digestCanonical({ ...profile, profile_hash: undefined });
  const extracted = await supplement(batch, profile, await extractVerifiedRuleCandidates(batch), options);
  const refs = await Promise.all(batch.events.map(async (event) => ({ event_id: event.event_id, turn_id: event.turn_id ?? null, digest: await eventDigest(event), is_new_input: true, signed_tool_event: Boolean(event.signed_tool_event), excerpt: safeText(event.text).slice(0, 2_000) })));
  const background = await Promise.all(batch.background.map(async (event) => ({ event_id: event.event_id, turn_id: event.turn_id ?? null, digest: await eventDigest(event), is_new_input: false, signed_tool_event: Boolean(event.signed_tool_event), excerpt: safeText(event.text).slice(0, 2_000) })));
  const sourceDigest = await digestCanonical(refs.map((item) => ({ event_id: item.event_id, digest: item.digest })));
  const eventChainHash = await digestCanonical([...refs, ...background].map((item) => ({ event_id: item.event_id, digest: item.digest, is_new_input: item.is_new_input })));
  const unsigned = {
    contract_version: VERIFIED_KNOWLEDGE_BUNDLE_CONTRACT_VERSION,
    tenant_id: session.tenant_id,
    project_id: session.project_id ?? null,
    task_id: session.task_id ?? null,
    decision_thread_id: session.decision_thread_id ?? null,
    bundle_key: [session.tenant_id, session.project_id ?? "global", session.task_id ?? "taskless", session.decision_thread_id ?? "threadless", batch.events[0]?.turn_id ?? batch.events[0]?.event_id, ...(options.bundle_index === undefined ? [] : ["batch-" + options.bundle_index])].join(":"),
    source_digest: sourceDigest,
    scene_key: batch.scene_key,
    new_input_refs: refs,
    background_refs: background,
    extractor_ref: { name: "orgbrain-local-rules", schema_version: VERIFIED_EXTRACTOR_SCHEMA_VERSION, implementation_digest: null },
    prompt_ref: options.local_llm ? "local:" + (options.model_id ?? "local") : null,
    model_ref: { provider: options.local_llm ? "local" as const : "none" as const, model_id: options.model_id ?? "none", prompt_hash: null },
    extraction_profile_ref: { profile_id: profile.profile_id, version: profile.version, hash: profileHash, scope: profile.scope },
    candidates: extracted.candidates,
    field_bindings: extracted.field_bindings,
    edge_bindings: extracted.edge_bindings,
    evidence_receipts: extracted.evidence_receipts,
    policy_version: VERIFIED_POLICY_VERSION,
    collector_key_id: options.collector_key_id ?? "unregistered-local",
    event_chain_hash: eventChainHash,
    created_at: options.now ?? Date.now()
  };
  return verifiedKnowledgeBundleV1Schema.parse({ ...unsigned, bundle_digest: await digestCanonical(unsigned), signature: { algorithm: "ECDSA-P256-SHA256", key_id: options.collector_key_id ?? "unregistered-local", value: "unsigned" } });
}

export async function buildSignedVerifiedKnowledgeBundle(session: LocalSessionV1, privateKey: CryptoKey, options: VerifiedBundleBuildOptions & { collector_key_id: string }): Promise<VerifiedKnowledgeBundleV1> {
  return createSignedVerifiedKnowledgeBundle(await buildVerifiedKnowledgeBundle(session, options), privateKey, options.collector_key_id);
}

export async function buildVerifiedKnowledgeBundles(session: LocalSessionV1, options: VerifiedBundleBuildOptions = {}): Promise<VerifiedKnowledgeBundleV1[]> {
  const batches = splitVerifiedSessionIntoBatches(session).filter((batch) => batch.events.length > 0);
  return Promise.all(batches.map((batch, index) => buildVerifiedKnowledgeBundle(
    { ...session, events: [...batch.events, ...batch.background] },
    { ...options, bundle_index: index }
  )));
}

export async function buildSignedVerifiedKnowledgeBundles(
  session: LocalSessionV1,
  privateKey: CryptoKey,
  options: VerifiedBundleBuildOptions & { collector_key_id: string }
): Promise<VerifiedKnowledgeBundleV1[]> {
  const bundles = await buildVerifiedKnowledgeBundles(session, options);
  return Promise.all(bundles.map((bundle) => createSignedVerifiedKnowledgeBundle(bundle, privateKey, options.collector_key_id)));
}

export function evaluateVerifiedKnowledgeBundle(bundle: VerifiedKnowledgeBundleV1, options: { signature_valid?: boolean; event_chain_valid?: boolean; publish_authorized?: boolean } = {}): VerifiedBundleEvaluation {
  const parsed = verifiedKnowledgeBundleV1Schema.safeParse(bundle);
  if (!parsed.success) return { state: "quarantined", reasons: ["schema_invalid"], missing_stages: [], provenance_coverage: 0, evidence_count: 0, candidate_count: 0, edge_count: 0 };
  const value = parsed.data;
  const reasons: string[] = [];
  const missing: string[] = [];
  if (options.signature_valid === false) reasons.push("signature_invalid");
  if (options.event_chain_valid === false) reasons.push("event_chain_invalid");
  const candidates = new Map(value.candidates.map((item) => [item.candidate_id, item]));
  const receipts = new Map(value.evidence_receipts.map((item) => [item.receipt_id, item]));
  const boundCandidates = new Set(value.field_bindings.map((item) => item.candidate_id));
  const boundEdges = new Set(value.edge_bindings.map((item) => item.binding_id));
  for (const binding of value.field_bindings) {
    const item = candidates.get(binding.candidate_id);
    const receiptValue = receipts.get(binding.receipt_id);
    const span = item?.source_spans[binding.source_span_index];
    if (!item || !span || !receiptValue || receiptValue.event_id !== span.event_id) reasons.push("field_binding_invalid:" + binding.binding_id);
    if (!receiptValue || (!receiptValue.is_new_input && !receiptValue.signed_tool_event)) reasons.push("field_receipt_not_current:" + binding.binding_id);
  }
  for (const edge of value.edge_bindings) {
    if (!candidates.has(edge.source_candidate_id) || !candidates.has(edge.target_candidate_id) || !VERIFIED_EDGE_RELATIONS.includes(edge.relation)) reasons.push("edge_binding_invalid:" + edge.binding_id);
    if (!edge.receipt_ids.every((id) => receipts.has(id))) reasons.push("edge_receipt_invalid:" + edge.binding_id);
  }
  const expected = value.candidates.length + value.edge_bindings.length;
  const coverage = expected ? Math.min(1, (boundCandidates.size + boundEdges.size) / expected) : 0;
  if (coverage < 1) reasons.push("provenance_coverage_incomplete");
  const decisions = value.candidates.filter((item) => item.candidate_type === "decision");
  const reasonItems = value.candidates.filter((item) => item.candidate_type === "reason");
  const evidence = value.candidates.filter((item) => item.candidate_type === "evidence");
  const artifacts = value.candidates.filter((item) => item.candidate_type === "artifact");
  if (!decisions.length) missing.push("decision");
  if (!reasonItems.length) missing.push("reason");
  if (!evidence.length) missing.push("evidence");
  if (!artifacts.length) missing.push("artifact");
  if (decisions.length && !decisions.some((item) => item.actor_type === "human" || item.actor_type === "principal")) reasons.push("explicit_human_decision_required");
  if (!value.edge_bindings.some((item) => item.relation === "decision_reason")) reasons.push("decision_reason_edge_missing");
  if (reasonItems.length && !value.edge_bindings.some((item) => item.relation === "reason_evidence")) reasons.push("reason_evidence_edge_missing");
  if (artifacts.some((item) => !item.artifact_ref || !item.content_hash)) reasons.push("artifact_content_hash_missing");
  if (!value.evidence_receipts.some((item) => ["tool_result", "command_result", "file_change", "resource_snapshot", "explicit_confirmation"].includes(item.evidence_type) && (item.is_new_input || item.signed_tool_event))) reasons.push("independent_evidence_missing");
  const decisionsBySemanticKey = new Map<string, string>();
  for (const decision of decisions) {
    if (!decision.semantic_key) continue;
    const prior = decisionsBySemanticKey.get(decision.semantic_key);
    if (prior && prior !== decision.value && !value.edge_bindings.some((edge) => edge.relation === "decision_supersedes")) reasons.push("contradictory_decision");
    decisionsBySemanticKey.set(decision.semantic_key, decision.value);
  }
  for (const item of value.candidates) {
    const screened = screenMemoryText(item.value);
    if ((item.safety_flags?.length ?? 0) > 0 || screened.unsafe_instruction || screened.redactions.secrets > 0 || screened.redactions.email_addresses > 0 || screened.redactions.phone_numbers > 0) reasons.push("unsafe_candidate:" + item.candidate_id);
    for (const sourceSpan of item.source_spans) if (sourceSpan.excerpt && !sourceSpan.excerpt.toLowerCase().includes(item.value.slice(0, 80).toLowerCase())) reasons.push("candidate_not_in_source:" + item.candidate_id);
  }
  if (missing.includes("artifact")) reasons.push("artifact_missing");
  if (missing.includes("reason") || missing.includes("evidence")) reasons.push("supporting_reason_or_evidence_missing");
  if (options.publish_authorized === false) reasons.push("publish_permission_missing");
  const quarantine = reasons.some((item) => item.includes("invalid") || item.includes("unsafe") || item.includes("contradictory") || item.includes("signature") || item.includes("event_chain") || item.includes("schema"));
  const state = quarantine ? "quarantined" : reasons.some((item) => item.startsWith("candidate_not_in_source")) ? "extractor_disagreement" : missing.length || reasons.length || options.signature_valid === false || options.event_chain_valid === false || options.publish_authorized === false ? "verified_draft" : "active";
  return { state, reasons: [...new Set(reasons)], missing_stages: [...new Set(missing)], provenance_coverage: coverage, evidence_count: value.evidence_receipts.length, candidate_count: value.candidates.length, edge_count: value.edge_bindings.length };
}

export function clearVerifiedLocalModelCache(): void {
  modelCache.clear();
}
