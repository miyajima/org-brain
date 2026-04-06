#!/usr/bin/env node

import process from "node:process";
import {
  buildFtsQuery,
  fetchR2ObjectText,
  formatJst,
  parseLocationArgs,
  runD1Queries,
  sqlString
} from "./lib/metrics-common.mjs";
import { summarizeReplayComparisons } from "./lib/retrieval-metrics-core.mjs";
import { overlapAtFive, resolveReplayInput } from "./lib/retrieval-replay-core.mjs";

const STRATEGIES = ["bm25_v1", "bm25_rewrite_v1", "hybrid_memory_docs_v1"];

function printHelp() {
  console.log(`Org Brain retrieval metrics replay

Usage:
  pnpm metrics:replay [-- --tenant <tenant_id>] [--limit <n>] [--task-id <id>]
  node ./scripts/retrieval-metrics-replay.mjs [options]

Options:
  --tenant <tenant_id>   Tenant to inspect (default: default)
  --database <name>      D1 database binding/name (default: open-brain)
  --capability <name>    Optional capability filter
  --task-id <id>         Replay a single task
  --limit <n>            Number of recent tasks to inspect (default: 20)
  --bucket <name>        R2 bucket for r2:// input refs (default: open-brain-bucket)
  --local                Query the local wrangler D1 database
  --preview              Query the preview D1 database
  --remote               Query the remote D1 database (default)
  --env <name>           Wrangler environment name
  --json                 Emit machine-readable JSON
  --help                 Show this message
`);
}

function parseArgs(argv) {
  const options = {
    ...parseLocationArgs(argv),
    limit: 20,
    taskId: undefined,
    bucket: "open-brain-bucket"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" || arg === "--help" || arg === "-h" || arg === "--json" || arg === "--local" || arg === "--preview" || arg === "--remote") continue;
    if (
      arg === "--tenant" ||
      arg.startsWith("--tenant=") ||
      arg === "--database" ||
      arg.startsWith("--database=") ||
      arg === "--env" ||
      arg.startsWith("--env=") ||
      arg === "--capability" ||
      arg.startsWith("--capability=")
    ) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit requires a positive integer");
      options.limit = parsed;
      continue;
    }
    if (arg === "--task-id" || arg.startsWith("--task-id=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--task-id requires a value");
      options.taskId = value;
      continue;
    }
    if (arg === "--bucket" || arg.startsWith("--bucket=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--bucket requires a value");
      options.bucket = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function tokenizeForRewrite(raw) {
  return [...new Set(
    collapseWhitespace(raw)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[\s/_.:-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  )].slice(0, 8);
}

function singularizeToken(token) {
  if (token.length <= 3) return token;
  return token.endsWith("s") ? token.slice(0, -1) : token;
}

function buildQueryVariants(raw, rewrite = false) {
  const normalized = collapseWhitespace(raw);
  if (!normalized) return [];
  const seen = new Set();
  const variants = [];
  const push = (query) => {
    if (!query || seen.has(query)) return;
    seen.add(query);
    variants.push(query);
  };

  if (rewrite) {
    push(`"${normalized.replace(/"/g, '""')}"`);
  }

  push(buildFtsQuery(normalized));

  if (rewrite) {
    const splitTokens = tokenizeForRewrite(normalized);
    if (splitTokens.length > 0) {
      push(splitTokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR "));
      const singularTokens = [...new Set(splitTokens.map(singularizeToken).filter((token) => token.length >= 2))];
      push(singularTokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR "));
    }
  }

  return variants.slice(0, rewrite ? 4 : 1);
}

function buildDocQuery(rawVariant) {
  const cleaned = rawVariant.replace(/\*/g, "").replace(/"/g, " ");
  return buildFtsQuery(cleaned.replace(/\s+OR\s+/g, " "));
}

function compareRank(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function sortByRank(left, right) {
  return compareRank(left.raw_rank, right.raw_rank) || Number(right.created_at ?? 0) - Number(left.created_at ?? 0);
}

async function runStrategy(options, queryText, strategy) {
  const rewrite = strategy !== "bm25_v1";
  const variants = buildQueryVariants(queryText, rewrite);
  if (variants.length === 0) {
    return {
      strategy,
      matched_count: 0,
      returned_count: 0,
      fallback_used: true,
      memory_ids: []
    };
  }

  const memoryById = new Map();
  for (const variant of variants) {
    const response = await runD1Queries(options, {
      matched: `
        SELECT m.id, m.created_at, bm25(memories_fts) AS raw_rank
        FROM memories_fts
        JOIN memories m
          ON m.id = memories_fts.memory_id
         AND m.tenant_id = memories_fts.tenant_id
        WHERE memories_fts.tenant_id = ${sqlString(options.tenant)}
          AND memories_fts.content MATCH ${sqlString(variant)}
        ORDER BY bm25(memories_fts) ASC, m.created_at DESC
        LIMIT 10;
      `
    });

    for (const row of response.matched) {
      const existing = memoryById.get(row.id);
      if (!existing || compareRank(row.raw_rank ?? null, existing.raw_rank ?? null) < 0) {
        memoryById.set(row.id, {
          id: row.id,
          created_at: row.created_at,
          raw_rank: row.raw_rank ?? null
        });
      }
    }
  }

  const lexicalRows = [...memoryById.values()].sort(sortByRank);
  const lexicalIds = lexicalRows.map((row) => row.id);
  let resultIds = lexicalIds.slice(0, 5);

  if (strategy === "hybrid_memory_docs_v1" && lexicalRows.length < 3) {
    const docById = new Map();
    for (const variant of variants) {
      const docQuery = buildDocQuery(variant);
      if (!docQuery) continue;
      const response = await runD1Queries(options, {
        docs: `
          SELECT d.id, d.updated_at AS created_at, bm25(knowledge_docs_fts) AS raw_rank
          FROM knowledge_docs_fts
          JOIN knowledge_docs d
            ON d.id = knowledge_docs_fts.doc_id
           AND d.tenant_id = knowledge_docs_fts.tenant_id
          WHERE knowledge_docs_fts.tenant_id = ${sqlString(options.tenant)}
            AND knowledge_docs_fts MATCH ${sqlString(docQuery)}
            AND d.deleted_at IS NULL
          ORDER BY bm25(knowledge_docs_fts) ASC, d.updated_at DESC
          LIMIT 4;
        `
      });
      for (const row of response.docs) {
        const id = `doc:${row.id}`;
        const existing = docById.get(id);
        if (!existing || compareRank(row.raw_rank ?? null, existing.raw_rank ?? null) < 0) {
          docById.set(id, {
            id,
            created_at: row.created_at,
            raw_rank: row.raw_rank ?? null
          });
        }
      }
    }

    const docIds = [...docById.values()].sort(sortByRank).slice(0, 2).map((row) => row.id);
    resultIds = [...resultIds, ...docIds].slice(0, 5);
  }

  return {
    strategy,
    matched_count: lexicalRows.length,
    returned_count: resultIds.length,
    fallback_used: resultIds.length === 0,
    memory_ids: resultIds
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const capabilityFilter = options.capability ? ` AND capability = ${sqlString(options.capability)}` : "";
  const taskFilter = options.taskId ? ` AND id = ${sqlString(options.taskId)}` : "";
  const tasks = await runD1Queries(options, {
    tasks: `
      SELECT id, capability, status, input_ref, updated_at
      FROM tasks
      WHERE tenant_id = ${sqlString(options.tenant)}
        ${capabilityFilter}
        ${taskFilter}
      ORDER BY updated_at DESC
      LIMIT ${options.limit};
    `
  });

  const memoryCache = new Map();
  const comparisons = [];

  for (const task of tasks.tasks) {
    const resolved = await resolveReplayInput(
      task,
      {
        loadMemory: async (memoryId) => {
          const memoryRows = await runD1Queries(options, {
            memory: `
              SELECT content
              FROM memories
              WHERE tenant_id = ${sqlString(options.tenant)}
                AND id = ${sqlString(memoryId)}
              LIMIT 1;
            `
          });
          return memoryRows.memory[0]?.content ?? "";
        },
        loadR2: async (key) => fetchR2ObjectText(options, options.bucket, key)
      },
      memoryCache
    );

    const queryText = String(resolved.input).slice(0, 120);
    const strategyResults = Object.fromEntries(
      await Promise.all(STRATEGIES.map(async (strategy) => [strategy, await runStrategy(options, queryText, strategy)]))
    );
    const baseIds = strategyResults.bm25_v1.memory_ids;

    comparisons.push({
      task_id: task.id,
      capability: task.capability,
      status: task.status,
      input_source: resolved.input_source,
      query_preview: queryText.slice(0, 80),
      ...strategyResults,
      overlap_vs_bm25: {
        bm25_rewrite_v1: overlapAtFive(baseIds, strategyResults.bm25_rewrite_v1.memory_ids),
        hybrid_memory_docs_v1: overlapAtFive(baseIds, strategyResults.hybrid_memory_docs_v1.memory_ids)
      },
      changed_vs_bm25: {
        bm25_rewrite_v1:
          JSON.stringify(baseIds) !== JSON.stringify(strategyResults.bm25_rewrite_v1.memory_ids),
        hybrid_memory_docs_v1:
          JSON.stringify(baseIds) !== JSON.stringify(strategyResults.hybrid_memory_docs_v1.memory_ids)
      }
    });
  }

  const snapshot = {
    captured_at: Date.now(),
    captured_at_jst: formatJst(Date.now()),
    scope: {
      tenant: options.tenant,
      capability: options.capability ?? null,
      task_id: options.taskId ?? null,
      limit: options.limit,
      database: options.database,
      location: options.location,
      env: options.env ?? null,
      bucket: options.bucket
    },
    summary: summarizeReplayComparisons(comparisons),
    comparisons
  };

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log("Org Brain retrieval metrics replay");
  console.log(`Scope: tenant=${snapshot.scope.tenant} capability=${snapshot.scope.capability ?? "(all)"} limit=${snapshot.scope.limit}`);
  console.log(`Captured: ${snapshot.captured_at_jst}`);
  for (const strategy of STRATEGIES) {
    const entry = snapshot.summary.strategies[strategy];
    console.log(
      `Strategy ${strategy}: fallback_rate=${(entry.fallback_rate * 100).toFixed(1)}% avg_returned=${entry.average_returned_count.toFixed(2)} changed_vs_bm25=${(entry.changed_rate_vs_bm25 * 100).toFixed(1)}% overlap@5_vs_bm25=${entry.average_overlap_at_5_vs_bm25.toFixed(2)}`
    );
  }
  console.log("");

  for (const record of snapshot.comparisons.slice(0, 10)) {
    console.log(`${record.task_id} (${record.capability}/${record.input_source})`);
    console.log(`  bm25          : ${record.bm25_v1.memory_ids.join(", ") || "(none)"}`);
    console.log(`  bm25_rewrite  : ${record.bm25_rewrite_v1.memory_ids.join(", ") || "(none)"}`);
    console.log(`  hybrid_memory : ${record.hybrid_memory_docs_v1.memory_ids.join(", ") || "(none)"}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
