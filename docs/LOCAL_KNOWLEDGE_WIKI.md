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

### Troubleshoot `wiki_engine_unavailable`

Check the CLI path used by the failing MCP server, as well as the separate
`wiki_command` in `~/.config/org-brain/wiki-integration.json`. A working Wiki CLI
does not establish that the MCP installation contains its native engine.
For a packaged `dist/orgbrain.mjs`, the native executable belongs at
`bin/<platform>-<arch>/orgbrain-wiki-engine` under the same package root
(`orgbrain-wiki-engine.exe` on Windows). Preserve this directory when installing
or replacing a standalone runtime; copying only `dist/` is insufficient.

Restore the matching native package, or build with `pnpm build:wiki` and copy the
matching platform's executable into that installation with executable permissions.
Reuse an existing binary only after checking that it matches the intended build
and platform. `ORGBRAIN_WIKI_ENGINE` is an explicit override when a separate
engine installation is intended. Do not change the Wiki feature flag or data root
to repair a missing executable.

Verify search through the original failing MCP connection. Check init, put, read
and search with the exact installed CLI against an isolated Wiki and feature file;
resolve temporary paths to real paths on macOS to avoid `/var` symlink rejection.
Run `wiki diagnose` to distinguish engine recovery from existing corpus findings.

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
orgbrain wiki ingest-folder /absolute/docs --dry-run
orgbrain wiki ingest-folder /absolute/docs
orgbrain wiki catalog --limit 50
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

### Folder Import And Coverage Catalog

For individual sources, the upload control and `wiki ingest document.pdf`
extract selectable PDF text with local Poppler `pdftotext`.
`wiki ingest --url https://example.org/page` and the URL form accept public
HTTPS HTML or text, using a checked and pinned public IPv4 address with no
redirects. Imports are limited to 8 MB. The original bytes, extracted text,
extractor version, and PDF page count are stored together. Image-only,
encrypted or unreadable PDFs are reported as extraction failures. Folder
imports continue to use the text-only format list below.

`wiki ingest-folder` recursively imports `.md`, `.markdown`, `.txt` and `.text`
files containing UTF-8 text, preserving original bytes (including line endings).
It does not synthesize pages, activate memories, call a model or fetch URLs.
Wiki must already be enabled and initialized. `--dry-run` reads selected text
but writes no originals, source versions or catalog; it returns counts, skip
reasons and a bounded 20-entry preview.

Imports exclude hidden entries, symbolic links, generated directories
(`node_modules`, `target`, `dist`, `build`, `coverage`, `Library`, `Temp`, `obj`,
`__pycache__`) and the Wiki's own storage. Nested `.gitignore` and
`.orgbrainignore` rules are honored within the selected folder. Parent/global Git
ignore settings are not loaded. Ignored directories are recorded once without
reading their children. Invalid ignore rules fail the scan before writing.
Unsupported extensions, binary content, invalid UTF-8 and files over 1 MB are
recorded with explicit reasons. This folder scan does not extract PDF/DOCX or
index source-code syntax. The scan is capped at 10,000 entries and depth 64.

The native engine commits at most 50 entries / 8 MB of text per CLI batch, with
source versions and their catalog entries in the same transaction. File identity
depends on the canonical selected folder plus relative path; identical contents
in different files retain distinct source IDs while sharing original objects.
Rerunning skips unchanged originals and creates a new immutable version for
changed content, including changes back to a previous body. After interruption,
rerun the same command: committed files are reused; an interrupted batch is
rolled back. Scans changing between batches are refused with `folder_changed`;
rerun from the beginning. A confirmed dead native process may leave the existing
feature lock; inspect it before removing a stale lock as described above.

`wiki catalog [--folder-id ID] [--offset N] [--limit N]` reads persisted coverage
without rescanning files. Entries include format, last import status, skip reason,
source ID/version, latest source version and whether retained source text is
searchable. Summary groups count entries and bytes by folder/format/status;
directory skips count as one entry. The unfiltered summary is capped at 100
groups (`summary_truncated`); filter a folder for its full summary. Files missing
from a completed rescan are marked `missing`; previously imported originals
remain retained and searchable as evidence. Skipped replacements also retain
their earlier source reference. No source or citation is deleted automatically.

The read-only `orgbrain_wiki_catalog` MCP tool accepts `folder_id`, `offset`,
`limit` and `token_budget`; follow `next_offset`. If even one entry cannot fit,
`wiki_catalog_budget_exhausted` asks for a larger budget or a folder filter.
Catalog reads are also accepted by the local Wiki HTTP request endpoint.
Folder filesystem reads are CLI-only and are refused by browser/MCP surfaces.
Catalog metadata is included in backups and Markdown exports; older schema-1
backups with no catalog remain restorable. Reading an older Wiki does not
create a catalog table; its first folder import adds it transactionally.

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
reparsed. Search queries use the stored index; explicit source reads verify the
immutable original bytes. RRF combines lexical/vector ranks.

The default `match_mode=phrase` retains the existing literal-phrase behavior.

### Preserve reports before summarizing

`wiki capture PATH --input REPORT --summary-input SUMMARY` retains the selected
UTF-8 report unchanged and saves a page with its summary plus omitted source
lines. Number/identifier, decision/reason, condition, state and correction
signals select lines with adjacent context. The report is limited to 256 KB and
512 inventory lines; exceeding a limit fails explicitly rather than truncating
evidence. A second immutable source stores the inventory and optional `origin`
(`session_id`, `turn_id`, `recorded_at`). Both sources are cited by the page.
Existing pages require their read `expected_hash` / `--if-match`; database
changes to sources and page share one transaction. Original objects remain
content addressed, including if a failed write leaves an unreferenced object.

`capture_audit` / `wiki capture-audit` compare these selected source lines with
the summary. `missing_count=0` proves only mechanical retention of those lines;
`semantic_completeness_verified` remains false. Full originals are retained even
when a relevant statement has no rule signal. Claims stay `reported_unverified`:
storing a report does not attest that its described commands ran successfully.
This explicit operation neither changes Stop hooks nor activates memories or
starts a model. It is not automatic full-session capture.

### Retrieve originals before selecting sessions

`wiki recall 'TERM TERM'` / `orgbrain_wiki_recall` perform read-only lexical
retrieval over Wiki pages and all eligible stored originals, including uncited
ones. Up to eight terms are ranked by their rarity in the candidate set. The
reader pins source versions, reads at most 16 original candidates, selects up to
eight evidence passages by default, and caps their combined body at 12,000
characters. Explicit project/page/source/path/heading/ingestion-time filters are
kept across searches. Candidate limits still mean this is not exhaustive recall.

The default `context_mode=focused` returns original passages matching every query
term when available. It does not fill the remaining budget with partial matches
and Wiki copies. If no original matches all terms it retains the broader candidate
set. Use `context_mode=broad` / `--context-mode broad` when background or additional
partial matches are needed; a full term match does not prove answer completeness.

For historical questions use `targets` (CLI `--targets-json`) to distinguish event
time from the existing ingestion-time filters. Each target has an inclusive
`event_since` and exclusive `event_until` in RFC3339 with an explicit offset, an
`experiment_id`, or both. The conditions within one target are ANDed; up to eight
targets are ORed. An experiment ID matches an exact `artifacts/ID/` path segment
or explicit origin metadata, never an incidental topical word. Each time window
is at most31days. Date/ID discovery is bounded at64 unique search seeds and64
source candidates; truncation remains explicit. Project and other filters still
apply. Unknown event times do not inherit the source's ingestion timestamp.
Windows of five minutes or less prioritize exact UTC-minute index matches before
experiment-only and broader date matches, so same-day background cannot crowd
precise matches out of the bounded candidate set. Alternate stored offsets still
use adjacent-date discovery and the exact parsed-time check.

```sh
orgbrain wiki recall '差分 確認' --targets-json '[{"event_since":"2026-10-20T10:00:00+09:00","event_until":"2026-10-20T10:01:00+09:00","experiment_id":"run-a"}]'
```

Explicit targets never silently widen to another event or experiment. Inspect
`unmatched_targets`, per-target `target_coverage` and `truncated`; a match is not
verification of execution or proof of answer completeness. A partial match for
one target is not dropped just because another has a complete query-term match.
Missing targets may trigger the already explicit session fallback, subject to
the same target filters and workspace/file limits.

The default `excerpt_mode=passages` keeps matching blocks, complete matching
table blocks and adjacent qualifications within `passage_chars` (default1800,
128..4000). `context_lines` defaults to2. Each excerpt retains the pinned original
hash/version, event provenance and exact `excerpt_ranges` in original line
coordinates. Disjoint excerpts have an omission marker. Long lines or budgets
may still truncate evidence. Explicit `excerpt_mode=full` / `--excerpt-mode full`
allows the previous longer per-source context, up to4000characters. Read the
original again if qualifications or requested facts are missing.

Preservation inventories are provenance records, not answer passages. Recall
follows their exact original ID/version, verifies its declared hash, and returns
the original report text with the inventory ID and event provenance as metadata.
Raw-original/inventory copies are deduplicated; identical bytes reported at different
times retain each event's provenance. This changes returned context, not stored
originals. Use source_read with the returned pinned version for more context.

An optional `session_files` array (CLI `--session-file` or JSON
`--session-files`) selects at most 16 local Codex JSONL files. `workspace` must
match their metadata exactly. Each file is at most 16 MB, 64 MB in total.
Only user messages and assistant final messages are read as candidate evidence;
reasoning/system/developer/tool bodies are not returned. The parser retains actual
file line numbers, session ID and byte hash. `session_since` / `session_until`
filter message timestamps, separately from source ingestion-time filters.

The default `session_policy=missing_terms` enters that final stage only if a
query term is absent from the gathered stored evidence. This is a lexical trigger,
not an answer-completeness judgment. A separately authorized caller that still
lacks requested facts may explicitly choose `always`. No files are discovered or
read automatically, and session text is not persisted by recall. If a session is
deleted, its locator alone cannot recover it; separately captured report bytes
remain available. MCP token-budget trimming marks truncation and invalidates
the previously computed query-term coverage rather than reporting stale coverage.
`all` and `any` split up to eight whitespace-separated terms, including short
Japanese terms. Citation targets are excluded from these term checks, and numeric
terms do not match inside ASCII identifiers. Query text never becomes executable SQL.

Search can narrow by `project_id`, `page_id`, `source_id`, literal `path_prefix`,
case-sensitive heading substring `heading`, and `since` / `until` RFC3339 instants
(inclusive/exclusive). These times mean latest **page revision** or **source
ingestion**, not a business/event date mentioned in the text. Source search with a
project or page filter follows citations from live matching pages; it does not
expose every source in the personal Wiki. Search indexes the latest source version;
use an explicit version when reading an older citation.
`project_id` is an exact ownership filter, not a topical classifier: it excludes
unscoped pages and pages owned by another project even when relevant. For a
personal Wiki spanning projects, omit it or select known page/path scopes instead.

```sh
orgbrain wiki search '原本 再利用' --match-mode all --project-id org-brain --path-prefix wiki/
orgbrain wiki search '結果' --heading '2026-10-31' --per-owner-limit 8 --max-chars 2400
orgbrain wiki source-read --source-id SOURCE_ID --version 1 --query '採用未確認 保留' --match-mode all --context-lines 6 --max-chars 1200
```

The per-document hit limit defaults to two and can be set to 1–20. `max_chars`
controls each search snippet; the existing total token budget still applies.
Source reads accept an exact heading, line range, or query-centered excerpt, so a
matching fact near the end of a long document need not be read from its beginning.
Section queries require all/any terms within one section, then center a bounded
window on a matching line. `matched_section`, `matched_line`, `start_line`, and
`end_line` describe that selection. `query_in_excerpt` reports whether the returned
excerpt itself contains the query; it can be false on a continuation page, or null
after an additional MCP token-budget trim. `char_offset` and `next_char_offset`
refer to this selected range. Continue with the same query/section/range arguments
and the returned offset. A missing query raises `query_not_found`; it does not
silently return the document's beginning. Originals and their hashes are unchanged.

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

PDF OCR, semantic citation evaluation, cloud synchronization,
Postgres, multi-user authorization and large-corpus ANN are outside this release.
See `KNOWLEDGE_WIKI_VALIDATION.md` for measured checks and remaining validation.
