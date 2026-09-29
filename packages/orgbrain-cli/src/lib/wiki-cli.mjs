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
  if (op === "ingest") input.file = resolve(rest[0] || args.get("--file"));
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
