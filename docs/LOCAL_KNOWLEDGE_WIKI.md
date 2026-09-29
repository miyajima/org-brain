# Local Knowledge Wiki

OrgBrain's optional personal Knowledge Wiki is independent of its memory/task
database. Initial state is **OFF**, including upgrades without this setting.
Obsidian, cloud sync, Postgres and an internal generation chat are not required.
Existing agents perform synthesis. No model is automatically downloaded.

## Build And Run

```sh
pnpm build:wiki
pnpm build:standalone
node dist/orgbrain.mjs feature llm-wiki status
node dist/orgbrain.mjs feature llm-wiki enable
node dist/orgbrain.mjs wiki init
node dist/orgbrain.mjs serve --host 127.0.0.1 --port 8788
```

Open `http://127.0.0.1:8788/settings` or `/wiki`. UI: static Astro + TypeScript +
Tailwind, CodeMirror Markdown editor, Lucide icons, sanitized Markdown preview.
Rust owns storage, validation, indexing, links and transactions for UI/CLI/MCP.
Build distributes the native executable and bundled SQLite/sqlite-vec for the
current OS/CPU alongside the CLI and static assets. Build on each target platform
before distributing that platform's package; this is not a universal binary.
Node >=22.13, pnpm and Rust are build prerequisites, not runtime Rust compilers.

Private defaults: `~/.org-brain/features.json`,
`~/.org-brain/wiki/personal/knowledge.sqlite`, `objects/<SHA-256>` originals.
The server's Wiki root follows its memory DB directory unless overridden.
`ORGBRAIN_FEATURES_FILE`, `ORGBRAIN_WIKI_ROOT`, `ORGBRAIN_WIKI_ENGINE` select
explicit alternate installations. They do not discover or modify a legacy Vault.

## Feature Boundary

`features.llm_wiki.enabled=false` suppresses Wiki tools/screens and stops all
Wiki read/search/write/maintenance operations. Disabled requests return
`feature_disabled`, not an empty result. Missing Wiki/native assets are harmless
to ordinary OrgBrain functions while OFF. No Wiki DB, source read, index or
embedding call occurs from a disabled request. Data is retained across switches.

The shared feature lock serializes native operations and configuration commits.
Disabling waits for an already committing operation; after disable completes,
no such update can commit. Queued calls carry a generation epoch. Suspended
embedding work cannot commit or resume after OFF/ON. A stopped job must be
explicitly run again. A crash may leave `features.json.lock`; inspect active
processes and state before manually removing a genuinely stale lock.

`auto_maintenance` is a separate retained setting, initially false. The settings
screen controls it. `orgbrain wiki maintenance-context` accepts optional stdin
JSON `{ "mode": "Plan", "read_only": true }` and returns bounded guidance only
when both switches permit it. It never reads transcripts or starts the engine.
Already selected OrgBrain-managed Codex/Claude context hooks include this guidance
when both switches are ON. Cursor/custom adapters can explicitly use the standalone
command. This release does not install, disable, remove or rewrite other clients'
hook/settings files, and performs no maintenance itself inside a hook.
The Skill is `skills/org-brain-wiki/SKILL.md`. `orgbrain wiki install-skill
--target codex|claude|cursor [--home HOME]` previews the selected client only;
add `--execute` to install. It refuses different existing content and preserves
external `llm-wiki` skills and all hook/settings files. Architecture, comparison
and procedure topic guides are installed together and loaded only as needed.

`orgbrain_context_enrich` accepts `include_wiki=true`. Memory retrieval remains
active while OFF and adds `wiki.status=disabled`. ON evidence is labeled
separately and omitted when the remaining context budget is too small. Wiki
evidence searches the selected personal Wiki, independently of the memory
project filter. Explicit Wiki searches can still supply `project_id`.

## CLI Examples

```sh
orgbrain wiki ingest /absolute/source.txt --name source.txt
orgbrain wiki sources
orgbrain wiki put topics/example.md --input /absolute/draft.md
orgbrain wiki read topics/example.md --section Evidence
orgbrain wiki patch topics/example.md --section Evidence --input /absolute/section.md --if-match HASH
orgbrain wiki search 検索 --scope all --token-budget 4000
orgbrain wiki rename topics/example.md topics/new-name.md --if-match HASH
orgbrain wiki links topics/new-name.md
orgbrain wiki history topics/new-name.md
orgbrain wiki restore-revision --revision-id ID --if-match CURRENT_HASH
orgbrain wiki diagnose
orgbrain wiki backup --output /absolute/new-backup-directory
orgbrain wiki restore-backup --from /absolute/backup-directory
orgbrain wiki export --output /absolute/new-export-directory
orgbrain wiki migrate --from /absolute/selected-vault --dry-run
orgbrain wiki migrate --from /absolute/selected-vault
orgbrain feature llm-wiki disable
```

Updates, patches, rename, deletion, restoration and draft approval require the
hash returned by read. `hash` is an opaque state/revision concurrency token;
`content_hash` is the SHA-256 of the full body. Partial reads use `--char-offset`
and return `next_char_offset`. Lists use `--offset` and `next_offset`.
Page reads, lists, search and link results also expose `display_title`. Explicit
titles are retained; legacy path-only titles use the first Markdown H1 in the
first 8,192 characters, then the file stem as a fallback. This presentation field
does not rewrite stored titles, bodies, hashes or revisions. The UI uses compact,
single-line titles with ellipsis and full-title tooltips. Navigation, the document
and the evidence pane scroll independently within the viewport; narrow screens
use dismissible side drawers.
The sidebar distinguishes pages, sources and review findings. Review findings
are grouped by kind and show the affected source name or page title plus the
reason. `unpaged_source` means no page citation references that source ID; it is
not an ingestion failure or a semantic judgment that the source needs a new page.
Unused originals can remain archived. Opening a finding only reads its target;
it does not re-import, edit evidence or run synthesis. Source-related diagnostics
include names, original paths and versions; stale citations also identify the
latest source version.
Drafts: `wiki draft PATH --input FILE --if-match HASH`, `wiki draft-read
--draft-id ID`, then `wiki approve --draft-id ID --if-match CURRENT_HASH`.

Sources retain IDs, immutable versions and originals. Register external text
with `wiki extraction-put --source-id ID --version VERSION --if-match RAW_HASH
--extractor READER_VERSION --input FILE [--page-count N]`; this creates a new
source version with extraction hash. `#L1-L3` ranges address this version's
text, `#P2-P4` require verified page-count registration. Whole-source citations
do not invent a locator. Structural validity is not semantic proof.

## Search And Model Identity

Markdown headings are parsed, then bounded chunks are indexed with FTS5 trigram
and NFKC-normalized one/two-character postings. Japanese and English are supported.
Literal substring matching is retained; full-text mode currently shares these
literal semantics rather than using a Japanese morphological tokenizer.
Unchanged chunk IDs/postings and embeddings are reused; changed pages are
reparsed. Queries do not scan original files. RRF combines lexical/vector ranks.

Hybrid is explicit:

```sh
export ORGBRAIN_WIKI_EMBEDDING_PROVIDER=qwen-ollama
export ORGBRAIN_LOCAL_EMBEDDING_URL=http://127.0.0.1:11434
export ORGBRAIN_LOCAL_EMBEDDING_MODEL=qwen3-embedding:0.6b
export ORGBRAIN_LOCAL_EMBEDDING_DIMENSIONS=1024
orgbrain wiki reindex-embeddings
orgbrain wiki search 'related paraphrase' --mode hybrid
```

Use an already installed model compatible with the configured dimensions.
Ollama's reported model digest, dimensions and instruction revision identify the
embedding cache; an explicit immutable `ORGBRAIN_WIKI_EMBEDDING_REVISION` can
replace digest discovery. Digest changes during a batch abort it. Missing local
provider/index falls back to full text with a reason. sqlite-vec cosine distance
is exact linear vector ranking, not ANN; large hybrid corpora have growing cost.
No real-model paraphrase quality claim follows from synthetic-vector tests.

## Safety, Migration And Recovery

The Wiki HTTP surface is loopback-only even if other OrgBrain routes are opted
into remote binding. Host is validated; browser mutations require exact Origin
and a session CSRF token. Browser requests cannot select arbitrary filesystem
paths for ingest/migrate/export/backup. Selected file upload is capped at 8 MB;
larger originals use CLI. Markdown is sanitized; imported content is not code.

Migration verifies registered `.llm-wiki/sources/*.json` source SHA-256, exact
bytes and page content before/after import in a single transaction. Original
paths and legacy raw citations are retained; no unverified range is added.
Relative/shorthand links resolve only when unambiguous. The original Vault is
never renamed, deleted or edited; client/Skill/Hook cutover is not automatic.
Unregistered raw files are not silently treated as source evidence.

Markdown export rewrites resolved page/source links to relative exported paths;
IDs, aliases and source versions also have JSON sidecars. Unresolved links remain
visible. Backups use SQLite's consistent snapshot API plus hash-verified referenced
originals and a database-hash manifest. Restore validates the snapshot and originals
and replaces the selected Wiki transactionally. Back up before replacement;
feature settings are deliberately not restored or enabled from a backup.

Built-in PDF/Web extraction, semantic citation evaluation, cloud synchronization,
Postgres, multi-user authorization and large-corpus ANN are outside this release.
See `KNOWLEDGE_WIKI_VALIDATION.md` for measured checks and remaining validation.
