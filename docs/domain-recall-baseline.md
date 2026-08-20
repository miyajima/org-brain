---
title: OrgBrain Recall implementation baseline
doc_type: reference
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-20
---

# OrgBrain Recall implementation baseline

- Captured: 2026-08-20 (Asia/Tokyo)
- Git HEAD: `24b6914 merge: integrate domain packs with decision console`
- Working tree before Recall changes: clean

## Validation before Recall changes

| Check | Result |
| --- | --- |
| `rtk pnpm packs:validate` | PASS; four first-party packs validated |
| `rtk pnpm typecheck` | PASS; TypeScript reported no errors |
| `rtk pnpm test:node` | PASS; 146 tests passed |
| `rtk pnpm test` | BLOCKED after `test:node`; root `vitest` executable is absent because root `node_modules` is not installed |

The blocked full-suite result is an environment baseline, not a Recall regression.
Package-scoped tests and every available repository-level check remain required
after implementation.

## Compatibility surface

`artifacts/feature-surface/recall-baseline.json` is the machine-extracted golden
surface for API routes, Remote and Local MCP tools, CLI commands, Console routes,
capabilities, feature flags, and public contract/core exports. Additions are
allowed. Removing or renaming a baseline entry fails
`node scripts/feature-surface-snapshot.mjs --check`.
