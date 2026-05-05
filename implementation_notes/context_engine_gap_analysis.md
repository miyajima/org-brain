# Context Engine Gap Analysis

## already_supported
- Tenant-scoped memory storage in D1.
- Lifecycle-aware memory snapshots and version history.
- Rationale capture with conclusion, reason summary, evidence refs, status, confirmation state, and supersession pointer.
- FTS/BM25 memory search with query rewriting.
- Hybrid fallback from memory search to knowledge docs.
- API-key auth for `/v1/*`.
- MCP service-token auth with tenant grants.
- Retrieval telemetry tables for memory search measurement.

## partially_supported
- Decision memory:
  - Existing `decision_rationales` handles conclusion/reason/evidence.
  - Missing a single first-class object for rejected alternatives, constraints, known pitfalls, validity windows, status values like `deprecated`, source refs, owner refs, and permission metadata.
- Context scoring:
  - Existing search ranking considers lexical rank, project proximity, memory kind/tier, tag priority, and recency.
  - Missing explicit source authority, permission fit, conflict penalty, staleness penalty, and testable score breakdown.
- Conflict handling:
  - `superseded_by` exists on `decision_rationales`.
  - No context response currently reports contradictions or preferred source rationale.
- Permission-aware context:
  - Tenant isolation exists.
  - Fine-grained source/memory filtering by user/agent/team is missing.
- Task-shaped context:
  - `/v1/memories/profile` gives durable/recent/search sections.
  - No `taskType`-specific context response exists.
- Metrics:
  - Generic retrieval metrics exist.
  - Context-engine-specific request count, returned token estimate, selected memory count, conflict count, and human-review count are missing.

## missing
- `/v1/context/enrich`.
- First-class `decision_memories` storage.
- Decision memory create/search API.
- Conflict response model for context enrichment.
- Max-token context compression for agent preflight.
- Context debt scanner and candidate promotion flow.
- `/v1/context/review-check`.
- MCP tools for context engine.

## conflicts_with_current_design
- Replacing `memories` or `decision_rationales` would conflict with current memory lifecycle design.
- Introducing a separate non-D1 persistence path for decision metadata would conflict with Cloudflare-native source-of-truth design.
- Treating source refs as raw unrestricted citation blobs would conflict with the required permission-aware behavior.

## risky_to_change
- Existing `/v1/memories/search` ranking and filtering are used by cap-runner and API profile flows; changing them directly has regression risk.
- Existing MCP tenant authorization should not be broadened without tests.
- Current migrations are additive without down migrations; destructive schema rewrites are risky.
- Full LLM extraction/context-debt automation would add operational and cost risk; it should be a later PR.
