---
title: OrgBrain Memory Quality Runbook
doc_type: reference
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-16
---

# OrgBrain Memory Quality Runbook

## Synthetic dual-route regression

```text
rtk pnpm memories:build-ingestion-regression -- --emit-sessions /private/tmp/orgbrain-quality-generated --check
rtk pnpm memories:evaluate-ingestion -- --input generated --output-dir .local/memory-quality/<run-id>
```

Formal observe hashes must match for `realtime_hook` and `initial_import`.
Fallback-only history stays quarantined because its command claims cannot be
independently verified. A locked oracle, never the generator, certifies
expected routes. Candidate count remains at most three per turn; replay must
preserve plan hash and idempotency.

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
