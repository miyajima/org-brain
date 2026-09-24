---
name: org-brain-llm-wiki-import
description: Extract compact confirmed decisions and reusable execution lessons from an optional configured LLM Wiki into OrgBrain. Use when the user asks to import, backfill, or synchronize LLM Wiki knowledge into OrgBrain; do not use for ordinary wiki maintenance or general memory capture.
---

# Import LLM Wiki Decisions into OrgBrain

This is an optional OrgBrain-side adapter. LLM Wiki must remain independently
usable, and OrgBrain must remain usable when LLM Wiki is absent.

## Availability

Run `scripts/discover-wiki.mjs` from this skill's actual directory. You may pass
`--config /absolute/path/integration.json` or `--vault /absolute/path` when the
user selected one explicitly.

- `available:false` is a successful no-op. Report the returned reason briefly;
  do not install LLM Wiki, invent a vault, or change integration settings.
- Treat invalid configuration as an error to fix, not as an empty wiki.
- Do not persist the absolute vault or configuration path in OrgBrain.

The helper only discovers eligible Markdown pages and hashes. It never calls
LLM Wiki, writes the vault, extracts memories, or writes OrgBrain.

## Extraction

Read `wiki/index.md`, then only the pages needed for this import. Prefer the
configured LLM Wiki CLI when available. Never scan `raw/`, `wiki/log.md`, hidden
files, symlinks, or the whole vault indiscriminately.

Extract only an atomic item that the page presents as one of:

- a confirmed decision with its rationale and applicability; or
- a completed execution lesson with procedure, verified outcome and reuse
  condition.

Exclude background explanation, sourced facts without a decision, plans,
speculation, unresolved conflicts, page summaries and raw source text. A cited
page is evidence of what the page says; it does not by itself prove an external
system state. Keep at most three candidates per invocation.

Each candidate must include a concise conclusion, rationale, reuse condition,
the vault-relative page and section, and the page SHA-256 returned by discovery.
Never store an absolute path, full page body, raw source, transcript, credential
or unnecessary personal data.

## Deduplication and recording

Search OrgBrain for the candidate's conclusion and reuse condition before
proposing it. Skip an equivalent active memory; do not create a new version just
because the wiki page hash changed.

Interactive writes must use the active OrgBrain backend and its
`orgbrain_memories_propose` then explicit user confirmation then
`orgbrain_memories_confirm` flow. Show the exact conclusion, rationale, reuse
condition and vault-relative source before asking. Do not use a direct upsert or
silently switch between local and cloud backends.

Use a stable external key derived from the vault-relative page, section and
normalized conclusion. Store only vault-relative provenance plus the page hash.
If nothing is confirmed or reusable, record nothing and say so.
