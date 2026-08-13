# Local Qwen embeddings

Org Brain can use `qwen3-embedding:0.6b` through a loopback-only Ollama
process for local `hybrid_v4` retrieval. Sparse feature hashes remain the
offline fallback and are never labelled as Qwen vectors.

## Installed runtime

- Ollama: Homebrew formula
- Model: `qwen3-embedding:0.6b`
- Vector format: 1024-dimensional little-endian Float32 (`dense-f32`)
- Document projection: v4 retrieval units
- Dense search unit: `segment` (conclusion, rationale, reuse rule, outcome)

Do not run Ollama as a login service for the regression suite. The test runner
allocates an unused loopback port, starts `ollama serve`, checks or downloads
the model, runs the tests, and terminates the process in `finally`.

```sh
pnpm run test:local-qwen
```

After the first successful download, the runner uses the installed model and
does not contact the model registry when the tag is already present.

## Local CLI usage

Start Ollama only for the period in which interactive local semantic retrieval
is required:

```sh
OLLAMA_NO_CLOUD=1 ollama serve
```

In another shell, configure the provider, project stored v4 units, and use the
dense-enabled search mode:

```sh
export ORGBRAIN_LOCAL_EMBEDDING_PROVIDER=qwen-ollama
export ORGBRAIN_LOCAL_EMBEDDING_URL=http://127.0.0.1:11434
export ORGBRAIN_LOCAL_EMBEDDING_MODEL=qwen3-embedding:0.6b
export ORGBRAIN_LOCAL_EMBEDDING_DIMENSIONS=1024

pnpm local:memory index rebuild-dense --tenant-id default --project-id org-brain
pnpm local:memory memory search "<query>" --tenant-id default --project-id org-brain --search-mode hybrid_v4
```

The provider rejects non-loopback endpoints, non-finite values, and vectors
whose dimensions differ from the configured index width. A configured but
unavailable provider returns an explicit provider error instead of silently
claiming that sparse features are Qwen embeddings.

## Regression corpus

`packages/shared/test/fixtures/local-qwen-session-regression-v1.json` contains
12 synthetic, credential-free sessions covering successes, decisions, and
failures. Each session has two next-task questions whose wording differs from
the captured learning tuple.

The integration test creates a private temporary SQLite database, captures the
12 learning memories, projects 74 v4 retrieval units, checks every stored blob
is 4096 bytes (1024 Float32 values), and compares Qwen with the unchanged sparse
fallback over 24 questions.

Current Apple M5 Pro result:

| Retrieval | Recall@5 | MRR |
| --- | ---: | ---: |
| Sparse fallback | 91.67% | 57.78% |
| Qwen dense | 100% | 95.83% |

The vectors are intentionally not compared byte-for-byte with Cloudflare
Workers AI. Runtime and quantization differences can change numeric values;
retrieval metrics and top-k behavior are the compatibility contract.
