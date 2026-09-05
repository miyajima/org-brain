# Router v3.3 cloud-assisted development experiment

## Boundary

The runtime router stays v2. This CLI never writes production memory, changes a
DB, opens final holdout data, or generates extraction candidates. It reviews
existing development conversations, creates embeddings, and evaluates a local
classification-selection procedure. AI consensus is not human ground truth.
Existing v3.2 files, UI/localStorage answers and frozen models are untouched.

Cloud review uses OpenAI Responses API, Sol/high and Luna/max independently,
without tools, conversation history or previous answers. Embeddings use
`text-embedding-3-large`, 1024 dimensions. There is no Ollama request, model
download, Codex subprocess or provider fallback. `OPENAI_API_KEY` must be set in
the CLI environment; do not put credentials in a manifest or a review bundle.
`store:false` is requested for Responses, not a guarantee of provider-wide zero
retention. API billing is separate from a Codex subscription.

## Commands

Create a new private, empty directory (0700). All files are exclusive-create
0600; successful artifacts cannot be overwritten. Each command requires the
manifest, verifies its hash and verifies that the original source files have
not changed. Preserve the source paths to resume.

```sh
node scripts/memory-extraction-router-v33.mjs prepare \
  --manifest /private/tmp/NEW-RUN/manifest.json \
  --source /private/tmp/orgbrain-dedup-work/deduplicated-500.json \
  --legacy-manifest /private/tmp/orgbrain-router-v32-eval.nYZFTL/manifest.json \
  --challenge /private/tmp/orgbrain-router-v32-eval.nYZFTL/review-batch-1.json

node scripts/memory-extraction-router-v33.mjs review --manifest /private/tmp/NEW-RUN/manifest.json
node scripts/memory-extraction-router-v33.mjs embed --manifest /private/tmp/NEW-RUN/manifest.json
node scripts/memory-extraction-router-v33.mjs train --manifest /private/tmp/NEW-RUN/manifest.json
node scripts/memory-extraction-router-v33.mjs report --manifest /private/tmp/NEW-RUN/manifest.json
```

`prepare` fixes the existing challenge 40 and a hash-selected 80 from other
groups, at most two per group, without consulting labels or predictions. It
fixes outer/inner folds and the pre-existing Safety fixture before review.
The sampled 80 represent this eligible development sample, not production
traffic or the whole 500. `token-profile.json` gives conservative input/output
ceilings; requests never truncate an oversized conversation. Reviews are capped
at 240 logical jobs, with one transport/schema retry each (480 requests max).

`review` saves full successful responses privately and preserves model, effort,
request ID, usage and input hashes. Sol's validated spans remain canonical;
Luna's spans are not merged into the gold. Agreement must be valid on both
sides; otherwise the case stays uncertain. Two failed attempts remain errors,
not fabricated labels. An interrupted attempt without a response checkpoint is
an unknown outcome and stops without an automatic resend. Investigate an
orphaned stage lock and process before removing the exact lock; do not delete
attempt claims to force retries.

`inspect --manifest FILE` is a read-only, credential-free inspection of every
review checkpoint. It reports successful responses, failures, exhausted jobs,
unknown outcomes and the stage lock before any network preflight can run.
An exhausted job or permanent failure stops the entire run immediately, not
just its current case. An unknown outcome anywhere also blocks earlier pending
jobs from being sent on resume. Completed successes are never retransmitted.

Incomplete responses now retain their status, request/response IDs, requested
limit, incomplete reason and input/output/reasoning usage in the private failure
checkpoint, together with the raw response. The report emits diagnostic fields
only, never the raw response or transcript. `max_output_tokens`, content-filter
and other incomplete responses stop without same-settings retries. Transport
or schema errors still have at most one retry; exhaustion stops before the next
job. The fixed 8192-token ceiling includes reasoning, not just visible JSON.
Neither the limit nor model/effort is silently increased or changed.

Legacy `review_response_incomplete` checkpoints have no detailed reason or usage.
They remain explicitly unknown; inspection cannot reconstruct discarded API
data. They require investigation rather than another automatic send. Existing
claims, failed results, successful results and locks are not rewritten by this
repair. Unknown outcomes and exhausted attempts are not reset by this command.

`embed` starts only with sufficient review support and no unresolved request
errors. It processes full, non-overlapping 1500-codepoint chunks, in serial
batches of at most eight. Successful batches and channel vectors are resumable.
Each vector is normalized before character-weighted pooling and normalized
again. Frozen actual vectors, not an invented cloud digest, are the offline
reproducibility source. Role-specific channels are user and assistant; missing
roles produce zero features plus presence flags. Other roles remain in the
global channel and rule features.

## Learning and interpretation

Four configurations only: rules, embedding_mean, combined_mean, combined_role.
Projection is data-independent SHA-256 Rademacher (1024→64 globally, or 32 per
role). All scaling, class weights and fitting occur inside training folds.
Nested 5×4 grouped CV selects L2 per binary task by sampled-semantic inner OOF
log loss, then cascade thresholds and configuration by the specified metric
ordering. L2 ties prefer stronger regularization, as v3.2 does. Training uses
accepted semantic rows from both cohorts; inner selection metrics use only
sampled_development. Uncertain rows are predicted but never trained on.

Outer-fold rows evaluate the selection procedure, not a configuration selected
after seeing outer scores. Per-configuration OOF is diagnostic only. The final
all-development model repeats inner selection and has no independent quality
claim. Records retain folds, source/revision hashes, probabilities, thresholds,
training-group hashes, model hashes and fold models.

Candidate rate uses both all sampled rows (including uncertain) and accepted
semantic rows, with 47% caps. Durable-first routing counts operational cases
misrouted to durable as operational false negatives. Required label support is
72/80 accepted, 20 durable, 20 operational and 30 groups. A mathematically
infeasible durable prevalence/call-cap combination is reported, not relaxed.

Evidence has two separate experiments: forced packer-only and routed
end-to-end. End-to-end missed durable rows get zero coverage; no emitted packet
has undefined, not 100%, exactness. Previous 92.9% vs 21.4% was an unmatched
comparison and is retained only as a historical note. This is packet evidence,
not LLM-output grounding. Paired group bootstrap uses 2000 fixed-seed resamples.

Development gates require recall≥95%, operational F1≥75%, both call rates≤47%,
same-input evidence at least v2, and frozen synthetic Safety 80/80 and 0/80.
Uncertain-case pessimistic bounds must also pass; accepted-only scores cannot
establish a pass. All labels and results remain AI-assisted development data.

## Output and stop states

The private run contains manifest, Safety, token profile, review attempt
checkpoints, labels, embedding batch/channel caches, vector snapshot, training
artifact, identifier-only error queue and content-addressed JSON reports.

- `cloud_not_ready`: cloud review incomplete, including missing credentials.
- `insufficient_ai_review_support`: insufficient consensus/class support, or
  uncertainty prevents establishing the metric targets.
- `development_gate_failed`: measured target or prevalence/call-cap failure.
- `ai_assisted_development_gates_passed`: development procedure passed, not a
  production-ready or independently validated model.

Intermediate states such as `prepared`, `ai_reviews_ready`, and
`awaiting_embeddings_or_training` do not imply evaluation completion.

Validation: `pnpm test:router-v33`, existing Router test suites, affected
typechecks, repository lint and `git diff --check`. Tests use simulated provider
responses only; synthetic fixtures are never substituted for the real review
corpus or used to claim model quality.
