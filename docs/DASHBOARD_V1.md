# Dashboard v1

Org Brain's dashboard presents three read-only projections over the existing D1 sources of truth. It does not introduce a graph database, materialized dashboard tables, agent presence, or a streaming transport.

## Routes

| Console route | View | Source API |
| --- | --- | --- |
| `/overview` | Organizational Nervous System | `GET /v1/dashboard/activity` |
| `/memories/constellation` | Knowledge Constellation | `GET /v1/dashboard/knowledge-graph` |
| `/decisions/history` | Memory Strata | `GET /v1/dashboard/strata` and its detail route |

The existing `/memories`, `/decisions`, `/tasks`, and management screens remain authoritative and available. Visualization selections deep-link to those screens.

`INSIGHTS_UI_MODE` controls the home, dashboard routes, navigation, and polling:

- `off` or unset: keep the classic task dashboard at `/`, hide all insights links, and redirect direct insights-route requests to their classic surfaces before any dashboard API request or poller is created.
- `beta`: keep the classic home, expose `/overview` through a Labs link, and allow the Constellation/Strata routes from their classic surfaces.
- `on`: render the Nervous System at `/` and keep the classic home available at `/dashboard` from the Manage menu.

Tenant, project, and language query parameters must be retained in navigation. Empty responses stay empty; the Console never replaces them with example records.

## API contracts

The shared Zod and TypeScript contracts live in `@org-brain/contracts` under the version literal `dashboard/v1`. All endpoints use the normal `{ ok, data }` API envelope and existing read permission middleware.

Activity defaults to the previous 24 hours and rejects windows over seven days. It uses opaque `(timestamp, event key)` cursors and is polled no faster than every 30 seconds. The response contains event summaries and safe metadata only: it excludes task payloads, input refs, queries, message bodies, memory bodies, and raw version snapshots.

The knowledge graph returns at most 150 nodes and 300 edges. Edges come only from stored relations, confirmed assertions, usage links, supersession, entity links, and deterministic project membership. An edge is omitted when either endpoint is unreadable. Project nodes are synthetic labels generated from `project_id`; they are not project records.

Strata collection responses are capped at 100 chains. Detail is capped at 100 revisions and 50 sources and reports truncation independently for each. A revision reconstructed from an old or absent `snapshot_json` contains only whitelisted known fields and is marked `partial: true`.

## Semantics

- `observed_agents.state` means observed during the requested window, not online presence.
- Identity resolution prefers recorded agent name, authenticated actor principal, runtime/capability, then `System / Unknown`.
- Pre-migration usage events are not backfilled or guessed.
- Canonical strata require promotion, a canonical key, or an explicit `canonical-memory` tag.
- Assumption strata require a proposal assertion or an explicit assumption tag. Low confidence alone is not an assumption.
- Knowledge similarity never creates a graph edge.

## Polling behavior

The Console starts from the SSR snapshot, then requests only events after `newest_cursor` every 30 seconds. It pauses while `document.hidden`, aborts an overlapping request, and backs off exponentially to a maximum of five minutes after failure. A failed refresh keeps the last successful snapshot and marks it stale. Reduced-motion preference disables pulse, automatic panning, and JavaScript motion.

## Schema and deployment

Migrations are additive and forward-only:

1. `0026_dashboard_activity.sql` adds authenticated attribution and activity indexes.
2. `0027_dashboard_knowledge_graph.sql` adds graph traversal indexes.
3. `0028_dashboard_strata.sql` adds assertion/resource history indexes.

Deploy migrations before the API Worker, and the API Worker before the Console. Roll back the feature first by setting `INSIGHTS_UI_MODE=off`; do not down-migrate D1. Dashboard logs may contain view name, duration, counts, status, and truncation only.

Dashboard handlers sample approximately 5% of requests by the Cloudflare request id. The structured `dashboard.view` record contains only `view`, `duration_ms`, `count`, `status`, and `truncated`; it never includes tenant, project, principal, query text, or record content.

### Staging promotion procedure

1. Apply migrations, deploy the API Worker, and run the live API smoke before deploying the Console.
2. Deploy the Console with `INSIGHTS_UI_MODE=beta`.
3. Exercise four isolated staging projects: empty, sparse (1–5 visible records), dense (the 100k-memory fixture), and mixed-access (readable and restricted records interleaved). Confirm that empty views remain honest, sparse layouts remain usable, dense responses truncate explicitly, and restricted records do not affect counts or cursors.
4. Keep beta enabled for at least 24 hours. Compare each dashboard endpoint with the immediately preceding 24-hour Worker baseline and promote to `on` only when every gate below passes.

| Signal | 24-hour promotion gate |
| --- | --- |
| API latency | p95 ≤ 1 second live; local 100k fixture p95 ≤ 500 ms |
| 5xx | < 1% per dashboard view and no sustained five-minute interval above 1% |
| 429 | < 1% and no increase greater than 0.2 percentage points from the preceding baseline |
| Payload | gzip p95 ≤ 250 KiB for every view |
| Truncation | every truncated response renders an explicit state; no false `has_more` or hidden-row crowd-out in the mixed-access fixture |
| Polling | successful refreshes ≥ 99%; failures retain the last good snapshot and recover after backoff |

Run the API smoke with deployment-scoped credentials (the command prints counts only):

```bash
ORGBRAIN_API_URL=https://api.example.com \
ORGBRAIN_API_KEY=... \
ORGBRAIN_TENANT_ID=... \
ORGBRAIN_PROJECT_ID=... \
node scripts/dashboard-live-smoke.mjs
```

The smoke checks Activity, Knowledge Graph, Strata collection, and one available Strata detail response against `dashboard/v1` and rejects sensitive response fields. It is mandatory after any Cloudflare API deployment. After the Console deploy, repeat the empty/sparse/dense/mixed-access browser smoke before changing the flag to `on`.

If any gate fails, set `INSIGHTS_UI_MODE=off` first to stop polling and hide the new navigation. Roll the API Worker back only if the fault remains; leave additive migrations in place and remove a problematic index only through a later forward migration.

## Verification

Required checks cover tenant/project isolation, scoped tokens, cursor stability at equal timestamps, bounds, partial history, dangling edges, actor spoof rejection, deterministic coordinates, cycle handling, desktop/mobile navigation, keyboard selection, hidden-tab polling, reduced motion, empty/error/truncated states, and regressions in the existing Memory and Decision workflows.

Performance targets are API p95 at or below 500 ms for the representative 100k-memory fixture, live p95 at or below one second, compressed responses at or below 250 KiB, and selection feedback within 100 ms.
