import { execFileSync } from "node:child_process";
import { mkdir, copyFile, chmod, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    "packages/wiki-engine/Cargo.toml",
  ],
  { cwd: root, stdio: "inherit" },
);
execFileSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@org-brain/console", "build:wiki"],
  { cwd: root, stdio: "inherit" },
);
const dir = join(
  root,
  "packages/orgbrain-cli/bin",
  `${process.platform}-${process.arch}`,
);
const executable =
  process.platform === "win32"
    ? "orgbrain-wiki-engine.exe"
    : "orgbrain-wiki-engine";
await mkdir(dir, { recursive: true });
await copyFile(
  join(root, "packages/wiki-engine/target/release", executable),
  join(dir, executable),
);
await chmod(join(dir, executable), 0o755);
await cp(
  join(root, "skills/org-brain-wiki"),
  join(root, "packages/orgbrain-cli/skills/org-brain-wiki"),
  { recursive: true },
);
console.log(`Native Wiki package: ${dir}`);
