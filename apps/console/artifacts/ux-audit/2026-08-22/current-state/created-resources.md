# UX audit resources and cleanup

## Local-only resources

- Temporary SQLite fixture DBs were created below `/private/tmp` for the local setup and Local MCP runs. They contain synthetic UX-audit records only; no production data or Codex raw session JSONL was copied into the artifact.
- The local API/Console used a Wrangler `--persist-to` directory under `.local/production-dump/local-state`. Migrations `0001` through `0037` (40 migration files in the current checkout) were applied there so the running API could expose its intended empty state. This is local-only and is not a Cloudflare D1 mutation.
- No product source, public API, or schema file was changed. The only tracked additions are this audit artifact directory; a generated Astro type file was restored to its original checkout contents.

## Cloudflare read-only checks

- `cf doctor` and `cf doctor --live` completed successfully for the existing checkout. Existing Wrangler OAuth authentication was used by the CLI, but no token value, account ID, email, or raw scope list is stored here.
- `cf provision` was run in dry-run mode only. It displayed an existing topology using D1 `open-brain`, R2 `open-brain-bucket`, the org-bus/cap-plan/retrieval-projection queues, migration application, and deployment steps. `--execute` was intentionally not run because it would deploy or reconcile an existing environment rather than isolate an audit tenant.
- Wrangler D1/R2/Queue lists were read-only. No D1, R2 bucket, Queue, Worker, Pages project, Vectorize index, OAuth client, hook installation, registration code, or secret was created, deleted, rotated, or recreated.
- The configured public host was probed without credentials: `/api/v1/dashboard/activity` returned an empty 200 body shape, `/api/mcp` returned 401, and the root served an Org Bus Dashboard rather than the expected OrgBrain Console. This prevents a safe claim of Remote MCP OAuth, cloud hook enrollment, or shared-memory readiness.

## Evaluation tenant/team data

The requested `ux-audit-*` Cloudflare tenant/project/users/groups were not created because the target Console/API and authenticated Remote MCP flow could not be established without guessing the production target. Creating users or writing to the existing D1 would have made the measured state ambiguous. Team axes that require owner/admin/member, three groups, two projects, and shared/restricted memories are therefore `N/A` in `scorecard.json`, with `T-01` evidence.

## Cleanup result

No remote cleanup was needed because no remote resource was created. Temporary local fixture files remain outside the repository under `/private/tmp` and are not referenced by the product. The artifact contains only synthetic IDs, status shapes, and redacted evidence.
