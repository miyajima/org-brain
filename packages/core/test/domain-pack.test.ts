import { describe, expect, it } from "vitest";
import type { DomainPackManifestV1 } from "@org-brain/contracts";
import { canonicalJson, domainPackManifestDigest, evaluateMetricFormula, resolveDomainPackOrder, verifyPackEnvelope } from "../src/domain-pack";

const pack = (packId: string, dependencies: DomainPackManifestV1["dependencies"] = []): DomainPackManifestV1 => ({
  contract_version: "domain-pack/v1",
  pack_id: packId,
  version: "1.0.0",
  classification: "function",
  title: packId,
  description: `${packId} description`,
  language: "ja",
  min_orgbrain_version: "0.2.0",
  dependencies,
  object_types: [], metrics: [], dashboards: [], connectors: [], assets: [], loadout_templates: [], example_refs: []
});

describe("Domain Pack core", () => {
  it("canonicalizes keys and creates stable digests", async () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(await domainPackManifestDigest(pack("function.sre"))).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("orders dependencies and rejects cycles", () => {
    const base = pack("function.sre");
    const overlay = pack("industry.saas", [{ pack_id: "function.sre", version: "1.0.0" }]);
    expect(resolveDomainPackOrder([overlay, base]).map((item) => item.pack_id)).toEqual(["function.sre", "industry.saas"]);
    expect(() => resolveDomainPackOrder([
      pack("function.one", [{ pack_id: "function.two", version: "1.0.0" }]),
      pack("function.two", [{ pack_id: "function.one", version: "1.0.0" }])
    ])).toThrow(/dependency_cycle/u);
  });

  it("evaluates only supported derived operations", () => {
    expect(evaluateMetricFormula({ operation: "ratio", metric_keys: ["qualified", "new_users"] }, { qualified: [54], new_users: [100] })).toBe(0.54);
    expect(evaluateMetricFormula({ operation: "percentile", metric_keys: ["ttfv"], percentile: 75 }, { ttfv: [1, 2, 3, 4] })).toBe(3.25);
    expect(evaluateMetricFormula({ operation: "ratio", metric_keys: ["qualified", "new_users"] }, { qualified: [54], new_users: [0] })).toBeNull();
  });

  it("verifies canonical digest and Ed25519 signature together", async () => {
    const manifest = pack("function.sre");
    const manifestDigest = await domainPackManifestDigest(manifest);
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(manifestDigest)
    ));
    const valueBase64url = btoa(String.fromCharCode(...signature)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
    const envelope = {
      contract_version: "pack-envelope/v1" as const,
      pack_kind: "domain" as const,
      manifest,
      manifest_digest: manifestDigest,
      publisher: { id: "orgbrain", key_id: "test-key" },
      signature: { alg: "EdDSA" as const, value_base64url: valueBase64url },
      license: { id: "Apache-2.0", url: null },
      archive: { object_key: "packs/function.sre/1.0.0.tgz", size: 10, sha256: "a".repeat(64) }
    };
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
    await expect(verifyPackEnvelope(envelope, publicKey)).resolves.toBe(true);
    await expect(verifyPackEnvelope({ ...envelope, manifest_digest: "b".repeat(64) }, publicKey)).resolves.toBe(false);
  });
});
