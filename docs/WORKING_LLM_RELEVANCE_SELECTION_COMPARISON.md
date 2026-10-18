# Working LLM versus a dedicated relevance selector

This experiment compares the current local Qwen3 reranker with selection by the
same model and reasoning effort as the working Codex conversation. It does not
change production retrieval settings or add a runtime dependency to OrgBrain.

## Frozen comparison

The existing holdout has 32 authored questions: 16 positives with one known target
and 16 unrelated negatives. These were written from frozen memory summaries,
not sampled from historical user sessions. The earlier Qwen evaluation already
used this holdout; the working-LLM prompt is fixed before its first predictions,
with no tuning against those labels. These labels cannot establish exhaustive
precision or whole-task success.

Use the frozen Gemma candidate arm, at most 20 candidates per question, from the
same 114-memory snapshot. Reconstruct each document using nonempty summary,
rationale, reuse_rule and content joined with newlines and JavaScript's first
4,000 UTF-16 code units. Restrict source reads to tenant `default`. Candidate IDs
become D001, D002, etc.; original IDs and expected answers are not model input.

The three arms are:

1. Qwen3-Reranker-0.6B alone, using the previously frozen 0.9 cutoff and top 5.
2. The working LLM selecting directly from all frozen raw candidates.
3. The same working LLM selecting from the candidates already kept by Qwen.

The working LLM is `gpt-6.1-sol` with reasoning effort `high`, matching the current
parent turn's runtime metadata rather than the machine's default Codex model.
Each LLM arm uses the same fixed relevance prompt, strict selected_ids JSON,
one fresh ephemeral Codex CLI invocation per question, and the same isolated
CLI state directory. Hooks, memories, apps, plugins and execution tools are off.
The scratch working directory has no project instructions. Existing Codex
sign-in is reused without logging credential values.

Each pair uses one LLM call in each LLM arm, including empty candidate sets, to
keep call counts comparable. Questions are shuffled with seed 20261018, and the
first LLM arm alternates between pairs. Runs are sequential. Qwen still skips
inference for the two empty raw-candidate cases. Qwen identity, candidate IDs and
score bounds are validated; LLM output rejects unknown, duplicate or excessive
IDs. A failed Qwen stage counts as a failed cascade even if its downstream LLM
returns an empty list successfully.

## Timing and usage interpretation

Qwen time includes HTTP, a fresh Python process, model loading, scoring and exit.
LLM time includes fresh CLI startup and one inference. Cascade time is Qwen plus
its downstream LLM. This is selection handoff latency, not measured marginal
latency inside a running main turn, or time to complete the original user task.
Both LLM arms share the same CLI/system overhead, but provider queueing and
prompt caching can still vary. One pass does not establish latency stability.

Keep provider input, cache-read input, cache-write input, output and reasoning
usage separately when available. Cache input is a subset of input; reasoning
output is a subset of output. Missing usage and provider-internal retries remain
unknown. No actual subscription charge or monetary saving is inferred.
Public transport/schema probes are recorded separately from holdout metrics,
and the initial CLI startup failure remains in the task tool output (its probe
files were replaced by an explicit successful retry). A start-once receipt and
existing-artifact checks reject restarts that would overwrite prior attempts.

## Reproduction and evidence

`scripts/working-llm-selection-evaluation.py` implements read-only reconstruction,
output validation and matching known-target metrics. Its synthetic tests cover
labels outside the payload, UTF-16 truncation, tenant isolation, missing targets,
invalid output IDs, ranking and negative-query rejection.

```sh
python3 -m unittest scripts.test_working_llm_selection_evaluation
```

Raw prompts, predictions, usage events and the frozen execution script are kept
in the private `~/.org-brain/evaluations/working-llm-selection-20261018/` directory.
Do not publish memory text, question text, raw IDs or authentication files with
the safe aggregate. A changed model, prompt or candidate policy needs a new
experiment directory and an explicit fresh evaluation plan; do not tune on this
holdout. The production selector remains configured independently through the
per-database `.retrieval.json` sidecar.

## Results on 2026-10-18

All 32 paired cases completed: 30 Qwen requests (two empty cases skipped) and
64 LLM requests. No HTTP, CLI, validation or cascade failures occurred. The six
helper tests passed; independent preflight review passed and the start guard
was observed refusing an attempted restart before further inference.

| Metric | Qwen alone | Working LLM on raw candidates | Qwen then working LLM |
| --- | ---: | ---: | ---: |
| Known target ranked first | 16/16 | 15/16 | 15/16 |
| Known target in top five | 16/16 | 16/16 | 16/16 |
| MRR@5 | 1.00000 | 0.96875 | 0.96875 |
| Unrelated questions returning anything | 0/16 | 0/16 | 0/16 |
| Lost retrieved known targets | 0 | 0 | 0 |
| Mean selected count, all questions | 1.25000 | 0.78125 | 0.75000 |
| Wall time median | 8.631 s | 5.455 s | 13.952 s |
| Wall time mean | 8.155 s | 7.513 s | 13.629 s |
| Wall time p95, linear interpolation | 11.721 s | 7.151 s | 16.816 s |
| Wall time maximum | 12.786 s | 66.403 s | 17.896 s |

The direct-LLM arm was faster than Qwen alone on 26 of 32 cases and faster
than the cascade on 30 of 32 paired cases. The
median paired cascade-minus-direct difference was 8.314 seconds (mean 6.116).
A 66.403-second direct-LLM outlier is retained; its stderr reported no error.
The recorded wall time cannot separate provider queueing, transport retries,
CLI startup and inference. The direct method is not guaranteed faster for every
case. This experiment did not measure a warm Qwen worker retained for ten minutes.

| Provider-recorded mean usage per LLM call | Raw candidates | Qwen-filtered candidates |
| --- | ---: | ---: |
| Input tokens, including common Codex overhead | 24,422.8125 | 12,935.125 |
| Cached input, subset of input | 4,716 | 3,580 |
| Cache-write input, subset of input | 0 | 0 |
| Output tokens | 45.4375 | 32.28125 |
| Reasoning output, subset of output | 26.21875 | 13.84375 |

Direct selection used 1.888 times the total LLM input, or 11,487.6875 additional
input tokens on average. All fields above were reported for all 32 calls per
arm. These are token counts, not actual charges or Codex-credit savings.

The principal retention and unrelated-query rejection metrics matched, but Qwen
alone placed the known target first on one additional question. Different counts
of other selected memories do not establish a precision improvement: positive
questions do not have exhaustive relevance labels. Nine cases differed in order
or selected extras and were retained for read-only review. No gold labels or
prompt were changed after predictions.

The direct LLM received the full candidate text (median 29,967.0 characters,
maximum 46,422). Final compact-context packing and downstream user-task execution
were not evaluated. This is evidence that the tested working model can perform
selection without a dedicated local reranker, not proof that every smaller model
or every existing context budget can preserve the same result.

For a lightweight installation, working-LLM selection is a promising optional
path; Qwen can remain an explicit extension where reducing candidate input or
using a separate local judge matters. Production remains on its existing Qwen
configuration. Do not silently turn a failed enabled verifier into unfiltered
retrieval; a change in selection mode needs an explicit, reviewable configuration.

The safe aggregate is
`artifacts/embeddinggemma2-evaluation-20261017/working-llm-selection-comparison-20261018.json`.

Independent final read-only review passed. It recomputed all hashes, metrics,
latency, failure counts and the 64 event usage records. The single first-rank
difference put another directly relevant record before the known target, which
remained second. Keep the fixed Hit@1 difference; it is not by itself proof of a
substantive selection error. Extra selections include complementary records and
adjacent dates/attempts, so a smaller result count is not a measured precision gain.
