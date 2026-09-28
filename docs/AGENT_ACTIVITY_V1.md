# Agent activity v1

`agent-activity/v1` is the local, metadata-only observation contract for agent
sessions. It makes hook and connector failures diagnosable without creating a
second memory database or storing complete conversations.

## Event contract

Every event has a stable ID and source hash, timestamp, per-session sequence,
harness, collection method, fidelity, action, category, session/tool-call IDs,
optional model/provider names, and normalized token counts. Supported collection
methods are `hook`, `plugin`, `otlp`, `poll`, and `manual`; fidelity is always
`observed` or `inferred`.

The common categories are session, tool, command, file, approval, MCP, token,
model, and other. Codex lifecycle hooks record this contract directly. The same
normalizer accepts Claude Code, Cursor, and OpenCode fixtures and manual/plugin
or OTLP-shaped input so those connectors do not need a separate schema.

When a memory-use event ID is available, collectors may set
`memory_usage_event_id`. It is stored as a bounded identifier in event metadata,
which lets token observations be joined to the existing retrieval/adoption/
execution/result history without making activity the source of memory truth.
Collectors may also attach bounded task/run IDs, one of the explicit memory-use
stages (`returned`, `adopted`, `executed`, `result_confirmed`), and a measured
duration. `activity summary` aggregates stage counts, token totals, and duration
sample average/p95 for pilot analysis.

## Privacy default

The persisted `content_json` field is always `NULL`. Prompt text, command text,
absolute file paths, tool output, and tool arguments are not persisted. The
collector derives only bounded classifications, byte counts, statuses, and
SHA-256 hashes before the database write. `orgbrain doctor` verifies that no
activity row contains a body.

This default is not configurable in v1. Full-session storage, browser
conversation collection, and SIEM forwarding are explicitly out of scope.

## CLI

```text
orgbrain activity ingest codex '{"action":"session.started"}'
orgbrain activity ingest-otlp codex '<OTLP ExportLogsServiceRequest JSON>'
orgbrain activity search mcp --project-id orgbrain
orgbrain activity show act_...
orgbrain activity timeline --session-id ...
orgbrain activity summary --project-id orgbrain
orgbrain activity scan --project-id orgbrain
orgbrain connector inventory --project-id orgbrain
pnpm benchmark:activity-overhead
```

`search`, `show`, `timeline`, and `summary` are read-only. `scan` evaluates
metadata against versioned local rules and returns findings without changing an
event. Rules declare a version, severity, maturity (`experimental` or `stable`),
and positive/negative fixtures. A stable rule is invalid unless both fixture
classes pass.

Directly observable hook events and opaque code-mode wrappers are counted
separately in the summary. `missing` remains `null` until a pilot supplies an
expected-event denominator; absence is never fabricated from the events that
did arrive.

`connector inventory` reports four separate states:

- `installed`: the harness executable is available.
- `configured`: a known connector configuration exists.
- `managed`: that configuration contains an OrgBrain-managed entry.
- `observed`: a matching event was recorded in the recent observation window.

`orgbrain doctor` includes the same inventory and reports
`configured_not_observed`, `managed_but_not_installed`, and disabled hook capture
as explicit warnings. It also reports `user_system_mode_mismatch` when a system
runtime is inspecting user-scoped configuration. Configuration is therefore not treated as proof that a
connector is running.

`ingest-otlp` accepts an OTLP `ExportLogsServiceRequest` only when a connector
needs fields unavailable from hooks. It maps standard `gen_ai.*`, session,
trace/span, model/provider and token attributes into the same v1 contract. Log
bodies, command lines and file paths still pass through the metadata-only
normalizer and are never stored verbatim.

## Memory evidence and skills

A memory may cite an event with a source reference like:

```json
{"type":"agent_activity","ref":"agent-activity:act_..."}
```

Capture rejects missing events and cross-project references. Accepted
references are enriched with the stable event ID, timestamp, sequence, action,
fidelity, and harness. An event is evidence about observed execution; it does
not bypass memory extraction, verification, or `propose -> confirm`.

`orgbrain memory skill preview <memory-id>` and `install` accept only verified
or explicitly user-confirmed memories. Installation is manual, writes to the
project's `.agents/skills` directory, and refuses to replace an existing skill
unless `--force` is explicitly supplied.

## Rollout gates

The implementation provides measurement fields but does not itself establish
production impact. A Codex pilot of at least 100 local sessions should compare
observable/inferred/missing coverage, verified candidates and precision,
diagnosis time, memory retrieval/adoption/execution/result stages, token counts,
and completion time. Expansion should stop if extraction precision falls below
95%, hook p95 overhead exceeds 50 ms, or persisted activity contains secret or
body content. Claude Code, Cursor, and OpenCode rollout follows only after the
Codex measurements meet those gates.

The overhead command measures 100 metadata writes against an initialized local
store and fails when p95 exceeds 50 ms. It deliberately excludes process startup;
the 100-session pilot must measure end-to-end hook latency separately.
