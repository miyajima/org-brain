# Runtime and dependency security verification — 2026-10-23

Workspace builds, CI and Docker use Node 26.12.1. The published CLI accepts only patched Node families (`^22.23.4 || ^24.22.1 || ^26.12.1`); production adoption of Node 22 is not implied.

The previous container omitted shared modules and external production dependencies and could not start. The dependency stage now installs the frozen production workspace and copies its required packages and node_modules into the runtime image, preserving its non-root user, data path, entrypoint and localhost default.

Previously verified dependency updates are included in the lock. DOMPurify is additionally updated to 3.4.17 for GHSA-cg2g-xh64-v4q7 and GHSA-mrv2-3pqr-j5jr (official release: https://github.com/cure53/DOMPurify/releases/tag/3.4.17). No lock deletion or forced audit fix is used.

Validation:
- Clean frozen installation and exact locked-version advisory matching: High/Critical 0; lower severity and peer-version warnings remain.
- Before and after dependency updates, Node 22.23.4 and Node 26.12.1 each run 503 Node tests: 492 pass, the same 9 pre-existing atomic lesson-capture failures, 2 skipped. No new runtime failure was observed.
- Docker CLI help and 30 isolated SQLite/MCP tests pass without network access.
- Workspace typecheck, builds, MCP protocol/conformance and targeted 25 OAuth/lifecycle tests pass.
- Full Gateway regression: 426 tests pass.

Production boundaries:
- Cloudflare API Worker runs managed V8, not this Node Docker image. Active version 58835059-51b3-4f95-a096-111ef009eb59 is annotated with deployed main commit 0dedf923896738bbf4089515b9220f1da8787451. Its live bindings and OAuth settings have not been changed by these source edits.
- Current main includes later application changes. This change does not establish that production dependencies have been replaced. A security-only release from the active application baseline is required.
- Existing Codex MCP processes require a later application restart; no user process or call was stopped.
