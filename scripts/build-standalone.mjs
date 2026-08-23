#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { rollup } from "rollup";

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
  plugins: [{
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
process.stdout.write(`${output}\n`);
