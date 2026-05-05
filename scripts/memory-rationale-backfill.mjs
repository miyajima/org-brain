#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import process from "node:process";
import { parseLocationArgs, runD1Queries, sqlString } from "./lib/metrics-common.mjs";

const DEFAULT_LIMIT = 5000;
const HIGH_VALUE_TAGS = ["project-fact", "curated-memory", "promoted", "canonical-memory"];

function printHelp() {
  console.log(`Org Brain memory rationale backfill

Usage:
  pnpm memories:backfill-rationales [-- --json] [--apply]
  node ./scripts/memory-rationale-backfill.mjs [options]

Options:
  --tenant <tenant_id>   Tenant to inspect (default: default)
  --database <name>      D1 database binding/name (default: open-brain)
  --local                Query the local wrangler D1 database
  --preview              Query the preview D1 database
  --remote               Query the remote D1 database (default)
  --env <name>           Wrangler environment name
  --limit <n>            Maximum candidate memories to inspect (default: 5000)
  --apply                Persist inferred rationale/evidence rows
  --json                 Emit machine-readable JSON
  --help                 Show this message
`);
}

function parseArgs(argv) {
  const options = {
    ...parseLocationArgs(argv),
    apply: false,
    limit: DEFAULT_LIMIT
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
    ) continue;
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
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 50_000) throw new Error("--limit must be between 1 and 50000");
      options.limit = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function collapseWhitespace(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function parseTagsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value) => typeof value === "string");
  } catch {
    return [];
  }
}

function clip(value, limit) {
  const text = collapseWhitespace(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableId(prefix, ...parts) {
  return `${prefix}_${hashText(parts.join(":"))}`.slice(0, 64);
}

function decisionTypeFor(text) {
  if (/(方針|policy|always|never|must|ルール|原則)/i.test(text)) return "policy";
  if (/(原因|理由|root cause|because)/i.test(text)) return "diagnose";
  if (/(回避|workaround|暫定)/i.test(text)) return "workaround";
  if (/(優先|prioritize)/i.test(text)) return "prioritize";
  return "adopt";
}

function extractSection(content, heading) {
  const regex = new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "iu");
  return collapseWhitespace(content.match(regex)?.[1] ?? "");
}

function inferRationale(row) {
  const content = String(row.content ?? "");
  const summary = collapseWhitespace(row.summary ?? "");
  const text = collapseWhitespace(`${summary}\n${content}`);
  const decision = extractSection(content, "Decision") || extractSection(content, "Result") || summary || text;
  const reason = extractSection(content, "Reason") || extractSection(content, "Trigger") || extractSection(content, "Evidence") || text;
  return {
    decision_type: decisionTypeFor(text),
    conclusion: clip(decision, 240),
    reason_summary: clip(reason, 500),
    confidence_score: 0.45
  };
}

function inferEvidence(row) {
  const text = `${row.summary ?? ""}\n${row.content ?? ""}`;
  const evidence = [];
  const patterns = [
    ["memory", /\bmemory:\/\/[^\s)]+/gi],
    ["artifact", /\br2:\/\/[^\s)]+/gi],
    ["task_event", /\btask:\/\/[^\s)]+/gi],
    ["doc", /\bdoc:\/\/[^\s)]+/gi],
    ["thread", /\b(?:thread|turn)[:/][A-Za-z0-9_-]+/gi],
    ["file", /(?:^|\s)(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|rb|erb|astro|md|yml|yaml|json|jsonc|sql|rs|py|sh)\b/gi],
    ["command", /`[^`\n]+`/g]
  ];
  for (const [type, regex] of patterns) {
    for (const match of text.matchAll(regex)) {
      const ref = type === "command" ? match[0].slice(1, -1).trim() : collapseWhitespace(match[0]);
      if (!ref) continue;
      evidence.push({
        evidence_type: type,
        evidence_ref: ref,
        relation: "supports",
        note: null,
        weight_score: 0.5
      });
      if (evidence.length >= 8) return evidence;
    }
  }
  evidence.push({
    evidence_type: "memory",
    evidence_ref: `memory://${row.id}`,
    relation: "context_for",
    note: "source memory snapshot",
    weight_score: 0.4
  });
  return evidence;
}

function isHighValue(row) {
  const tags = parseTagsJson(row.tags_json);
  if (row.lifecycle_state && row.lifecycle_state !== "active") return false;
  return HIGH_VALUE_TAGS.some((tag) => tags.includes(tag));
}

function buildBackfillPlan(rows, tenantId, now = Date.now()) {
  const targetRows = rows.filter((row) => isHighValue(row) && !row.rationale_id);
  const skippedExisting = rows.filter((row) => isHighValue(row) && row.rationale_id).length;
  const rationaleRows = [];
  const evidenceRows = [];

  for (const row of targetRows) {
    const rationale = inferRationale(row);
    const rationaleId = stableId("rat_backfill", tenantId, row.id);
    rationaleRows.push({
      id: rationaleId,
      tenant_id: tenantId,
      memory_id: row.id,
      project_id: row.project_id ?? null,
      ...rationale,
      status: "accepted",
      confirmation_state: "inferred_unconfirmed",
      created_at: now
    });
    for (const [index, evidence] of inferEvidence(row).entries()) {
      evidenceRows.push({
        id: stableId("ev_backfill", tenantId, row.id, index, evidence.evidence_ref),
        tenant_id: tenantId,
        rationale_id: rationaleId,
        created_at: now,
        ...evidence
      });
    }
  }

  return { targetRows, skippedExisting, rationaleRows, evidenceRows };
}

function buildApplySql(plan) {
  const statements = [];
  for (const row of plan.rationaleRows) {
    statements.push(
      `INSERT INTO decision_rationales(
        id, tenant_id, memory_id, project_id, decision_type, conclusion, reason_summary, status,
        confirmation_state, decider_entity_id, confidence_score, created_at, confirmed_at, superseded_by
      ) VALUES(
        ${sqlString(row.id)}, ${sqlString(row.tenant_id)}, ${sqlString(row.memory_id)},
        ${row.project_id ? sqlString(row.project_id) : "NULL"}, ${sqlString(row.decision_type)},
        ${sqlString(row.conclusion)}, ${sqlString(row.reason_summary)}, 'accepted',
        'inferred_unconfirmed', NULL, ${row.confidence_score}, ${row.created_at}, NULL, NULL
      );`
    );
  }
  for (const row of plan.evidenceRows) {
    statements.push(
      `INSERT INTO decision_evidence(
        id, tenant_id, rationale_id, evidence_type, evidence_ref, relation, note, weight_score, created_at
      ) VALUES(
        ${sqlString(row.id)}, ${sqlString(row.tenant_id)}, ${sqlString(row.rationale_id)},
        ${sqlString(row.evidence_type)}, ${sqlString(row.evidence_ref)}, ${sqlString(row.relation)},
        ${row.note ? sqlString(row.note) : "NULL"}, ${row.weight_score ?? "NULL"}, ${row.created_at}
      );`
    );
  }
  return statements;
}

function summarize(plan, inspectedCount) {
  const projects = {};
  for (const row of plan.targetRows) {
    const key = row.project_id ?? "(none)";
    projects[key] = (projects[key] ?? 0) + 1;
  }
  return {
    inspected_count: inspectedCount,
    target_count: plan.targetRows.length,
    skipped_existing_rationale_count: plan.skippedExisting,
    rationale_count: plan.rationaleRows.length,
    evidence_count: plan.evidenceRows.length,
    confirmation_states: {
      inferred_unconfirmed: plan.rationaleRows.length
    },
    projects
  };
}

function printText(snapshot) {
  console.log("Org Brain memory rationale backfill");
  console.log(`scope: tenant=${snapshot.scope.tenant} database=${snapshot.scope.database} location=${snapshot.scope.location}`);
  console.log(`apply_requested: ${snapshot.apply_requested}`);
  console.log(`applied: ${snapshot.applied}`);
  console.log("");
  console.log("Summary");
  console.log(`  inspected=${snapshot.summary.inspected_count}`);
  console.log(`  target=${snapshot.summary.target_count}`);
  console.log(`  skipped_existing_rationale=${snapshot.summary.skipped_existing_rationale_count}`);
  console.log(`  rationales=${snapshot.summary.rationale_count}`);
  console.log(`  evidence=${snapshot.summary.evidence_count}`);
  console.log("");
  console.log("Projects");
  for (const [project, count] of Object.entries(snapshot.summary.projects)) {
    console.log(`  ${project}: ${count}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const tenant = sqlString(options.tenant);
  const tagFilter = HIGH_VALUE_TAGS.map((tag) => `m.tags_json LIKE '%"${tag}"%'`).join(" OR ");
  const data = await runD1Queries(options, {
    memories: `
      SELECT m.*, r.id AS rationale_id
      FROM memories m
      LEFT JOIN decision_rationales r
        ON r.tenant_id = m.tenant_id
       AND r.memory_id = m.id
      WHERE m.tenant_id = ${tenant}
        AND COALESCE(m.lifecycle_state, 'active') = 'active'
        AND (${tagFilter})
      ORDER BY m.created_at DESC
      LIMIT ${Number(options.limit)};
    `
  });

  const plan = buildBackfillPlan(data.memories, options.tenant);
  const statements = buildApplySql(plan);
  if (options.apply && statements.length > 0) {
    for (let index = 0; index < statements.length; index += 40) {
      await runD1Queries(options, { apply: statements.slice(index, index + 40).join("\n") });
    }
  }

  const snapshot = {
    captured_at: Date.now(),
    scope: {
      tenant: options.tenant,
      database: options.database,
      location: options.location,
      env: options.env ?? null
    },
    apply_requested: options.apply,
    applied: options.apply,
    summary: summarize(plan, data.memories.length)
  };

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  printText(snapshot);
}

export {
  buildApplySql,
  buildBackfillPlan,
  inferEvidence,
  inferRationale,
  isHighValue,
  parseArgs,
  summarize
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
