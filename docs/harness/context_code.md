# Context: memory quality implementation

- Cloud runtime callers (`apps/cap-runner` and `apps/api-gateway`) import `assessMemoryUsefulness` from `@org-brain/shared`.
- Node operator and ingestion callers import the richer classifier from `scripts/lib/memory-quality.mjs`.
- The implementations disagree on summary normalization, score calculation, expiry, and suppression classification.
- Use one runtime-neutral shared implementation with a typed TypeScript facade and a thin Node compatibility re-export.
- Preserve tenant isolation, deterministic mutation rules, version history, and FTS update behavior.

