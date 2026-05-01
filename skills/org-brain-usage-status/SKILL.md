---
name: org-brain-usage-status
description: Report the current Org Brain usage snapshot from Cloudflare D1. Use when the user asks for 現在の利用状況, 稼働状況, usage snapshot, D1-backed utilization, recent Org Brain activity, or a tenant-level operational summary.
---

# Org Brain Usage Status

Use the bundled script instead of ad hoc SQL when checking how Org Brain is being used right now.

## Workflow

1. Treat Cloudflare D1 as the source of truth for operational counts.
2. Run `pnpm -s usage:status` from the repo root for the default snapshot.
3. Use `pnpm -s usage:status -- --tenant <tenant_id>` when the user asks about a non-default tenant.
4. Use `pnpm -s usage:status -- --json` when another tool or script will consume the output.
5. Do not query or report `tasks`; task records are operational internals and are intentionally excluded from this snapshot.
6. Mention the query scope in the report: tenant, database, and `remote|local|preview`.
7. Report memory stages separately. The default script output includes the latest 3 rows per stage; use `--recent <n>` only when the user asks for a different number.

## Script

- Default command: `pnpm -s usage:status`
- Direct entrypoint: `node ./skills/org-brain-usage-status/scripts/report-usage-status.mjs`
- Useful flags:
  - `--tenant <tenant_id>`
  - `--recent <n>`
  - `--json`
  - `--local`
  - `--preview`
  - `--remote`

## Report Contents

- Memory and thread counts
- First/last memory and thread timestamps
- Memory stage counts and latest rows:
  - `canonical-memory`
  - `curated/promoted-memory`
  - `memory-digest`
  - `recent-raw`
  - `compacted`
  - `suppressed`

Prefer this workflow over reading console HTML or querying local OpenClaw SQLite caches.
