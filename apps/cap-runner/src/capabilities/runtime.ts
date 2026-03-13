import { sha256, ulid } from "@org-brain/shared";
import { recordRetrievalTelemetry } from "../retrieval-metrics";
import type { CapabilityContext, CapabilityResult } from "../types";

type MemoryRow = {
  id: string;
  summary: string | null;
  content: string;
  lexical_score?: number | null;
};

function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 6)
    .map((token) => `"${token.replace(/"/g, '""')}"*`);

  if (tokens.length === 0) return null;
  return tokens.join(" OR ");
}

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

async function memorySearch(ctx: CapabilityContext, query: string): Promise<MemoryRow[]> {
  const startedAt = Date.now();
  const ftsQuery = buildFtsQuery(query);
  let matchedCount = 0;
  let strategy = "fallback_recent_v1";
  let rows: MemoryRow[] = [];

  if (ftsQuery) {
    const countRow = await ctx.env.OPEN_BRAIN_DB.prepare(
      `SELECT COUNT(*) AS matched_count
       FROM memories_fts
       WHERE tenant_id = ?
         AND content MATCH ?`
    )
      .bind(ctx.tenantId, ftsQuery)
      .first<{ matched_count: number }>();

    matchedCount = countRow?.matched_count ?? 0;
    const matched = await ctx.env.OPEN_BRAIN_DB.prepare(
      `SELECT m.id, m.summary, m.content, bm25(memories_fts) AS lexical_score
       FROM memories_fts
       JOIN memories m
         ON m.id = memories_fts.memory_id
        AND m.tenant_id = memories_fts.tenant_id
       WHERE memories_fts.tenant_id = ?
         AND memories_fts.content MATCH ?
       ORDER BY bm25(memories_fts) ASC, m.created_at DESC
       LIMIT 5`
    )
      .bind(ctx.tenantId, ftsQuery)
      .all<MemoryRow>();

    if (matched.results.length > 0) {
      strategy = "bm25_v1";
      rows = matched.results;
    }
  }

  if (rows.length === 0) {
    const fallback = await ctx.env.OPEN_BRAIN_DB.prepare(
      `SELECT m.id, m.summary, m.content
       FROM memories m
       WHERE m.tenant_id = ?
       ORDER BY m.created_at DESC
       LIMIT 5`
    )
      .bind(ctx.tenantId)
      .all<MemoryRow>();

    rows = fallback.results;
  }

  const telemetry = {
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    capability: ctx.capability,
    searchStrategy: strategy,
    queryText: query,
    queryHash: await sha256(query),
    matchedCount,
    returnedCount: rows.length,
    fallbackUsed: strategy !== "bm25_v1",
    latencyMs: Math.max(0, Date.now() - startedAt),
    topMemoryIds: rows.map((row) => row.id),
    topScores: strategy === "bm25_v1" ? rows.map((row) => row.lexical_score ?? null) : null
  } as const;

  await recordRetrievalTelemetry(ctx.env.OPEN_BRAIN_DB, telemetry);

  return rows;
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

export async function runCapability(ctx: CapabilityContext): Promise<CapabilityResult> {
  const input = await loadInput(ctx);
  const memoryHints = await memorySearch(ctx, input.slice(0, 120));

  const summary = [
    `Capability: ${ctx.capability}`,
    `InputRef: ${ctx.inputRef}`,
    `InputPreview: ${input.slice(0, 240)}`,
    `MemoryHints: ${memoryHints.map((m) => m.summary ?? m.id).join(" | ") || "none"}`
  ].join("\n\n");

  const outputBody = renderOutput(ctx.capability, input, memoryHints, summary);
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
  memoryHints: MemoryRow[],
  summary: string
): string {
  if (capability === "plan_writer") {
    return [
      "# Plan",
      "",
      "## Input",
      input,
      "",
      "## Related Memory",
      ...memoryHints.map((x) => `- ${x.summary ?? x.id}`),
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
      "@@ -0,0 +1,8 @@",
      "+Generated patch proposal",
      `+Source: ${input.slice(0, 180)}`,
      "+",
      "+Context:",
      ...memoryHints.map((x) => `+ - ${x.summary ?? x.id}`),
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
    "## Memory Hints",
    ...memoryHints.map((x) => `- ${x.summary ?? x.id}`),
    "",
    "## Summary",
    summary
  ].join("\n");
}
