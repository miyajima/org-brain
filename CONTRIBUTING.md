# Contributing to Org Brain

Thanks for helping make AI memory portable, inspectable, and useful.

## License

Org Brain is licensed under Apache-2.0. By contributing, you agree that your contribution will be distributed under the same license.

## What Belongs in This Repository

This public repository includes:

- local SQLite memory for personal self-hosting
- Cloudflare self-host source for API, console, Remote MCP, and organization bus
- benchmark and evaluation scripts
- shared schemas, retrieval helpers, and migrations

This repository should not include:

- production secrets or account-specific Cloudflare identifiers
- official SaaS billing or customer administration internals
- private operational runbooks for the managed service
- credentials, tokens, raw customer data, or tenant-specific exports

## Development

```bash
pnpm install
pnpm test
pnpm build
```

Use `pnpm local:memory` for local SQLite memory smoke tests and `pnpm benchmark:tokens` for LongMemEval-S evaluation.

## Pull Request Expectations

- Keep changes scoped and explain the user-facing behavior.
- Add or update tests for retrieval, memory lifecycle, API contracts, or benchmark behavior when those areas change.
- Keep public docs free of prototype feature labels. Product releases are tracked only through SemVer in `CHANGELOG.md` and GitHub Releases.
- Do not commit secrets. Use `.env.example` and `.dev.vars.example` files for documented configuration shape.

## Managed SaaS Boundary

Self-hosting this repository is free under Apache-2.0. The official managed SaaS is a paid service that bundles hosting, authentication, operations, monitoring, backups, and support. Contributions to this repo should keep self-hosting complete while avoiding official SaaS-only billing, customer management, or secret configuration.
