# OrgBrain CLI

Public local-first CLI package for SQLite memory, MCP stdio, agent hook capture,
connector setup, and Cloudflare provisioning checks. The executable is
`orgbrain` and requires Node.js 22.13 or newer.

`connector setup` keeps local stdio as `--mode mcp`, registers an
Access-Managed-OAuth remote URL with `--mode remote-mcp`, and enrolls
installation-scoped Codex, Claude Code, or Cursor realtime hooks with
`--mode cloud-hooks`. Every setup mode is a dry run until `--execute` is
provided. A hook-writing execute additionally displays the target file and
events and requires an interactive `yes`; reviewed non-interactive provisioning
must pass `--approve-hooks`. Cloud hook secrets are accepted only after that
approval, through masked TTY input or the documented setup-only environment
variables.

Evaluation runners and competitor adapters are intentionally excluded; they
live in the private `@org-brain/benchmarks` workspace package.

## Evidence-backed use history (optional)

`orgbrain usage configure --mode c --collect` enables context search and bounded
usefulness ranking locally. Modes `a`, `b`, `c` support comparison; the default
is off. Queries must include `--project-id`, `--work-type`, and `--task-id` for
ranking. Inspect `orgbrain usage history`, submit explicit assessments through
`orgbrain usage evaluate`, and revoke a use through `orgbrain usage revoke`.
Only verified action/outcome evidence plus an explicit contribution assessment
can affect ranking. Saving a memory or completing a task is insufficient.

Automatic collection uses existing Codex context/Stop hooks and adds no model
calls or Cloud calls to Stop. Set `default_work_type` in the existing workspace
mapping. Optional synchronization runs separately through
`orgbrain usage sync --watch`; it requires `--sync` in the configuration and
`ORGBRAIN_API_URL` / `ORGBRAIN_API_KEY`. Cloud never trusts unsigned Local proof
flags. Use `orgbrain usage configure --mode off` to roll back the feature while
retaining history. Full contracts and validation are in the source repository's
`docs/MEMORY_USE_HISTORY.md`.
