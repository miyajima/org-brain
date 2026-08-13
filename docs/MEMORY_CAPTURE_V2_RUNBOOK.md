# Memory Capture v2 rollout and repair runbook

The strict hook profile is generated from the executable gold dataset. See
`docs/MEMORY_CAPTURE_GOLD_PROFILE.md` before changing extraction thresholds or
seeding preview data.

All public behavior is off by default:

```text
ORGBRAIN_MEMORY_CAPTURE_V2_MODE=off
memory_learning_mode=off
ORGBRAIN_UNCONFIRMED_DECISION_BLOCKING=off
MEMORY_CLASSIFICATION_MODE=observe
RETRIEVAL_GENERATION_ROUTING=legacy
```

Capture can be enabled for one workspace without changing the tenant default by
setting `memory_capture_v2_mode` to `shadow` or `on` in workspace config v3.
Keep `sensitive_memory.mode` at `deny` unless a reviewed principal allow-list is
present. `restricted_7d` never permits credentials and caps redacted sensitive
memory at seven days.

## Preconditions

1. Apply additive migrations `0029_memory_capture_v2.sql` and
   `0030_memory_learning_quality.sql`.
   It adds independent `reuse_rule` storage, decision-origin provenance, and
   atomic guards that reject new active canonical-key duplicates without
   failing on legacy duplicates awaiting repair.
2. Verify API Gateway and retrieval-projector `AI` and
   `MEMORY_VECTOR_INDEX_V3` bindings. The semantic path uses
   `@cf/qwen/qwen3-embedding-0.6b`; reranking uses
   `@cf/baai/bge-reranker-base`.
3. Verify a D1 export can be restored in a disposable database.
4. Verify the trusted package manager is exactly the pinned `pnpm@10.16.1`.
   Do not disable Corepack signature verification. Run the capture, rationale,
   maintenance, parity, lint, typecheck, test, and build commands listed in the
   project plan.

## Rollout order

1. Apply additive migrations `0029` and `0030`, then deploy the
   backward-compatible API
   while all new behavior flags remain off.
2. Build the private session manifest with
   `pnpm memories:build-learning-corpus -- --output <private-0600.json>`. Set
   `memory_learning_mode=shadow`. Fix the pre-change baseline with
   `pnpm memories:baseline-learning -- --output <private-baseline-0600.json>`;
   it persists only aggregate counts, project hashes, and exclusion reason
   codes. Compare observe recall, verifier reason-code counts, and candidate
   hashes; logs must contain no body or detected value.
3. Run the existing category backfill in dry-run mode, review it, then apply it.
   Confirm active memory and decision category/work-type coverage is 100%.
4. Set `MEMORY_CLASSIFICATION_MODE=require` only after the unclassified count is
   zero. Invalid explicit classifications must still fail closed.
5. Run `pnpm memories:repair -- --remote --tenant <id> --json`, review the full
   dry-run, create the required D1 export and SHA-256 manifest, and complete a
   restore drill.
6. Apply repair with
   `--apply --output-dir <private-dir> --api-url <url> --api-key <key>`. Use
   `--resume` only with the same private plan, manifest, backup, and checkpoint.
7. Backfill all active memories through
   `POST /v1/retrieval-index/v4/backfill` and all active decisions through
   `POST /v1/retrieval-index/v4/decisions/backfill`, following each returned
   cursor until complete.
8. Backfill `gen_verified_learning` through the retrieval-generation backfill
   endpoint. It projects only `observed + verified + active + unexpired` rows.
9. Export and hash a backup of the existing GoldSeed rows, suppress those rows
   without deleting them, then generate any replacement fixtures with
   `memories:seed-gold`. The seed command defaults to the isolated
   `org-brain-memory-fixtures` project and marks every row
   `synthetic + unverified`, so none enters the verified learning generation.
10. Assign the learning generation as shadow for one project, set only that
   workspace's `memory_learning_mode` to `on`, and run a 24-hour canary.
11. Run `pnpm memories:certify-quality -- --manifest <private-locked-manifest>`.
    Every axis is independent; missing samples report `insufficient_evidence`.
    Do not enable capture until all seven axes and all Wilson lower bounds pass.
12. Enable verified capture for the remaining workspaces and then the tenant.
13. Keep inferred-decision blocking off for seven additional days. Enable it only
   if there are zero false blocks and every block has confidence at least 0.90,
   exact scope, a reason, current validity, no conflict, and durable evidence.

## Repair safety

- Dry-run is the default. `memory-cleanup --apply` is not part of this process.
- Local apply refuses a missing database and never creates an empty one.
- Apply requires `--output-dir`; backups/exports, manifests, checkpoints, and
  reports are mode `0600` (directory `0700`).
- Credential reports contain only memory ID and `rotation_required`.
- Every memory row is cursor-scanned, including already-suppressed rows.
  Suppressed rows are never reactivated; credential findings still enter the
  content-free rotation report.
- Content, summary, rationale, reuse rule, evidence, source references, tags,
  entities, and conflicts receive the same credential/path screening.
- Repair creates derived atomic memories and `derived_from` edges before
  suppressing the source. It performs no physical deletes.
- The private plan is written before mutation. Resume reuses that exact plan and
  verifies its hash plus the existing manifest/backup; it never replans partially
  mutated data.

## Required monitoring

- capture accepted/skipped counts by reason code (no content)
- duplicate canonical-key active count
- rationale/reuse-rule field-separation and active canonical-write conflicts
- category/work-type coverage
- credential, absolute-path, UI-directive, and body/evidence-duplication audits
- Stop-hook latency p50/p95, timeout count, and API 5xx/Cloudflare 1102 count
- semantic, atomic, segment, and reranker candidate counts and degraded reasons
- inferred-decision review/block counts and false-block incidents

The live gate is `pnpm smoke:memory-learning -- --project <canary> --requests 200`
with no request error/5xx/1102. The locked 300-query evaluation additionally
requires Recall@5, MRR, known-theme non-empty rate, and unrelated-query
abstention all at least 0.95, and zero
occurrences of `semantic_provider_unavailable`,
`atomic_extractor_not_configured`, `segment_candidates_unavailable`, and
`reranker_unavailable`.

## Rollback

1. Set both capture and inferred-blocking flags to `off`.
   Set every workspace `memory_learning_mode` to `off`.
2. Restore the previous retrieval-generation assignment.
3. Mark auto-generated decisions `deprecated`.
4. Suppress newly derived repair memories.
5. Restore changed memories from versions or the verified backup/export.

Do not remove additive columns or deterministic project categories during
rollback. Every pre-repair memory ID must remain as `active` or `suppressed`.
