# Context: memory quality verification

- `scripts/memory-quality.test.mjs` covers the richer classifier used by hook ingestion and operator tools.
- `packages/shared/test/memory-quality.test.ts` covers the divergent Cloud/runtime classifier.
- `apps/cap-runner/test/memory-maintenance.test.ts` verifies maintenance planning, quality updates, canonical/digest generation, and D1 writes.
- `apps/api-gateway/test/memory-service.test.ts` verifies quality metadata at Cloud API ingestion.
- Focused verification: shared tests, script quality tests, cap-runner maintenance tests, and API gateway memory tests.
- Manifest full gate: recursive typecheck, full tests, lint, and build.

