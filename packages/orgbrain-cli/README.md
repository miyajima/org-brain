# OrgBrain CLI

Public local-first CLI package for SQLite memory, MCP stdio, agent hook capture,
connector setup, and Cloudflare provisioning checks. The executable is
`orgbrain` and requires Node.js 22.13 or newer.

## Workspace identity

For an ordinary Git project using OrgBrain, put `.orgbrain.local.json` at the
repository root:

```json
{"version":1,"tenant_id":"default","project_id":"my-project"}
```

This file contains identifiers only. Keep API keys, service tokens, and local
capture policy out of it. Keep it out of Git (for example, add its name to the
local exclude file from `git rev-parse --git-path info/exclude`) and set mode
`0600` on Unix. Each collaborator creates
their own file with the shared tenant and project IDs. An explicit private
mapping in `~/.config/org-brain/workspaces.json` takes precedence, and an
invalid project file without a private mapping fails rather than silently
choosing a project. This identity file does not install hooks or enable capture;
`connector setup` handles those steps. Setup reads the identity file
automatically: `remote-mcp` uses its tenant ID, while `minimal-hooks` and
`cloud-hooks` use both IDs for their private hook mapping. If an explicit ID
conflicts with the file, setup fails.
OrgBrain's own repository can continue using its existing private mapping
without a project file.

To look up the effective ID without opening the CLI source or running database
diagnostics, use `orgbrain workspace resolve --root <checkout>`. Omit `--root`
to use the current directory. The command prints `project_id`, `tenant_id`,
the matched root, and how it matched. An unmapped workspace returns
`project_id: null` and exits with status 2; it does not guess from the
directory name. Local hooks use the same resolver. Pass the resolved ID to
interactive MCP calls that require `project_id`.

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

### Local confirmation flow

With the local MCP and local Codex hooks configured, set the workspace's
`memory_learning_mode` to `confirm`. Stop queues source-backed candidates; a later
substantive prompt offers a bounded confirmation question. Only the actual save
or correction answer authorizes the local MCP write. `confirmation_status` and
immutable SQLite receipts make an uncertain reply recoverable without another
question or duplicate save. Local schema 27 is additive; Cloud data is not copied.
See `docs/MEMORY_CAPTURE_HARNESS_COMPATIBILITY.md` in the repository for the contract.
