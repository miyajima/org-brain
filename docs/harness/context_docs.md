# Context: governed memory quality contracts

- `docs/SPEC.md` requires quality-v2 summaries to expose reusable guidance rather than count-only labels and defines the four memory tiers.
- `docs/SYSTEM_DESIGN.md` assigns daily maintenance to cap-runner and manual destructive cleanup to an export-gated operator workflow.
- The documentation does not currently identify a single shared quality classifier across Cloud and Node runtimes.
- Update SPEC and SYSTEM_DESIGN to make the shared classifier the source of truth and keep mutations deterministic and tenant-scoped.

