import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { projectIndexPath } from "../../../shared/src/agent-memory-protocol.mjs";

// This is a local, read-only preview. It never executes repository scripts.
export async function draftProjectIndex({ root, projectId }) {
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) throw new Error("project_index_project_id_required");
  const gaps = [];
  const result = { project_id: projectId, saved: false, procedures: [], gaps };
  let info;
  try { info = await lstat(join(root, "package.json")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    gaps.push("package_json_missing");
    return result;
  }
  if (!info.isFile() || info.size > 1024 * 1024) {
    gaps.push("package_json_not_regular_file");
    return result;
  }
  let handle;
  try { handle = await open(join(root, "package.json"), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === "ELOOP" || error.code === "ENOENT") { gaps.push("package_json_not_regular_file"); return result; }
    throw error;
  }
  let text;
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > 1024 * 1024) { gaps.push("package_json_not_regular_file"); return result; }
    text = await handle.readFile("utf8");
  } finally { await handle.close(); }
  let manifest;
  try { manifest = JSON.parse(text); }
  catch { gaps.push("package_json_invalid"); return result; }
  const scripts = manifest && manifest.scripts && typeof manifest.scripts === "object" && !Array.isArray(manifest.scripts) ? manifest.scripts : {};
  let manager = "npm";
  for (const [file, name] of [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"]]) {
    try { if ((await lstat(join(root, file))).isFile()) { manager = name; break; } }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const sha256 = createHash("sha256").update(text).digest("hex");
  for (const name of Object.keys(scripts).sort()) {
    if (!/^(?:test|check|lint|build|dev|start)(?::[A-Za-z0-9_-]+)*$/u.test(name) || typeof scripts[name] !== "string") continue;
    result.procedures.push({ title: name, command: `${manager} run ${name}`, source: { path: "package.json", sha256 }, verification: "not_run" });
  }
  if (!result.procedures.length) gaps.push("no_supported_scripts");
  if (result.procedures.length > 12) {
    result.procedures = result.procedures.slice(0, 12);
    gaps.push("additional_scripts_omitted");
  }
  if (result.procedures.length) {
    result.entries = result.procedures.map(item => ({
      key: `script-${createHash("sha256").update(item.title).digest("hex").slice(0, 16)}`,
      title: item.title,
      command: item.command,
      source: `package.json sha256 ${item.source.sha256}`
    }));
    const projectPath = projectIndexPath(projectId);
    const prefix = projectPath.slice(0, -"index.md".length);
    result.memories = result.procedures.map(item => ({
      path: `${prefix}script-${createHash("sha256").update(item.title).digest("hex").slice(0, 16)}.md`,
      memory: {
        title: item.title,
        claim: `Run the ${item.title} script defined in package.json.`,
        procedure: [item.command],
        basis: "implementation",
        limitations: ["This command was not run; review it and the current package.json before use.",
          `Source: package.json sha256 ${item.source.sha256}`]
      }
    }));
    const lines = result.memories.map(item => `- [${item.memory.title}](${item.path}): package.json script; execution not verified.`);
    result.index_markdown = `---\namp: "0.4"\nkind: project_index\nproject_id: ${JSON.stringify(projectId)}\n---\n# Project procedures\n\nReview each script and its source before use.\n\n## Procedures\n${lines.join("\n")}\n`;
  }
  return result;
}
