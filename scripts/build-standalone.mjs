#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { rollup } from "rollup";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(repositoryRoot, process.argv[2] || "dist/orgbrain.mjs");
const bundle = await rollup({
  input: resolve(repositoryRoot, "packages/orgbrain-cli/src/local-memory.mjs"),
  external: (id) => id.startsWith("node:")
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
