# Gold-derived memory capture profile

The Stop-hook quality contract is defined from executable gold data instead of
maintaining a separate list of hand-tuned hook thresholds.

## Source of truth

- Gold inputs and expected candidates:
  `packages/shared/test/fixtures/memory-capture-gold-v1.json`
- Deterministic derivation:
  `scripts/derive-memory-hook-profile.mjs`
- Generated hook profile:
  `packages/shared/src/memory-capture-profile.generated.mjs`
- Hook enforcement:
  `packages/orgbrain-cli/src/hook-memory-bridge.mjs`

The generated profile is imported directly by the hook. Do not edit it by
hand. Its `source_dataset_sha256` makes dataset/profile drift observable.

## What is derived

Accepted gold candidates determine:

- the durable kinds the hook may save;
- required `rationale`, `reuse_rule`, and `evidence` fields;
- minimum rationale and reuse-rule lengths;
- minimum verifiable evidence count for each kind;
- allowed evidence types;
- TTL for each kind.

The dataset safety block fixes the maximum candidate count, atomic-conclusion
requirement, unresolved-Gaps behavior, and rationale/content separation. The
maximum remains capped at three independently of fixture content.

Files must be repository-relative. A final answer is never command evidence.
Command evidence is attached only when the current-turn transcript verifier
matches an actual execution result with an exit code, or verifies the HMAC
attestation emitted by `orgbrain evidence run -- <command>`. Inline identifiers
such as `account_id`, `@org_brain`, and `DevContainer` are not evidence.

## Authoring loop

1. Add or correct an accepted or rejected example in the gold dataset. Every
   accepted candidate must contain one atomic conclusion, a distinct reason, a
   concrete reuse condition, and verifiable evidence.
2. Generate the hook profile:

   ```text
   pnpm memories:derive-hook-config
   ```

3. Check that the committed profile matches the dataset:

   ```text
   pnpm memories:derive-hook-config -- --check
   ```

4. Run the gold, shared-extractor, and hook compatibility tests.
5. Produce a private dry-run seed plan before writing any memory:

   ```text
   pnpm memories:seed-gold -- --output /private/path/gold-plan.json
   ```

6. Inspect the mode-0600 report, then add `--apply` to send the same candidates
   through the normal capture API. MCP is preferred when its service-token
   configuration is complete. REST is limited to loopback unless
   `--allow-remote` is explicit.

## Optional fallback final-answer shape

The verified-learning path does not alter user-facing output. These headings
only improve the lower-recall transcript fallback:

```text
## Conclusion
One durable, atomic rule.

## Rationale
Why the rule exists.

## Reuse
When and where to apply it again.

## Evidence
Repository-relative files, document URLs, and verified commands.

## Gaps
Only unresolved facts; a non-empty section is rejected by strict-gold-v1.
```

Ordinary responses without headings remain supported when the rationale,
evidence, and reuse condition immediately follow their conclusion. Low-quality
responses are skipped rather than padded with invented rationale or evidence.
