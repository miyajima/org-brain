import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSharedTarball } from "./shared-release-tarballs.mjs";

export function resolvePublishDecision({ status, localIntegrity, remoteIntegrity }) {
  if (status === 404) return "publish";
  if (status !== 200) throw new Error(`npm registry returned HTTP ${status}`);
  if (!remoteIntegrity) throw new Error("published npm version has no dist.integrity");
  if (remoteIntegrity === localIntegrity) return "skip";
  throw new Error(`published npm integrity mismatch: expected ${localIntegrity}, received ${remoteIntegrity}`);
}

function packageVersionUrl(registry, name, version) {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  const escapedName = encodeURIComponent(name).replace(/^%40/u, "@");
  return new URL(`${escapedName}/${encodeURIComponent(version)}`, base);
}

export async function publishSharedTarball(tarballPath, options = {}) {
  const absolutePath = resolve(tarballPath);
  const { manifest } = await inspectSharedTarball(absolutePath);
  const bytes = await readFile(absolutePath);
  const localIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const registry = options.registry
    ?? process.env.NPM_CONFIG_REGISTRY
    ?? process.env.npm_config_registry
    ?? "https://registry.npmjs.org/";
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(packageVersionUrl(registry, manifest.name, manifest.version), {
    headers: { accept: "application/json" }
  });
  let remoteIntegrity;
  if (response.status === 200) {
    const metadata = await response.json();
    remoteIntegrity = metadata.dist?.integrity;
  }
  const decision = resolvePublishDecision({
    status: response.status,
    localIntegrity,
    remoteIntegrity
  });
  if (decision === "skip") {
    process.stdout.write(`skip ${manifest.name}@${manifest.version}: registry integrity matches\n`);
    return { decision, localIntegrity };
  }

  const runPublish = options.runPublish ?? ((args) => spawnSync("npm", args, {
    env: process.env,
    stdio: "inherit"
  }));
  const result = runPublish(["publish", absolutePath, "--provenance", "--access", "public"]);
  if (result.status !== 0) throw new Error(`npm publish failed with status ${result.status}`);
  return { decision, localIntegrity };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    throw new Error("usage: node scripts/publish-shared-tarball.mjs <tarball>");
  }
  await publishSharedTarball(process.argv[2]);
}
