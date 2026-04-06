# Org Brain System Design

## Current State
- The API gateway exposes operator utilities, including `pnpm -s usage:status`, which queries the `open-brain` D1 database through Wrangler.
- The usage-status wrapper now retries transient Wrangler/D1 failures before returning a fatal error, so operator snapshots are less sensitive to one-off remote blips.
