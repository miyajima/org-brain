# Memory policy component replay

Run the same synthetic source history against an explicit current checkout and
an explicit improved checkout:

```sh
node scripts/memory-policy-replay.mjs \
  --current-root /path/to/current-checkout \
  --improved-root /path/to/improved-checkout \
  --output /path/to/new-private-report.json
node --test scripts/memory-policy-replay.test.mjs
```

Each checkout needs its normal frozen dependencies. The output path must be new;
the runner writes a private report and never replaces an existing report. It does
not use a production database, transcripts, authentication or a provider.

The three conditions are `no-memory`, `current`, and `improved`. Each runs in a
fresh process, with a fresh database per case and the same query, principal,
tenant, project, as-of timestamp, top-k and full-payload token budget. No-memory
uses the same current runtime with an empty prior-memory/attempt database. Its
missing guidance is a retained comparison result, not a failed actual task.
Runtime commit, tracked-dirty status, relevant source hashes, fixture hash,
snapshot hash, usage/item/version receipts and full output token counts are
recorded. Raw receipt IDs are random; compare fixture keys and source versions.
Receipts must match final returned evidence, task, project and test purpose.

The invented fixtures cover authoritative policy versus unconfirmed chatter,
explicit correction of a prior version, an applicability exception, retraction,
future source updates, deterministic failure recurrence, changed conditions,
unverified reported failure, project boundaries and read permissions. Events
after the fixed as-of timestamp never enter the database, including later
successes that would otherwise unblock a known failure. Suppression and revision
use the existing lifecycle/version APIs. The fixture's trusted attempt flag
simulates a trusted collector solely to test its gates; it authenticates no real
event or human answer.

Oracle checks are evaluated after retrieval and report failures without changing
the query, thresholds, corpus or source priority to fit the result. They measure
guidance availability, preservation of conditions, source versions and preflight
decisions. The fixture is public and deliberately curated; it is not held out.
Source-priority changes can be compared without asserting that a model followed
the first result or successfully completed a task.

Adoption and verified outcomes remain unobserved. Task time, task tokens, provider
cost and causal savings remain null. These component results must not be counted
as actual-session quality or efficiency gains. Use the separate explicit
conversation-session evaluation for authorized session evidence and actual
task-level measurements for benefit claims.
