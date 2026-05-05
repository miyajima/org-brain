# Context Engine PR Plan

## PR 1: Decision Memory Schema
- Add `decision_memories` D1 table.
- Store domain, title, decision, rationale, rejected alternatives, constraints, known pitfalls, source refs, owner refs, validity window, status, supersession, confidence, and permission metadata.
- Add `POST /v1/decision-memories` and `POST /v1/decision-memories/search`.
- Keep existing memory/rationale APIs unchanged.

## PR 2: Context Scoring Engine
- Add a scoring helper with explicit breakdown:
  - semantic relevance
  - recency
  - source authority
  - source proximity
  - task specificity
  - permission fit
  - conflict penalty
  - staleness penalty
  - final score
- Keep it internal and testable before exposing debug output.

## PR 3: `/v1/context/enrich`
- Add request validation for org/tenant, project, agent, user, task type, task text, max tokens, and source/conflict flags.
- Return summary, decision context, constraints, known pitfalls, conflicts, recommended next actions, confidence, and human-review flag.
- Use decision memory rows first, with source refs preserved.

## PR 4: Minimal Conflict Detection
- Detect same-topic active/deprecated/superseded/expired rows.
- Prefer active, newer, higher-authority rows.
- Mark high-severity unresolved conflicts as human-review required.

## PR 5: Context Debt Scanner
- Add rule-based candidate extraction from review comments/logs.
- Persist pending candidates.
- Add status transitions and promotion to decision/constraint memory.

## PR 6: Review Check API
- Add `POST /v1/context/review-check`.
- Return review risks, similar past comments, recommended checks, and human-review flag.

## PR 7: MCP Adapter
- Add MCP tools:
  - `orgbrain_context_enrich`
  - `orgbrain_context_review_check`
  - `orgbrain_context_debt_record`
  - `orgbrain_decisions_search`
- Reuse HTTP service functions and MCP tenant authorization.

## PR 8: Metrics
- Add context-engine telemetry rows or extend retrieval telemetry with a context capability.
- Report enrich count, average returned tokens, selected memory count, conflict count, context debt count, and human-review count.

## Minimal PR Implemented First
- Decision memory schema.
- Decision memory create/search APIs.
- Context scoring helper.
- `/v1/context/enrich`.
- Minimal conflict detection.
- Basic tests for ranking, deprecated penalty, conflicts, permission filtering, and max token compression.
