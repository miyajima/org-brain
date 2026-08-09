# Implementation Plan — remediation round 2

## Stack Detection

Astro 6 SSR, static semantic components, URL-driven selection, small custom elements for polling, Tailwind v4 plus component-scoped CSS.

## Selected Adapter

Astro. Shared orientation/status stays static. Existing poller remains the only client-side state island.

## Target Files

- `apps/console/src/components/intelligence/InsightScopeRail.astro`
- `apps/console/src/components/intelligence/NervousSystem.astro`
- `apps/console/src/components/intelligence/KnowledgeConstellation.astro`
- `apps/console/src/components/intelligence/MemoryStrata.astro`
- `apps/console/src/layouts/BaseLayout.astro`
- dashboard page routes and focused UI helpers/tests

## Execution Order

1. Add scope/data-state and activity-comparison view models.
2. Pass fetch errors and 24-hour comparison data from SSR routes.
3. Repair Activity topology/provenance, graph relationship labels and missing selection, and unified history review state.
4. Compact mobile navigation and minimum metadata sizing.
5. Add focused unit/E2E coverage; typecheck, build, screenshot review, and rescore.

## Validation

Unit tests, Astro typecheck, console build, dashboard Playwright suite with installed Chrome, and browser screenshots at 390 and 1280.

## Risks

The API does not expose an explicit agent provider or reviewer display name. The UI will present conservative labels derived from event actor kinds and revision actor IDs without inventing identity.
