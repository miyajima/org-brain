# Context delivery accounting

Local compact context and Cloud memory/decision context use the same local
`o200k_base` tokenizer over complete pretty-printed MCP text. The budget includes
JSON framing, provenance, conditions, metadata, guidance and item receipts.
`estimated_tokens` / `estimatedTokens` is a tokenizer estimate; it is not provider
billing, saved tokens, task success or causal benefit.

Cloud context allocates opaque usage and item IDs before packing and records
only the final delivered items. Decision constraints, pitfalls, rationale and
requested provenance remain together: an oversized capsule is omitted instead
of silently deleting its limiting conditions. MCP decision context includes
prior action attempts and optional domain recall before packing. An envelope
that cannot fit returns `context_budget_below_envelope` before memory injection
usage is written. Agent asset usage is also deferred until the envelope fits.

Receipts identify the delivered source ID and version. Context requests accept
`task_id`, `trace_id`, `external_run_id` and `usage_purpose`. Allowed purposes are
`task`, `audit`, `diagnostic`, `test`, and `unclassified`; omitted purpose remains
`unclassified` for compatibility. A zero-item context still has a usage event,
so missing retrievals are retained in the task denominator. Neither injection
nor user-reported use is upgraded to verified execution or positive effect.

No schema migration, production flag change, authentication change or activation
is required by this accounting code. Projection changes have separate shadow /
backfill requirements described in
[retrieval generation notes](RETRIEVAL_GENERATIONS_AND_MEMORY_IMPACT.md).
Before production rollout, measure cold tokenizer initialization and complete
context latency in the deployed Worker configuration; local tests and dry runs
do not establish production latency or provider cost improvements.
