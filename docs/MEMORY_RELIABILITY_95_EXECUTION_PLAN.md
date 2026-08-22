---
title: Memory Reliability 95+ Execution Plan
doc_type: reference
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-15
---

# Memory Reliability 95+ Execution Plan

## Background

This plan is for a separate implementation session after the memory-quality-v2
work has been merged to `main`. It separates what is confirmed in production
from code that exists only in the repository.

### Confirmed production state on 2026-08-13 JST

Scope: Cloudflare D1 `open-brain`, location `remote`, tenant `default`.

- The tenant has 696 memories, of which 684 are active.
- The `org-brain` project has 32 memories, of which 31 are active.
- In `org-brain`, 20 of 32 rows are command-result records; there are no
  decision memories and no structured success/decision/failure learning tuples.
- `rationale`, Evidence, source references, category, and work type have zero
  coverage in `org-brain`. The same fields have zero coverage across the tenant.
- 26 of 31 active `org-brain` rows are older than 90 days, 24 have no TTL, and
  7 are expired but still active.
- Twenty active `org-brain` rows have an empty content hash. No `org-brain` row
  has a canonical key. At least three same-event duplicate groups affect six
  active rows.
- Twenty-one rows contain home-path forms, two contain raw hook payloads, and
  two match credential-assignment syntax. Credential values were not retrieved
  during the audit and must not be printed by the repair flow.
- Production D1 does not have the migration 0030 learning-quality columns.
- Production has only `gen_baseline_units` and `gen_structured_context`.
  `gen_verified_learning` is absent; `org-brain` has zero v4 units; its baseline
  units are all degraded with `atomic_extractor_not_configured`.
- There are no generation assignments or retrieval events for `org-brain`.

### Confirmed repository state after this merge

- Additive migrations 0029 and 0030, capture-v2 contracts, evidence verification,
  repair tooling, learning projection, Console provenance fields, and feature
  flags exist in the repository.
- Public behavior remains off or shadow by default.
- Local Ollama `qwen3-embedding:0.6b` regression passes on a synthetic,
  credential-free session fixture: Recall@5 100% and MRR 95.83%, versus sparse
  Recall@5 91.67% and MRR 57.78%.
- The local Qwen result proves the adapter and regression harness, not the
  reliability of current D1 data or the production Workers AI/Vectorize path.
- The pre-existing `local-memory.test.mjs` telemetry test expects two outbox
  rows but observes three on both the old `main` and this branch. Treat this as
  an explicit baseline defect; do not hide or waive it for rollout.

## Goal

Produce a production corpus of verified, atomic learning memories that help the
next AI task with successful methods, decisions and their rationale, and failure
causes plus avoidance rules. Every quality axis is scored independently out of
100. No total or weighted average is allowed. All seven axes must score at least
95, and every hard-zero gate must pass, before capture or retrieval is enabled
for all projects.

## Non-goals and safety boundaries

- Do not infer verified evidence from an assistant's final-answer claim.
- Do not read or persist hidden reasoning, encrypted reasoning, subagent
  reasoning, or automation-session internals.
- Do not physically delete historical memories during repair.
- Do not print credential values, candidate text, or PII in logs or reports.
- Do not weaken evidence requirements to improve capture recall.
- Do not compare local and Cloudflare embeddings byte-for-byte. Compare
  retrieval behavior because runtimes and quantization may differ.
- Do not enable unconfirmed-decision blocking during the initial rollout.

## Quality scorecard and release gates

Each axis score is the minimum percentage among its listed metrics, rounded
down to an integer. A strong metric cannot compensate for a weak one. If the
minimum sample size is not met, the axis is `insufficient_evidence`, which is a
failed gate rather than a score of 95.

| Axis | Independent 95/100 gate | Hard-zero conditions |
| --- | --- | --- |
| Decision usefulness | Minimum of useful-injection precision, eligible-opportunity recall, correct abstention on unrelated tasks, and positive/non-inferior paired-task outcome is at least 95% | No unsupported memory may change a destructive or external action |
| Evidence and rationale | Minimum of conclusion/rationale/evidence semantic-support pass rate, admissible-evidence coverage, and reviewer agreement is at least 95% | Zero falsely verified commands; zero Evidence copied from final-answer self-report |
| Retrieval reproducibility | Recall@5, MRR, known-theme non-empty rate, and unrelated-query abstention are each at least 95% | Zero known-theme empty results in the locked test; zero queries routed to a missing generation |
| Freshness and validity | Minimum of correct TTL, valid-until, verified-at, source-hash, and scope coverage is at least 95% | Zero expired or source-drifted memories injected; zero access events rewriting semantic freshness |
| Duplicate and conflict control | Exact/near-duplicate suppression, contradiction precision, contradiction recall, and unresolved-conflict non-block rate are each at least 95% | Zero active duplicates per canonical key; zero unresolved contradictions allowed to block |
| Useful coverage | Minimum capture recall across success, decision, failure, and every major work type is at least 95% | Synthetic data is excluded from certification; no class may be omitted from the score |
| Structure and metadata | Minimum valid-row coverage for required fields, atomicity, category, work type, origin, verification, TTL, and provenance is at least 95% | Zero credentials, home paths, UI directives, raw hook envelopes, or conclusion/Evidence full-text duplication in active verified rows |

Additional release gates:

- Active memory and decision category coverage: 100%.
- Active memory and decision work-type coverage: 100%.
- Local/Cloud candidate JSON hashes: 100% identical on shared fixtures.
- Current-memory IDs after repair: 100% retained as active or suppressed.
- Physical deletion count: zero.
- Live API smoke: 200 consecutive requests with zero 5xx or Cloudflare 1102.
- Stop-hook capture p95: below 2.5 seconds, with a five-second hard timeout.
- Human-reviewed metrics require a point estimate of at least 95% and a 95%
  Wilson lower bound of at least 95%.
- Minimum certification corpus: at least 75 independently reviewed examples
  each for success, decision, and failure; at least 200 non-durable turns; at
  least 300 locked next-task queries. Sessions may not cross data splits.

## Affected files and modules

Primary implementation areas:

- `migrations/0029_memory_capture_v2.sql`
- `migrations/0030_memory_learning_quality.sql`
- `packages/shared/src/memory-capture-v2.ts`
- `packages/shared/src/memory-learning.ts`
- `packages/shared/src/memory-quality-certifier.ts`
- `packages/shared/src/memory-repair.ts`
- `packages/shared/src/retrieval-units.ts`
- `packages/orgbrain-cli/src/hook-memory-bridge.mjs`
- `packages/orgbrain-cli/src/lib/memory-learning-transcript.mjs`
- `packages/orgbrain-cli/src/lib/local-memory-store.mjs`
- `packages/orgbrain-cli/src/lib/local-dense-embedding.mjs`
- `apps/api-gateway/src/rationale-service.ts`
- `apps/api-gateway/src/memory-service.ts`
- `apps/api-gateway/src/retrieval-generation-service.ts`
- `apps/api-gateway/src/retrieval-index-service.ts`
- `apps/api-gateway/src/context-engine-service.ts`
- `apps/cap-runner/src/memory-maintenance.ts`
- `apps/console/src/pages/memories.astro`
- `scripts/memory-repair.mjs`
- `scripts/memory-quality-certify.mjs`
- `scripts/memory-learning-corpus.mjs`
- `scripts/memory-learning-live-smoke.mjs`
- `skills/org-brain-usage-status/scripts/report-usage-status.mjs`

## Execution packets

Execute sequentially because migration, repair, projection, and certification
share schemas and production state. Before each implementation packet, confirm
the active Codex model catalog and record the harness routing decision.

### Packet 0: Reproducible baseline and operational fixes

Difficulty: Low. Preferred route: the least expensive available Codex model
that can reliably update scripts and focused tests.

1. Fix `cf:usage:status` so it runs the API Gateway workspace Wrangler with
   `wrangler.remote-d1.toml`; do not depend on a root-level binary.
2. Resolve the telemetry-outbox expected-count defect by identifying whether
   two or three events are contractually correct. Update implementation or test
   from the contract, not by changing the assertion to the observed value.
3. Add a read-only audit command that produces only counts, rates, reason codes,
   IDs, and hashes. It must never emit credential candidates or raw content.
4. Save the 2026-08-13 audit as the immutable baseline artifact.

Gate: focused tests, lint, typecheck, and baseline audit reproduction must pass
before production mutations are allowed.

### Packet 1: Additive production schema and API deployment

Difficulty: High because it changes authorization, persistence, and decision
behavior. Preferred route: strongest available Codex implementation model with
high effort.

1. Validate migrations 0029 and 0030 against a copy of the current D1 schema.
2. Deploy additive columns, indexes, API schema, attestor permission, and
   review reason codes with capture-v2, learning retrieval, and blocking off.
3. Confirm old clients still receive their legacy response shape.
4. Backfill all existing rows as `capture_origin=legacy` and
   `verification_state=unverified`; never auto-promote them to verified.
5. Verify decision auto-upsert remains disabled until its evidence gates pass.

Gate: schema parity, backward-compatibility tests, authorization tests, and 200
read/write smoke requests with zero server errors.

### Packet 2: Full-corpus repair with restore proof

Difficulty: High because all 696 memories are in scope and accidental mutation
has high recovery cost.

1. Produce a remote D1 export, SHA-256 manifest, 0600 local copy, and restore
   drill report before apply.
2. Scan every row with cursor/checkpoint pagination. A 500-row sample is not
   sufficient.
3. Quarantine credential-assignment candidates server-side. Reports contain
   memory ID and `rotation_required`, never the detected value.
4. For `org-brain`, suppress expired command results, usage snapshots, raw hook
   envelopes, temporary artifacts, and low-quality completion reports.
5. Reprocess durable diagnoses into derived pitfall candidates only when root
   cause, avoidance rule, corrected outcome, and admissible evidence can be
   independently reconstructed. Otherwise leave them suppressed/review.
6. Reprocess durable policies into decision/constraint candidates only when
   decision, rationale, scope, and evidence pass verification. Do not convert
   prose into verified records merely because it sounds authoritative.
7. Populate deterministic category, work type, canonical key, content hash,
   TTL, origin, and verification fields. Preserve `derived_from` relationships.
8. Keep the best active member of each canonical group; suppress the rest.
9. Apply to `org-brain` first, validate, then process remaining projects in
   bounded batches with checkpoint/resume.

Gate: dry-run report approved, restore drill successful, zero physical deletes,
100% ID retention, zero active expired rows, zero empty hashes, zero active
canonical duplicates, and 100% category/work-type coverage.

### Packet 3: Verified capture and hook shadow canary

Difficulty: Medium. Preferred route: balanced Codex implementation model with
xhigh effort.

1. Enable the stateless `orgbrain_memory_observe` path in shadow for one project.
2. Inject the hidden observe instruction only on UserPromptSubmit. Keep the
   user-facing response unchanged.
3. At Stop, read only the current turn, accept at most three successful observe
   events, verify evidence, and send one batch to the known capture tool.
4. Never call tool discovery, an LLM, or remote fallback from Stop.
5. Store incomplete, conflicting, sensitive, or unverifiable candidates as
   skipped/review, not active.
6. Build private annotations from real user-origin sessions. Exclude reasoning,
   subagent, automation, credential, and PII content.

Gate: durable precision at least 95%, durable recall at least 95%, zero false
verified evidence, user-answer quality non-inferior, and hook p95 below 2.5s.

### Packet 4: Production Qwen projection and locked retrieval test

Difficulty: Medium. Preferred route: balanced Codex implementation model with
xhigh effort.

1. Verify Workers AI and Vectorize bindings in API Gateway and retrieval
   projector. Pin `@cf/qwen/qwen3-embedding-0.6b` and the 1024-dimension index.
2. Create `gen_verified_learning`; project only active verified learning and
   verified decision memories into atomic, profile, ledger, timeline, and
   segment channels.
3. Pass semantic candidates and scores through fusion and reranking. Record an
   explicit degraded reason when any provider is unavailable.
4. Reproject repaired `org-brain` data, then all eligible projects.
5. Build a locked test from real next-task questions plus anonymous synthetic
   adversarial cases. Development, validation, and locked sessions must not
   overlap.
6. Compare lexical/sparse, local Qwen, and Cloudflare Qwen by Recall@5, MRR,
   abstention, and top-k overlap. Never require numeric-vector equality.

Gate: all retrieval metrics in the scorecard at least 95%; zero known-theme
empty results; zero normal-production occurrences of semantic provider,
atomic extractor, segment candidate, or reranker unavailable reasons.

### Packet 5: Certification, canary, and rollout

Difficulty: Medium. Preferred route: balanced Codex implementation model.

1. Run the seven-axis certifier on the locked corpus and current active data.
2. Publish each axis independently. Do not publish a total or average.
3. Keep capture and verified retrieval shadowed if any axis is below 95 or has
   insufficient evidence.
4. Run a 200-turn AI-audited `org-brain` canary, then a multi-project shadow
   period. Active candidates are council-checked; disagreement is quarantine.
5. Let the autonomy state machine advance to `guarded` and `autonomous` only
   after route Wilson gates, observed outcomes, rollback readiness, and
   retrieval coverage pass. No human approval step is required.
6. Keep unconfirmed-decision blocking off for seven additional days. Enable it
   only after zero false blocks, with 0.90 confidence plus admissible evidence;
   0.89 or unsupported 0.90 decisions remain advisory/review.

Gate: every independent score at least 95, every hard-zero condition satisfied,
and operational smoke/latency gates satisfied.

## Verification commands

Run the narrow tests first, then the complete repository checks:

```text
rtk pnpm exec vitest run scripts/codex-session-hook-replay.test.mjs scripts/hook-memory-bridge.test.mjs packages/shared/test/memory-learning-event.test.ts packages/shared/test/memory-evidence-verifier.test.ts
rtk pnpm exec vitest run apps/api-gateway/test/rationale-service.test.ts apps/api-gateway/test/retrieval-index-service.test.ts apps/api-gateway/test/context-engine-service.test.ts
rtk pnpm exec vitest run apps/cap-runner/test/memory-maintenance.test.ts packages/shared/test/retrieval-projection-parity.test.ts packages/shared/test/retrieval-learning-fixture.test.ts
rtk pnpm run test:local-qwen
rtk pnpm cf:memory:repair -- --tenant default --dry-run --report <private-report>
rtk pnpm memories:qualify-ingestion-oracle -- --output <private-oracle-report>
rtk pnpm memories:calibrate-ingestion -- generate --seed-file <private-seed> --output-dir <private-calibration-dir>
rtk pnpm memories:machine-reference -- generate --seed-file <private-seed> --output-dir <private-machine-reference-dir>
rtk pnpm memories:machine-reference -- judge --cases <private-machine-reference-dir>/cases.jsonl --runner-module <managed-council-adapter.mjs> --signing-key <council-key> --output <private-machine-reference-dir>/council.json
rtk pnpm memories:machine-reference -- seal --cases <private-machine-reference-dir>/cases.jsonl --council <private-machine-reference-dir>/council.json --output-dir <private-machine-reference-dir>/sealed
rtk pnpm memories:calibrate-ingestion -- canary --workspace <workspace> --sessions-root <sessions-root> --judge-runner <managed-council-adapter.mjs> --output <private-canary-report>
rtk pnpm memories:certify-quality -- --manifest <private-locked-manifest> --oracle-report <private-oracle-report> --autonomous-report <private-machine-report>
rtk pnpm smoke:memory-learning -- --project org-brain --requests 200
rtk pnpm run lint
rtk pnpm run typecheck
rtk pnpm run test
rtk pnpm run build
```

Do not disable Corepack/package-manager signature verification to make these
commands pass.

## Completion criteria

The task is complete only when:

- all seven independent quality axes score 95 or higher;
- no axis is `insufficient_evidence`;
- all hard-zero and additional release gates pass;
- production `org-brain` search uses `gen_verified_learning` successfully;
- current active rows contain no credentials, home paths, raw hook envelopes,
  UI directives, expired content, empty hashes, or duplicate canonical keys;
- every repaired pre-existing ID remains active or suppressed;
- capture/retrieval flags are enabled only after certification; and
- the final report includes before/after counts, score evidence, deployment
  identifiers, rollback readiness, and unresolved risks without a total score.

## Rollback plan

1. Turn off capture-v2, learning retrieval, and blocking flags.
2. Restore retrieval assignment to the prior generation.
3. Mark newly auto-generated decisions deprecated and newly derived memories
   suppressed; do not delete them.
4. Restore previous memory state from the verified D1 export if repair output is
   incorrect. Re-run the ID-retention audit after restore.
5. Leave additive columns, categories, audit records, and original IDs intact.
6. Record the rollback reason and failed gate; do not resume rollout until the
   locked certification is rerun from a clean assignment.
