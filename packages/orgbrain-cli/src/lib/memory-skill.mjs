import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

function slugify(value, identity) {
  const slug = String(value ?? "orgbrain-memory")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 47);
  const suffix = createHash("sha256").update(String(identity), "utf8").digest("hex").slice(0, 8);
  return `${slug || "orgbrain-memory"}-${suffix}`;
}

function approvedMemory(memory) {
  if (memory.verification_state === "verified") return true;
  return (memory.evidence ?? []).some((entry) =>
    ["user_confirmed", "user_corrected"].includes(entry.confirmation_state)
  );
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function render(memory, skillName) {
  const provenance = createHash("sha256")
    .update(`${memory.id}\0${memory.current_version}\0${memory.content_hash}`, "utf8")
    .digest("hex");
  const description = String(memory.summary ?? memory.content).replace(/\s+/gu, " ").slice(0, 180);
  return `---\nname: ${skillName}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${memory.summary ?? "Approved OrgBrain memory"}\n\n${memory.content}\n\n## When to use\n\n${memory.reuse_rule || "Use when this confirmed decision or procedure applies."}\n\n## Provenance\n\n- OrgBrain memory: ${memory.id}\n- Version: ${memory.current_version}\n- Content hash: ${memory.content_hash}\n- Skill provenance hash: ${provenance}\n- Approval: confirmed\n`;
}

export async function previewMemorySkill(store, { tenantId = "default", memoryId, projectRoot = process.cwd() }) {
  const memory = await store.get(tenantId, memoryId);
  if (!memory) throw new Error("memory_not_found");
  if (!approvedMemory(memory)) throw new Error("memory_not_approved");
  const skillName = slugify(memory.summary || memory.external_key || memory.id, memory.id);
  const path = resolve(projectRoot, ".agents", "skills", skillName, "SKILL.md");
  return {
    approved: true,
    memory_id: memory.id,
    memory_version: memory.current_version,
    skill_name: skillName,
    path,
    overwrites_existing: await exists(path),
    content: render(memory, skillName)
  };
}

export async function installMemorySkill(store, options) {
  const preview = await previewMemorySkill(store, options);
  const force = options.force === true;
  if (preview.overwrites_existing && !force) throw new Error("skill_already_exists");
  await mkdir(dirname(preview.path), { recursive: true, mode: 0o700 });
  const staged = join(dirname(preview.path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(staged, preview.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (force) {
      try {
        await rename(staged, preview.path);
      } catch (error) {
        if (!["EEXIST", "EPERM"].includes(error?.code)) throw error;
        await unlink(preview.path);
        await rename(staged, preview.path);
      }
    } else {
      await link(staged, preview.path);
      await unlink(staged);
    }
  } catch (error) {
    await unlink(staged).catch(() => undefined);
    if (error?.code === "EEXIST") throw new Error("skill_already_exists");
    throw error;
  }
  return { ...preview, installed: true, replaced: preview.overwrites_existing };
}
