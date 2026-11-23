import { sha256, screenSensitiveMemory } from "@org-brain/shared";
import { z } from "zod";
import { parseAmpPage, projectIndexPath } from "../../../packages/shared/src/agent-memory-protocol.mjs";
import type { Env } from "./types";

const singleLine = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), "single line required");
export const projectCommonEntry = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  title: singleLine(200),
  command: singleLine(500),
  source: singleLine(300)
});
export const projectCommonEntries = z.array(projectCommonEntry).max(40).refine(
  entries => new Set(entries.map(entry => entry.key)).size === entries.length,
  "duplicate entry key"
);
export const projectIndexEvidence = z.strictObject({
  source_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/),
  end_line: z.number().int().positive()
});
type Entry = z.infer<typeof projectCommonEntry>;
type Scope = { tenantId: string; projectId: string; principal: string };
type Row = { entries_json: string; hash: string; revision: number; updated_at: number; updated_by: string };
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

function verifyPackageSource(content: string, hash: string, entries: Entry[]) {
  if (!screenSensitiveMemory(content).allowed || content.length > 12000) throw Error("project_index_source_unavailable");
  let manifest: any;
  try { manifest = JSON.parse(content); } catch { throw Error("project_index_source_invalid"); }
  if (!manifest?.scripts || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)
    || entries.some(entry => !/^(?:test|check|lint|build|dev|start)(?::[A-Za-z0-9_-]+)*$/u.test(entry.title)
      || !Object.hasOwn(manifest.scripts, entry.title) || typeof manifest.scripts[entry.title] !== "string"
      || !["npm", "pnpm", "yarn"].some(manager => entry.command === `${manager} run ${entry.title}`)
      || entry.source !== `package.json sha256 ${hash}`)) throw Error("project_index_source_mismatch");
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

export async function readProjectCommonIndex(env: Env, scope: Scope) {
  const row = await env.OPEN_BRAIN_DB.prepare(
    "SELECT entries_json,hash,revision,updated_at,updated_by FROM project_common_indexes WHERE tenant_id=? AND project_id=?"
  ).bind(scope.tenantId, scope.projectId).first<Row>();
  if (!row) return { found: false, entries: [] as Entry[] };
  return { found: true, entries: projectCommonEntries.parse(JSON.parse(row.entries_json)), hash: row.hash,
    revision: row.revision, updated_at: row.updated_at, updated_by: row.updated_by };
}

export async function publishProjectCommonIndex(env: Env, scope: Scope, entries: Entry[], expectedHash?: string) {
  const parsed = projectCommonEntries.parse(entries);
  if (!screenSensitiveMemory(JSON.stringify(parsed)).allowed) throw Error("project_index_sensitive_content");
  const current = await readProjectCommonIndex(env, scope);
  if ((current.found && !expectedHash) || (expectedHash && expectedHash !== current.hash)) throw Error("project_index_changed");
  const revision = (current.revision ?? 0) + 1;
  const json = JSON.stringify(parsed);
  const hash = await sha256(JSON.stringify([scope.tenantId, scope.projectId, revision, json]));
  const now = Date.now();
  const statement = current.found
    ? env.OPEN_BRAIN_DB.prepare("UPDATE project_common_indexes SET entries_json=?,hash=?,revision=?,updated_at=?,updated_by=? WHERE tenant_id=? AND project_id=? AND hash=?")
      .bind(json, hash, revision, now, scope.principal, scope.tenantId, scope.projectId, expectedHash)
    : env.OPEN_BRAIN_DB.prepare("INSERT INTO project_common_indexes(tenant_id,project_id,entries_json,hash,revision,updated_at,updated_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(scope.tenantId, scope.projectId, json, hash, revision, now, scope.principal);
  if ((await statement.run()).meta.changes !== 1) throw Error("project_index_changed");
  return { saved: true, hash, revision };
}

// A checked guard and both page writes run in one D1 batch. A failed guard
// violates its CHECK constraint and rolls the entire batch back.
export async function savePersonalProjectIndex(
  env: Env, scope: Scope,
  input: { entries?: Entry[]; key?: string; commonHash?: string; personalHash?: string; evidence?: z.infer<typeof projectIndexEvidence>; sourceText?: string }
) {
  let entries: Entry[];
  let commonHash: string | undefined;
  let newSource: { id: string; text: string; hash: string; name: string; endLine: number } | undefined;
  let existingSource: z.infer<typeof projectIndexEvidence> | undefined;
  const adopting = input.key !== undefined;
  if (adopting) {
    const common = await readProjectCommonIndex(env, scope);
    if (!common.found || common.hash !== input.commonHash) throw Error("project_common_index_changed");
    const selected = common.entries.find(entry => entry.key === input.key);
    if (!selected) throw Error("project_common_entry_missing");
    entries = [selected];
    commonHash = common.hash;
    const sourceText = JSON.stringify({ project_id: scope.projectId, common_index_hash: common.hash,
      updated_by: common.updated_by, updated_at: common.updated_at, entry: selected });
    newSource = { id: `s-${crypto.randomUUID()}`, text: sourceText, hash: await sha256(sourceText), name: "Adopted project index entry", endLine: 1 };
  } else {
    entries = projectCommonEntries.parse(input.entries);
    if (!entries.length || entries.length > 12) throw Error("project_index_invalid_entries");
    if (input.evidence && input.sourceText !== undefined) throw Error("project_index_multiple_sources");
    if (input.sourceText !== undefined) {
      const sourceHash = await sha256(input.sourceText);
      const endLine = verifyPackageSource(input.sourceText, sourceHash, entries);
      newSource = { id: `s-${crypto.randomUUID()}`, text: input.sourceText, hash: sourceHash, name: "Reviewed package.json", endLine };
    } else if (input.evidence) {
      existingSource = projectIndexEvidence.parse(input.evidence);
      const source = await env.OPEN_BRAIN_DB.prepare(
        "SELECT content,hash FROM amp_sources WHERE tenant_id=? AND owner_principal=? AND project_id=? AND source_id=? AND version=?"
      ).bind(scope.tenantId, scope.principal, scope.projectId, existingSource.source_id, existingSource.version).first<{ content: string; hash: string }>();
      if (!source || source.hash !== existingSource.hash || await sha256(source.content) !== source.hash || source.content.length > 12000) throw Error("project_index_source_unavailable");
      if (verifyPackageSource(source.content, existingSource.hash, entries) !== existingSource.end_line) throw Error("project_index_source_incomplete");
    }
  }
  if (entries.some(entry => [entry.command, entry.title, entry.source].some(value => /[\r\n\p{Cc}\p{Zl}\p{Zp}]/u.test(value))
    || entry.command.length > 500)) throw Error("project_index_invalid_entry_text");
  if (!screenSensitiveMemory(JSON.stringify(entries)).allowed) throw Error("project_index_sensitive_content");

  const indexPath = projectIndexPath(scope.projectId);
  const binding = [scope.tenantId, scope.principal, scope.projectId];
  const current = await env.OPEN_BRAIN_DB.prepare(
    "SELECT path,title,markdown,hash,revision,updated_at FROM amp_pages WHERE tenant_id=? AND owner_principal=? AND project_id=? AND path=?"
  ).bind(...binding, indexPath).first<{ title: string; markdown: string; hash: string; revision: number }>();
  if (adopting ? (!current || current.hash !== input.personalHash) : Boolean(current)) throw Error("personal_project_index_changed");
  if (current) {
    const parsed = parseAmpPage(current.markdown);
    if (parsed.kind !== "project_index" || parsed.project_id !== scope.projectId || parsed.entries.length >= 12) throw Error("personal_project_index_invalid");
  }
  const sourceRef = newSource ? `source:${newSource.id}@1#L1-L${newSource.endLine}` : existingSource
    ? `source:${existingSource.source_id}@${existingSource.version}#L1-L${existingSource.end_line}` : undefined;
  const notes = await Promise.all(entries.map(async e => {
    const id = (await sha256(JSON.stringify([commonHash ?? "onboarding", e]))).slice(0, 32);
    const path = indexPath.slice(0, -"index.md".length) + `selected-${id}.md`;
    const title = adopting ? "Adopted project procedure" : "Project onboarding procedure";
    const content = `---\namp: "0.4"\nbasis: proposal\n---\n# ${title}\n\nReview this procedure and source before use. ${commonHash ? `Shared index version: ${commonHash}.` : ""}\n\n## Procedure\n\n- ${e.command}\n\n## Limitations\n\n- Unverified execution and source conditions for ${e.key}: ${e.source}\n${sourceRef ? `\n## Sources\n\n- ${sourceRef}\n` : ""}`;
    if (parseAmpPage(content).kind !== "memory") throw Error("project_index_invalid_document");
    const hash = await sha256(JSON.stringify([...binding, path, 1, title, content]));
    return { entry: e, path, title, content, hash };
  }));
  const links = notes.map(n => `- [${n.entry.title.replace(/[\[\]\\]/gu, "") || n.entry.key}](${n.path}): Selected project procedure; verify before use.`);
  const indexTitle = current?.title ?? "Project procedures";
  const index = current
    ? `${current.markdown.trimEnd()}\n\n## Procedures\n${links.join("\n")}\n`
    : `---\namp: "0.4"\nkind: project_index\nproject_id: ${JSON.stringify(scope.projectId)}\n---\n# Project procedures\n\nReview each procedure and its source before use.\n\n## Procedures\n${links.join("\n")}\n`;
  const parsedIndex = parseAmpPage(index);
  if (parsedIndex.kind !== "project_index" || parsedIndex.project_id !== scope.projectId) throw Error("project_index_invalid_document");
  const indexRevision = (current?.revision ?? 0) + 1;
  const indexHash = await sha256(JSON.stringify([...binding, indexPath, indexRevision, indexTitle, index]));
  const now = Date.now();
  const guardId = crypto.randomUUID();
  const personalGuard = current
    ? "EXISTS (SELECT 1 FROM amp_pages WHERE tenant_id=? AND owner_principal=? AND project_id=? AND path=? AND hash=?)"
    : "NOT EXISTS (SELECT 1 FROM amp_pages WHERE tenant_id=? AND owner_principal=? AND project_id=? AND path=?)";
  const commonGuard = adopting ? " AND EXISTS (SELECT 1 FROM project_common_indexes WHERE tenant_id=? AND project_id=? AND hash=?)" : "";
  const sourceGuard = existingSource ? " AND EXISTS (SELECT 1 FROM amp_sources WHERE tenant_id=? AND owner_principal=? AND project_id=? AND source_id=? AND version=? AND hash=?)" : "";
  const noteGuards = notes.map(() => " AND NOT EXISTS (SELECT 1 FROM amp_pages WHERE tenant_id=? AND owner_principal=? AND project_id=? AND path=?)").join("");
  const guard = env.OPEN_BRAIN_DB.prepare(`INSERT INTO project_index_write_guards(id,ok) SELECT ?,CASE WHEN ${personalGuard}
    ${noteGuards}${commonGuard}${sourceGuard} THEN 1 ELSE 0 END`)
    .bind(guardId, ...binding, indexPath, ...(current ? [current.hash] : []), ...notes.flatMap(n => [...binding, n.path]),
      ...(adopting ? [scope.tenantId, scope.projectId, commonHash] : []),
      ...(existingSource ? [...binding, existingSource.source_id, existingSource.version, existingSource.hash] : []));
  const noteWrites = notes.map(n => env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO amp_pages(tenant_id,owner_principal,project_id,path,title,markdown,search_text,hash,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?)"
  ).bind(...binding, n.path, n.title, n.content, normalize(`${n.title}\n${n.content}`), n.hash, now));
  const indexWrite = current
    ? env.OPEN_BRAIN_DB.prepare("UPDATE amp_pages SET title=?,markdown=?,search_text=?,hash=?,revision=?,updated_at=? WHERE tenant_id=? AND owner_principal=? AND project_id=? AND path=? AND hash=?")
      .bind(indexTitle, index, normalize(`${indexTitle}\n${index}`), indexHash, indexRevision, now, ...binding, indexPath, current.hash)
    : env.OPEN_BRAIN_DB.prepare("INSERT INTO amp_pages(tenant_id,owner_principal,project_id,path,title,markdown,search_text,hash,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?)")
      .bind(...binding, indexPath, indexTitle, index, normalize(`${indexTitle}\n${index}`), indexHash, now);
  const clear = env.OPEN_BRAIN_DB.prepare("DELETE FROM project_index_write_guards WHERE id=?").bind(guardId);
  const sourceWrite = newSource ? env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO amp_sources(tenant_id,owner_principal,project_id,source_id,version,name,content,search_text,hash,created_at) VALUES(?,?,?,?,1,?,?,?,?,?)"
  ).bind(...binding, newSource.id, newSource.name, newSource.text,
    normalize(newSource.text), newSource.hash, now) : null;
  await env.OPEN_BRAIN_DB.batch([guard, ...(sourceWrite ? [sourceWrite] : []), ...noteWrites, indexWrite, clear]);
  return { saved: true, index_path: indexPath, index_hash: indexHash, note_path: notes[0]!.path, note_hash: notes[0]!.hash,
    notes: notes.map(n => ({ path: n.path, hash: n.hash })) };
}
