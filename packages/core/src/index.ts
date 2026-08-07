import type { AvoidedLookup, DecisionResourceLink, DecisionResourceRole, MemoryImpactSummary } from "@org-brain/contracts";

export type MemoryImpactObservation = {
  event_type: "eligible" | "assessed" | "failed";
  external_run_id: string;
  memory_used?: boolean | null;
  avoided_lookup?: AvoidedLookup | null;
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;

export function summarizeMemoryImpact(events: MemoryImpactObservation[]): MemoryImpactSummary {
  const runs = new Map<string, { eligible: boolean; assessed: boolean; failed: boolean; memoryUsed: boolean; avoided: AvoidedLookup }>();
  for (const event of events) {
    const run = runs.get(event.external_run_id) ?? {
      eligible: false,
      assessed: false,
      failed: false,
      memoryUsed: false,
      avoided: "none" as const
    };
    if (event.event_type === "eligible") run.eligible = true;
    if (event.event_type === "failed") run.failed = true;
    if (event.event_type === "assessed") {
      run.assessed = true;
      run.memoryUsed = event.memory_used === true;
      run.avoided = event.avoided_lookup ?? "none";
    }
    runs.set(event.external_run_id, run);
  }

  const values = [...runs.values()];
  const eligibleRuns = values.filter((run) => run.eligible).length;
  const assessedRuns = values.filter((run) => run.assessed).length;
  const failedRuns = values.filter((run) => run.failed).length;
  const memoryUsedRuns = values.filter((run) => run.assessed && run.memoryUsed).length;
  const avoidedRuns = values.filter((run) => run.assessed && run.memoryUsed && run.avoided !== "none").length;
  const byAvoidedLookup: Record<AvoidedLookup, number> = {
    source_search: 0,
    web_search: 0,
    past_context: 0,
    none: 0
  };
  for (const run of values.filter((item) => item.assessed)) byAvoidedLookup[run.avoided] += 1;

  return {
    eligible_runs: eligibleRuns,
    assessed_runs: assessedRuns,
    failed_runs: failedRuns,
    memory_used_runs: memoryUsedRuns,
    avoided_runs: avoidedRuns,
    reporting_rate: ratio(assessedRuns + failedRuns, eligibleRuns),
    memory_usage_rate: ratio(memoryUsedRuns, assessedRuns),
    avoided_lookup_rate: ratio(avoidedRuns, memoryUsedRuns),
    by_avoided_lookup: byAvoidedLookup
  };
}

const ALLOWED_RESOURCE_SCHEMES = new Set(["https:", "orgbrain:", "r2:", "s3:", "gs:", "azure:", "git+https:"]);

export function normalizeKnowledgeResourceUri(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("resource_uri_required");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("invalid_resource_uri");
  }
  if (!ALLOWED_RESOURCE_SCHEMES.has(parsed.protocol)) throw new Error("unsupported_resource_uri_scheme");
  if (parsed.username || parsed.password) throw new Error("resource_uri_credentials_forbidden");
  parsed.hash = "";
  if (parsed.protocol === "https:" || parsed.protocol === "git+https:") {
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.port === "443") parsed.port = "";
  }
  return parsed.toString();
}

export function assertConnectorFetchUri(raw: string): string {
  const normalized = normalizeKnowledgeResourceUri(raw);
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" && parsed.protocol !== "git+https:") throw new Error("connector_fetch_requires_https");
  const hostname = parsed.hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  const ipv4Candidate = hostname.startsWith("::ffff:") ? hostname.slice("::ffff:".length) : hostname;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(ipv4Candidate)?.slice(1).map(Number);
  const nonGlobalIpv4 = Boolean(ipv4 && (
    ipv4.some((part) => part > 255) || ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] >= 224 ||
    (ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127) ||
    (ipv4[0] === 169 && ipv4[1] === 254) ||
    (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
    (ipv4[0] === 192 && ipv4[1] === 168) ||
    (ipv4[0] === 192 && ipv4[1] === 0 && (ipv4[2] === 0 || ipv4[2] === 2)) ||
    (ipv4[0] === 198 && (ipv4[1] === 18 || ipv4[1] === 19)) ||
    (ipv4[0] === 198 && ipv4[1] === 51 && ipv4[2] === 100) ||
    (ipv4[0] === 203 && ipv4[1] === 0 && ipv4[2] === 113)
  ));
  const nonGlobalIpv6 = hostname.includes(":") && !/^[23][0-9a-f]{0,3}:/u.test(hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.startsWith("::ffff:") ||
    nonGlobalIpv4 ||
    nonGlobalIpv6 ||
    /^127\./u.test(ipv4Candidate) ||
    /^10\./u.test(ipv4Candidate) ||
    /^192\.168\./u.test(ipv4Candidate) ||
    /^169\.254\./u.test(ipv4Candidate) ||
    /^172\.(1[6-9]|2\d|3[01])\./u.test(ipv4Candidate) ||
    /^f[cd][0-9a-f]{0,2}:/u.test(hostname) ||
    /^fe[89ab][0-9a-f]?:/u.test(hostname)
  ) throw new Error("connector_fetch_private_address_forbidden");
  return normalized;
}

export type KnowledgeResourceTextChunk = {
  index: number;
  text: string;
  source_span_start: number;
  source_span_end: number;
};

export function chunkKnowledgeResourceText(
  text: string,
  options: { maxChars?: number; overlapChars?: number } = {}
): KnowledgeResourceTextChunk[] {
  const maxChars = Math.max(256, options.maxChars ?? 2_000);
  const overlapChars = Math.min(Math.max(0, options.overlapChars ?? 200), maxChars - 1);
  if (!text) return [];
  const chunks: KnowledgeResourceTextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(text.length, start + maxChars);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const paragraph = text.lastIndexOf("\n\n", hardEnd);
      const newline = text.lastIndexOf("\n", hardEnd);
      const space = text.lastIndexOf(" ", hardEnd);
      const boundary = Math.max(paragraph >= start + 256 ? paragraph + 2 : -1, newline >= start + 256 ? newline + 1 : -1, space >= start + 256 ? space + 1 : -1);
      if (boundary > start) end = boundary;
    }
    chunks.push({ index: chunks.length, text: text.slice(start, end), source_span_start: start, source_span_end: end });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

export function groupDecisionArtifacts(links: DecisionResourceLink[]): Record<DecisionResourceRole, DecisionResourceLink[]> {
  const grouped: Record<DecisionResourceRole, DecisionResourceLink[]> = {
    conclusion_source: [],
    rationale_source: [],
    contradiction: [],
    input: [],
    implementation_artifact: [],
    output_artifact: [],
    verification_artifact: []
  };
  for (const link of links) {
    if (link.confirmation_state === "confirmed" && link.valid_until == null) grouped[link.role].push(link);
  }
  return grouped;
}
