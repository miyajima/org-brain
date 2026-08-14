# OrgBrain Memory Contract v2

This document is the executable contract for durable learning and task
continuity. It is intentionally agent-independent; the Codex adapter is the
first adapter that enforces it.

## Design rule

Define the record that will be safe to reuse first, then derive capture prompts,
hooks, verification, and storage from that record. A candidate is not active
knowledge until its evidence and lifecycle state say that it is safe to use.

```mermaid
flowchart LR
  A[Current turn] --> B{Explicit answer?}
  B -- yes --> C[TaskCommitmentV1]
  B -- no --> D[LearningObservationV2]
  D --> E{Deterministic checks}
  E -- incomplete --> F[Review candidate, 180 days]
  E -- complete --> F
  F --> G[Async: three independent AI judges]
  G -- unanimous pass --> H[Formal memory or decision memory]
  G -- disagreement/fail --> I[Hold or expire]
  C --> I[Task context injection]
  I --> J[PreToolUse re-ask guard]
```

## Layers

### `LearningObservationV2`

This is a current-turn candidate. It is never used as active context. The
agent supplies only semantic fields; hooks and the API add identity, hashes,
scope, producer, prompt/verifier versions, timestamps, TTL, quality, ACL, and
lifecycle state.

The common semantic envelope is:

```json
{
  "record_type": "learning_observation",
  "schema_version": 2,
  "lesson_type": "success | decision | failure",
  "capture_intent": "verify | review",
  "trigger": "what made this reusable",
  "applicability": { "target_files": [], "components": [] },
  "evidence_selectors": [],
  "gaps": []
}
```

The type-specific required fields are:

- `success`: `procedure`, `why_it_worked`, `observed_outcome`, `reuse_when`.
- `decision`: `decision_type`, `decision_key`, `question`, an exact
  `selected_value` or `decision`, and applicability. `implementation` and
  `governance` also require `rationale` and `alternatives`. A user choice may
  use `rationale: null`; the agent must not invent a reason.
- `failure`: `symptom`, `failed_approach`, `root_cause`, `correction`,
  `verified_outcome`, and `avoidance_rule`.

`capture_intent=verify` is accepted only when the type-specific fields and
evidence are complete. `capture_intent=review` is retained as a redacted,
180-day candidate with honest `gaps` and cannot become active automatically.

### `TaskCommitmentV1`

This is the authoritative record for an explicit `request_user_input` answer.
It is scoped to one task and is kept separate from ordinary memory.

```json
{
  "record_type": "task_commitment",
  "schema_version": 1,
  "task_key": "codex:<session_id>",
  "decision_key": "agent_rollout",
  "question_fingerprint": "sha256:<64 hex chars>",
  "answer": { "option_id": "common_contract_codex_first", "label": "共通契約＋Codex先行" },
  "authority": "explicit_user",
  "confirmation_state": "user_confirmed",
  "ask_policy": "reuse_until_superseded",
  "scope": { "level": "task", "project_id": "org-brain" },
  "evidence": { "type": "request_user_input_result", "digest": "sha256:<64 hex chars>" }
}
```

For a given tenant, task, and `decision_key`, the database permits one active
version. A changed answer supersedes the old version and creates a new
immutable version. Expiry, an explicit change request, scope change, or
conflicting current evidence permits a new question.

## Prompt and hooks

The single source of truth is the manifest at
`packages/shared/src/memory-contract-v2-contract.mjs`, which binds the
versioned prompt, the JSON Schema source digest, the reason-code dictionary
digest, the verifier version, and the three judge profiles into one contract
hash. Its inputs are
`packages/shared/src/memory-contract-v2-runtime.mjs`,
`packages/shared/schemas/memory_contract_v2.schema.json`, and
`packages/shared/src/memory-contract-v2-reason-codes.mjs`. Run
`pnpm contract:check` in CI; it fails when the schema, prompt, judge
families, reason codes, or manifest hash drift. The runtime normalizer is the semantic
verifier; the JSON Schema is the deterministic AI input boundary; and the
reason-code dictionary is the stable reporting vocabulary. The shared package
also exposes the Ajv validator so local MCP, API MCP, and adapters cannot
silently invent a second input contract. The versioned prompt explicitly says
to reuse injected commitments, never re-ask an answered decision, avoid
rationale invention, and use `review` when evidence is incomplete.

The Codex installer configures:

| Event | Matcher | Purpose | Timeout | Context |
| --- | --- | --- | ---: | ---: |
| `SessionStart` | — | Restore task commitments and context | 2s | 8192 B |
| `UserPromptSubmit` | — | Inject commitments and capture prompt | 3s | 8192 B |
| `PreToolUse` | `request_user_input` | Deny exact answered questions | 1s | — |
| `PostToolUse` | `request_user_input` | Persist UI answer immediately | 2s | — |
| `PreCompact` | — | Checkpoint task commitment capsule | 3s | — |
| `PostCompact` | — | Re-inject commitments after compaction | 2s | 8192 B |
| `Stop` | — | Verify and batch current-turn learning | 5s | — |

Hook code does not call an LLM, discover tools, or store raw transcripts. The
answer hook writes the commitment to a 0600 local SQLite ledger first; a
learning-batch transport failure is retained in an idempotent outbox for seven
days. The
context payload is capped at 7168 bytes and is ordered by conflicts/change
requests, task commitments, project decisions, ordinary memory, and the
observation prompt. Records are never cut in the middle.

`task_commitment_semantic_aliases` is a separate, expiring index. It accepts
only an `ai_consensus_certified` result whose three judge records carry the
deployed judge prompt hash. PreToolUse denies a matching certified alias; a
newly similar question without that attestation remains warning-only.

## Evidence and deterministic verification

Evidence selectors support `command`, `file`, `doc`, `user_statement`, and
`tool_result`.

- Commands match a normalized command hash, never a substring.
- Files use repo-relative paths, content hashes, and the relevant diff.
- User input is linked to its exact question, option set, and tool-result
  digest.
- A final answer cannot attest its own command or tool result.
- Sensitive text, credentials, raw reasoning, raw transcripts, and absolute
  home paths are rejected or redacted before persistence.

The deterministic verifier checks schema, evidence selectors, command/file/
tool-result correspondence, scope, duplicate keys, sensitive data, prompt and
verifier hashes, and lifecycle transitions. Any incomplete candidate is
review-only. Even a complete deterministic candidate is first sent as a
review candidate with `ai_consensus_pending`; only the asynchronous judge
worker may return it as `verified_items` for active promotion.

Semantic checks use three independent, temperature-zero, version-pinned judge
profiles: evidence entailment, durability/atomicity, and future reuse/
overgeneralization. The producer is not used as a judge. A candidate is
`ai_consensus_certified` only when all three pass and at least two model
families are represented. Any disagreement becomes
`ai_review_pending/disagreed`; it is not resolved by majority vote.

Judge persistence contains only verdict, reason codes, supported selectors,
judge/model identity, and prompt hash—not reasoning text. The D1 migration also
blocks a candidate from entering `verified` unless three distinct passing judge
rows already exist; the application layer additionally checks exact profile,
family, prompt, verifier, and unanimity constraints.
The shared `runMemoryContractJudgeConsensus` function is the provider-neutral
worker boundary: a deployment supplies three independent model runners outside
the hooks, then submits only the certified verdict metadata to
`orgbrain_learning_batch_ingest`. Hooks never call those runners. Formal
implementation/governance decisions are promoted only to `decision_memories`;
ordinary success/failure records use `memories`, so the same decision is not
duplicated across both stores.

Retention tiers are explicit: redacted, AI-labelled real candidates are Silver
and expire after 180 days; only deterministic, re-anonymized oracle fixtures
are Gold and may be retained permanently in the locked evaluation corpus.

## Quality gates

`packages/shared/src/memory-quality-certifier.mjs` provides deterministic
measurement and certification helpers. Every measurement retains its `axis`
and `cohort`; no cohort is hidden by an aggregate score.

The primary KPIs are:

- `verified_knowledge_correctness`: active fields supported by admissible
  evidence.
- `durable_knowledge_coverage`: durable success/decision/failure events
  candidate-ized without omission.
- `decision_continuity`: an applicable commitment is reused without asking
  again. The same task and decision key re-ask is a hard zero-tolerance gate.

The existing seven axes remain independent gates:
structure/metadata, evidence/rationale, decision usefulness, retrieval
reproducibility, freshness/validity, duplicate/conflict control, and useful
coverage. Each cohort requires a point estimate of at least 95% and a 95%
Wilson lower bound of at least 95%. Re-ask rate additionally requires a 95%
Wilson upper bound of at most 5%.

The hard guardrails are zero tolerance for unsupported active records,
credential/PII leakage, cross-tenant or cross-scope injection, stale or
superseded application, final-answer self-attestation, canonical duplicates,
contract hash mismatch, and same-key re-asking.

Operational certification is separate from data quality: `PreToolUse` p95 must
be below 100 ms, `PostToolUse` p95 below 250 ms, `Stop` p95 below 2.5 s with a
5 s hard timeout, and a 200-turn smoke must have zero timeouts, API 5xx, and
Cloudflare 1102 responses. These gates are exposed by
`evaluateMemoryContractPerformance` and are not averaged into a quality score.

## Regression corpus and incident fixture

The locked corpus must keep sessions intact across train/dev/test and include
at least 75 success, 75 decision, 75 failure, 200 non-durable turns, 300
next-task retrieval cases, and 75 cases per continuity class (same key,
paraphrase, compaction/resume, and change/conflict/scope change). The
executable minimums are exported as `MEMORY_CONTRACT_CORPUS_MINIMUMS`, and a
v2 quality manifest without a passing corpus is insufficient evidence.

The incident regression is:

1. Answer three structured questions.
2. Capture all three answers in `PostToolUse`.
3. Compact after removing the original tool result.
4. Submit only “作業を続けて”.
5. Restore the three commitments through `PostCompact`/`UserPromptSubmit`.
6. Assert that neither the exact nor paraphrased questions (with the same
   stable decision key) are issued again. A previously unseen semantic match
   is warning-only until an independent judge has certified it as an alias.

Additional cases cover supersede, cross-task IDs, MCP outage/local restore,
duplicate events, missing evidence, malicious final answers, secret redaction,
and context-size boundaries.

## Rollout and rollback

The migration and tools are additive and initially flag-off. Rollout order is
shadow hooks, recorded-only pre-tool decisions, locked-corpus gates, a 24-hour
`org-brain` canary, seven-day monitoring, then additional workspaces and
adapters. Daily jobs check deterministic constraints; weekly jobs break down
quality by lesson type, work type, agent, model, prompt contract, and hook
version. Contract, prompt, verifier, or model changes rerun the locked corpus.

If a metric drops by two points, a Wilson gate fails, or a hard violation
appears, promotion stops. Rollback disables forced guards and automatic active
promotion, suppresses new promotions, and retains candidates, versions, and
audit history.
