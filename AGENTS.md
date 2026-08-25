# Adaptive Outcome Harness Bridge

Use the Adaptive Outcome Harness router installed on this machine:
- `/Users/miyajimakazuhiro/projects/adaptive-outcome-harness/ROUTER.md`

Project-specific compatibility contract:
- `docs/MEMORY_CAPTURE_HARNESS_COMPATIBILITY.md`

Also read:
- `/Users/miyajimakazuhiro/.codex/RTK.md`

Use only the canonical paths above. If an instruction contains a different
home directory, treat it as stale and do not execute it.

If instructions conflict, use this priority:
1. Direct user request
2. Safety or platform policy
3. Tool adapter file in this workspace
4. Adaptive Outcome Harness Router instructions
5. Private or project skill instructions
6. Project notes below

## Skills

Keep both skill locations available:
- Private skills: `/Users/miyajimakazuhiro/.agents/skills/*/SKILL.md`
- Project skills: `/Users/miyajimakazuhiro/projects/org-brain/skills/*/SKILL.md`

When a user names a skill, or the task clearly matches a skill description, read
and follow that skill without replacing this harness bridge. Installing or
updating private skills must not overwrite this file; merge any required skill
discovery instructions into the `Skills` section instead.

## Execution contract

- Do not use `claude -p`.
- Use the current agent for ordinary implementation work.
- Use the Adaptive Outcome Harness Router for code-search preflight,
  autonomous first-pass execution, terminal quality checks, and cost-aware
  delegation.
- Load the full Adaptive Outcome Harness skill only when the Router's
  delegation admission conditions require it.
- Use Codex App sub-agents only for explicitly delegable parallel or supporting
  work.
- Mention the execution route in the final report only when work was delegated
  to another agent or external runtime.

## Project Notes

- For Context Engine or harness preflight changes, check bootstrap and contract
  compatibility with the Adaptive Outcome Harness Router.
- `ORGBRAIN_API_URL` is the canonical environment variable.
  `ORGBRAIN_API_BASE` is a compatibility alias.
- When asked to deploy to Cloudflare, run local validation and a live API smoke
  test.
