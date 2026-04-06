#!/usr/bin/env node

import process from "node:process";
import { planMemoryMaintenance } from "./lib/memory-maintenance-core.mjs";
import { parseLocationArgs, runD1Queries, sqlString } from "./lib/metrics-common.mjs";

function printHelp() {
  console.log(`Org Brain memory maintenance

Usage:
  pnpm memories:maintain [-- --apply] [--tenant <tenant_id>] [--json]
  node ./scripts/memory-maintenance.mjs [options]

Options:
  --tenant <tenant_id>             Tenant to inspect (default: default)
  --database <name>                D1 database binding/name (default: open-brain)
  --local                          Query the local wrangler D1 database
  --preview                        Query the preview D1 database
  --remote                         Query the remote D1 database (default)
  --env <name>                     Wrangler environment name
  --digest-older-than-days <n>     Minimum age for digest compaction (default: 7)
  --duplicate-older-than-days <n>  Minimum age for duplicate collapse (default: 14)
  --digest-group-min <n>           Minimum raw rows per digest group (default: 4)
  --apply                          Persist changes instead of dry-run
  --json                           Emit machine-readable JSON
  --help                           Show this message
`);
}

function parsePositiveInt(raw, flag, fallback, min = 1, max = 365) {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    ...parseLocationArgs(argv),
    apply: false,
    digestOlderThanDays: 7,
    duplicateOlderThanDays: 14,
    digestGroupMin: 4
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--" ||
      arg === "--json" ||
      arg === "--help" ||
      arg === "-h" ||
      arg === "--local" ||
      arg === "--preview" ||
      arg === "--remote"
    ) {
      continue;
    }
    if (
      arg === "--tenant" ||
      arg.startsWith("--tenant=") ||
      arg === "--database" ||
      arg.startsWith("--database=") ||
      arg === "--env" ||
      arg.startsWith("--env=")
    ) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--digest-older-than-days" || arg.startsWith("--digest-older-than-days=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      options.digestOlderThanDays = parsePositiveInt(value, "--digest-older-than-days", 7);
      continue;
    }
    if (arg === "--duplicate-older-than-days" || arg.startsWith("--duplicate-older-than-days=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      options.duplicateOlderThanDays = parsePositiveInt(value, "--duplicate-older-than-days", 14);
      continue;
    }
    if (arg === "--digest-group-min" || arg.startsWith("--digest-group-min=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      options.digestGroupMin = parsePositiveInt(value, "--digest-group-min", 4, 2, 50);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function sqlNullable(value) {
  if (value === null || value === undefined) return "NULL";
  return sqlString(value);
}

async function executeSql(options, sql) {
  await runD1Queries(options, { apply: sql });
}

async function loadExistingDigestIds(options, tenant, externalKeys) {
  const results = new Map();
  if (externalKeys.length === 0) return results;
  for (const chunk of chunkArray(externalKeys, 100)) {
    const sql = `
      SELECT id, external_key
      FROM memories
      WHERE tenant_id = ${sqlString(tenant)}
        AND external_key IN (${chunk.map((key) => sqlString(key)).join(", ")});
    `;
    const response = await runD1Queries(options, { existing: sql });
    for (const row of response.existing) {
      if (row.external_key) results.set(String(row.external_key), String(row.id));
    }
  }
  return results;
}

function buildApplyStatements(tenantId, plan, existingDigestIds) {
  const statements = [];

  for (const synthesized of [...plan.canonicals, ...plan.digests]) {
    const tagsJson = JSON.stringify(synthesized.tags);
    const existingId = existingDigestIds.get(synthesized.external_key);
    if (existingId) {
      statements.push(
        `UPDATE memories
         SET project_id = ${sqlNullable(synthesized.project_id)},
             content = ${sqlString(synthesized.content)},
             summary = ${sqlString(synthesized.summary)},
             tags_json = ${sqlString(tagsJson)},
             source = ${sqlString("org-brain")},
             created_at = ${synthesized.created_at}
         WHERE tenant_id = ${sqlString(tenantId)} AND id = ${sqlString(existingId)};`,
        `DELETE FROM memories_fts WHERE memory_id = ${sqlString(existingId)} AND tenant_id = ${sqlString(tenantId)};`,
        `INSERT INTO memories_fts(memory_id, tenant_id, content)
         VALUES(${sqlString(existingId)}, ${sqlString(tenantId)}, ${sqlString(synthesized.content)});`
      );
      continue;
    }

    const id = `mem_digest_${synthesized.external_key.replace(/[^A-Za-z0-9_]/g, "_")}`;
    statements.push(
      `INSERT INTO memories(id, tenant_id, project_id, content, summary, tags_json, source, external_key, created_at)
       VALUES(
         ${sqlString(id)},
         ${sqlString(tenantId)},
         ${sqlNullable(synthesized.project_id)},
         ${sqlString(synthesized.content)},
         ${sqlString(synthesized.summary)},
         ${sqlString(tagsJson)},
         ${sqlString("org-brain")},
         ${sqlString(synthesized.external_key)},
         ${synthesized.created_at}
       );`,
        `INSERT INTO memories_fts(memory_id, tenant_id, content)
         VALUES(${sqlString(id)}, ${sqlString(tenantId)}, ${sqlString(synthesized.content)});`
    );
  }

  for (const compaction of plan.compactions) {
    statements.push(
      `UPDATE memories
       SET tags_json = ${sqlString(JSON.stringify(compaction.next_tags))}
       WHERE tenant_id = ${sqlString(tenantId)} AND id = ${sqlString(compaction.id)};`,
        `DELETE FROM memories_fts
       WHERE memory_id = ${sqlString(compaction.id)} AND tenant_id = ${sqlString(tenantId)};`
    );
  }

  return statements;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const tenant = sqlString(options.tenant);
  const rows = await runD1Queries(options, {
    memories: `
      SELECT id, project_id, source, summary, content, tags_json, created_at
      FROM memories
      WHERE tenant_id = ${tenant}
        AND (tags_json IS NULL OR tags_json NOT LIKE '%"compacted"%')
        AND source IN ('codex', 'claude', 'cursor', 'openclaw', 'opencode')
      ORDER BY created_at DESC
      LIMIT 5000;
    `
  });

  const plan = planMemoryMaintenance(rows.memories, {
    tenantId: options.tenant,
    now: Date.now(),
    digestOlderThanDays: options.digestOlderThanDays,
    duplicateOlderThanDays: options.duplicateOlderThanDays,
    digestGroupMin: options.digestGroupMin
  });

  let applied = false;
  if (options.apply && (plan.canonicals.length > 0 || plan.digests.length > 0 || plan.compactions.length > 0)) {
    const existingDigestIds = await loadExistingDigestIds(
      options,
      options.tenant,
      [...plan.canonicals, ...plan.digests].map((item) => item.external_key)
    );
    const synthesizedPlan = {
      canonicals: plan.canonicals,
      digests: plan.digests,
      compactions: []
    };
    const compactionPlan = {
      canonicals: [],
      digests: [],
      compactions: plan.compactions
    };

    for (const synthesized of [...synthesizedPlan.canonicals, ...synthesizedPlan.digests]) {
      const statements = buildApplyStatements(
        options.tenant,
        { canonicals: [synthesized], digests: [], compactions: [] },
        existingDigestIds
      );
      const sql = statements.join("\n");
      await executeSql(options, sql);
    }

    const compactionStatements = buildApplyStatements(options.tenant, compactionPlan, existingDigestIds);
    for (const chunk of chunkArray(compactionStatements, 80)) {
      const sql = chunk.join("\n");
      await executeSql(options, sql);
    }
    applied = true;
  }

  const result = {
    captured_at: Date.now(),
    scope: {
      tenant: options.tenant,
      database: options.database,
      location: options.location,
      env: options.env ?? null
    },
    apply_requested: options.apply,
    applied,
    stats: plan.stats,
    sample_canonicals: plan.canonicals.slice(0, 5).map((item) => ({
      external_key: item.external_key,
      project_id: item.project_id,
      source: item.source,
      summary: item.summary,
      member_count: item.member_ids.length
    })),
    sample_digests: plan.digests.slice(0, 5).map((digest) => ({
      external_key: digest.external_key,
      project_id: digest.project_id,
      source: digest.source,
      summary: digest.summary,
      member_count: digest.member_ids.length
    })),
    sample_compactions: plan.compactions.slice(0, 10)
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`tenant=${options.tenant} location=${options.location} apply=${applied ? "yes" : "no"}`);
  console.log(
    `scanned=${result.stats.scanned_count} digest_groups=${result.stats.digest_group_count} digested=${result.stats.digested_memory_count} duplicate_compactions=${result.stats.duplicate_compaction_count}`
  );
  for (const digest of result.sample_digests) {
    console.log(`digest ${digest.project_id || "(none)"} ${digest.summary} members=${digest.member_count}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
