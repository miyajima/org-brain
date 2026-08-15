---
title: Org Brain concept
doc_type: concept
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-15
---

# Org Brain concept

## Context

AI agents create useful decisions, procedures, and failure evidence while
working across local workspaces and shared organizational systems.

## Problem

Durable memory is difficult to maintain safely when every capture requires a
person to inspect, approve, repair, or roll back it. Human queues also make
new installations stop before they can learn from real usage.

## Goals

- Keep durable memory useful without a routine human review queue.
- Route uncertain or unsafe candidates to an automatically re-evaluated
  quarantine.
- Make quality, maintenance, tuning, and rollback deterministic and auditable.

## Non-goals

AI quality decisions do not authorize physical deletion, tenant-boundary
changes, retention-law changes, or edits to hard guardrails.

## Success criteria

New installations scan sessions, qualify evidence, maintain indexes, retry
quarantine, and roll back unsafe runs without operator action; every scope
remains fail-closed when deterministic checks or the independent AI council
cannot provide sufficient evidence.
