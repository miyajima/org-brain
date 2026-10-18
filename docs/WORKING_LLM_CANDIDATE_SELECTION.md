# Working-LLM candidate selection

OrgBrain defaults to `working-llm`. Candidate search still uses the configured
embedding provider. Relevance selection runs in the LLM already handling the
task; OrgBrain starts no second LLM or reranker in this mode.

## Read and apply

1. Search or enrich context. `candidates` are pending previews; `results` and
   memory `evidence` are empty until the caller selects and checks originals.
2. Select directly useful candidates, or select none. Shared topic alone is
   insufficient.
3. For **every** selected candidate, call its `detail_ref` using the same
   principal and task scope. `orgbrain_memory_get` requires the expected version
   and rechecks current permissions, active state, scope and expiry. A missing,
   stale or forbidden source returns `memory_detail_unavailable`.
4. Review the full content, sources, exceptions and current facts before applying
   it. Delivery and detail reads are not adoption, verified use or success.

The preview retains complete summary/rationale/reuse-rule fields, deduplicating
exact repeats. It falls back to content when a summary is absent. It discloses
omitted full content, leaves source records unchanged, and omits optional null
metadata. Context packing drops whole candidates rather than cutting conditions;
only delivered entries receive returned/unknown usage receipts.

The existing automatic hook-use collector does not treat a pending preview as
full-source delivery proof. Without matching detail/action evidence, verified use
remains unassessed. Do not relabel preview receipts as injected full evidence to
make a use counter increase.

CLI and default MCP search share the projection and default to 20 candidates.
Explicit limits are honored. Context honors its complete response token budget,
so it can deliver fewer candidates. The automatic Codex hook retains its separate
two-entry/7,168-byte limits and invokes no reranker. Operational identifiers and
version references remain exact when preview text is redacted.

The `answer-ux-readonly` profile retains its existing two-tool, sanitized summary
contract: it exposes neither internal IDs nor raw bodies. Its internal projection
does not invoke a relevance model. It is separate from the default MCP's pending
candidate/detail workflow.

## Optional Qwen

The npm package contains no Python, MLX or Qwen weights and starts no Qwen service.
Users who want local cross-encoder filtering install the service and pinned model
separately, then explicitly select `qwen3-reranker-mlx` in the database's
`.retrieval.json` or environment. See [setup and measured service behavior](LOCAL_RELEVANCE_SELECTION.md).
An enabled Qwen failure returns no selected memories; it never falls back to raw
candidates. `off` explicitly requests the legacy full-record response.

No retrieval sidecar means `working-llm`. An explicit equivalent is:

```json
{"version":1,"provider":"working-llm"}
```

New CLI/MCP processes read the configuration. Existing MCP connections need to
reconnect after replacing the executable or changing its provider settings.

For CLI-only callers, resolve a selected preview with the same scope:

```sh
orgbrain memory get MEMORY_ID --expected-version VERSION \
  --tenant-id default --project-id PROJECT --work-type implementation
```

Pass `--principal-id` when the search used one. Missing versions and stale or
unauthorized reads return no body.

## Evaluation contract

The fixed 32-question comparison uses 16 known-positive and 16 unrelated queries
from the prior frozen corpus. This fixture was previously used; it is not an
unseen holdout. Labels identify one known target, not every relevant memory.

The fresh baseline receives full normalized records for the same candidates.
The compact arm receives the exact production previews. Every nonempty first
selection gets all selected full records and a second confirmation call, including
on negative queries. The second input retains the initial previews and IDs.
All calls' actual provider input, including common prefixes and repeated context,
is summed. Cache reads/writes are subsets of input, not deducted savings.

The frozen acceptance requires Hit@5 16/16, no unrelated returns, no newly lost
targets, Hit@1 and MRR no worse than the contemporaneous baseline, no failed or
invalid selections, complete input usage, and lower total provider input.
The earlier 4,000-character text-only benchmark has a different payload baseline;
it is retained as a historical reference, not mixed into this paired comparison.

These are selection checks. They do not establish general precision, complete
task-answer quality, billing savings, or equivalent quality for the separately
budgeted context and hook paths.

## Measured result: 2026-10-18

All 81 calls completed with valid IDs and complete usage: 32 full-record calls,
32 preview calls, and 17 full-detail confirmations. There were no per-question
known-target rank regressions.

| Measure | Full records | Previews + mandatory details |
| --- | ---: | ---: |
| Known target first | 15/16 | 15/16 |
| Known target in top five | 16/16 | 16/16 |
| MRR@5 | 0.96875 | 0.96875 |
| Unrelated query with a final result | 0/16 | 0/16 |
| Total actual provider input | 1,037,604 | 848,184 |
| Mean input per question | 32,425.1 | 26,505.8 |
| Median seconds per question, including confirmation | 7.344 | 12.237 |

Total input decreased **18.26% against fresh full records**. The earlier
4,000-character text-only experiment used 24,422.8 input tokens per question;
the new two-stage total is **8.53% higher than that historical reference**.
Reduction against that earlier method was not achieved. The payloads and runs
differ, so it is not the contemporaneous paired baseline.

Preview-only selection returned a candidate for one unrelated question. Full
detail confirmation removed it. Skipping the required detail step would not
retain the measured negative-query result. Smaller final result counts do not
establish better precision because labels are not exhaustive.

The Codex CLI was explicitly configured as `gpt-6.1-sol` with `high` effort in
both arms. Its structured usage events do not independently attest the provider's
model identity. Times include fresh CLI startup, so they do not measure marginal
latency inside an existing working turn. Cache input was counted as input, not
deducted; no monetary saving is claimed.

Safe aggregate: [working-llm-candidates-20261018.json](../artifacts/embeddinggemma2-evaluation-20261017/working-llm-candidates-20261018.json).
Raw source records, labels, prompts, answers and receipts remain in the private
evaluation directory. Frozen attempts are not overwritten.

## Local activation and recovery: 2026-10-18

The standard `~/.org-brain/memory.sqlite.retrieval.json` now contains
`{"version":1,"provider":"working-llm"}`. The normal runtime alias
`~/.org-brain/runtimes/attempt-pilot-current` points to
`working-llm-default-20261018`. The embedding configuration is preserved.
The build uses base `87cdb4941f8e997a27a19cb59f546709a2f32b92` plus the recorded
retrieval overlay; unrelated dirty extraction changes were excluded.

`com.orgbrain.local-reranker` was idle, then disabled and unloaded. Its port 11435
was closed during fresh configured MCP and normal CLI searches. Search returned
six pending previews, context returned four within 2,314/2,500 estimated tokens,
and a pinned full detail resolved. A separate synthetic hook check through the
normal alias returned a bounded pending preview. These checks prove delivery and
detail access; they do not perform or prove final LLM adoption.

Existing MCP connections retain the code loaded when they started. Reconnect
them to use the new default. Other chats' processes were not terminated.

Qwen's model, Python environment and plist are retained for optional reuse.
Backups are in `~/.org-brain/backups/working-llm-default-20261018/`.
To restore this installation's Qwen mode, enable
`gui/$(id -u)/com.orgbrain.local-reranker`, bootstrap its preserved LaunchAgent,
verify health, restore the backed-up `.retrieval.json`, and reconnect MCP.
Keep the new runtime: it still supports explicit Qwen mode. Restore the old
runtime alias from `before-switch.json` only if rolling back the implementation.
These recovery steps are documented, not executed in this activation.

Validation passed: 42 focused tests, 32 hook tests (two skipped), 88 judgment
tests, typecheck, lint, independent review, and all ten other resumed root test
phases. The final complete Node run was 491 passed, nine failed and two skipped.
The nine failures belong to existing dirty extraction capture code; the same
23-case suite passes on the isolated build base and retrieval overlay. Therefore
the repository-wide `pnpm test` is **not green**. No extraction fix is included
in this runtime change.

The standalone package dry run contains 13 files (4,216,097 packed bytes), with
no Python environment, MLX libraries or model weights. No dependency or lockfile
change was needed. See the [safe runtime verification](../artifacts/embeddinggemma2-evaluation-20261017/working-llm-runtime-verification-20261018.json).
