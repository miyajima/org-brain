# Memory extraction input preservation and budget diagnostics

The deployed configuration and the source implementation are separate. Source
changes do not replace an installed CLI or enable provider extraction. Keep
`ORGBRAIN_MEMORY_EXTRACTION_MODE`, coverage exact allowlists, A+ selection and the
v3 external-send stop unchanged until separately qualified.

## Budget units

`memory-extraction-provider-contract-runtime.mjs` keeps the live input ceiling at
2,000, output at 800 and candidates at three. Input is a conservative UTF-8 byte
upper bound over the prompt and strict JSON schema, plus a fixed provider
envelope reserve. It is not the provider tokenizer count. Coverage stages up to
16 spans/16 KiB but sends at most eight spans per request and at most two requests.

Budget complete evidence before shortening it. Coverage dependency groups are
atomic. The ordinary one-pass packer still permits clipping the first selected
span and reports `clipped_input_budget`; subsequent omitted spans report
`input_budget`, and candidates beyond the per-request span bound report
`span_limit`. These diagnostics contain IDs, counts and reason codes, never source
bodies. They do not claim that every omitted span was useful.

Inspect collection/read diagnostics first, then pool/input omissions, generated
output, verifier rejections, merge conflicts and `candidate_limit`. Unexecuted
stages remain unmeasured. A missing source, a legitimate safety refusal, a model
omission and a verifier rejection have different denominators.

CLI packing, API admission and worker execution use the shared coverage packer:
only selected call IDs contribute request events, while the complete event pool
remains staged for verification. API admission rejects an oversized selection
instead of silently accepting a smaller subset. Include a CLI-to-enqueue fixture
with unrelated pool events when changing this boundary.

Exclude injected user-format contexts (including AGENTS instructions) before
sentence splitting. Direct coordination and named MCP chat reads/results are
excluded; opaque wrappers remain an identification gap. Human decision reasons,
rejected alternatives and applicability require literal human support. Separate
groups alone do not prevent assistant text from being attributed to a user. Reject
duplicate candidate field names before refinement and normalization so different
consumers cannot choose different values. Coordination filtering and ordinary
tool parsing use the same tool-name reader, including supported MCP formats.

## Reproducible offline source comparison

The experiment runner is
`artifacts/hy-memory-evaluation-20261017/evaluate_implementation_budget.mjs`.
It requires the previously frozen private corpus and a new `implementation-vN`
run name. It preserves historical source at the original commit, copies current
source, then changes only input-ceiling literals in isolated 4,000/8,000 variants.
It fingerprints all copied modules and refuses to overwrite an existing run.
Existing local dependencies are reused without installation. Fetch is disabled;
no API, memory database, enqueue, promotion or production settings are accessed.

```sh
node artifacts/hy-memory-evaluation-20261017/evaluate_implementation_budget.mjs implementation-vN
node artifacts/hy-memory-evaluation-20261017/measure_offline_budget_tokens.mjs implementation-vN
```

The tokenizer diagnostic uses installed `js-tiktoken` with `o200k_base`, records
its version/rank hash, and counts prompt/schema/name text separately from a
256-token envelope reserve. These are local reference estimates, not attested
model tokenization, API usage or billed cost. No encoder table is downloaded and
no model runs. Human semantic labels, complete two-pass generation/verification
and provider fees remain necessary before quality or economic qualification.

Keep raw conversations and case packets in the private evaluation directory.
Only source-free aggregate counts/hashes belong in Git or the personal Wiki.
Do not broaden the production budget merely because an offline variant admits
more text. Measure preservation of reasons, exceptions, negation, numbers and
verified outcomes together with actual provider usage and fees.

## Checks and rollback boundary

Use the loader, evidence, provider-contract, coverage, hook, enqueue and worker
tests. Verify type checks, lint, the shared contract check and API/worker policy
compatibility. Fixture providers prove execution mechanics, not model accuracy.
Keep human gold and semantic review explicitly pending until actually completed.

Policy changes reject queued jobs carrying old hashes before provider transport,
preserving their reservations and checkpoints. Future deployment must pause
admission and preserve old jobs with a matching implementation, never rewrite
their hashes. Rollback switches source/runtime versions and disables admission;
it does not delete experiment data or rewrite existing memories. The existing
exact-allowlist and rollout requirements still apply.
