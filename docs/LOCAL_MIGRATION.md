# Local memory migration and recovery

OrgBrain local memory uses the same MemoryRecord v2 logical contract as the
Cloud D1 service. The authoritative SQLite schema version is `14`. Full-text and
future vector indexes are derived data and can be rebuilt from authoritative
records.

## Upgrade an existing OrgBrain database

Back up the database, then run `init`. Initialization detects the legacy
`memories` columns, adds v2 fields, computes missing SHA-256 content hashes,
creates initial version snapshots, and rebuilds FTS.

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
