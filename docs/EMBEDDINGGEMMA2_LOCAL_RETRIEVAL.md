# EmbeddingGemma 2 local retrieval

EmbeddingGemma 2 is available through the existing Ollama / `hybrid_v4`
retrieval path. It adds a dense channel to the existing lexical, sparse and
structural channels; it does not replace evidence validation or extraction.

## Model and input contract

- Provider setting: `embeddinggemma2-ollama`.
- Default model: `embeddinggemma-2:270m-bf16-text`, text-only BF16 weights.
- Default dimensions: 768; supported MRL widths: 128, 256, 512, 768.
- Query: `task: search result | query: {query}`.
- Document: `title: none | text: {content}`.
- Provider identity includes `:retrieval-v1` to distinguish this input format.
- Ollama must run on loopback HTTP. Configuring a missing/unavailable model
  returns an error; it does not claim sparse results are model embeddings.
- The existing 4,000-character content bound is retained. This evaluation does
  not test the model's full context window or other modalities.

Primary specifications: [Google input formatting](https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers)
and [Ollama model tags](https://ollama.com/library/embeddinggemma-2/tags).

## Enable for a specific database

The model is explicitly installed by the operator:

```sh
ollama pull embeddinggemma-2:270m-bf16-text
```

Place the following JSON beside the selected SQLite database, with the suffix
`.embedding.json`. For the normal local store the filename is
`~/.org-brain/memory.sqlite.embedding.json`.

```json
{
  "version": 1,
  "provider": "embeddinggemma2-ollama",
  "model": "embeddinggemma-2:270m-bf16-text",
  "dimensions": 768,
  "url": "http://127.0.0.1:11434",
  "timeout_ms": 120000
}
```

The setting applies only to that database, including CLI, hooks and MCP processes
using the updated runtime. Scratch databases do not inherit the live setting.
An explicit `ORGBRAIN_LOCAL_EMBEDDING_PROVIDER` environment value takes precedence;
`off` or `sparse` disables the dense provider. Existing Qwen defaults are retained.

Take a WAL-aware SQLite backup before rebuilding. Then use the updated CLI:

```sh
orgbrain index rebuild-dense --tenant-id default
orgbrain memory search "以前の解決策を探す" --tenant-id default --search-mode hybrid_v4
```

The rebuild updates derived vector projections, not memory originals. Sparse
features are stored separately and remain available. Disabling the provider does
not require restoring the whole database. Reverting the complete database would
discard any later writes and is not the normal rollback.

Already-running MCP processes retain their loaded code and require reconnection
after deployment. A new CLI or newly started MCP process reads the settings.
No model download or background service installation happens during search.

## Execution readback

CLI and MCP search metadata, and compact/full context metadata, expose:

- `dense_provider`, `dimensions`, `query_embedding_completed`;
- `dense_scored_unit_count` and `dense_candidate_count`.

A completed query embedding with zero scored units means the provider ran but
there was no matching dense index in that query scope. Compact context labels
that result as sparse retrieval. These fields attest only retrieval execution,
not whether a returned memory is relevant or used in a later action.

## Paired evaluation on 2026-10-17

The private evaluation used one SQLite backup with 114 total records, including
109 active records. The same 26 questions and known target IDs were frozen
before observing results: 22 positive questions (Japanese paraphrases, English
paraphrases and identifiers) plus four unrelated questions. The questions were
authored from stored summaries; they are not a sample of historical user queries.
The stored memories' factual correctness was not reverified.

Both arms used `hybrid_v4`, no project filter, top five, one fixed evaluation time,
and unchanged ranking weights and eligibility rules. The baseline ran before
dense projection replacement in the scratch DB. The memory ID/version/content
hash/lifecycle digest was checked unchanged afterwards. The original backup was
preserved. Retrieval judgments were not applied for this test run.

| Metric | Feature hash baseline | With EmbeddingGemma 2 |
| --- | ---: | ---: |
| Known target at rank 1 | 8/22 (36.4%) | 15/22 (68.2%) |
| Known target in top 5 | 12/22 (54.5%) | 21/22 (95.5%) |
| MRR at 5 | 0.4295 | 0.7856 |
| Unrelated question returned any candidate | 2/4 | 4/4 |
| Median search time, one warm run | 18.8 ms | 50.8 ms |

This is single-known-target Hit@5, not exhaustive relevance precision. Alternate
relevant results were not comprehensively labeled. The unrelated-question metric
measures search candidates, not completed answers or verified action misuse.
The existing dense scorer has no independent cosine cutoff. Better positive
recall does not establish correct abstention; unrelated results increased.
No threshold or ranking weight was fitted to these questions after observing them.
After fixing ACL counter visibility and rejecting mismatched vector widths, a
repeat used the original corpus, queries and evaluation timestamp. Retrieval
ranks and hit metrics were unchanged. The table contains the final run.

Model identity: `embeddinggemma-2:270m-bf16-text`, digest
`afeb999480b2a5e48b590fc0583f8cbc7d206b74156feaead3a7840b81719295`.
Ollama server version: `0.40.5`. All inference stayed on loopback.
The comparison observed 84 document batches / 1,329 indexed units and 26 query
embedding calls. Query-file SHA-256:
`2e39512ee9ef6d6f696659706b23920ad4e0808e55e1fcba927935fb506df7c1`.

Private per-question results and the frozen input are under
`~/.org-brain/evaluations/embeddinggemma2-20261017/`; memory text is not copied
into this repository. The pre-change backup is under
`~/.org-brain/backups/embeddinggemma2-20261017/`.

## Repeat on a new, separately frozen evaluation

Use a scratch copy, never the live DB. The tool rebuilds the supplied DB's dense
projection and writes a new report without overwriting an existing output.
Each query supplies `id`, `query`, and `expected_ids` (empty for unrelated input).

```sh
ORGBRAIN_LOCAL_EMBEDDING_PROVIDER=embeddinggemma2-ollama \
ORGBRAIN_JEV_SEARCH_MODE=off \
node scripts/local-retrieval-comparison.mjs \
  --db /private/evaluation/memory.sqlite \
  --queries /private/evaluation/questions.json \
  --output /private/evaluation/comparison.json
```

Adapter, configuration, execution-metadata and scoring checks:

```sh
node --test scripts/local-embeddinggemma2.test.mjs scripts/local-retrieval-comparison.test.mjs
```

## Qwen3 comparison with an independent relevance selector

A second evaluation used 64 newly authored questions, with 32 for calibration
and 32 held out. Each split contained 16 positive questions and 16 unrelated or
plausible-but-unsupported questions. The 32 known target memories were distinct
between splits and from the prior 26-question evaluation. This remains an
authored evaluation from stored memories, not historical session traffic.

Both embedding arms used separate copies of the same original 114-record backup,
`hybrid_v4`, no project filter, 20 candidates, five outputs and one fixed time.
Gemma used BF16 text weights and 768 dimensions; the installed
`qwen3-embedding:0.6b` used Q8_0 weights and 1,024 dimensions. This compares those
actual deployed configurations, not equal precision or equal dimensions.

The independent `Qwen/Qwen3-Reranker-0.6B` cross-encoder scored the union of the
two candidate sets once per question. A common cutoff of 0.9 was selected only
on calibration using the declared grid and zero-lost-target rule, then frozen
before opening holdout. No cutoff or ranking weight was changed after holdout.
See [selection contracts and procedure](LOCAL_RELEVANCE_SELECTION.md).

| Held-out metric | Gemma raw | Gemma selected | Qwen raw | Qwen selected |
| --- | ---: | ---: | ---: | ---: |
| Known target at rank 1 | 13/16 | 16/16 | 12/16 | 16/16 |
| Known target in top 5 | 16/16 | 16/16 | 16/16 | 16/16 |
| MRR at 5 | 0.90625 | 1.0 | 0.86458 | 1.0 |
| Unrelated question returned any result | 14/16 | 0/16 | 14/16 | 0/16 |

No raw top-five target was lost on either split for either embedding. Calibration
selected all 16 positives and returned candidates for one of 16 negative
questions in each arm. Held-out selection quality was equal between embeddings;
the one-question raw Hit@1 difference does not establish general superiority.
The current local embedding setting remains Gemma, with shared relevance
selection enabled. Exhaustive precision, actual task success and improvement on
historical sessions remain unmeasured.

The broader candidate-union rerank took a median 5.33 seconds and maximum 33.10
seconds in holdout. These are union-scoring measurements, not serving latency.
A fresh MCP process using the installed runtime and a project/work-type scope
selected one positive result in 0.68 seconds, rejected two negative candidates
in 0.22 seconds, and produced compact positive context in 0.46 seconds within
1,231 of 2,500 estimated tokens. These three calls are smoke checks, not a
latency benchmark. A local CLI check also verified explicit empty results when
the verifier endpoint was unavailable.

Incomplete calibration runs caused by an interrupted/stopped child service were
preserved and excluded. The unchanged calibration/policy was rerun at a new
fixed time after launching the service independently with launchd. Derived
indexes were reused only after validating provider, dimensions, unit coverage,
absence of orphan rows, non-NULL blobs and exact Float32 byte widths. Both
indexes contained 1,329 valid units. Holdout ran once after the successful freeze.

Private questions, per-query predictions and operational readbacks are under
`~/.org-brain/evaluations/relevance-selection-20261017/`. Only aggregate results
are copied into `artifacts/embeddinggemma2-evaluation-20261017/`.
