import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const sharedPackageSpecs = [
  {
    name: "@org-brain/contracts",
    version: "0.4.0",
    filename: "org-brain-contracts-0.4.0.tgz",
    internalDependencies: {},
    fixtures: ["package/fixtures/memory-impact-v1.json"]
  },
  {
    name: "@org-brain/core",
    version: "0.4.0",
    filename: "org-brain-core-0.4.0.tgz",
    internalDependencies: { "@org-brain/contracts": "0.4.0" },
    fixtures: []
  },
  {
    name: "@org-brain/server-core",
    version: "0.1.0",
    filename: "org-brain-server-core-0.1.0.tgz",
    internalDependencies: {
      "@org-brain/contracts": "0.4.0",
      "@org-brain/core": "0.4.0"
    },
    fixtures: [
      "package/fixtures/api-manifest.json",
      "package/fixtures/api-manifest.sha256"
    ]
  },
  {
    name: "@org-brain/mcp-core",
    version: "0.1.0",
    filename: "org-brain-mcp-core-0.1.0.tgz",
    internalDependencies: { "@org-brain/contracts": "0.4.0" },
    fixtures: [
      "package/fixtures/tool-manifest.json",
      "package/fixtures/tool-manifest.sha256"
    ]
  }
];

const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies"
];
const forbiddenDependencyProtocol = /^(?:workspace:|link:|file:)/u;
const allowedEntries = [
  "package/LICENSE",
  "package/package.json"
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function runTar(args) {
  const result = spawnSync("tar", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`tar ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function validateTarballContents(spec, manifest, entries) {
  invariant(manifest.name === spec.name, `${spec.filename}: unexpected package name`);
  invariant(manifest.version === spec.version, `${spec.filename}: unexpected package version`);
  invariant(manifest.license === "Apache-2.0", `${spec.filename}: Apache-2.0 license metadata required`);

  for (const section of dependencySections) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      invariant(
        !forbiddenDependencyProtocol.test(version),
        `${spec.filename}: ${section}.${name} uses forbidden protocol ${version}`
      );
    }
  }

  const internalDependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).filter(([name]) => name.startsWith("@org-brain/"))
  );
  const actualInternalDependencies = Object.entries(internalDependencies).sort(([left], [right]) => left.localeCompare(right));
  const expectedInternalDependencies = Object.entries(spec.internalDependencies).sort(([left], [right]) => left.localeCompare(right));
  invariant(
    JSON.stringify(actualInternalDependencies) === JSON.stringify(expectedInternalDependencies),
    `${spec.filename}: internal dependencies must be ${JSON.stringify(spec.internalDependencies)}`
  );

  const rootExport = manifest.exports?.["."];
  invariant(rootExport?.types === "./dist/index.d.ts", `${spec.filename}: types export must target dist`);
  invariant(rootExport?.import === "./dist/index.js", `${spec.filename}: import export must target dist`);
  if (spec.fixtures.length > 0) {
    invariant(
      manifest.exports?.["./fixtures/*"] === "./fixtures/*",
      `${spec.filename}: fixture export is required`
    );
  }

  const entrySet = new Set(entries);
  for (const required of [
    "package/LICENSE",
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    ...spec.fixtures
  ]) {
    invariant(entrySet.has(required), `${spec.filename}: missing ${required}`);
  }

  for (const entry of entries) {
    const allowed = allowedEntries.includes(entry)
      || entry.startsWith("package/dist/")
      || entry.startsWith("package/fixtures/");
    invariant(allowed, `${spec.filename}: unexpected packaged file ${entry}`);
  }
}

export async function inspectSharedTarball(tarballPath) {
  const spec = sharedPackageSpecs.find((candidate) => candidate.filename === basename(tarballPath));
  invariant(spec, `${basename(tarballPath)}: unexpected shared package tarball`);
  const entries = runTar(["-tzf", tarballPath]).trim().split("\n").filter(Boolean).sort();
  const manifest = JSON.parse(runTar(["-xOf", tarballPath, "package/package.json"]));
  validateTarballContents(spec, manifest, entries);
  return { spec, manifest, entries };
}

export async function verifySharedReleaseTarballs(directory) {
  const verified = [];
  for (const spec of sharedPackageSpecs) {
    const tarballPath = join(directory, spec.filename);
    await readFile(tarballPath);
    const inspected = await inspectSharedTarball(tarballPath);
    verified.push({ ...inspected, tarballPath });
  }
  return verified;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? process.cwd());
  const verified = await verifySharedReleaseTarballs(directory);
  for (const item of verified) {
    process.stdout.write(`verified ${item.spec.name}@${item.spec.version} ${item.spec.filename}\n`);
  }
}
