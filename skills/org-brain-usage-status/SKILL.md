---
name: org-brain-usage-status
description: Report the current Org Brain usage snapshot from Cloudflare D1. Use when the user asks for 現在の利用状況, 稼働状況, usage snapshot, task activity, D1-backed utilization, recent Org Brain activity, or a tenant-level operational summary.
---

# Org Brain Usage Status

Use the bundled script instead of ad hoc SQL when checking how Org Brain is being used right now.

## Workflow

1. Treat Cloudflare D1 as the source of truth for operational counts.
2. Run `pnpm -s usage:status` from the repo root for the default snapshot.
3. Use `pnpm -s usage:status -- --tenant <tenant_id>` when the user asks about a non-default tenant.
4. Use `pnpm -s usage:status -- --json` when another tool or script will consume the output.
5. Call out active tasks separately from historical totals, and highlight failed tasks if any are present.
6. Mention the query scope in the report: tenant, database, and `remote|local|preview`.

## Script

- Default command: `pnpm -s usage:status`
- Direct entrypoint: `node ./skills/org-brain-usage-status/scripts/report-usage-status.mjs`
- Useful flags:
  - `--tenant <tenant_id>`
  - `--json`
  - `--recent <n>`
  - `--local`
  - `--preview`
  - `--remote`

## Report Contents

- Task totals and current active count
- Status breakdown
- Capability breakdown
- Project breakdown
- Memory and thread counts
- Recent tasks with JST timestamps

Prefer this workflow over reading console HTML or querying local OpenClaw SQLite caches.
