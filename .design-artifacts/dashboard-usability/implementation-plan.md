# Implementation Plan

## Stack

Astro 6 SSR, Tailwind CSS v4, static semantic components, existing URL-driven selection, and existing dashboard/v1 data.

## Adapter

Astro: static guidance and action markup; no new client island. Existing polling and URL interactions remain unchanged.

## Order

1. Add guidance/action view models and focused unit tests.
2. Add shared Astro components and global tokens.
3. Update navigation and locale copy.
4. Integrate Activity, Connections, and History.
5. Run unit tests, typecheck, build, E2E, browser screenshots, and blocking design QA.

## Constraints

No public API, migration, route, or feature-flag change. Preserve unrelated work and existing visual assets.
