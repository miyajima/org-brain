# Local production snapshot

This checkout has a local-only Wrangler D1 snapshot for memory evaluation and
console development. The snapshot contains the current application data,
including identity and authentication tables. Keep `.local/` and the ignored
`.dev.vars` files private; never commit or upload them.

## Restore or refresh

The current snapshot is restored into:

```text
.local/production-dump/local-state/
```

Use the latest downloaded dump by default:

```bash
pnpm local:prod-data restore
pnpm local:prod-data status
```

Refreshing production is deliberately explicit:

```bash
pnpm local:prod-data refresh --from-production
pnpm local:prod-data sync --from-production
```

`sync` exports the 69 application tables, including memory quality runs and
MCP client installations, resets only the dedicated local D1,
restores the rows, and rebuilds the search projections. Cloudflare D1 internal
bookkeeping tables and SQLite FTS5 virtual tables are not part of the export.

During a local restore, memories without an owner or creator are assigned to
`user:local-dev` for reproducible local development. Production exports do not
infer ownership; unresolved production rows remain available for an explicit
administrator mapping.

## FTS5 reconstruction

FTS5 is derived data, not the source of truth. The restore process recreates:

- `memories_fts`
- `knowledge_docs_fts`
- `memory_retrieval_units_fts`
- `memory_retrieval_units_v4_fts`
- `retrieval_units_fts`
- `knowledge_resource_versions_fts`

The rebuild reads the authoritative tables with `INSERT ... SELECT`, so local
`MATCH` queries work without copying the production virtual-table internals.
Run only the rebuild when needed:

```bash
pnpm local:prod-data fts
```

## Start the local API and console

Terminal 1, from the repository root:

```bash
pnpm local:api
```

Terminal 2, from the repository root:

```bash
pnpm local:console
```

Open <http://127.0.0.1:4321/>. The local gateway grants the development key
`dev-org-brain-api-key` the `tenant_admin` role for tenant `default`; this key
is only for the local worker and is not a production credential.

## Verification

`local:prod-data status` reports row counts for the 69 authoritative tables and
the six FTS projections. Verify the current snapshot after every refresh rather
than relying on checked-in production counts. The restore applies all local
migrations, rebuilds the FTS projections, and keeps the dump and Wrangler state
under the private `.local/production-dump/` directory.
