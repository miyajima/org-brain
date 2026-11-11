import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  WikiService,
  wikiStatus,
  setWikiFeature,
  DEFAULT_FEATURES_FILE,
} from "./wiki-service.mjs";

export async function runWikiCli(command, action, rest, args, readStdin) {
  const config = args.get(
    "--features",
    process.env.ORGBRAIN_FEATURES_FILE || DEFAULT_FEATURES_FILE,
  );
  if (command === "feature") {
    if (action !== "llm-wiki") throw new Error("unknown_feature");
    const op = rest[0] || "status";
    if (op === "status") return wikiStatus(config);
    if (!["enable", "disable"].includes(op))
      throw new Error("invalid_feature_action");
    return setWikiFeature(config, op === "enable");
  }
  const wiki = new WikiService({ config, root: args.get("--wiki-root") });
  if (action === "install-skill") {
    if (!(await wikiStatus(config)).enabled)
      throw new Error("feature_disabled");
    const { installWikiSkill } = await import("./wiki-skill-install.mjs");
    return installWikiSkill({
      home: args.get("--home"),
      target: args.get("--target"),
      execute: args.flags.has("--execute"),
    });
  }
  if (action === "maintenance-context") {
    const { wikiMaintenanceContext } = await import("./wiki-maintenance.mjs");
    const raw = await readStdin();
    return wikiMaintenanceContext(wiki, raw.trim() ? JSON.parse(raw) : {});
  }
  if (action === "reindex-embeddings") return wiki.reindexEmbeddings();
  if (action === "status") return wikiStatus(config);
  if (["amp-search", "amp-read", "amp-validate", "amp-schema"].includes(action)) {
    const allowed = new Set(["--features", "--wiki-root", "--json", ...(action === "amp-schema" ? [] : ["--project-id", "--path", "--token-budget"]),
      ...(["amp-search", "amp-read"].includes(action) ? ["--path-prefix", "--facts-json", "--mode"] : []),
      ...(action === "amp-search" ? ["--limit", "--query", "--detail", "--no-fallback"] : action === "amp-read" ? ["--expected-hash", "--include-evidence"] : action === "amp-validate" ? ["--page-id"] : [])]);
    if (args.names().some(name => !allowed.has(name)) || args.ambiguousOptions()) throw new Error("amp_invalid_cli_options");
    if ((action === "amp-schema" && rest.length) || (["amp-validate", "amp-read"].includes(action) && (rest.length > 1 || (rest.length && (args.get("--path") || args.get("--page-id")))))) throw new Error("amp_invalid_cli_options");
    const { searchAmp, readAmp, validateAmpPage, ampJsonSchema } = await import("./agent-memory-protocol.mjs");
    if (action === "amp-schema") return ampJsonSchema();
    const input = {};
    for (const key of ["project_id", "path_prefix", "path", "page_id"])
      if (args.get(`--${key.replaceAll("_", "-")}`) !== undefined) input[key] = args.get(`--${key.replaceAll("_", "-")}`);
    for (const key of ["token_budget", "limit"])
      if (args.get(`--${key.replaceAll("_", "-")}`) !== undefined) input[key] = Number(args.get(`--${key.replaceAll("_", "-")}`));
    if (action === "amp-validate") {
      if (rest[0]) input.path = rest[0];
      return validateAmpPage(wiki, input);
    }
    if (args.get("--facts-json")) input.facts = JSON.parse(args.get("--facts-json"));
    if (args.get("--mode") !== undefined) input.mode = args.get("--mode");
    if (action === "amp-read") {
      if (rest[0]) input.path = rest[0];
      input.expected_hash = args.get("--expected-hash");
      input.include_evidence = args.flags.has("--include-evidence");
      return readAmp(wiki, input);
    }
    input.query = rest.join(" ") || args.get("--query");
    if (args.get("--detail") !== undefined) input.detail = args.get("--detail");
    if (args.flags.has("--no-fallback")) input.fallback = false;
    return searchAmp(wiki, input);
  }
  if (action === "ingest-folder") {
    const folder = rest[0] || args.get("--folder");
    if (!folder) throw new Error("folder_required");
    return wiki.ingestFolder({ folder: resolve(folder), dry_run: args.flags.has("--dry-run") });
  }
  const op = action?.replaceAll("-", "_");
  const input = { op };
  for (const field of [
    "page_id",
    "source_id",
    "expected_hash",
    "section",
    "title",
    "project_id",
    "name",
    "url",
    "draft_id",
    "revision_id",
    "extractor",
    "mode",
    "scope",
    "folder_id",
    "match_mode",
    "path_prefix",
    "heading",
    "since",
    "until",
    "query",
    "workspace",
    "session_policy",
    "context_mode",
    "excerpt_mode",
    "session_since",
    "session_until",
  ]) {
    const value = args.get(`--${field.replaceAll("_", "-")}`);
    if (value !== undefined) input[field] = value;
  }
  input.expected_hash ??= args.get("--if-match");
  for (const field of [
    "start_line",
    "end_line",
    "max_chars",
    "char_offset",
    "offset",
    "token_budget",
    "limit",
    "version",
    "depth",
    "page_count",
    "per_owner_limit",
    "context_lines",
    "passage_chars",
  ]) {
    const value = args.get(`--${field.replaceAll("_", "-")}`);
    if (value !== undefined) input[field] = Number(value);
  }
  if (args.flags.has("--dry-run")) input.dry_run = true;
  if (["put", "patch", "draft", "extraction_put"].includes(op)) {
    input.content = args.get("--input")
      ? await readFile(resolve(args.get("--input")), "utf8")
      : (args.get("--content") ?? (await readStdin()));
    if (op === "extraction_put") {
      input.text = input.content;
      delete input.content;
    }
  }
  if (op === "search")
    return wiki.search({
      ...input,
      query: rest.join(" ") || args.get("--query"),
    });
  if (op === "capture" || op === "capture_audit") {
    if (args.get("--input")) input.file = resolve(args.get("--input"));
    else input.text = await readStdin();
    if (op === "capture_audit" && input.file) { input.text = await readFile(input.file, "utf8"); delete input.file; }
    input.summary = args.get("--summary-input") ? await readFile(resolve(args.get("--summary-input")), "utf8") : (args.get("--summary") ?? "");
    const origin = Object.fromEntries([ ["session_id","--origin-session-id"], ["turn_id","--origin-turn-id"], ["recorded_at","--recorded-at"] ].filter(([,flag])=>args.get(flag)!==undefined).map(([key,flag])=>[key,args.get(flag)]));
    if(Object.keys(origin).length) input.origin=origin;
  }
  if (op === "recall") {
    input.query = rest.join(" ") || args.get("--query");
    if(args.get("--targets-json")) input.targets=JSON.parse(args.get("--targets-json"));
    if(args.get("--session-files")) input.session_files=JSON.parse(args.get("--session-files"));
    else if(args.get("--session-file")) input.session_files=[resolve(args.get("--session-file"))];
    const { recallWiki } = await import("./wiki-recall.mjs");
    return recallWiki(wiki,input);
  }
  if (op === "ingest") {
    const file = rest[0] || args.get("--file");
    if (!file && !input.url) throw new Error("source_content_required");
    if (file) input.file = resolve(file);
    if ((!file && input.url) || file?.toLowerCase().endsWith(".pdf")) {
      const status = await wikiStatus(config);
      if (!status.enabled) throw new Error("feature_disabled");
      const { importWikiSource } = await import("./wiki-source-import.mjs");
      return importWikiSource(wiki, { ...input, kind: file ? "pdf" : "url" }, status.epoch);
    }
  }
  if (["migrate", "restore_backup"].includes(op))
    input.from = resolve(args.get("--from"));
  if (["backup", "export"].includes(op))
    input.output = resolve(args.get("--output"));
  if (op === "rename") {
    const old = await wiki.request({ op: "read", path: rest[0] });
    input.page_id = old.page_id;
    input.path = rest[1];
  } else if (
    rest[0] &&
    !["ingest", "migrate", "restore_backup", "backup", "export"].includes(op)
  )
    input.path = rest[0];
  return wiki.request(input);
}
