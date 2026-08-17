---
title: OrgBrain Memory Quality Runbook
doc_type: reference
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-17
---

# OrgBrain Memory Quality Runbook

## Synthetic dual-route regression

```text
rtk pnpm memories:build-ingestion-regression -- --emit-sessions /private/tmp/orgbrain-quality-generated --check
rtk pnpm memories:evaluate-ingestion -- --input generated --output-dir .local/memory-quality/<run-id>
```

The evaluator runs the generated JSONL through both the realtime hook parser
and the initial-import parser. It records route counts, candidate hashes,
parity mismatches, hard violations, and all seven quality axes with point
estimates and Wilson lower bounds. Fallback-only history stays quarantined
because its command claims cannot be independently verified. A locked oracle,
never the generator, certifies expected routes. Candidate count remains at
most three per turn; replay must preserve plan hash and idempotency.

The evaluator returns run-scoped loopback metadata for the API and Console
(`127.0.0.1:8787` and `127.0.0.1:4321`). It never reports `passed` merely
because the parser ran: local private-judge availability, parity, hard
violations, and Wilson gates must all pass. Otherwise the run remains
`insufficient_evidence` with an explicit reason.

## Bilingual storage replay

```text
rtk pnpm memories:regress-ingestion-storage -- \
  --output-dir .local/memory-quality/<run-id> \
  --keep
```

The v3 fixture deterministically assigns 1,037 cases to English 519件 and
Japanese 518件. Natural-language fields use reviewed static templates; IDs,
commands, repository-relative paths, hashes, and schema keys remain shared.
The runner creates temporary Git workspaces, emits accepted
`mcp_tool_call_end` evidence, imports the capture lane through the real Codex
session importer, and writes only to local SQLite.

The storage gate expects 225 active memories, 12 quarantine candidates, and
200 excluded capture cases. All 75 decision memories must retain their
decision key, rationale, reuse rule, evidence, and verified state. Replaying
the same content-addressed plan must create zero new memories, versions, or
quarantine rows. The report also records English/Japanese storage counts and
fails if synthetic credentials or PII reach SQLite.

## Private Mac canary

```text
rtk pnpm memories:evaluate-ingestion -- \
  --input mac \
  --sessions-root ~/.codex/sessions \
  --scope all-user-workspaces \
  --judge-mode local \
  --output-dir .local/memory-quality/<run-id>
rtk pnpm memories:view-quality-run -- --run-id <run-id>
```

The command groups worktrees by Git common directory and emits a basename plus
short hash project ID. It reads user-origin root sessions only; the parser
excludes automation, subagents, and non-final reasoning rows. The bundle stores
hashes and counts, not transcript text, command output, credentials, or
absolute paths. Cloud URL variables are ignored and no outbound request path
exists. Without a local private judge, cases remain `requires_private_judge`;
fewer than 75 qualifying cases remains `insufficient_evidence`.

Inspect `/memories?view=quality`. Confirm each axis independently, route
parity, hard violations, evidence traceability, reuse specificity, source
drift, and route classification. The Quality view is read-only; remediation
opens the authorized Memory detail.

## Disposal and rollback

```text
rtk pnpm memories:dispose-quality-run -- --run-id <run-id>
```

Disposal rejects unsafe IDs, paths outside `.local/memory-quality`, symlinks,
and directories without a matching private-run marker. Deletion is permanent.
For rollout rollback set `MEMORY_QUALITY_UI_MODE=off` and stop writing new
capture routes. Keep the additive schema and existing IDs; legacy rows remain
`capture_route=legacy`. Never physically delete production memories as part of
quality rollback.
