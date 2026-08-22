# Local memory migration and recovery

OrgBrain local memory uses the same MemoryRecord v2 logical contract as the
Cloud D1 service. The authoritative SQLite schema version is `19`. Full-text and
future vector indexes are derived data and can be rebuilt from authoritative
records.

## Upgrade an existing OrgBrain database

Back up the database, then run `init`. Initialization detects the legacy
`memories` columns, adds v2 fields, computes missing SHA-256 content hashes,
creates initial version snapshots, and rebuilds FTS.

Initialization also detects obsolete `memories_fts_ai`, `memories_fts_ad`, and
`memories_fts_au` triggers left by older local databases. Before removing them
and rebuilding FTS, OrgBrain creates a private timestamped backup under
`~/.org-brain/backups/`. Current writes maintain FTS explicitly, so the legacy
triggers must not remain as a second projection writer.

```bash
orgbrain backup create
orgbrain init
orgbrain doctor
```

Initialization is idempotent. It preserves memory IDs, source keys, content,
summaries, tags, projects, and original creation timestamps.

## Import a separate legacy database

Import into a new or existing canonical database with:

```bash
ORGBRAIN_LOCAL_DB=/path/to/canonical.sqlite \
  orgbrain migrate --from /path/to/legacy-memory.sqlite
```

The command reports:

- source record count
- target counts before and after import
- record, version, and FTS counts
- a deterministic digest of memory IDs and content hashes
- integrity and schema verification errors

Rows with an existing `(tenant, source, external_key)` are versioned updates
instead of duplicates.

## Backup and restore

Create and verify a consistent SQLite backup:

```bash
orgbrain backup create --output /secure/path/memory.sqlite
orgbrain backup verify --from /secure/path/memory.sqlite
```

Restore validates the backup before replacement and preserves the current
database as a timestamped `.pre-restore-*` safety copy:

```bash
orgbrain backup restore --from /secure/path/memory.sqlite
orgbrain doctor
```

Backups contain tenant memory and may contain sensitive organizational
information. Store them encrypted when the underlying disk is not trusted.

## Rebuild derived data

FTS is not authoritative. Rebuild it at any time:

```bash
orgbrain index rebuild
orgbrain doctor
```

`doctor` runs SQLite `quick_check`, validates every content hash, compares FTS
and searchable-record counts, checks schema version, and verifies POSIX private
permissions.

## Schema v19 classification and impact telemetry

Schema v19 includes the schema-v18 business classification and detailed
per-memory effect telemetry, then adds the merged run-level
`memory_impact_events` / `memory_impact_daily_metrics` contract. It also adds
nullable `memory_usage_events.external_run_id`, so one eligible execution can
be associated with its deduplicated memory references without treating
execution reporting and per-memory attribution as the same metric.

The earlier schema-v18 work adds explicit business categories, category/work snapshots on
memory history, stable retrieval generations and units, usage/effect/failure
telemetry, a rebuildable daily impact projection, and a local telemetry outbox.
The outbox is populated only when explicit Cloud synchronization is enabled
with `ORGBRAIN_ENABLE_CLOUD_MEMORY=true`. Deliver pending usage records before
their dependent effect records with `orgbrain telemetry sync`; the command
also requires `ORGBRAIN_API_URL` (or its compatibility alias) and
`ORGBRAIN_API_KEY`, and retries failures with bounded exponential backoff.

Run-level measurement uses `orgbrain impact start`, `orgbrain impact report`,
or the matching `orgbrain_memory_impact_start` / `orgbrain_memory_impact_report`
tools. The separate `orgbrain_memory_impact_metrics` tool reports per-memory
references, effects, token estimates, and failure avoidance.

Existing rows remain unclassified; initialization does not infer a category or
work type from their content. Workspace config v2 can provide explicit defaults
for future capture. Use `pnpm cf:memory:backfill-classification` for a validated
JSON/CSV dry run before any operator-approved backfill.

Legacy v3/v4 local projection tables coexist with stable tables during rollout.
Do not remove them until stable assignment has passed the promotion gates and a
backup/restore drill has succeeded. See
[`RETRIEVAL_GENERATIONS_AND_MEMORY_IMPACT.md`](RETRIEVAL_GENERATIONS_AND_MEMORY_IMPACT.md).
