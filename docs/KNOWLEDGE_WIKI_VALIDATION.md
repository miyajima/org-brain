# Knowledge Wiki Validation

Measured 2026-09-29 on macOS arm64, Apple M5 Pro. These are local development
results, not a cross-platform release certification or a production migration.

## Behavioral Checks

- Rust: source byte/SHA retention (including CRLF), source/extraction versions,
  citation bounds/types, atomic rejection, stable IDs/aliases/relative links,
  revision/draft conflicts, partial-read cursors, Japanese/English/short queries,
  incremental chunk/embedding reuse, traversal/symlink rejection, corruption
  diagnostics, explicit read-only Vault migration, portable export, backup/restore.
  A killed temporary native transaction also retains only the prior committed state.
  Direct configuration changes while a write waits on SQLite are checked again
  before commit and roll back rather than publishing a disabled update.
- Node/CLI/MCP: missing feature configuration is OFF with no engine/DB creation;
  unrelated/external settings, skills and hooks retained; memory remains usable;
  OFF/ON cancels suspended embedding commits; bounded output; concurrent updates
  have one winner; actual MCP connections hide tools and return feature_disabled;
  project memory context also retrieves independent personal Wiki evidence.
- HTTP/UI: Host/Origin/CSRF guards, browser filesystem-operation restrictions,
  feature switch persistence; Chrome desktop 1440x1000 and mobile 390x844
  creation, editing, search, sources, diff/history, cross-tab OFF redirects and no horizontal
  overflow. Source upload uses exact bytes. UI has no generation chat.
- Readable titles: Markdown parsing ignores fenced false headings, retains explicit
  titles and derives legacy labels without changing body/state hashes or history.
  A 40-page browser fixture checks ellipsis, selection near the bottom, independent
  document scrolling and viewport containment on desktop 1440x900, tablet 900x700
  and mobile 390x844, including evidence/page drawers and Escape dismissal.
- Source review: latest uncited-source names/versions and stale-citation version
  pairs are exposed without modifying originals. Browser checks verify source
  and review labels, grouped link/orphan/uncited findings, readable targets,
  context-specific review reasons, mobile containment and read-only inspection.
- Packaging: native macOS arm64 build, static UI and Skill; copied bundle works
  outside the repository without node_modules. Existing OrgBrain memory, local
  MCP protocol and context-hook regression checks also pass.

Commands:

```sh
cargo fmt --manifest-path packages/wiki-engine/Cargo.toml --check
cargo clippy --manifest-path packages/wiki-engine/Cargo.toml --all-targets -- -D warnings
pnpm test:wiki
pnpm --filter @org-brain/console typecheck:wiki
pnpm build:wiki
pnpm build:standalone
node --test scripts/wiki-release.test.mjs scripts/wiki-ui.test.mjs
node --test scripts/local-memory.test.mjs scripts/local-mcp-protocol.test.mjs scripts/codex-memory-context.test.mjs
```

## Search Measurements

`cargo run --release --manifest-path packages/wiki-engine/Cargo.toml --example
benchmark` seeds temporary Wikis with 100 headings per page. Each query has 21
warm service calls; table values are median milliseconds. Timing includes SQLite
connection and feature guard, excludes Node/process startup and all LLM/network
embedding calls. Many repeated terms match the full corpus, intentionally exposing
ranking cost. Cold-cache behavior and large real-model hybrid search are not measured.

| Operation | 1,000 Chunks | 10,000 Chunks | 100,000 Chunks |
|---|---:|---:|---:|
| Japanese trigram, 日本語検索 | 1.16 | 6.00 | 60.73 |
| Japanese two-character, 検索 | 0.75 | 3.56 | 34.00 |
| One-character, 語 | 0.74 | 3.56 | 34.33 |
| English common term, knowledge | 1.33 | 8.47 | 79.35 |
| Selective literal, marker_0_1 | 0.45 | 0.67 | 0.55 |
| No literal match | 0.36 | 0.39 | 0.38 |
| Change all 100 headings in one page | 16.71 | 23.98 | 22.16 |
| Unchanged page update | 1.32 | 2.01 | 1.50 |
| Seed time, seconds | 0.13 | 1.81 | 26.50 |
| SQLite bytes | 4,980,736 | 50,429,952 | 541,126,656 |

Before adding `short_grams_chunk`, the same changed-page operation took
250.30 / 2,445.27 / 26,541.77 ms. Foreign-key cascades lacked a chunk-side index;
the index removes that global deletion scan. This is a measured implementation
fix, not a claim that all search costs stay constant as knowledge grows.
Trigram ranking still grows with the number of matched chunks. Vector ranking is
exact cosine distance using sqlite-vec and grows with indexed vectors/dimensions.

## Small Real-Model Evaluation

`WIKI_LIVE_OLLAMA=1 node scripts/wiki-search-evaluate.mjs` used the already
installed `qwen3-embedding:0.6b`, digest
`ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d`,
1024 dimensions, local Ollama. No model was downloaded. Four source-backed fixture
pages yielded correct first hits for Japanese/English/short/literal queries,
literal no-match, English evidence-preservation paraphrase and Japanese edit-undo
paraphrase: 7/7 fixed checks. The second embedding pass indexed zero chunks.
This small fixed fixture is not a general retrieval-quality benchmark.

## Remaining Validation

Linux/Windows native packaging, real large-Vault migration, adversarial load,
large real-model hybrid latency/quality, cold-cache measurements and a broad
accessibility audit have not been completed. The real user Vault/configuration
was not changed during these fixture checks. A later explicitly authorized import
copied 40 pages and 288 originals into the personal Wiki and enabled its feature,
without changing the source Vault or existing hook/settings files. The title/layout
change retained all imported page rows, revisions and original bytes against the
post-import backup. Its live UI shows all 40 readable titles within one viewport.
Hook installation remains an explicit client-selected operation; no background agent runs inside
the Wiki. PDF/Web extraction and semantic citation judging are excluded by scope.
