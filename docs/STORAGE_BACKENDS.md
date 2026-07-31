# Storage backend policy

## Current defaults

OrgBrain keeps two supported source-of-truth modes:

| Use case | Authoritative store | Retrieval projections |
| --- | --- | --- |
| Private local use | SQLite | SQLite FTS and rebuildable v3/v4 local units |
| Shared/self-hosted use | Cloudflare D1 | D1 FTS plus versioned Vectorize namespaces |

SQLite remains the zero-service local default. D1 remains the shared Cloudflare
default because it keeps deployment, tenancy, queues, Workers, and operational
ownership in one stack. Changing the relational store by itself is not expected
to improve retrieval quality: LongMemEval and LoCoMo scores are primarily
controlled by retrieval-unit quality, embeddings, candidate fusion, and
reranking.

## Future PostgreSQL option

PostgreSQL with pgvector is a planned opt-in backend, not a replacement for the
defaults above. It is intended for deployments that need larger per-tenant
datasets, sustained concurrent writes, complex organizational analytics or
transactions, private-network placement, or an existing PostgreSQL operating
model.

The option must preserve the same logical `MemoryRecord` contract and expose the
same capture, search, revise, suppress, delete, ACL, audit, retention, and
projection-rebuild behavior. It must not introduce a second authoritative
write path. A deployment selects exactly one authoritative relational backend;
embedding, FTS, graph, and cache data remain rebuildable projections.

The intended boundary is:

1. Extract a relational storage port from the current D1-specific services.
2. Keep SQLite local-first behavior separate and dependency-free.
3. Add D1 and PostgreSQL implementations of the relational port.
4. Add a pgvector `RetrievalIndex` implementation without coupling the
   `MemoryStore` contract to pgvector.
5. Move data through versioned export/import with row counts, content hashes,
   tombstones, and projection coverage verification. Do not dual-write during
   migration.

Cloudflare deployments may connect to PostgreSQL through Hyperdrive when that
fits the operator's network and latency requirements. This is an optional
topology; D1 plus Vectorize remains the simpler shared default.

## Activation criteria

PostgreSQL implementation should start only when production evidence shows at
least one of these conditions:

- a tenant is approaching D1's practical database-size envelope;
- measured D1 write contention or overload persists after batching and schema
  tuning;
- required cross-memory analytics or multi-row transactions cannot be served
  safely by the D1 design;
- a customer requires VPC, on-premises, or an existing PostgreSQL control
  plane.

Benchmark score alone is not an activation criterion. A PostgreSQL backend must
be evaluated through the same product-path and same-harness suites; provider-
specific tuning or benchmark-only storage paths are not accepted.

## Acceptance gates

Before the option can be called supported:

- contract tests pass unchanged for SQLite, D1, and PostgreSQL;
- capture, search, revise, suppress, hard delete, ACL isolation, audit chain,
  retention, legal hold, and projection rebuild have parity evidence;
- export/import verifies row counts, version history, content hashes,
  tombstones, and retrieval-index coverage;
- rollback to the source backend is documented and exercised before cutover;
- LongMemEval-S, LoCoMo, and `competitive-memory-v1` run through the normal
  product path with no regression beyond the frozen acceptance thresholds;
- latency, cost, backup/restore, and operational complexity are reported
  separately from retrieval quality.

Until those gates pass, PostgreSQL is a roadmap option and must not be presented
as a supported production backend.
