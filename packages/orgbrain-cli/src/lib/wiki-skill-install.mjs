import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, mkdir, writeFile, lstat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

async function rejectSymlinks(path) {
  for (let current = path; ; current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("symlink_rejected");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current === dirname(current)) break;
  }
}

async function skillFiles(root, relative = "") {
  const files = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    if (entry.isSymbolicLink()) throw new Error("symlink_rejected");
    const path = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await skillFiles(root, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error("invalid_skill_file");
  }
  return files.sort();
}

export async function installWikiSkill({
  home = homedir(),
  target,
  execute = false,
} = {}) {
  const clients = { codex: ".codex", claude: ".claude", cursor: ".cursor" };
  if (!Object.hasOwn(clients, target))
    throw new Error("target_required: codex|claude|cursor");
  home = resolve(home);
  const destination = join(
    home,
    clients[target],
    "skills/org-brain-wiki/SKILL.md",
  );
  const candidates = [
    fileURLToPath(
      new URL("../../skills/org-brain-wiki/SKILL.md", import.meta.url),
    ),
    fileURLToPath(
      new URL("../skills/org-brain-wiki/SKILL.md", import.meta.url),
    ),
    fileURLToPath(
      new URL("../../../../skills/org-brain-wiki/SKILL.md", import.meta.url),
    ),
  ];
  const source = candidates.find(existsSync);
  if (!source) throw new Error("wiki_skill_unavailable");
  const pending = [];
  for (const relative of await skillFiles(dirname(source))) {
    const path = join(dirname(destination), relative);
    await rejectSymlinks(path);
    const content = await readFile(join(dirname(source), relative));
    try {
      if (!(await readFile(path)).equals(content)) {
        throw new Error(
          "skill_already_installed: preserve and review existing content",
        );
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      pending.push({ path, content });
    }
  }
  if (pending.length === 0) {
    return { destination, applied: false, unchanged: true };
  }
  if (!execute)
    return {
      destination,
      applied: false,
      files: pending.map((file) => file.path),
    };
  for (const { path, content } of pending) {
    await rejectSymlinks(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600, flag: "wx" });
  }
  return { destination, applied: true };
}
