# Local relevance selection

Local memory search defaults to `working-llm`: the LLM already doing the task
selects relevant memories. OrgBrain does not start another generation model or
reranker in this mode. EmbeddingGemma remains the candidate-search provider when
configured; embedding and relevance selection are separate operations.

The default response contains `candidates`, with `results: []` and
`pending_host_selection`. Each preview preserves its complete summary, rationale
and reuse conditions, and includes a version-pinned `orgbrain_memory_get`
reference. A missing summary falls back to content. A preview explicitly says
when the full body was omitted. Before applying **every** selected candidate,
fetch that full version with the same principal and task scope, and check its
sources, conditions and current facts. An unavailable or changed version requires
abstention. Returning a preview or fetching details does not record actual use.

`Qwen/Qwen3-Reranker-0.6B` is an explicit optional cross-encoder add-on. It is
independent of Qwen3-Embedding and EmbeddingGemma. The npm distribution does not
include Python, MLX or model weights, and does not install or start that service.
The current local installation has disabled and unloaded its Qwen LaunchAgent;
the preserved files are optional rollback/add-on material. See
[the working-LLM contract, measurements and activation](WORKING_LLM_CANDIDATE_SELECTION.md).

## Retrieval contract

CLI search, MCP `memory_search`, and compact/full memory context use the same
selection mode. Raw `LocalMemoryStore.search()` remains available to evaluation
code. Working-LLM search defaults to 20 previews and honors an explicit result
limit. Context omits whole previews to honor its complete response budget; it
does not cut a reuse condition. Source records remain unchanged.

The automatic Codex hook keeps its existing two-entry and 7,168-byte limits.
Ordinary memory entries use pending previews; protected commitments and complete
execution lessons keep their existing safety rules. The hook starts no LLM or
reranker. Its smaller candidate set is distinct from the 20-candidate comparison.

The following inference contract applies only to explicitly enabled Qwen.

Before inference, sources are reread and checked for project, category, work type,
ACL, active state, validity and expiry. Sources are reread after inference; a
changed source is omitted. Unknown/duplicate/missing scores, revision or instruction
changes, HTTP errors and timeouts produce no selected memories and an explicit
`local_relevance_unavailable` status. An unavailable selector does not return the
unfiltered candidate set. Empty eligible input needs no inference.

Search/full context metadata includes model, revision, scoring version, instruction
hash, cutoff and counters. Compact context may shorten nonessential selector
metadata to preserve its valid minimum 512-token envelope. The status and failure
reason remain visible. Existing evidence verification and abstention rules still
apply after relevance selection.

## Local service

The implementation follows the [official Qwen reranker example](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B).
The pinned model revision for this evaluation is
`e61197ed45024b0ed8a2d74b80b4d909f1255473`. Scoring is
`sigmoid(yes_logit - no_logit)`, using the model's yes/no label tokens. This score
is not a calibrated probability of relevance.

The service in `scripts/local-reranker-service.py` uses MLX on Apple Silicon.
The current tested environment is Python 3.15.0, `mlx==0.32.4`, `mlx-lm==0.32.2`, and
`transformers==5.20.1`. Install model files explicitly from the pinned official
repository before starting it. Neither search nor service startup downloads them.
A private manifest contains `model`, `revision`, and the local snapshot `path`.

```sh
HF_HUB_OFFLINE=1 /path/to/venv/bin/python scripts/local-reranker-service.py \
  --manifest /private/path/reranker-model.json --port 11435
```

For an optional persistent macOS installation, run the prepared service with launchd rather
than tying it to an evaluation shell. The installation keeps its private
manifest and service copy in `~/.org-brain/runtimes/local-reranker-on-demand-20261018/` and
can register `com.orgbrain.local-reranker` with `RunAtLoad` and `KeepAlive`.
The login plist is `~/Library/LaunchAgents/com.orgbrain.local-reranker.plist`.
Check `GET /health` after startup; plist validation alone does not prove inference.
To stop this installation, disable selection first and then boot out the service.
Changing or deleting the embedding index is unnecessary.

The broker uses only the Python standard library. Each accepted request starts
one fresh Python worker, which loads the pinned model, scores the request and
exits before the broker returns the response. No model or MLX cache is retained
between requests. A small HTTP broker remains available through launchd.
A second concurrent request receives 503; it cannot load another model copy.
The worker timeout defaults to 29 seconds, within the current client's 30-second
budget; failures still abstain. Timeout and broker shutdown kill and reap the
worker. A worker also watches its expected parent PID and exits if that parent
vanishes. `/health` reports broker availability and `worker_active`; it is not a
model-load or inference test.

The server binds only `127.0.0.1`. `GET /health` reports model identity;
`POST /rerank` accepts at most 50 uniquely identified documents and 256 KB.
Query/document character bounds and a 4,096-token pair budget limit inference.
Template control tokens in input data are escaped. The server logs no request
content, and the client rejects redirects and non-loopback endpoints.

## Resident-memory measurement on 2026-10-18

The running service was measured without restarting, loading another model,
executing a forward pass or clearing caches. The existing model had already
been loaded and used. MLX 0.32.4 reported the following stable idle allocations:

| Component | Bytes | GiB |
| --- | ---: | ---: |
| Unique model parameter buffers | 1,191,559,168 | 1.109726 |
| Other active MLX buffers | 8 | less than 0.000001 |
| Reusable MLX cache | 4,872,645,808 | 4.538005 |
| Total MLX active plus cache | 6,064,204,984 | 5.647731 |
| OS physical footprint, separate accounting | 6,251,185,832 | 5.821870 |

The 310 model parameter arrays were BF16 and contained 1,191,553,024 logical
bytes. Unique backing-buffer measurement includes allocator padding and avoids
double-counting shared buffers. Cache accounted for 80.35% of MLX allocations.
The OS/MLX difference is only an arithmetic residual; it was not classified as
Python, driver, shared or compressed memory.

Use `get_active_memory()` and `get_cache_memory()` in the same process that owns
the model. Use `get_array_buffer_size(existing_model.parameters())` for unique,
already-evaluated parameter buffers. A different Python process reports its own
allocator, not the running service. Model file size and the process RSS alone
do not provide this breakdown. These APIs are documented by
[MLX memory management](https://ml-explore.github.io/mlx/build/html/python/memory_management.html).

This investigation used short debugger attachments to the idle dedicated service,
invoked the public counter getters and read the existing model's parameter tree
under the CPython GIL. Those calls execute code in the target; they are not passive
OS reads. No tensor contents or private query text were read. Before/after MLX
counters were identical, a repeated measurement matched, and detach and service
health were checked. Python inspection can have small CPU-allocation effects.
Debugger permissions and allocator/GIL lock safety must be considered before
reusing this technique. No cache-release outcome was measured.

The sanitized original measurement is
`artifacts/embeddinggemma2-evaluation-20261017/reranker-memory-20261018.json`.

## On-demand benchmark on 2026-10-18

Identical requests were scored three times in the old resident Python 3.12.13
service and the new per-request Python 3.15.0 service. Library versions, model
weights, prompt, batch size, 4,096-token budget and 0.9 deployment cutoff stayed
unchanged. Times include HTTP, worker startup, imports, model load, scoring and
worker exit. OS file caches were not purged; these are cold processes with cached
files, not cold-disk measurements.

| Request | Resident median | On-demand median | On-demand maximum |
| --- | ---: | ---: | ---: |
| Short synthetic, 1 candidate | 0.017 s | 1.297 s | 2.097 s |
| Short synthetic, 5 candidates | 0.049 s | 1.366 s | 1.520 s |
| Short synthetic, 20 candidates | 0.157 s | 1.514 s | 1.579 s |
| Long synthetic, 20 candidates | 1.201 s | 2.933 s | 2.966 s |
| Frozen real corpus, 17 candidates | 1.046 s | 2.660 s | 3.395 s |

The real-corpus query came from the earlier authored calibration set; it was
not a historical user-session replay. Each request's scores and 0.9 cutoff
choices matched exactly across both runtimes. This verifies parity on these
inputs, not a new accuracy improvement. The first worker run in the newly
installed environment took 5.42 seconds, separately from the repeated HTTP table.
Every measured synthetic response arrived after its worker PID had exited.
After installing the final broker under the normal launchd Background service,
the same real 17-candidate request took 5.140 seconds on its first call and
4.189 / 4.454 / 4.572 seconds on three subsequent calls (median 4.454 seconds).
Use those deployed figures for expected interactive latency; the earlier table
came from a separate evaluation service. Every final-service worker exited before
its response, and the old resident PID exited. Idle broker physical footprint
was 16,908,696 bytes (16.9 MB); no model process remained. The old resident service
had grown to 8,110,245,928 bytes after the speed benchmark, including reusable
caches. This old post-load figure is separate from the earlier restart's 1.37 GiB.
The operating system may still cache model files; worker exit releases its own
model/GPU allocations rather than purging the whole machine's file cache.
Single-request interactive use is practical within the existing 30-second
client budget on this machine. High request concurrency is not qualified: only
one worker runs, and concurrent requests explicitly abstain through HTTP 503.

A fresh MCP process using the deployed runtime completed positive search in
3.985 seconds (one candidate, one selected) and unrelated search in 3.883 seconds
(one candidate, none selected). Compact context had no eligible candidates and
completed in 0.275 seconds without a worker; this does not validate a nonempty
context-inference path. All returned an explicit complete selector status.
Eleven Python lifecycle/HTTP tests and nine Node selector tests passed, and
independent read-only review passed, including a non-model parent-death fixture.

The safe aggregate is
`artifacts/embeddinggemma2-evaluation-20261017/reranker-on-demand-20261018.json`.
Keep raw real-corpus requests and results under the private evaluation directory.
Rollback uses the previous plist kept at
`~/.org-brain/backups/reranker-on-demand-20261018/com.orgbrain.local-reranker.plist`
and the preserved `local-reranker-20261017` runtime. Reinstall that plist, boot
out/bootstrap the existing launchd label, and verify `/health` and inference.

## Per-database configuration

Put the following beside the intended SQLite database as `.retrieval.json`.
For the normal store this is `~/.org-brain/memory.sqlite.retrieval.json`.
Set `minimum_score` to the frozen calibration result, rather than assuming the
example cutoff is suitable for a new corpus.

```json
{
  "version": 1,
  "provider": "qwen3-reranker-mlx",
  "url": "http://127.0.0.1:11435",
  "revision": "e61197ed45024b0ed8a2d74b80b4d909f1255473",
  "minimum_score": 0.5,
  "candidate_limit": 20,
  "timeout_ms": 30000
}
```

No file means `working-llm`. To select it explicitly, use
`{"version":1,"provider":"working-llm"}` or
`ORGBRAIN_LOCAL_RELEVANCE_PROVIDER=working-llm`.
The Qwen example above is an opt-in and requires a separately installed local
service and model. An explicit `ORGBRAIN_LOCAL_RELEVANCE_PROVIDER=off` preserves
the legacy full-record raw response, even when the file is present; it is not
working-LLM selection. Other `ORGBRAIN_LOCAL_RELEVANCE_*` fields override the
corresponding Qwen settings. Scratch databases do not inherit live sidecars.
Changing the selector changes derived retrieval behavior only and needs no
database restore.
New CLI/MCP processes read these settings; already-running MCP needs reconnection
after a runtime update.

## Paired evaluation procedure

Use two scratch copies of the same WAL-aware backup. Freeze an input policy and
independently authored calibration/holdout question sets before predictions.
Each query has `id`, `query`, and known `expected_ids` (empty for unrelated input).
Keep question text and memory IDs in a private evaluation directory.

`scripts/local-relevance-comparison.mjs` compares the two embedding providers
using `hybrid_v4`, the same corpus, fixed timestamp, top 20 candidates and top 5
outputs. For each question it scores the union of the two candidate sets once,
then applies the same scores and cutoff to each arm. This avoids scoring an
identical query/document pair differently between arms.

The declared calibration rule preserves every known target already found in raw
top 5 for either embedding, minimizes mean unrelated-question any-result rate,
then maximizes mean positive Hit@5; ties choose the lower cutoff. If no grid point
qualifies, report failure rather than tuning on holdout. The holdout file is not
opened until a qualified common cutoff is frozen, and the cutoff is not adjusted
after holdout. A later rerun needs a new evaluation directory.

```sh
node --no-warnings scripts/local-relevance-comparison.mjs \
  --directory /private/evaluation --phase calibration
node --no-warnings scripts/local-relevance-comparison.mjs \
  --directory /private/evaluation --phase holdout
```

Report raw and selected Hit@1, Hit@5, MRR@5, lost known targets and unrelated
any-result counts. Known-target labels do not establish exhaustive precision.
Authored questions do not establish improvement on historical sessions or whole
tasks. Different deployed model precisions must be disclosed. Search timing
excludes reranking, and union-scoring time is not serving latency.

Behavior checks:

```sh
node --test scripts/local-relevance-selection.test.mjs scripts/local-relevance-comparison.test.mjs
python3 -m unittest scripts/test_local_reranker_service.py
```
