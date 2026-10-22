import {
  wikiStatusSync,
  wikiServiceForStore,
  countWikiTokens,
} from "./wiki-service.mjs";

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
  limit: { type: "integer", minimum: 1, maximum: 100 },
  token_budget: { type: "integer", minimum: 128, maximum: 16000 },
  project_id: { type: "string" },
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
  ["source_read", "Read one exact source version."],
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
  const result = await wiki.request({
    ...input,
    op,
    max_chars: Math.min(input.max_chars || 6000, 6000),
    limit: Math.min(input.limit || 50, 100),
  });
  const budget = Math.max(256, Math.min(input.token_budget || 4000, 16000));
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
          (input.char_offset || 0) + [...result[key]].length;
    } else break;
    changed = true;
  }
  if (changed) result.truncated = true;
  if (op === "catalog" && result.next_offset === (input.offset || 0))
    throw new Error("wiki_catalog_budget_exhausted: increase token_budget or filter folder_id");
  for (let n = 0; n < 4; n++) result.estimated_tokens = countWikiTokens(result);
  return result;
}
