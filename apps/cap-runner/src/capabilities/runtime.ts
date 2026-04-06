import { buildTenantMemoryProfile, sha256, ulid, type MemoryProfileResponse } from "@org-brain/shared";
import { recordRetrievalTelemetry } from "../retrieval-metrics";
import type { CapabilityContext, CapabilityResult } from "../types";

async function loadInput(ctx: CapabilityContext): Promise<string> {
  const ref = ctx.inputRef;

  if (ref.startsWith("r2://")) {
    const key = ref.slice("r2://".length);
    const obj = await ctx.env.OPEN_BRAIN_BUCKET.get(key);
    if (!obj) {
      throw new Error(`input artifact not found: ${ref}`);
    }
    return await obj.text();
  }

  if (ref.startsWith("memory://")) {
    const memoryId = ref.slice("memory://".length);
    const row = await ctx.env.OPEN_BRAIN_DB.prepare(
      "SELECT content FROM memories WHERE tenant_id = ? AND id = ?"
    )
      .bind(ctx.tenantId, memoryId)
      .first<{ content: string }>();

    if (!row) {
      throw new Error(`memory not found: ${ref}`);
    }
    return row.content;
  }

  return ref;
}

function outputKey(ctx: CapabilityContext): string {
  const base = `tenants/${ctx.tenantId}/projects/${ctx.projectId ?? "default"}/tasks/${ctx.taskId}`;
  if (ctx.capability === "plan_writer") return `${base}/plan.md`;
  if (ctx.capability === "code_gen") return `${base}/patch.diff`;
  return `${base}/review.md`;
}

async function loadMemoryProfile(ctx: CapabilityContext, query: string): Promise<MemoryProfileResponse> {
  const startedAt = Date.now();
  const profile = await buildTenantMemoryProfile(ctx.env.OPEN_BRAIN_DB, {
    tenantId: ctx.tenantId,
    projectId: ctx.projectId ?? null,
    q: query,
    limitDurable: 8,
    limitRecent: 8,
    rewriteQuery: true,
    searchMode: "hybrid"
  });

  const searchMeta = profile.meta.search;
  await recordRetrievalTelemetry(ctx.env.OPEN_BRAIN_DB, {
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    capability: ctx.capability,
    searchStrategy: searchMeta?.search_strategy ?? "fallback_recent_v1",
    queryText: query,
    queryHash: await sha256(query),
    matchedCount: searchMeta?.matched_count ?? 0,
    returnedCount: searchMeta?.returned_count ?? 0,
    fallbackUsed: searchMeta?.fallback_used ?? true,
    latencyMs: Math.max(0, Date.now() - startedAt),
    topMemoryIds: searchMeta?.top_result_ids ?? [],
    topScores: searchMeta?.top_result_ranks ?? null
  });

  return profile;
}

async function saveMemorySummary(ctx: CapabilityContext, summary: string, tags: string[]): Promise<string> {
  const now = Date.now();
  const content = `${ctx.capability} output for task ${ctx.taskId}\n${summary}`;
  const externalKey = `task:${ctx.taskId}:${ctx.capability}`;
  const existing = await ctx.env.OPEN_BRAIN_DB.prepare(
    "SELECT id FROM memories WHERE tenant_id = ? AND external_key = ?"
  )
    .bind(ctx.tenantId, externalKey)
    .first<{ id: string }>();

  const id = existing?.id ?? ulid();
  const tagsJson = JSON.stringify(tags);

  if (existing) {
    await ctx.env.OPEN_BRAIN_DB.batch([
      ctx.env.OPEN_BRAIN_DB.prepare(
        "UPDATE memories SET project_id = ?, content = ?, summary = ?, tags_json = ?, source = ?, created_at = ? WHERE tenant_id = ? AND id = ?"
      ).bind(ctx.projectId ?? null, content, summary, tagsJson, "org-brain", now, ctx.tenantId, id),
      ctx.env.OPEN_BRAIN_DB.prepare("DELETE FROM memories_fts WHERE memory_id = ? AND tenant_id = ?").bind(
        id,
        ctx.tenantId
      ),
      ctx.env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)"
      ).bind(id, ctx.tenantId, content)
    ]);
    return id;
  }

  await ctx.env.OPEN_BRAIN_DB.batch([
    ctx.env.OPEN_BRAIN_DB.prepare(
      "INSERT INTO memories(id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at) VALUES(?,?,?,?,?,?,?,?,?)"
    ).bind(id, ctx.tenantId, ctx.projectId ?? null, content, summary, tagsJson, "org-brain", externalKey, now),
    ctx.env.OPEN_BRAIN_DB.prepare(
      "INSERT INTO memories_fts(memory_id, tenant_id, content) VALUES(?,?,?)"
    ).bind(id, ctx.tenantId, content)
  ]);

  return id;
}

async function maybeCreateThread(ctx: CapabilityContext, summary: string): Promise<void> {
  if (ctx.capability !== "code_review") return;
  await ctx.env.OPEN_BRAIN_DB.prepare(
    "INSERT INTO threads(id, tenant_id, project_id, title, content, created_at) VALUES(?,?,?,?,?,?)"
  )
    .bind(ulid(), ctx.tenantId, ctx.projectId ?? null, `Review ${ctx.taskId}`, summary, Date.now())
    .run();
}

function renderList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- none"];
}

function summarizeProfile(profile: MemoryProfileResponse): string {
  return [
    `Durable Context: ${profile.durable.map((item) => item.summary).join(" | ") || "none"}`,
    `Recent Context: ${profile.recent.map((item) => item.summary).join(" | ") || "none"}`,
    `Related Search Results: ${profile.search_results.map((item) => item.summary ?? item.id).join(" | ") || "none"}`
  ].join("\n\n");
}

export async function runCapability(ctx: CapabilityContext): Promise<CapabilityResult> {
  const input = await loadInput(ctx);
  const query = input.slice(0, 120);
  const memoryProfile = await loadMemoryProfile(ctx, query);

  const summary = [
    `Capability: ${ctx.capability}`,
    `InputRef: ${ctx.inputRef}`,
    `InputPreview: ${input.slice(0, 240)}`,
    summarizeProfile(memoryProfile)
  ].join("\n\n");

  const outputBody = renderOutput(ctx.capability, input, memoryProfile, summary);
  const key = outputKey(ctx);
  await ctx.env.OPEN_BRAIN_BUCKET.put(key, outputBody, {
    customMetadata: {
      tenant_id: ctx.tenantId,
      task_id: ctx.taskId,
      capability: ctx.capability
    }
  });

  await saveMemorySummary(ctx, summary, [ctx.capability, "org-bus"]);
  await maybeCreateThread(ctx, summary);

  return {
    outputRef: `r2://${key}`,
    summary
  };
}

function renderOutput(
  capability: CapabilityContext["capability"],
  input: string,
  memoryProfile: MemoryProfileResponse,
  summary: string
): string {
  const durableLines = renderList(memoryProfile.durable.map((item) => item.summary));
  const recentLines = renderList(memoryProfile.recent.map((item) => item.summary));
  const searchLines = renderList(memoryProfile.search_results.map((item) => `[${item.kind}] ${item.summary ?? item.id}`));

  if (capability === "plan_writer") {
    return [
      "# Plan",
      "",
      "## Input",
      input,
      "",
      "## Durable Context",
      ...durableLines,
      "",
      "## Recent Context",
      ...recentLines,
      "",
      "## Related Search Results",
      ...searchLines,
      "",
      "## Summary",
      summary
    ].join("\n");
  }

  if (capability === "code_gen") {
    return [
      "diff --git a/placeholder.txt b/placeholder.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/placeholder.txt",
      "@@ -0,0 +1,14 @@",
      "+Generated patch proposal",
      `+Source: ${input.slice(0, 180)}`,
      "+",
      "+Durable Context:",
      ...durableLines.map((line) => `+ ${line}`),
      "+",
      "+Recent Context:",
      ...recentLines.map((line) => `+ ${line}`),
      "+",
      "+Related Search Results:",
      ...searchLines.map((line) => `+ ${line}`),
      "+",
      `+Summary: ${summary.slice(0, 180)}`
    ].join("\n");
  }

  return [
    "# Review",
    "",
    "## Diff Source",
    input,
    "",
    "## Findings",
    "- [P2] Placeholder finding: ensure tests cover generated patch semantics.",
    "",
    "## Durable Context",
    ...durableLines,
    "",
    "## Recent Context",
    ...recentLines,
    "",
    "## Related Search Results",
    ...searchLines,
    "",
    "## Summary",
    summary
  ].join("\n");
}
