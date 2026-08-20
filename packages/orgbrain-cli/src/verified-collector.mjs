import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    return "{" + Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  throw new Error("canonical_json_unsupported_value");
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function unsigned(bundle) {
  const { bundle_digest: _digest, signature: _signature, ...payload } = bundle;
  return payload;
}

function credentialService(keyId) {
  return "orgbrain.collector." + keyId;
}

function writeKeychain(keyId, privateJwk) {
  if (process.platform !== "darwin") return false;
  const payload = Buffer.from(JSON.stringify(privateJwk), "utf8").toString("base64");
  try {
    execFileSync("security", ["add-generic-password", "-a", "orgbrain", "-s", credentialService(keyId), "-w", payload, "-U"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readKeychain(keyId) {
  if (process.platform !== "darwin") return null;
  try {
    const value = execFileSync("security", ["find-generic-password", "-a", "orgbrain", "-s", credentialService(keyId), "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function publicJwkFromPrivate(privateJwk) {
  if (!privateJwk?.x || !privateJwk?.y || !privateJwk?.crv) throw new Error("collector_private_key_invalid");
  return {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    y: privateJwk.y,
    ext: true,
    key_ops: ["verify"]
  };
}

async function readFileKey(directory, keyId) {
  try {
    return JSON.parse(await readFile(join(directory, keyId + ".json"), "utf8"));
  } catch {
    return null;
  }
}

export async function createCollectorIdentity({ keyId, directory = join(homedir(), ".config", "org-brain", "collectors") }) {
  if (!keyId || !/^[A-Za-z0-9._:-]{1,128}$/u.test(keyId)) throw new Error("invalid_collector_key_id");
  const existing = readKeychain(keyId) || await readFileKey(directory, keyId);
  if (existing) return { key_id: keyId, public_key: publicJwkFromPrivate(existing), storage: process.platform === "darwin" ? "keychain" : "0600-file" };
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await subtle.exportKey("jwk", pair.publicKey);
  if (!writeKeychain(keyId, privateJwk)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, keyId + ".json");
    await writeFile(file, JSON.stringify(privateJwk) + "\n", { mode: 0o600 });
    await chmod(file, 0o600);
  }
  return { key_id: keyId, public_key: publicJwk, storage: process.platform === "darwin" ? "keychain" : "0600-file" };
}

async function loadPrivateKey(keyId, directory) {
  const keychain = readKeychain(keyId);
  if (keychain) return keychain;
  const file = join(directory ?? join(homedir(), ".config", "org-brain", "collectors"), keyId + ".json");
  return JSON.parse(await readFile(file, "utf8"));
}

export async function signVerifiedBundle(bundle, { keyId, directory } = {}) {
  if (!keyId) throw new Error("collector_key_id_required");
  if (bundle.collector_key_id !== keyId) throw new Error("collector_key_id_mismatch");
  const privateJwk = await loadPrivateKey(keyId, directory);
  const payload = unsigned(bundle);
  const bundleDigest = digest(payload);
  const key = await subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(bundleDigest));
  return {
    ...payload,
    bundle_digest: bundleDigest,
    signature: { algorithm: "ECDSA-P256-SHA256", key_id: keyId, value: base64Url(new Uint8Array(signature)) }
  };
}
