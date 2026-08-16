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
