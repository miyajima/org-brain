---
title: Org Brain concept
doc_type: concept
status: approved
owner: org-brain-maintainers
last_updated: 2026-08-18
---

# Org Brain concept

## Product promise

Org Brain makes the decision and its reason immediately understandable to an
individual, then turns the knowledge behind that decision into a governed,
shareable asset for an organization.

The canonical experience is:

`Decision -> Reason -> Evidence -> Artifact`

Skills and named Agent Loadouts extend that chain into execution. They are a
distribution layer for approved knowledge, not a replacement for the decision
record or its provenance.

## Context

People and agents create useful decisions, procedures, evidence, and outcomes
across local workspaces and shared systems. Those facts lose value when a user
must search several tools to reconstruct why a choice was made, whether it is
still valid, and where it was applied.

## Problem

- Individuals cannot reliably find the current decision, reason, evidence, and
  artifact in one short path.
- Organizations cannot safely turn tacit operating knowledge into a reusable
  form without consistent ownership, access, versioning, and audit semantics.
- Agent context becomes unsafe when distribution configuration can bypass the
  source asset's current access policy or lifecycle state.
- Durable memory is difficult to maintain when uncertain or unsafe capture
  depends on a routine human review queue.

## Product principles

- **Decision first:** every primary surface starts from the decision and keeps
  its reason and evidence close enough to verify without leaving the context.
- **Provenance before automation:** only explicitly selected, version-pinned
  sources may enter Skill generation. Raw conversations, unselected sources,
  and source code are not fetched implicitly.
- **Private by default:** generated Skills always begin as private drafts.
  Publishing is an explicit Owner or administrator action.
- **ACL first:** every read, trace, generation, preview, and runtime resolution
  intersects the current unified access policy. A Loadout never grants access.
- **Explicit over inferred:** normal decision traces show saved and confirmed
  relations. Inferred relations require a deliberate user opt-in.
- **Cloud source of truth:** shared P0 Skills, immutable Skill versions, named
  Agents, Loadouts, policies, and usage records are authoritative in D1; Skill
  file bodies are authoritative in R2 with hashes and metadata in D1.
- **Accessible alternatives:** the map always has keyboard, 2D list, reduced
  motion, and mobile timeline experiences with the same authorized data.
- **Fail closed and recoverable:** provider, schema, storage, policy, or
  verification failure never publishes a partial Skill. Rollback disables the
  new read or resolution path without deleting additive data.

## Goals

- Let an individual reach the decision, reason, evidence, and artifact within
  two transitions from the home briefing.
- Let an organization share a decision, generate and publish a Skill, and bind
  it to a named Agent with an inspectable effective context.
- Keep quality, access, versioning, maintenance, usage, and rollback
  deterministic and auditable.
- Keep existing Memory, Resource, Task, and Operations capabilities available
  as supporting surfaces during the transition.

## Non-goals

- Code graph construction, repository ingestion, and local-only Skill storage
  are not part of the P0 release.
- Loadouts do not override permissions, revive retired or expired Skills, or
  inject unpublished drafts.
- AI quality decisions do not authorize physical deletion, tenant-boundary
  changes, retention-law changes, or edits to hard guardrails.

## Success criteria

The product succeeds when a person can explain what was decided and why from a
single trace, an organization can reuse that verified knowledge through a
published Skill and named Agent, and authorization revocation is reflected on
the next read or context resolution with no hidden-node leakage.

Autonomous capture and maintenance remain fail closed: uncertain candidates
enter quarantine, scheduled evaluation can retry them, and unsafe runs can be
rolled back without depending on a routine human approval queue.
