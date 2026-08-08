<!-- task: Org Brain 3-view insight dashboard -->

# Implementation Plan

## Stack Detection

Astro 6 SSR, Tailwind CSS v4, native client TypeScript, Cloudflare Worker/Hono API, D1, shared Zod contracts. No React/Vue/D3/graph library.

## Selected Adapter

`adapters/astro.md`: static semantic markup first, isolated Custom Elements only for polling and graph/strata selection.

## Source Artifacts

- `design-intent.md`
- `ui-structure.json`
- `design-tokens.json`
- `component-contracts.md`

Visual sources:

- Organizational Nervous System: `/Users/miyajimakazuhiro/.codex/generated_images/019fdc38-54dc-7132-9c65-719b59790908/exec-2391b241-0f07-4192-ba2d-aed1a5a55ee2.png`
- Knowledge Constellation: `/Users/miyajimakazuhiro/.codex/generated_images/019fdc38-54dc-7132-9c65-719b59790908/exec-5d8001b2-d6bf-45d0-a69a-dbbdfffcde28.png`
- Memory Strata: `/Users/miyajimakazuhiro/.codex/generated_images/019fdc38-54dc-7132-9c65-719b59790908/exec-adc7f1f5-cf53-45b8-98c6-9e012060c6a1.png`

## Target Files

- `packages/contracts/src/index.ts`
- `migrations/0026_dashboard_activity.sql` through `0028_dashboard_strata.sql`
- `apps/api-gateway/src/*dashboard-service.ts`, route wiring, attribution paths, tests
- `apps/console/src/components/dashboard/*`, `src/lib/*-ui.ts`, new routes, layout/tokens, unit/E2E fixtures

## Component Mapping

Each visualization is an Astro server-rendered component enhanced by a purpose-built Custom Element. Pure transforms and deterministic coordinates live in testable TypeScript modules.

## Token Mapping

Normalize global tokens to the values in `design-tokens.json`; keep warning/danger semantic and constrain blue glow to live or selected data.

## Execution Order

1. Add contracts, additive schema changes, attribution propagation, and read-only dashboard services/routes.
2. Add the three routes and isolated UI modules while preserving classic Memories, Decisions, Tasks, and management routes.
3. Add focused unit/route/E2E coverage, capture 1440x1024 evidence, run visual comparison and the full repository gates.

## Validation

Contracts and service tests, Console unit tests, Astro typecheck/build, Playwright desktop/mobile/reduced-motion when browser approval is available, schema/config parity, then repository lint/typecheck/test/build. Visual QA requires same-viewport reference/implementation pairs and a passing project-root `design-qa.md`.

## Risks

Sparse historical relations, pre-migration unknown actors, unavailable browser rendering, D1 query limits, and the current dependency installation state. Surface each limitation explicitly; never fill gaps with fabricated content.
