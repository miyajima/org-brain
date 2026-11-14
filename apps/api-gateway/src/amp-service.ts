import { sha256 } from "@org-brain/shared";
import { z } from "zod";
import { countAmpTokens, createAmpRuntime, type AmpRuntime } from "../../../packages/shared/src/agent-memory-protocol.mjs";
import type { Env } from "./types";

type Input = Record<string, any>;
type Scope = { tenantId: string; principal: string; projectId: string };
type Page = { path: string; title: string; markdown: string; hash: string; revision: number; updated_at: number };
type Source = { source_id: string; version: number; name: string; content: string; hash: string; created_at: number };
const digest = (text: string) => sha256(text);
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
const sourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(128);
export const ampSourceInputShape = {
  name: z.string().trim().min(1).max(200), text: z.string().min(1).max(64000), source_id: sourceId.optional()
};
export const ampSourceReadInputShape = {
  source_id: sourceId, version: z.number().int().positive(),
  start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional(),
  max_chars: z.number().int().min(1).max(64000).optional()
};

// The MCP authorization gate checks tenant/project permissions first. This backend also
// binds every statement to the authenticated owner; request arguments cannot change it.
export class CloudAmpService {
  private readonly runtime: AmpRuntime;
  constructor(private readonly env: Env, private readonly scope: Scope) {
    for (const value of Object.values(scope)) if (!value?.trim()) throw Error("amp_scope_required");
    this.runtime = createAmpRuntime({
      countTokens: countAmpTokens, recall: (_wiki, input) => this.recall(input),
      readArguments: args => ({ ...args, tenant_id: scope.tenantId, project_id: scope.projectId })
    });
  }
  private binding() { return [this.scope.tenantId, this.scope.principal, this.scope.projectId]; }
  private input(raw: Input): Input {
    if (this.env.ORGBRAIN_AMP_ENABLED !== "true") throw Error("feature_disabled");
    if (raw.tenant_id !== undefined && raw.tenant_id !== this.scope.tenantId) throw Error("tenant_scope_mismatch");
    if (raw.project_id !== undefined && raw.project_id !== this.scope.projectId) throw Error("project_scope_mismatch");
    if (raw.wiki_id !== undefined && raw.wiki_id !== "personal") throw Error("wiki_binding_mismatch");
    const { tenant_id, ...input } = raw;
    return { ...input, project_id: this.scope.projectId };
  }
  async save(input: Input) { return this.runtime.saveAmp(this, this.input(input)); }
  async search(input: Input) { return this.runtime.searchAmp(this, this.input(input)); }
  async read(input: Input) { return this.runtime.readAmp(this, this.input(input)); }
  async validate(input: Input) { return this.runtime.validateAmpPage(this, this.input(input)); }
  async projectIndex() { return this.runtime.projectIndexContext(this, this.input({})); }

  async request(raw: Input): Promise<Input> {
    const input = this.input(raw);
    if (input.op === "source_read") return this.sourceRead(input);
    if (input.op === "search") {
      const terms = String(input.query).split(/\s+/).filter(Boolean).map(normalize).slice(0, 8);
      const hits = await this.searchRows("amp_pages", terms, input.limit ?? 100, input.path_prefix);
      return { hits: hits.rows.map(row => ({ kind: "page", owner_id: row.path })), truncated: hits.truncated };
    }
    const path = input.path ?? input.page_id;
    if (typeof path !== "string") throw Error("amp_path_required");
    const existing = await this.env.OPEN_BRAIN_DB.prepare(
      "SELECT path,title,markdown,hash,revision,updated_at FROM amp_pages WHERE tenant_id=? AND owner_principal=? AND project_id=? AND path=?"
    ).bind(...this.binding(), path).first<Page>();
    if (input.op === "read") {
      if (!existing) throw Error("page_not_found");
      return { path, page_id: path, title: existing.title, content: existing.markdown, hash: existing.hash,
        project_id: this.scope.projectId, truncated: false };
    }
    if (input.op !== "put") throw Error("amp_unsupported_operation");
    if (existing && !input.expected_hash) throw Error("expected_hash_required");
    if (input.expected_hash && input.expected_hash !== existing?.hash) throw Error("amp_memory_changed");
    const revision = (existing?.revision ?? 0) + 1;
    const hash = await digest(JSON.stringify([...this.binding(), path, revision, input.title, input.content]));
    const searchText = normalize(`${input.title}\n${input.content}`);
    const result = existing
      ? await this.env.OPEN_BRAIN_DB.prepare(
        "UPDATE amp_pages SET title=?,markdown=?,search_text=?,hash=?,revision=?,updated_at=? WHERE tenant_id=? AND owner_principal=? AND project_id=? AND path=? AND hash=?"
      ).bind(input.title, input.content, searchText, hash, revision, Date.now(), ...this.binding(), path, input.expected_hash).run()
      : await this.env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO amp_pages(tenant_id,owner_principal,project_id,path,title,markdown,search_text,hash,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING"
      ).bind(...this.binding(), path, input.title, input.content, searchText, hash, revision, Date.now()).run();
    if (result.meta.changes !== 1) throw Error("amp_memory_changed");
    return { path, hash, created: !existing };
  }

  async ingest(raw: Input) {
    const { project_id, wiki_id, ...input } = this.input(raw);
    const value = z.strictObject(ampSourceInputShape).parse(input);
    const hash = await digest(value.text), id = value.source_id ?? `s-${hash.slice(0, 24)}`;
    const existing = await this.env.OPEN_BRAIN_DB.prepare(
      "SELECT source_id,version,name,content,hash,created_at FROM amp_sources WHERE tenant_id=? AND owner_principal=? AND project_id=? AND source_id=? ORDER BY version DESC LIMIT 1"
    ).bind(...this.binding(), id).first<Source>();
    if (existing && existing.hash === hash) return { source_id: id, version: existing.version, hash, writes_performed: false };
    const saved = await this.env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO amp_sources(tenant_id,owner_principal,project_id,source_id,version,name,content,search_text,hash,created_at)
       SELECT ?,?,?,?,COALESCE(MAX(version),0)+1,?,?,?,?,? FROM amp_sources
       WHERE tenant_id=? AND owner_principal=? AND project_id=? AND source_id=? RETURNING version`
    ).bind(...this.binding(), id, value.name, value.text, normalize(`${value.name}\n${value.text}`), hash, Date.now(), ...this.binding(), id).first<{ version: number }>();
    if (!saved) throw Error("amp_source_not_saved");
    return { source_id: id, version: saved.version, hash, writes_performed: true };
  }

  async sourceRead(raw: Input): Promise<Input> {
    const { project_id, wiki_id, op, ...input } = this.input(raw);
    const value = z.strictObject(ampSourceReadInputShape).parse(input);
    const row = await this.env.OPEN_BRAIN_DB.prepare(
      "SELECT source_id,version,name,content,hash,created_at FROM amp_sources WHERE tenant_id=? AND owner_principal=? AND project_id=? AND source_id=? AND version=?"
    ).bind(...this.binding(), value.source_id, value.version).first<Source>();
    if (!row) throw Error("source_not_found");
    if (await digest(row.content) !== row.hash) throw Error("source_corrupt");
    const lines = row.content.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const start = value.start_line ?? 1, end = value.end_line ?? lines.length;
    if (start > end || end > lines.length) throw Error("invalid_line_range");
    const text = lines.slice(start - 1, end).join("\n"), max = value.max_chars ?? 64000;
    return { source_id: row.source_id, version: row.version, name: row.name, hash: row.hash,
      start_line: start, end_line: end, text: text.slice(0, max), truncated: text.length > max };
  }

  private async searchRows(table: "amp_pages" | "amp_sources", terms: string[], limit: number, prefix?: string) {
    if (!terms.length) return { rows: [] as Input[], truncated: false };
    const matches = terms.map(() => "instr(search_text,?)>0");
    const score = matches.map(match => `CASE WHEN ${match} THEN 1 ELSE 0 END`).join("+");
    const latest = table === "amp_sources" ? ` AND NOT EXISTS (
      SELECT 1 FROM amp_sources newer WHERE newer.tenant_id=s.tenant_id AND newer.owner_principal=s.owner_principal
      AND newer.project_id=s.project_id AND newer.source_id=s.source_id AND newer.version>s.version)` : "";
    const pathFilter = prefix !== undefined ? " AND substr(path,1,length(?))=?" : "";
    const columns = table === "amp_pages" ? "path,title,hash" : "source_id,version,name,content,hash";
    const rows = await this.env.OPEN_BRAIN_DB.prepare(
      `SELECT ${columns},(${score}) AS rank FROM ${table} s WHERE tenant_id=? AND owner_principal=? AND project_id=?
       AND (${matches.join(" OR ")})${latest}${pathFilter} ORDER BY rank DESC,${table === "amp_pages" ? "updated_at" : "created_at"} DESC LIMIT ?`
    ).bind(...terms, ...this.binding(), ...terms, ...(prefix !== undefined ? [prefix, prefix] : []), limit + 1).all<Input>();
    return { rows: rows.results.slice(0, limit), truncated: rows.results.length > limit };
  }

  private async recall(input: Input) {
    // Cloud originals have project ownership but no Wiki page path. A path filter
    // must not silently broaden to all originals in the project.
    if (input.path_prefix !== undefined) return { evidence: [], truncated: false };
    const terms = String(input.query).split(/\s+/).filter(Boolean).map(normalize).slice(0, 8);
    const found = await this.searchRows("amp_sources", terms, input.limit ?? 20);
    const evidence = found.rows.map(row => {
      const lines: string[] = row.content.split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      const first = Math.max(0, lines.findIndex(line => terms.some(term => normalize(line).includes(term))) - 2);
      const max = input.passage_chars ?? 1800;
      let end = first, text = lines[first] ?? "";
      while (end + 1 < lines.length && text.length + lines[end + 1]!.length + 1 <= max) text += `\n${lines[++end]}`;
      return { kind: "source", id: `source:${row.source_id}@${row.version}#L${first + 1}-L${end + 1}`,
        source_id: row.source_id, version: row.version, hash: row.hash, heading: row.name,
        start_line: first + 1, end_line: end + 1, text: text.slice(0, max),
        truncated: first > 0 || end + 1 < lines.length || text.length > max,
        verification_state: "source_content_not_execution_attestation" };
    });
    return { evidence, truncated: found.truncated };
  }
}
