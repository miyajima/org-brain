import {
  verifiedKnowledgeBundleV1Schema,
  type VerifiedKnowledgeBundleV1
} from "@org-brain/contracts";

type RecordValue = Record<string, unknown>;

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_json_non_finite_number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const input = value as RecordValue;
    return `{${Object.keys(input)
      .filter((key) => input[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical_json_unsupported_value");
}

export async function digestCanonical(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (item) => item.charCodeAt(0));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function unsignedPayload(bundle: RecordValue): RecordValue {
  const { bundle_digest: _digest, signature: _signature, ...payload } = bundle;
  return payload;
}

export async function createSignedVerifiedKnowledgeBundle(
  input: Omit<VerifiedKnowledgeBundleV1, "bundle_digest" | "signature"> & {
    bundle_digest?: string;
    signature?: VerifiedKnowledgeBundleV1["signature"];
  },
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
      exactArrayBuffer(base64UrlToBytes(value.signature.value)),
      new TextEncoder().encode(digest)
    );
  } catch {
    signatureValid = false;
  }
  return { valid: digestMatch && signatureValid, digest_match: digestMatch, signature_valid: signatureValid, parsed: value };
}
