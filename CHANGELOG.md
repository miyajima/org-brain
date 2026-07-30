# Changelog

All notable changes to Org Brain are documented here. Releases use semantic versioning.

## 0.1.0 - Initial public release target

- Publish Org Brain under Apache-2.0 for free self-hosting.
- Include personal local SQLite memory, Cloudflare self-host API, organization bus, Remote MCP, console, and benchmarks.
- Add the `orgbrain` CLI with Node-bundled SQLite, MemoryRecord v2, migration,
  lifecycle history, integrity verification, index rebuild, backup/restore, and
  loopback-only serving.
- Add Cloud D1 MemoryRecord v2 fields and hard-delete propagation with a
  content-free tombstone.
- Add npm provenance, build attestation, CycloneDX SBOM, Docker Compose,
  migration guidance, and a threat model.
- Add stable benchmark profile names for the reproducible LongMemEval-S evaluation.
- Add six fixed RBAC roles, project-scoped assignments, generic RS256 OIDC,
  short-lived hashed scoped tokens with rotation and revocation, hash-chained
  API/MCP audit events, and retention/legal-hold enforcement.
- Add structured durable-memory extraction with secret/PII redaction and
  proposed-state handling for decision and tenant-wide knowledge.
- Add `hybrid_v2` retrieval fusion, explicit provider availability, a
  Workers AI + Vectorize projection, D1 entity/edge graph expansion, validity
  and record-ACL filtering, and per-result score breakdowns.
- Add an offline local sparse-vector embedding projection with synonym-aware
  semantic candidates, graph expansion, projection verification, and 100k-scale
  benchmark coverage.
- Add an agent pre-action decision gate plus decision review/debt queues.
- Add a structured MCP handoff package carrying decisions, rationale, source
  references, unresolved items, and next actions over the durable agent inbox.
- Add a scheduled destructive local restore drill with RPO/RTO and integrity
  evidence uploaded as a CI artifact.
- Add a credential-gated staging D1 restore workflow that exports into an
  isolated drill database, verifies record/version/edge/audit/RBAC counts and
  ordered content hashes, enforces the RPO/RTO targets, and always deletes the
  drill database.
- Add a single-file Node executable release artifact, Cloudflare resource
  diagnosis/provisioning, and review-before-execute MCP registration for Codex,
  Claude Code, OpenCode, and OpenClaw.
- Add STATE-Bench-style completion/turn/cost fields, null-safe weighted
  scorecards, and a 500-item LongMemEval-S CI artifact path with CPU worker
  parallelism.
- Require artifact-backed component scores and identical model, budget, and
  hardware declarations before the five-adapter benchmark can permit a
  first-place claim.
- Enforce optional per-principal API rate limits plus per-capability concurrency
  quotas and execution-duration cost ceilings.
- Document the managed SaaS boundary: self-hosting is free, official hosted operations are paid.

Live cloud-stage restore evidence, third-party SaaS connector ingestion,
complete poisoning/redaction evaluation, and same-harness competitor
measurements remain pre-1.0 work.
