---
title: Verified ingestion rollout and recovery runbook
doc_type: reference
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-18
---

# Verified ingestion rollout and recovery runbook

## Trust boundary

The local collector operator is the trusted boundary. The server accepts only
an ECDSA P-256/SHA-256 signature from a non-revoked tenant key, a matching
event-chain hash, and a Bundle whose every field and edge points to a current
new-input or signed tool receipt. This flow never calls a server-side LLM and
does not replace the existing capture or AI-review lanes.

## Flags and rollout

Keep the flags independent:

| Flag | `off` | `shadow` | `beta` | `on` |
| --- | --- | --- | --- | --- |
| `VERIFIED_INGESTION_MODE` | reject new Bundles | verify and record only | allow selected tenants/projects | allow production tenants |
| `VERIFIED_AUTO_PROMOTE` | no projection | no projection | promote only when explicitly enabled | promote Active Bundles |

1. Apply migration `0037_verified_knowledge_ingestion.sql` to a fresh local
   D1 database and run schema parity.
2. Register a short-lived collector key and verify registration, signature,
   event-chain, cross-tenant, and revocation checks.
3. Run the deterministic golden generator and shared/API tests with
   `VERIFIED_INGESTION_MODE=shadow`.
4. Enable `beta` for a synthetic tenant and set `VERIFIED_AUTO_PROMOTE=on`.
   Confirm duplicate replay, semantic conflict quarantine, provenance rows,
   and Decision Trace metadata.
5. Move to `on` only after seven consecutive days with zero unsupported Active
   fields/edges, zero ACL leaks, zero provenance gaps, zero idempotency drift,
   zero server-side LLM calls, and p95 targets met.

For a local JSONL session, use `pnpm memories:seed-verified path/to/session.jsonl`.
The script registers or reuses the collector identity, signs each Bundle, and
posts only to `/v1/memory-ingestions/verified`; it never issues direct D1 SQL.

## Failure handling

- `verified_draft`: fix the missing reason, evidence, artifact hash, or
  permission and submit a new Bundle. Do not edit the manifest in place.
- `quarantined`: revoke the collector key when forgery or key leakage is
  suspected, enumerate its manifests, and re-verify or retain them for audit.
- `extractor_disagreement`: require an explicit `decision_supersedes` edge;
  never overwrite the prior semantic decision implicitly.
- `duplicate`: treat as a successful no-op; do not retry with a new Bundle key.

To roll back, set `VERIFIED_AUTO_PROMOTE=off` first, then set
`VERIFIED_INGESTION_MODE=shadow` or `off`. Keep manifests and provenance for
audit, do not down-migrate, and leave `/v1/memories/capture`, AI review,
Decision Trace, Console, Skill, and Agent paths available.

## Evidence minimization

Store only masked excerpts, source spans, locators, content digests, and signed
receipt metadata. Do not persist raw session transcripts, private keys, model
confidence, or protected resource bodies in a Bundle or manifest.
