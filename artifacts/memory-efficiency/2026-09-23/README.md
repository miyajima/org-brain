# Memory efficiency evidence

These are review copies of the component replay, local validation, and 18-run
Codex Pro comparison. Measurements, missing values, acceptance decisions and
original evidence hashes are unchanged. Machine-specific absolute path prefixes
are represented by `$HOME`, `$WORKTREE`, `$BASELINE_ROOT` and `$RUNTIME_ROOT`.

Raw event logs, prompts, answers, retrieval contexts, synthetic SQLite databases,
the frozen source snapshot and validation logs are retained locally under:

```text
$HOME/.org-brain/experiments/memory-efficiency-2026-09-23-72af/
```

`artifacts/` contains the original 137 artifact files, including `live-codex/runs/`.
`archive-receipt.json` records their SHA-256 hashes. `frozen-source/` preserves the
406 measured source files, and `baseline-source/` preserves the baseline modules.
The local archive was verified before removing raw files from the checkout.
[publication.json](publication.json) records this separation and the original
summary hashes. Raw logs and databases are not committed to Git.

The checked-in rows support recalculation of the aggregate measurements. A fresh
audit of native event hashes, answers and frozen workspaces needs the local raw
archive and reconstruction of the workspace paths; the recorded validation results
describe the original run. Path placeholders are not runnable command arguments.
Use the scripts with a new output directory for a new experiment; it consumes
Codex usage.
