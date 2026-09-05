# Astra Harness Bridge

@/Users/miyajimakazuhiro/projects/astra-harness/ROUTER.md

Read `docs/MEMORY_CAPTURE_HARNESS_COMPATIBILITY.md` only for memory capture,
Context Engine or harness integration changes. Keep project skills under
`skills/` available when explicitly named or relevant; do not load them all.
Installing skills must preserve these project instructions.

## Project Notes

- For Context Engine or harness preflight changes, check bootstrap and contract
  compatibility with the Astra Harness and `docs/MEMORY_CAPTURE_HARNESS_COMPATIBILITY.md`.
- `ORGBRAIN_API_URL` is the canonical environment variable.
  `ORGBRAIN_API_BASE` is a compatibility alias.
- When asked to deploy to Cloudflare, run local validation and a live API smoke
  test.
