# Router v3.1 local repair

## Boundaries

Default routing remains v2. V3.1 is an explicit model artifact for offline
shadow evaluation. API enqueue and cap-runner refuse v3 provider execution with
`unsupported_token_profile`: the Sol encoding/request envelope is not verified.
`js-tiktoken@1.0.21` with o200k is an offline estimate, not a certified Sol token
counter. There was no provider invocation, deployment, migration, annotation
change, or external persistence in this repair run.

The original 75 calibration cases are the only development population. Four
`excluded` cases never enter fitting, L2, threshold, or feature-set selection.
The 425 previously viewed cases are regression-only (398 semantic); they are
not a new holdout and were not used to retune the selected artifact.

## Implementation

- Explicit v3 selection no longer passes the v2 model. Conflicting versions
  fail with a cause rather than falling back.
- V3 evidence has UTF-16 source offsets and dotted-parent-safe IDs. Japanese
  sentence splitting no longer clips at 1000 characters. Ranked causal groups
  are packed whole before chronological serialization; empty evidence fails.
- Output validation rejects unknown/duplicate/malformed fields and IDs before
  coercion, cross-span concatenated quotes, arbitrary gap text, wrong controls,
  unsupported targets and content-free candidates. V1/v2 contracts remain intact.
- Nested grouped calibration fits operational classifiers on predicted
  durable-negative residuals, not only gold negatives. All transforms and
  selections are calibration-only, with deterministic tie-breaks.
- Evaluation uses v2's actual operational flag, separates planned routing from
  actual provider calls, rejects undefined gate metrics, counts errors over all
  500 cases, and reports full-span/union-character coverage. A static historical
  LLM grounding rate and caller-supplied pass booleans cannot authorize calls.
- Context comparisons require a freshly reconstructed supplement, rather than
  self-attested hashes. Incomplete prior turns are no longer silently skipped.

## Reproduce (new output names required)

```sh
node scripts/memory-extraction-router-calibrate-v31.mjs \
  --bundle /private/tmp/orgbrain-dedup-work/deduplicated-500.json \
  --runtime-cases artifacts/memory-extraction-evaluation/2026-09-04-multilabel-router-v2/runtime-evaluation-cases.jsonl \
  --output /private/tmp/orgbrain-router-v31-new-model.json

node scripts/memory-extraction-router-repair-shadow.mjs \
  --bundle /private/tmp/orgbrain-dedup-work/deduplicated-500.json \
  --runtime-cases artifacts/memory-extraction-evaluation/2026-09-04-multilabel-router-v2/runtime-evaluation-cases.jsonl \
  --model /private/tmp/orgbrain-router-v31-new-model.json \
  --output-dir artifacts/memory-extraction-evaluation/router-v31-new-run

pnpm run test:router-v3
pnpm run test:router-v31
```

Reproduction is not permission to select models using regression results.
The runner checks the original bundle hash, fixes source/model manifests before
predictions, and writes artifacts exclusively with mode 0600. Existing runs
cannot be overwritten. Context comparison was optional and not rerun here.

Post-run independent review added enforced per-row gold source/phase/cohort
binding, evidence-offset validation, and training-input hash verification. The
existing 500 rows were checked against these constraints without fitting or
predicting again. The evaluation's frozen source copy is intentionally retained;
the later validation-only correction is not represented as its original code.

## Recorded result — 2026-09-05

Artifact directory: `artifacts/memory-extraction-evaluation/2026-09-05-router-v31-repair-shadow`.
The calibration-only selection chose **correctness-only**, not the larger new
feature set. Model hash:
`sha256:6a871b6d65d183926d755738462fc6fd43a402b90ac9dda61e28f712a970ef04`.

| Semantic regression metric | Fixed v2 comparator | Selected v3.1 | Gate |
| --- | ---: | ---: | --- |
| Durable recall | 58.6% | 53.1% | FAIL, needs 95% |
| Operational F1 | 64.0% | 50.3% | FAIL, needs 75% |
| Routed turn rate | 51.8% | 43.0% | PASS, at most 50% |
| Any-overlap evidence coverage | 31.7% | 50.3% | PASS |
| Full gold-span recall | 14.9% | 40.2% | PASS |
| Gold character coverage | 20.8% | 46.3% | PASS |
| Packet exact source | 100% | 100% | PASS |

All 500 cases completed without an execution error. Actual provider calls: 0.
The earlier v3 report's operational F1 was 54.0%; the new candidate is worse on
that measure. Better evidence packing is **not** better classification or a
proof of successful LLM extraction.

The new frozen synthetic fixture excludes unsafe 80/80 and benign 0/80, but
its normalized cross-split duplicate audit fails. Consequently the safety gate
is **FAIL**, despite perfect detection counts. Preserve this failed fixture/run;
do not quietly relabel it, change its fixed hash, or claim independent safety
evidence. A separately frozen replacement fixture is needed before acceptance.
The one-sided boundary intervals are descriptive, not population guarantees.

## Remaining gates

Quality targets are not met; keep v2 default. Do not call Sol or apply generated
results. A verified provider token/no-store profile, a valid disjoint safety
fixture, and passing quality gates are required for the external stage. A new
human-only holdout and explicit authorization are required for production.
