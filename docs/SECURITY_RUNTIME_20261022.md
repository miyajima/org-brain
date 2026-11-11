# Security dependency update: 2026-10-22

Node 26.12.1 is the validated runtime. Dependency lock updates remove all High/Critical
matches in the npm audit response. No production deployment is implied.

With the same current source, baseline and candidate node tests both report
503 tests, 492 passes, 9 identical failures and 2 skips. The failures concern
atomic lesson capture; they are not marked fixed. No new node-test failure was found.
The API gateway baseline and candidate both pass all 426 tests, including real-provider
synthetic OAuth/device/refresh/revocation flows with fixture identities and storage.
MCP protocol/conformance, Vitest worktree exclusion, typecheck and build pass.

Vitest 5 requires the gateway to explicitly select the repository configuration
so the Cloudflare Workers test adapter is used. Relative dynamic imports in three
cross-package tests now resolve against import.meta.url. The reporter is default.
Cloudflare binding declarations stay at the existing 4.20260405.1 version, and
API gateway Zod stays at 4.3.6 to preserve the published MCP JSON schema exactly.
The captured tool-manifest test passes unchanged; no production schemas were rewritten.
