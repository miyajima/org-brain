# Code Context: Workspace Mapping

- `scripts/hook-memory-bridge.mjs` loads `~/.config/org-brain/hooks.env`, resolves `ORGBRAIN_TENANT_ID`, and currently persists only `cwd -> project_id` in `project-names.json`.
- `resolveProjectNameForWorkspace` is called only after a hook record survives low-signal filtering, so skipped events do not create mapping files.
- `scripts/memory-quality-backfill.mjs` and `scripts/project-current-state-snapshot.mjs` separately consume `ORGBRAIN_PROJECT_ROOTS` as `project_id -> repo root` overrides.
- A shared runtime-neutral `scripts/lib/workspace-config.mjs` can make `workspaces.json` the single local mapping source for both directions while retaining environment and legacy compatibility.
- Cloud/API authorization remains authoritative: a local tenant selection must still be accepted by the API key or MCP tenant grant.
