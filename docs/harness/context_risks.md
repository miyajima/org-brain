# Context: memory quality unification risks

- The change affects future Cloudflare D1 memory mutations but does not require a migration or deployment in this task.
- Existing production rows must not be rewritten during implementation validation; use dry-run only.
- Tenant boundaries, lifecycle filtering, version history, and FTS updates must remain deterministic.
- A classifier change can alter summary, scores, expiry, and suppression candidates; tests must pin the chosen behavior.
- The richer Node classifier is the accepted behavior because it removes hook wrappers, preserves structured project facts, and already drives ingestion and operator review.
- Do not auto-delete or auto-suppress existing rows as part of unification.

