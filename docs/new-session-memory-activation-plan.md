---
title: New-session memory activation plan
doc_type: reference
status: draft
owner: org-brain-maintainers
last_updated: 2026-08-16
---

# New-session memory activation plan

## Goal

Make OrgBrain safe to operate from a newly opened Codex session and prove with
runtime evidence that an eligible memory was retrieved, injected or consulted,
used in the answer, and attributed without exposing raw session content.

Hook installation and interactive MCP login remain separate because an
interactive OAuth identity must not be reused by an unattended lifecycle hook.

## Initial setup

Every setup command is a dry run unless `--execute` is present. Commands that
write a lifecycle-hook file additionally require either an interactive `yes`
answer after displaying the exact file and events, or the explicit
`--approve-hooks` flag after a human has reviewed the dry-run output.

### Interactive MCP

```text
orgbrain connector setup codex --mode remote-mcp --url <access-protected-mcp-url>
orgbrain connector setup codex --mode remote-mcp --url <access-protected-mcp-url> --execute
```

The second command performs the Codex OAuth login. It does not install an
automatic hook identity.

### Automatic cloud hooks

Create a pending Codex installation and a dedicated Cloudflare Access Service
Token first. Then review and execute:

```text
orgbrain connector setup codex --mode cloud-hooks \
  --url <access-protected-mcp-url> \
  --workspace <workspace>

orgbrain connector setup codex --mode cloud-hooks \
  --url <access-protected-mcp-url> \
  --workspace <workspace> \
  --execute
```

The execute command asks for hook permission before reading credentials,
activating an installation, or writing files. Non-interactive provisioning must
add `--approve-hooks`; the invocation itself is the recorded human approval.

The Codex plan installs `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PreCompact`, `PostCompact`, and `Stop`, preserving non-OrgBrain
hooks and creating backups.

### Local-only alternative

```text
orgbrain connector setup codex --mode minimal-hooks --workspace <workspace>
orgbrain connector setup codex --mode minimal-hooks --workspace <workspace> --execute
```

This path has the same permission gate and makes no cloud or LLM calls.

## Operational readiness gates

1. `codex mcp get orgbrain --json` reports the interactive MCP registration and
   OAuth login succeeds with a read-only call.
2. The hook credential file exists with mode `0600`; report field presence,
   installation ID, client type, and hostname only.
3. `~/.config/org-brain/workspaces.json` maps the Git common directory to the
   intended tenant and project without persisting the absolute path remotely.
4. Codex is restarted and the user explicitly trusts the displayed OrgBrain
   hooks.
5. Hook errors and outbox are empty after a synthetic lifecycle smoke test.
6. At least one controlled memory is eligible for retrieval: active, observed,
   verified, all seven dimensions at least 95, independent AI consensus, current
   evidence hash, and no hard violation.
7. `MEMORY_QUALITY_UI_MODE=beta|on` exposes the read-only run and usage evidence.
8. Keep learning in `shadow` until capture and retrieval gates pass; move to
   `on` only through a separate reviewed rollout.

## New-session effective-use test

### Fixture and blind query

1. Create one controlled, non-sensitive decision memory with a unique semantic
   fact, rationale, reuse condition, repo-relative evidence, and stable external
   key. Certify it through the normal active gate.
2. Define a held-out user task that needs that decision but does not repeat its
   wording. Keep the expected memory ID outside runtime input.
3. Define an unrelated negative-control task and a source-drift mutation.

### Live execution

1. Close the setup task and start a genuinely new Codex task after restart.
2. Submit the held-out task. Record only session hash, project hash, hook event,
   latency, retrieval/usage ID, memory ID, rank, and token estimate.
3. Require either bounded `UserPromptSubmit` context containing the authorized
   memory ID or an authenticated `orgbrain_context_enrich`/memory-search call
   before the answer is planned.
4. Complete the answer and report whether the memory was used, which lookup it
   avoided, confidence, and an effect outcome. Do not infer `used` merely from
   retrieval.
5. Repeat with memory injection disabled as a blind paired control.
6. Run the unrelated task and source-drift mutation. Both must abstain.

### Pass criteria

- Hook events are installed exactly once and finish inside their timeouts.
- The held-out task retrieves the expected memory in both repeated fresh
  sessions, with no unauthorized or quarantined memory in context.
- An explicit usage item moves from `injected` to `used`, and the answer contains
  the expected decision without copying raw transcript text.
- The paired treatment is non-inferior to control and avoids a source or
  past-context lookup when claimed.
- The unrelated task, quarantined Mac-import cases, source-drift case, and any
  credential/PII fixture are never injected.
- DB, report, hook log, and UI contain no raw transcript, reasoning, absolute
  home path, or credential value.

## Current known gap

The hook implementation has deterministic local injection tests, but a cloud
fresh-session run must also prove the retrieval handoff. Cloud hooks currently
restore task commitments and capture Stop events; automatic general-memory use
must be evidenced by bounded hook context or an interactive MCP context call.
Do not declare production readiness from hook installation alone.
