#!/usr/bin/env node

/*
 * Deterministic seed lane for VerifiedKnowledgeBundleV1.  It intentionally
 * talks to the same HTTP ingestion endpoint as a collector; it does not write
 * Decision Trace tables directly.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { canonicalJson, createCollectorIdentity, signVerifiedBundle } from "../packages/orgbrain-cli/src/verified-collector.mjs";

const apiUrl = (process.env.ORGBRAIN_LOCAL_API_URL || "http://127.0.0.1:8787").replace(/\/+$/u, "");
const apiKey = process.env.ORGBRAIN_LOCAL_API_KEY || "dev-org-brain-api-key";
const tenantId = process.env.ORGBRAIN_TENANT_ID || "default";
const principal = process.env.ORGBRAIN_COLLECTOR_PRINCIPAL || "user:local-dev";
const keyId = process.env.ORGBRAIN_COLLECTOR_KEY_ID || "verified-seed";
const inputPath = process.argv[2];

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function eventRef(event, isNewInput) {
  const eventDigest = digest({ event_id: event.event_id, text: event.text, occurred_at: event.occurred_at });
  return {
    event_id: event.event_id,
    turn_id: event.turn_id || null,
    digest: eventDigest,
    is_new_input: isNewInput,
    signed_tool_event: Boolean(event.signed_tool_event),
    excerpt: String(event.text).slice(0, 2_000)
  };
}

function span(event, value = event.text) {
  const source = String(event.text);
  const start = Math.max(0, source.toLowerCase().indexOf(String(value).toLowerCase()));
  const excerpt = start ? source.slice(start, start + String(value).length) : source.slice(0, 2_000);
  return { event_id: event.event_id, turn_id: event.turn_id || null, start, end: start + excerpt.length, excerpt };
}

async function makeBundle(event) {
  const decision = String(event.decision || event.text);
  const reason = String(event.reason || "明示された理由を確認した。");
  const refs = [eventRef(event, true)];
  const receipt = {
    receipt_id: "receipt:" + event.event_id,
    event_id: event.event_id,
    evidence_type: event.file_change ? "file_change" : "explicit_confirmation",
    source_span: span(event),
    digest: refs[0].digest,
    is_new_input: true,
    signed_tool_event: Boolean(event.signed_tool_event),
    artifact_ref: event.file_change?.path || null,
    content_hash: event.file_change?.content_hash || null,
    observed_at: event.occurred_at
  };
  const decisionCandidate = {
    candidate_id: "candidate:" + event.event_id + ":decision",
    candidate_type: "decision",
    semantic_key: event.decision_key || null,
    value: decision,
    summary: decision.slice(0, 500),
    source_spans: [span(event, decision)],
    source_event_ids: [event.event_id],
    actor_type: "human",
    actor_id: event.actor_id || principal
  };
  const reasonCandidate = {
    candidate_id: "candidate:" + event.event_id + ":reason",
    candidate_type: "reason",
    value: reason,
    summary: reason.slice(0, 500),
    source_spans: [span(event, reason)],
    source_event_ids: [event.event_id],
    actor_type: "human",
    actor_id: event.actor_id || principal
  };
  const artifact = event.file_change ? {
    candidate_id: "candidate:" + event.event_id + ":artifact",
    candidate_type: "artifact",
    value: event.file_change.path,
    summary: event.file_change.path,
    source_spans: [span(event, event.file_change.path)],
    source_event_ids: [event.event_id],
    artifact_ref: event.file_change.path,
    content_hash: event.file_change.content_hash,
    actor_type: "human",
    actor_id: event.actor_id || principal
  } : null;
  const candidates = [decisionCandidate, reasonCandidate, ...(artifact ? [artifact] : [])];
  const fieldBindings = candidates.map((candidate) => ({
    binding_id: "field:" + candidate.candidate_id + ":value",
    entity: candidate.candidate_type,
    field: "value",
    candidate_id: candidate.candidate_id,
    source_span_index: 0,
    receipt_id: receipt.receipt_id
  }));
  const edges = [{
    binding_id: "edge:decision-reason",
    relation: "decision_reason",
    source_candidate_id: decisionCandidate.candidate_id,
    target_candidate_id: reasonCandidate.candidate_id,
    receipt_ids: [receipt.receipt_id]
  }, ...(artifact ? [{
    binding_id: "edge:reason-artifact",
    relation: "reason_artifact",
    source_candidate_id: reasonCandidate.candidate_id,
    target_candidate_id: artifact.candidate_id,
    receipt_ids: [receipt.receipt_id]
  }] : [])];
  const sourceDigest = digest(refs.map((ref) => ({ event_id: ref.event_id, digest: ref.digest })));
  const eventChainHash = digest(refs.map((ref) => ({ event_id: ref.event_id, digest: ref.digest, is_new_input: ref.is_new_input })));
  return {
    contract_version: "verified-knowledge-bundle/v1",
    tenant_id: tenantId,
    project_id: event.project_id || null,
    task_id: event.task_id || null,
    decision_thread_id: event.decision_thread_id || null,
    bundle_key: "seed:" + event.event_id,
    source_digest: sourceDigest,
    scene_key: [event.project_id || "global", event.task_id || "taskless", event.decision_thread_id || "threadless"].join("\0"),
    new_input_refs: refs,
    background_refs: [],
    extractor_ref: { name: "verified-seed-rules", schema_version: "rules/v1", implementation_digest: null },
    prompt_ref: null,
    model_ref: { provider: "none", model_id: "none", prompt_hash: null },
    extraction_profile_ref: { profile_id: "built-in/default", version: 1, hash: digest({ profile_id: "built-in/default", version: 1 }), scope: "built_in" },
    candidates,
    field_bindings: fieldBindings,
    edge_bindings: edges,
    evidence_receipts: [receipt],
    policy_version: "active-gate/v1",
    collector_key_id: keyId,
    event_chain_hash: eventChainHash,
    created_at: event.occurred_at
  };
}

async function main() {
  if (!inputPath) throw new Error("usage: verified-knowledge-seed.mjs <session.jsonl>");
  const identity = await createCollectorIdentity({ keyId });
  const keyResponse = await fetch(apiUrl + "/v1/memory-collectors/keys", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ tenant_id: tenantId, principal, key_id: keyId, public_key: identity.public_key })
  });
  if (!keyResponse.ok && keyResponse.status !== 409) throw new Error("collector_key_registration_failed:" + keyResponse.status);
  const events = (await readFile(inputPath, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const results = [];
  for (const event of events) {
    const bundle = await makeBundle(event);
    const signed = await signVerifiedBundle(bundle, { keyId });
    const response = await fetch(apiUrl + "/v1/memory-ingestions/verified", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(signed)
    });
    if (!response.ok) throw new Error("verified_ingestion_failed:" + response.status);
    results.push(await response.json());
  }
  process.stdout.write(JSON.stringify({ status: "passed", count: results.length, results }) + "\n");
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.stack || error.message : error) + "\n");
  process.exitCode = 1;
});
