import {
  verifiedKnowledgeBundleV1Schema,
  type VerifiedKnowledgeBundleV1
} from "@org-brain/contracts";
import { sha256Hex } from "./domain-pack.js";

type RecordValue = Record<string, unknown>;

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
  return sha256Hex(canonicalJson(value));
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
