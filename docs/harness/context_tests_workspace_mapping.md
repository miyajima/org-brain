# Test Context: Workspace Mapping

- `scripts/hook-memory-bridge.test.mjs` already covers first-use prompting, persistence, reuse, basename fallback, explicit global project scope, and memory-mode flags.
- New focused tests must cover secure file modes, atomic persistence, legacy migration, mapping precedence, environment fallback, corrupted config handling, and organization fail-closed behavior.
- `scripts/memory-quality-backfill.test.mjs` covers project mapping warnings and should prove that workspace mappings remove warnings without changing default behavior.
- Manifest verification is repository typecheck, full test, lint, and Cloudflare dry-run build.
