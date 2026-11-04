import {
  wikiStatusSync,
  wikiServiceForStore,
  countWikiTokens,
} from "./wiki-service.mjs";
import { recallWiki } from "./wiki-recall.mjs";

const properties = {
  wiki_id: { type: "string", enum: ["personal"] },
  path: { type: "string", maxLength: 512 },
  page_id: { type: "string" },
  source_id: { type: "string" },
  folder_id: { type: "string", pattern: "^[a-f0-9]{64}$" },
  version: { type: "integer", minimum: 1 },
  query: { type: "string", maxLength: 2000 },
  mode: { type: "string", enum: ["lexical", "literal", "hybrid"] },
  scope: { type: "string", enum: ["wiki", "sources", "all"] },
  match_mode: { type: "string", enum: ["phrase", "all", "any"] },
  path_prefix: { type: "string", maxLength: 512 },
  heading: { type: "string", maxLength: 500 },
  since: { type: "string", description: "Inclusive RFC3339 page-revision/source-ingestion time, not the event date mentioned in text." },
  until: { type: "string", description: "Exclusive RFC3339 page-revision/source-ingestion time." },
  per_owner_limit: { type: "integer", minimum: 1, maximum: 20 },
  context_lines: { type: "integer", minimum: 0, maximum: 20 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
  token_budget: { type: "integer", minimum: 128, maximum: 16000 },
  project_id: { type: "string", description: "Exact ownership filter, not topic relevance. It excludes unscoped and differently owned shared pages. Omit for cross-project personal Wiki retrieval." },
  title: { type: "string", maxLength: 500 },
  content: { type: "string", maxLength: 2_000_000 },
  expected_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  section: { type: "string" },
  start_line: { type: "integer", minimum: 1 },
  end_line: { type: "integer", minimum: 1 },
  max_chars: { type: "integer", minimum: 128, maximum: 64000 },
  char_offset: { type: "integer", minimum: 0 },
  offset: { type: "integer", minimum: 0 },
  file: { type: "string" },
  name: { type: "string" },
  url: { type: "string" },
  text: { type: "string" },
  summary: { type: "string", maxLength: 256000 },
  origin: { type: "object", additionalProperties: false, properties: { session_id: { type:"string", maxLength:256 }, turn_id: { type:"string", maxLength:256 }, recorded_at: { type:"string" } } },
  session_files: { type:"array", maxItems:16, items:{type:"string"}, description:"Explicit local Codex session files; never scans history automatically." },
  workspace: { type:"string", description:"Exact session metadata workspace; required for session access." },
  session_policy: { type:"string", enum:["missing_terms","always"] },
  context_mode: { type:"string", enum:["focused","broad"], description:"Focused returns complete query-term matches when available; broad includes partial matches and Wiki background. Neither proves answer completeness." },
  targets: { type:"array", minItems:1, maxItems:8, description:"OR across targets; AND within each target. Event windows use reported event time, never source ingestion time. Missing targets never widen automatically.", items:{type:"object",additionalProperties:false,properties:{
    event_since:{type:"string",description:"Inclusive RFC3339 event time; requires event_until. Maximum31days per window."},
    event_until:{type:"string",description:"Exclusive RFC3339 event time; requires event_since."},
    experiment_id:{type:"string",pattern:"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$",description:"Exact experiment identifier in an artifacts/ID/ path or explicit origin metadata; not a topical word."},
  },anyOf:[{required:["event_since","event_until"]},{required:["experiment_id"]}]} },
  excerpt_mode: { type:"string", enum:["passages","full"], description:"Passages keeps query-centered blocks, table headers and adjacent caveats. Full explicitly requests longer context. Check truncation and excerpt_ranges." },
  passage_chars: {type:"integer",minimum:128,maximum:4000,description:"Per-source passage ceiling; default1800. Does not guarantee complete answers."},
  session_since: { type:"string" },
  session_until: { type:"string" },
  extractor: { type: "string" },
  page_count: { type: "integer", minimum: 0 },
  draft_id: { type: "string" },
  revision_id: { type: "string" },
  depth: { type: "integer", minimum: 1, maximum: 3 },
};
export const WIKI_TOOLS = [
  ["pages", "List current Wiki pages."],
  ["read", "Read a bounded page or section with its full-page hash."],
  [
    "search",
    "Search source-backed Wiki passages. Does not run a generation LLM.",
  ],
  ["sources", "List immutable sources and versions."],
  ["catalog", "List folder import coverage, searchable sources and skip reasons. Read-only; does not scan the filesystem."],
  ["source_read", "Read one exact source version, optionally a section, line range, or query-centered excerpt. Check query_in_excerpt and continuation offsets."],
  ["capture", "Preserve a selected report unchanged, supplement a summary with rule-selected source lines, and retain a cited provenance inventory. Reported claims remain unverified; does not activate memories."],
  ["capture_audit", "Compare a summary with rule-selected source lines. Mechanical coverage is not semantic completeness."],
  ["recall", "Retrieve Wiki and all matching stored originals, including uncited originals. Reads only explicitly supplied session files as a final stage. Query coverage is not answer completeness."],
  ["put", "Create or update a page; updates require the read hash."],
  [
    "patch",
    "Replace a section or line range without replacing unread content.",
  ],
  [
    "ingest",
    "Import an explicitly selected original file without changing its bytes.",
  ],
  [
    "extraction_put",
    "Register explicitly extracted text with original-source provenance.",
  ],
  ["links", "Read backlinks, citations and bounded neighbors."],
  ["rename", "Rename a page while retaining identity and aliases."],
  ["delete", "Soft-delete a page with the read hash."],
  ["history", "List page revisions."],
  ["diff", "Compare a revision and current page."],
  ["restore_revision", "Restore a revision as a new version."],
  ["draft", "Save a draft against an exact current hash."],
  ["drafts", "List pending drafts."],
  ["draft_read", "Read a pending draft before approval."],
  [
    "approve",
    "Approve a draft only if its target has not changed; requires the current read hash.",
  ],
  ["diagnose", "List deterministic integrity and maintenance findings."],
].map(([op, description]) => ({
  name: `orgbrain_wiki_${op}`,
  description,
  inputSchema: { type: "object", properties, additionalProperties: false },
}));
export function enabledWikiTools(profile) {
  try {
    return profile === "default" && wikiStatusSync().enabled ? WIKI_TOOLS : [];
  } catch {
    return [];
  }
}
const SAFE_PIPELINE_WAKE_REASONS = new Set(["disabled", "idle", "reviewer_unavailable"]);

async function wakeQueuedWikiMemoryPipeline(store, tenantId, projectId, dependencies) {
  try {
    let env;
    if (typeof dependencies.loadEnvFallbacks === "function") {
      env = await dependencies.loadEnvFallbacks();
      if (!env || typeof env !== "object") env = process.env;
    } else {
      env = process.env;
      if (!env.OPENROUTER_API_KEY) {
        const { loadEnvFallbacks } = await import("../hook-memory-bridge.mjs");
        await loadEnvFallbacks();
        env = process.env;
      }
    }
    const wake = dependencies.wakeMemoryPipeline ??
      (await import("./memory-pipeline.mjs")).wakeMemoryPipeline;
    const result = await wake(store, { tenantId, projectId, env });
    if (result?.started === true) return { started: true };
    return {
      started: false,
      reason: SAFE_PIPELINE_WAKE_REASONS.has(result?.reason) ? result.reason : "worker_unavailable",
    };
  } catch {
    return { started: false, reason: "worker_unavailable" };
  }
}

async function enqueueWikiMutationMemoryIntake(store, wiki, input, result, dependencies) {
  const hash = result.hash ?? result.page?.hash;
  const pageId = result.page_id ?? result.page?.page_id;
  if (typeof pageId !== "string" || !pageId || typeof hash !== "string" || !hash)
    return { queued: false, reason: "wiki_mutation_identity_missing" };

  let storedPage;
  try {
    storedPage = await wiki.request({
      op: "read",
      wiki_id: "personal",
      page_id: pageId,
      max_chars: 128,
    });
  } catch {
    return { queued: false, reason: "wiki_page_readback_unavailable" };
  }

  if (storedPage?.page_id !== pageId)
    return { queued: false, reason: "wiki_page_id_mismatch" };
  if (storedPage.hash !== hash)
    return { queued: false, reason: "wiki_hash_mismatch" };
  const projectId = storedPage.project_id;
  if (typeof projectId !== "string" || !projectId.trim())
    return { queued: false, reason: "wiki_project_scope_missing" };
  if (input.project_id !== undefined && input.project_id !== projectId)
    return { queued: false, reason: "wiki_project_scope_mismatch" };

  try {
    const tenantId = typeof storedPage.tenant_id === "string" && storedPage.tenant_id.trim()
      ? storedPage.tenant_id.trim()
      : "default";
    const enqueue = dependencies.enqueueSource ??
      (await import("./memory-pipeline.mjs")).enqueueMemoryPipelineSource;
    const intake = await enqueue(store, {
      tenantId,
      projectId,
      selector: { source: "wiki", page_id: pageId, expected_hash: hash },
    });
    if (intake?.queued !== true) return intake;
    return {
      ...intake,
      worker: await wakeQueuedWikiMemoryPipeline(store, tenantId, projectId, dependencies),
    };
  } catch {
    return { queued: false, reason: "wiki_memory_intake_unavailable" };
  }
}

export async function callWikiTool(store, name, input, dependencies = {}) {
  if (input.wiki_id && input.wiki_id !== "personal")
    throw new Error("wiki_binding_mismatch");
  const op = name.slice("orgbrain_wiki_".length);
  if (!WIKI_TOOLS.some((t) => t.name === name))
    throw new Error("unknown_wiki_operation");
  const wiki = dependencies.wiki ?? wikiServiceForStore(store);
  if (op === "search") return wiki.search(input);
  const budget = Math.max(256, Math.min(input.token_budget || 4000, 16000));
  if (op === "recall") {
    const result = await recallWiki(wiki, { ...input, max_chars: Math.min(input.max_chars || 12000, budget * 2) });
    while (countWikiTokens(result) > budget - 40 && result.evidence.length) {
      result.evidence.pop(); result.truncated = true; result.missing_query_terms = null;
    }
    result.text_characters = result.evidence.reduce((n, e) => n + [...e.text].length, 0);
    if (countWikiTokens(result) > budget - 40) throw new Error("wiki_recall_budget_exhausted: increase token_budget");
    for(let n=0;n<4;n++) result.estimated_tokens = countWikiTokens(result);
    return result;
  }
  const result = await wiki.request({
    ...input,
    op,
    max_chars: Math.min(input.max_chars || 6000, 6000, budget * 2),
    limit: Math.min(input.limit || 50, 100),
  });
  if (["put", "patch", "approve", "restore_revision"].includes(op) && result.ok !== false && !result.error) {
    result.memory_intake = await enqueueWikiMutationMemoryIntake(
      store,
      wiki,
      input,
      result,
      dependencies,
    );
  }
  let changed = false;
  while (countWikiTokens(result) > budget - 40) {
    const arrays = Object.entries(result).filter(
      ([, value]) => Array.isArray(value) && value.length,
    );
    const fields = ["content", "text", "before", "after"].filter(
      (key) => typeof result[key] === "string" && result[key].length > 64,
    );
    if (arrays.length) {
      const [key, value] = arrays.sort((a, b) => b[1].length - a[1].length)[0];
      value.pop();
      if (["pages", "sources", "drafts", "entries"].includes(key))
        result.next_offset = (input.offset || 0) + value.length;
      if (key === "summary") result.summary_truncated = true;
    } else if (fields.length) {
      const key = fields.sort((a, b) => result[b].length - result[a].length)[0];
      result[key] = [...result[key]]
        .slice(0, Math.floor([...result[key]].length * 0.8))
        .join("");
      if (key === "content" || key === "text")
        result.next_char_offset =
          (result.char_offset ?? input.char_offset ?? 0) + [...result[key]].length;
      if ((key === "content" || key === "text") && Number.isInteger(result.start_line))
        result.end_line = result.start_line + Math.max(0, result[key].replace(/\n$/, "").split("\n").length - 1);
    } else break;
    changed = true;
  }
  if (changed) {
    result.truncated = true;
    if (op === "source_read" && input.query) result.query_in_excerpt = null;
  }
  if (op === "catalog" && result.next_offset === (input.offset || 0))
    throw new Error("wiki_catalog_budget_exhausted: increase token_budget or filter folder_id");
  for (let n = 0; n < 4; n++) result.estimated_tokens = countWikiTokens(result);
  return result;
}
