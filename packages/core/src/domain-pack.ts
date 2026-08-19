import {
  domainPackManifestSchema,
  type DomainPackManifestV1,
  type MetricFormulaV1,
  type PackEnvelopeV1
} from "@org-brain/contracts";

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_json_non_finite_number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  throw new Error("canonical_json_unsupported_value");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function domainPackManifestDigest(manifest: DomainPackManifestV1): Promise<string> {
  return sha256Hex(canonicalJson(domainPackManifestSchema.parse(manifest)));
}

function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export async function verifyPackEnvelope(envelope: PackEnvelopeV1, publicKeyJwk: JsonWebKey): Promise<boolean> {
  const digest = await domainPackManifestDigest(envelope.manifest);
  if (digest !== envelope.manifest_digest) return false;
  const key = await crypto.subtle.importKey("jwk", publicKeyJwk, { name: "Ed25519" }, false, ["verify"]);
  const signature = base64UrlBytes(envelope.signature.value_base64url);
  const signatureBuffer = signature.buffer.slice(
    signature.byteOffset,
    signature.byteOffset + signature.byteLength
  ) as ArrayBuffer;
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    signatureBuffer,
    new TextEncoder().encode(envelope.manifest_digest)
  );
}

export function resolveDomainPackOrder(manifests: DomainPackManifestV1[]): DomainPackManifestV1[] {
  const byId = new Map(manifests.map((manifest) => [manifest.pack_id, manifest]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: DomainPackManifestV1[] = [];
  const visit = (packId: string) => {
    if (visited.has(packId)) return;
    if (visiting.has(packId)) throw new Error(`domain_pack_dependency_cycle:${packId}`);
    const manifest = byId.get(packId);
    if (!manifest) throw new Error(`domain_pack_dependency_missing:${packId}`);
    visiting.add(packId);
    for (const dependency of manifest.dependencies) {
      const candidate = byId.get(dependency.pack_id);
      if (!candidate || candidate.version !== dependency.version) throw new Error(`domain_pack_dependency_missing:${dependency.pack_id}@${dependency.version}`);
      visit(dependency.pack_id);
    }
    visiting.delete(packId);
    visited.add(packId);
    ordered.push(manifest);
  };
  for (const manifest of manifests) visit(manifest.pack_id);
  return ordered;
}

export type MetricSeries = Readonly<Record<string, readonly number[]>>;

function valuesFor(keys: string[], series: MetricSeries): number[] {
  return keys.flatMap((key) => [...(series[key] ?? [])]).filter(Number.isFinite);
}

export function evaluateMetricFormula(formula: MetricFormulaV1, series: MetricSeries): number | null {
  const values = valuesFor(formula.metric_keys, series);
  if (formula.operation === "count") return values.length;
  if (formula.operation === "distinct_count") return new Set(values).size;
  if (values.length === 0) return null;
  if (formula.operation === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (formula.operation === "average") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (formula.operation === "duration") return values.length < 2 ? null : Math.max(...values) - Math.min(...values);
  if (formula.operation === "ratio") {
    const numerator = series[formula.metric_keys[0]]?.at(-1);
    const denominator = series[formula.metric_keys[1]]?.at(-1);
    return numerator === undefined || denominator === undefined || denominator === 0 ? null : numerator / denominator;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = formula.percentile ?? 50;
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? null;
  return (sorted[lower] ?? 0) + ((sorted[upper] ?? 0) - (sorted[lower] ?? 0)) * (index - lower);
}
