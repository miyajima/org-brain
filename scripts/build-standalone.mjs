#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile, cp, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { rollup } from "rollup";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(repositoryRoot, process.argv[2] || "dist/orgbrain.mjs");
const packageManifest = JSON.parse(await readFile(resolve(repositoryRoot, "packages/orgbrain-cli/package.json"), "utf8"));
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
} catch {
  // Source archives may not include Git metadata.
}
const buildInfoModule = resolve(repositoryRoot, "packages/orgbrain-cli/src/build-info.mjs");
const bundle = await rollup({
  input: resolve(repositoryRoot, "packages/orgbrain-cli/src/local-memory.mjs"),
  external: (id) => id.startsWith("node:"),
  plugins: [nodeResolve({ preferBuiltins: true }), commonjs(), {
    name: "orgbrain-build-info",
    load(id) {
      if (resolve(id) !== buildInfoModule) return null;
      return `export const CLI_BUILD_INFO = Object.freeze(${JSON.stringify({
        version: packageManifest.version,
        commit,
        built_at: new Date().toISOString(),
        source: "standalone"
      })});`;
    }
  }]
});

await mkdir(dirname(output), { recursive: true });
await bundle.write({
  file: output,
  format: "es",
  inlineDynamicImports: true,
  generatedCode: "es2015"
});
await bundle.close();

const generated = await readFile(output, "utf8");
if (!generated.startsWith("#!/usr/bin/env node")) {
  await writeFile(output, `#!/usr/bin/env node\n${generated}`, "utf8");
}
await chmod(output, 0o755);
const packageRoot = dirname(dirname(output));
for (const relative of ["bin", "assets/wiki", "skills/org-brain-wiki"]) {
  const source = resolve(repositoryRoot, "packages/orgbrain-cli", relative);
  const target = resolve(packageRoot, relative);
  if (source === target) continue;
  if (relative === "skills/org-brain-wiki" && packageRoot === repositoryRoot) continue;
  try { await access(source); } catch { continue; }
  await cp(source, target, { recursive: true });
}
process.stdout.write(`${output}\n`);
