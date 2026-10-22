import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PIPELINE_EXTRACTION_MODEL,
  DEFAULT_PIPELINE_REVIEW_MODELS,
  MEMORY_PIPELINE_REVIEW_PROFILES,
  MEMORY_PIPELINE_REVIEW_POLICY_HASH,
  canonicalPipelineReviewHash,
  createOpenRouterPipelineExtractor,
  createOpenRouterPipelineJudge,
  getPipelineReviewPolicyDescriptor,
  getPipelineReviewPolicyHash,
  reviewPipelineCandidate,
  verifyPipelineReviewReceipt
} from '../packages/orgbrain-cli/src/lib/memory-pipeline-review.mjs';

const validUsage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const result = (overrides = {}) => ({ model: 'openai/gpt-5.4', provider: 'OpenAI', verdict: 'pass', confidence: 0.99, reasons: [], usage: validUsage, ...overrides });
const policyResult = (profile, overrides = {}) => result({
  model: DEFAULT_PIPELINE_REVIEW_MODELS[profile],
  provider: profile === 'durability_atomicity' ? 'Google' : 'Anthropic',
  ...overrides
});
const alwaysPass = async ({ profile }) => policyResult(profile);
const rehashReceipt = (receipt) => {
  const copy = structuredClone(receipt);
  copy.responses_hash = canonicalPipelineReviewHash(copy.profiles);
  const { receipt_hash: _oldHash, ...unsigned } = copy;
  copy.receipt_hash = canonicalPipelineReviewHash(unsigned);
  return copy;
};

test('three sequential profile judgments accept only strict pass with two actual model families', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const receipt = await reviewPipelineCandidate({ snapshot: { content: 'source' }, candidate: { claim: 'claim' }, runJudge: async (input) => {
    calls.push(input.profile);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    return alwaysPass(input);
  } });
  assert.deepEqual(calls, [...MEMORY_PIPELINE_REVIEW_PROFILES]);
  assert.equal(maxActive, 1);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.status, 'accepted');
  assert.equal(new Set(receipt.profiles.map((run) => run.model_family)).size, 2);
  assert.deepEqual(receipt.usage_totals, { input_tokens: 30, output_tokens: 6, total_tokens: 36 });
  assert.match(receipt.snapshot_hash, /^[a-f0-9]{64}$/u);
  assert.match(receipt.candidate_hash, /^[a-f0-9]{64}$/u);
  assert.match(receipt.responses_hash, /^[a-f0-9]{64}$/u);
  assert.match(receipt.receipt_hash, /^[a-f0-9]{64}$/u);
});

test('same vendor under three different profile labels is not model-family diversity', async () => {
  const receipt = await reviewPipelineCandidate({ snapshot: {}, candidate: {}, runJudge: async () => result({ model: 'openai/gpt-5.4' }) });
  assert.equal(receipt.accepted, false);
  assert.ok(receipt.reason_codes.includes('model_family_diversity_required'));
});

test('unanimous profile passes admit valid confidence as diagnostic metadata', async () => {
  const snapshot = { content: 'source' };
  const candidate = { content: 'claim' };
  const confidences = { evidence_entailment: 0.90, durability_atomicity: 0.98, future_reuse_overgeneralization: 0.88 };
  const receipt = await reviewPipelineCandidate({ snapshot, candidate, runJudge: async ({ profile }) =>
    policyResult(profile, { confidence: confidences[profile] }) });
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.reason_codes.includes('confidence_below_threshold'), false);
  assert.equal(verifyPipelineReviewReceipt(receipt, { snapshot, candidate }), true);
  assert.deepEqual(receipt.profiles.map((run) => run.confidence), [0.90, 0.98, 0.88]);
});

test('profile model policy mismatch rejects aggregation and a rehashed wrong-model receipt', async () => {
  const snapshot = { content: 'source' };
  const candidate = { content: 'claim' };
  const rejected = await reviewPipelineCandidate({ snapshot, candidate, runJudge: async ({ profile }) =>
    profile === 'evidence_entailment'
      ? policyResult(profile, { model: 'anthropic/claude-sonnet-5.6' })
      : policyResult(profile) });
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.reason_codes.includes('policy_model_mismatch'));

  const receipt = await reviewPipelineCandidate({ snapshot, candidate, runJudge: alwaysPass });
  const tampered = structuredClone(receipt);
  tampered.profiles[0].model = 'anthropic/claude-sonnet-5.6';
  tampered.profiles[0].model_family = 'anthropic';
  assert.equal(verifyPipelineReviewReceipt(rehashReceipt(tampered), { snapshot, candidate }), false);
});

test('any fail verdict rejects even when every confidence value is valid', async () => {
  const receipt = await reviewPipelineCandidate({ snapshot: {}, candidate: {}, runJudge: async (input) =>
    policyResult(input.profile, input.profile === 'evidence_entailment'
      ? { verdict: 'fail', confidence: 0.90 }
      : { confidence: 0.99 }) });
  assert.equal(receipt.accepted, false);
  assert.ok(receipt.reason_codes.includes('judge_verdict_failed'));
});

test('missing and invalid confidence metadata rejects otherwise passing judgments', async () => {
  for (const confidence of [undefined, Number.NaN, -0.01, 1.01]) {
    const receipt = await reviewPipelineCandidate({ snapshot: {}, candidate: {}, runJudge: async ({ profile }) =>
      policyResult(profile, { confidence }) });
    assert.equal(receipt.accepted, false);
    assert.ok(receipt.reason_codes.includes('judgment_malformed'));
  }
});

test('malformed judgments and incomplete usage reject without fabricating zero tokens', async () => {
  const receipt = await reviewPipelineCandidate({ snapshot: {}, candidate: {}, runJudge: async (input) => policyResult(input.profile, {
    usage: input.profile === 'durability_atomicity' ? { input_tokens: 0, output_tokens: 0 } : validUsage,
    confidence: input.profile === 'evidence_entailment' ? Number.NaN : 0.99
  }) });
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.usage_totals, null);
  assert.ok(receipt.reason_codes.includes('judgment_malformed'));
  assert.ok(receipt.reason_codes.includes('usage_invalid'));
  assert.equal(receipt.profiles.find((run) => run.profile === 'durability_atomicity').usage, null);
});

test('aggregate usage that exceeds safe integer range remains unknown', async () => {
  const receipt = await reviewPipelineCandidate({ snapshot: {}, candidate: {}, runJudge: async ({ profile }) => policyResult(profile, {
    usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER }
  }) });
  assert.equal(receipt.usage_totals, null);
  assert.ok(receipt.reason_codes.includes('usage_invalid'));
});

test('judge exceptions return a rejected, cryptographically bound receipt', async () => {
  const receipt = await reviewPipelineCandidate({ snapshot: { a: 1 }, candidate: { b: 2 }, runJudge: async ({ profile }) => {
    if (profile === 'durability_atomicity') throw new Error('private transport detail');
    return policyResult(profile);
  } });
  assert.equal(receipt.accepted, false);
  assert.ok(receipt.reason_codes.includes('judge_call_failed'));
  assert.equal(JSON.stringify(receipt).includes('private transport detail'), false);
  assert.equal(receipt.usage_totals, null);
  assert.match(receipt.receipt_hash, /^[a-f0-9]{64}$/u);
});

test('snapshot, candidate, and normalized responses are bound into stable hashes', async () => {
  const runJudge = async (input) => policyResult(input.profile);
  const first = await reviewPipelineCandidate({ snapshot: { b: 2, a: 1 }, candidate: { z: 'x' }, runJudge });
  const reordered = await reviewPipelineCandidate({ snapshot: { a: 1, b: 2 }, candidate: { z: 'x' }, runJudge });
  const changed = await reviewPipelineCandidate({ snapshot: { a: 1, b: 3 }, candidate: { z: 'x' }, runJudge });
  assert.equal(first.receipt_hash, reordered.receipt_hash);
  assert.notEqual(first.snapshot_hash, changed.snapshot_hash);
  assert.notEqual(first.receipt_hash, changed.receipt_hash);
});

test('canonical review hash is stable across object key order', () => {
  assert.equal(canonicalPipelineReviewHash({ b: 2, a: 1 }), canonicalPipelineReviewHash({ a: 1, b: 2 }));
  assert.notEqual(canonicalPipelineReviewHash({ a: 1 }), canonicalPipelineReviewHash({ a: 2 }));
});

test('default model identities and review policy hash are canonical and change with model configuration', () => {
  assert.deepEqual(DEFAULT_PIPELINE_REVIEW_MODELS, {
    evidence_entailment: 'anthropic/claude-sonnet-5.5',
    durability_atomicity: 'google/gemini-3.8-flash',
    future_reuse_overgeneralization: 'anthropic/claude-sonnet-5.5'
  });
  assert.equal(DEFAULT_PIPELINE_EXTRACTION_MODEL, 'anthropic/claude-haiku-5.5');
  const descriptor = getPipelineReviewPolicyDescriptor();
  assert.equal(descriptor.extractor.sensitive_input_screen_version, 'wiki-identifiers-phone-only/v3');
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.consensus), true);
  assert.equal(Object.isFrozen(descriptor.review_models), true);
  assert.equal(Object.isFrozen(descriptor.provider.max_price), true);
  assert.deepEqual(Object.keys(descriptor), [...Object.keys(descriptor)].sort());
  assert.equal(canonicalPipelineReviewHash(descriptor), MEMORY_PIPELINE_REVIEW_POLICY_HASH);
  assert.match(MEMORY_PIPELINE_REVIEW_POLICY_HASH, /^[a-f0-9]{64}$/u);
  assert.equal(MEMORY_PIPELINE_REVIEW_POLICY_HASH, getPipelineReviewPolicyHash());
  const reordered = Object.fromEntries(Object.entries(DEFAULT_PIPELINE_REVIEW_MODELS).reverse());
  assert.equal(getPipelineReviewPolicyHash({ modelByProfile: reordered }), MEMORY_PIPELINE_REVIEW_POLICY_HASH);
  assert.notEqual(getPipelineReviewPolicyHash({ modelByProfile: { evidence_entailment: 'anthropic/claude-sonnet-5.6' } }), MEMORY_PIPELINE_REVIEW_POLICY_HASH);
  assert.notEqual(getPipelineReviewPolicyHash({ extractionModel: 'google/gemini-3.8-flash' }), MEMORY_PIPELINE_REVIEW_POLICY_HASH);
  assert.throws(() => getPipelineReviewPolicyHash({ nonce: 'arbitrary' }), /pipeline_review_policy_override_invalid/);
  assert.throws(() => getPipelineReviewPolicyDescriptor({ minimumConfidence: 0.1 }), /pipeline_review_policy_override_invalid/);
});

test('receipt verifier recomputes input, response, and receipt hashes against strict judgments', async () => {
  const snapshot = { content: 'source' };
  const candidate = { content: 'claim' };
  const receipt = await reviewPipelineCandidate({ snapshot, candidate, runJudge: alwaysPass });
  assert.equal(verifyPipelineReviewReceipt(receipt, { snapshot, candidate }), true);
  assert.equal(receipt.policy_hash, MEMORY_PIPELINE_REVIEW_POLICY_HASH);
  assert.deepEqual(receipt.policy_descriptor, getPipelineReviewPolicyDescriptor());
  assert.equal(verifyPipelineReviewReceipt(receipt, { snapshot: { content: 'changed' }, candidate }), false);
  assert.equal(verifyPipelineReviewReceipt(receipt, { snapshot, candidate: { content: 'changed' } }), false);

  const responseTamper = structuredClone(receipt);
  responseTamper.profiles[0].verdict = 'fail';
  assert.equal(verifyPipelineReviewReceipt(responseTamper, { snapshot, candidate }), false);
  assert.equal(verifyPipelineReviewReceipt({ ...receipt, responses_hash: '0'.repeat(64) }, { snapshot, candidate }), false);

  const policyTamper = structuredClone(receipt);
  policyTamper.policy_descriptor.consensus.minimum_confidence = 0.1;
  policyTamper.policy_hash = canonicalPipelineReviewHash(policyTamper.policy_descriptor);
  assert.equal(verifyPipelineReviewReceipt(rehashReceipt(policyTamper), { snapshot, candidate }), false);

  const legacyThresholdReceipt = structuredClone(receipt);
  delete legacyThresholdReceipt.policy_descriptor.consensus.confidence_rule;
  legacyThresholdReceipt.policy_descriptor.consensus.minimum_confidence = 0.98;
  legacyThresholdReceipt.policy_hash = canonicalPipelineReviewHash(legacyThresholdReceipt.policy_descriptor);
  assert.notEqual(legacyThresholdReceipt.policy_hash, MEMORY_PIPELINE_REVIEW_POLICY_HASH);
  assert.equal(verifyPipelineReviewReceipt(rehashReceipt(legacyThresholdReceipt), { snapshot, candidate }), false);
});

test('receipt verifier rejects rehashed profile-flag, family, verdict, and confidence tampering', async () => {
  const snapshot = { content: 'source' };
  const candidate = { content: 'claim' };
  const receipt = await reviewPipelineCandidate({ snapshot, candidate, runJudge: alwaysPass });

  const forgedFlag = rehashReceipt({ ...receipt, accepted: false, pass: true });
  assert.equal(verifyPipelineReviewReceipt(forgedFlag, { snapshot, candidate }), false);

  for (const mutate of [
    (copy) => { copy.profiles[2].model = 'openai/o3'; copy.profiles[2].model_family = 'openai'; },
    (copy) => { copy.profiles[1].verdict = 'fail'; },
    (copy) => { copy.profiles[1].confidence = 1.01; },
    (copy) => { copy.profiles[0].model_family = 'openai'; },
  ]) {
    const tampered = structuredClone(receipt);
    mutate(tampered);
    assert.equal(verifyPipelineReviewReceipt(rehashReceipt(tampered), { snapshot, candidate }), false);
  }
});

test('OpenRouter judge uses strict JSON, no fallback/data collection, and accepts a versioned same-family model', async () => {
  const requested = 'openai/gpt-5.4';
  let captured;
  const judge = createOpenRouterPipelineJudge({ apiKey: 'test-key', modelByProfile: Object.fromEntries(MEMORY_PIPELINE_REVIEW_PROFILES.map((profile) => [profile, requested])), fetchImpl: async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ model: 'openai/gpt-5.4-2026-01-22', provider: 'OpenAI', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdict: 'pass', confidence: 0.99, reasons: [] }) } }] }) };
  } });
  const response = await judge({ profile: 'evidence_entailment', snapshot: { source: 'proof' }, candidate: { claim: 'claim' } });
  assert.equal(response.model, 'openai/gpt-5.4-2026-01-22');
  assert.deepEqual(response.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
  assert.equal(captured.body.model, requested);
  assert.deepEqual(captured.body.provider, {
    only: ['google-vertex/global'], allow_fallbacks: false, require_parameters: true,
    data_collection: 'deny', zdr: true, max_price: { prompt: 2, completion: 10 }
  });
  assert.equal(captured.body.response_format.type, 'json_schema');
  assert.equal(captured.body.response_format.json_schema.strict, true);
});

test('OpenRouter judge rejects a different returned model family or unknown token totals', async () => {
  const config = { apiKey: 'test-key', modelByProfile: Object.fromEntries(MEMORY_PIPELINE_REVIEW_PROFILES.map((profile) => [profile, 'openai/gpt-5.4'])) };
  const mismatch = createOpenRouterPipelineJudge({ ...config, fetchImpl: async () => ({ ok: true, json: async () => ({
    model: 'anthropic/claude-4-sonnet', provider: 'Anthropic', usage: validUsage,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdict: 'pass', confidence: 0.99, reasons: [] }) } }]
  }) }) });
  await assert.rejects(mismatch({ profile: 'evidence_entailment', snapshot: {}, candidate: {} }), /pipeline_review_model_mismatch/);

  const unknownUsage = createOpenRouterPipelineJudge({ ...config, fetchImpl: async () => ({ ok: true, json: async () => ({
    model: 'openai/gpt-5.4', provider: 'OpenAI', usage: { prompt_tokens: 5, completion_tokens: 2 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdict: 'pass', confidence: 0.99, reasons: [] }) } }]
  }) }) });
  await assert.rejects(unknownUsage({ profile: 'evidence_entailment', snapshot: {}, candidate: {} }), /pipeline_review_usage_invalid/);
});

test('OpenRouter judge rejects incomplete generation and oversized input', async () => {
  const config = { apiKey: 'test-key', modelByProfile: Object.fromEntries(MEMORY_PIPELINE_REVIEW_PROFILES.map((profile) => [profile, 'openai/gpt-5.4'])) };
  const truncated = createOpenRouterPipelineJudge({ ...config, fetchImpl: async () => ({ ok: true, json: async () => ({
    model: 'openai/gpt-5.4', provider: 'OpenAI', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    choices: [{ finish_reason: 'length', message: { content: '{}' } }]
  }) }) });
  await assert.rejects(truncated({ profile: 'evidence_entailment', snapshot: {}, candidate: {} }), /pipeline_review_incomplete_output/);
  const bounded = createOpenRouterPipelineJudge({ ...config, maxInputChars: 40, fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(bounded({ profile: 'evidence_entailment', snapshot: { x: 'a'.repeat(50) }, candidate: {} }), /pipeline_review_input_too_large/);
});

test('OpenRouter extractor returns a bounded source-grounded candidate with actual model and usage', async () => {
  let captured;
  let fetchCalls = 0;
  const extractor = createOpenRouterPipelineExtractor({ apiKey: 'test-key', fetchImpl: async (url, options) => {
    fetchCalls += 1;
    captured = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({
      model: 'anthropic/claude-haiku-5.5-2026-01-22', provider: 'Anthropic',
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidate: {
        content: 'Use the cache for repeated reads; bypass it for production writes.',
        rationale: 'The source names both the procedure and its exception.',
        reuse_rule: 'Apply to repeated reads; do not use for production writes.',
        kind: 'fact', support_refs: ['span-cache', 'span-exception']
      } }) } }]
    }) };
  } });
  const snapshot = { support_span_ids: ['span-cache', 'span-exception'], snippets: [
    { span_id: 'span-cache', text: 'Use the cache for repeated reads.' },
    { span_id: 'span-exception', text: 'Bypass for production writes.' }
  ] };
  const result = await extractor({ snapshot });
  assert.deepEqual(result, {
    candidate: {
      content: 'Use the cache for repeated reads; bypass it for production writes.',
      rationale: 'The source names both the procedure and its exception.',
      reuse_rule: 'Apply to repeated reads; do not use for production writes.',
      kind: 'fact', support_refs: ['span-cache', 'span-exception']
    },
    model: 'anthropic/claude-haiku-5.5-2026-01-22', provider: 'Anthropic',
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 }
  });
  assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(captured.body.provider, {
    only: ['google-vertex/global'], allow_fallbacks: false, require_parameters: true,
    data_collection: 'deny', zdr: true, max_price: { prompt: 2, completion: 10 }
  });
  assert.equal(captured.body.response_format.type, 'json_schema');
  assert.equal(captured.body.response_format.json_schema.strict, true);
  assert.equal(captured.body.model, DEFAULT_PIPELINE_EXTRACTION_MODEL);
  assert.equal(captured.body.max_tokens, 1200);
  assert.equal(captured.body.response_format.json_schema.schema.properties.candidate.anyOf[1].properties.content.maxLength, 600);
  assert.equal(fetchCalls, 1);
  const instructions = captured.body.messages.map((message) => message.content).join('\n');
  assert.match(instructions, /untrusted/iu);
  assert.match(instructions, /historical execution/iu);
  assert.match(instructions, /human approval/iu);
  assert.match(instructions, /single short atomic technical behavior/iu);
  assert.match(instructions, /caveat/iu);
});

test('extractor abstention is accepted, but invented or duplicate support references are rejected', async () => {
  const config = { apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({
    model: 'anthropic/claude-haiku-5.5', provider: 'Anthropic', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidate: null }) } }]
  }) }) };
  const abstain = createOpenRouterPipelineExtractor(config);
  assert.equal((await abstain({ snapshot: { sources: [] } })).candidate, null);
  const fabricated = createOpenRouterPipelineExtractor({ ...config, fetchImpl: async () => ({ ok: true, json: async () => ({
    model: 'anthropic/claude-haiku-5.5', provider: 'Anthropic', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidate: { content: 'A fact.', rationale: 'A reason.', reuse_rule: 'When applicable.', kind: 'fact', support_refs: ['invented-id', 'invented-id'] } }) } }]
  }) }) });
  await assert.rejects(fabricated({ snapshot: { sources: [{ ref: 'source:11111111-1111-4111-8111-111111111111@1' }] } }), /pipeline_extractor_candidate_invalid/);
});

test('extractor accepts only exact Wiki source references present in the snapshot', async () => {
  const ref = 'source:11111111-1111-4111-8111-111111111111@1#L2-L3';
  const extractor = createOpenRouterPipelineExtractor({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({
    model: 'anthropic/claude-haiku-5.5', provider: 'Anthropic', usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidate: {
      content: 'Keep the source constraint.', rationale: 'The cited source states it directly.',
      reuse_rule: 'Apply only within the source scope.', kind: 'constraint', support_refs: [ref]
    } }) } }]
  }) }) });
  const result = await extractor({ snapshot: { sources: [{ ref, text: 'A bounded constraint.' }] } });
  assert.deepEqual(result.candidate.support_refs, [ref]);
});

test('extractor accepts 600-character fields but rejects oversized candidate before returning it', async () => {
  const ref = 'span-boundary';
  const response = (content) => ({
    model: DEFAULT_PIPELINE_EXTRACTION_MODEL, provider: 'Google',
    usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidate: {
      content, rationale: 'r'.repeat(600), reuse_rule: 'u'.repeat(600), kind: 'fact', support_refs: [ref]
    } }) } }]
  });
  const snapshot = { support_span_ids: [ref] };
  const atLimit = createOpenRouterPipelineExtractor({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => response('c'.repeat(600)) }) });
  assert.equal((await atLimit({ snapshot })).candidate.content.length, 600);
  const oversized = createOpenRouterPipelineExtractor({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => response('c'.repeat(601)) }) });
  await assert.rejects(oversized({ snapshot }), /pipeline_extractor_candidate_invalid/);
});

test('sensitive source text and home paths are rejected before either OpenRouter request', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error('sensitive input reached fetch');
  };
  const extractor = createOpenRouterPipelineExtractor({ apiKey: 'test-key', fetchImpl });
  const sensitiveInputs = [
    'token=sk-proj-00000000000000000000',
    'Contact person@example.com for details.',
    'Call +1 (202) 555-0100 today.',
    'Source path /Users/example-user/private/secret.txt',
  ];
  for (const text of sensitiveInputs) {
    await assert.rejects(extractor({ snapshot: { content: text, sensitive: false } }), /pipeline_extractor_sensitive_input/);
  }
  const judge = createOpenRouterPipelineJudge({
    apiKey: 'test-key', fetchImpl,
    modelByProfile: Object.fromEntries(MEMORY_PIPELINE_REVIEW_PROFILES.map((profile) => [profile, 'openai/gpt-5.4']))
  });
  await assert.rejects(judge({
    profile: 'evidence_entailment', snapshot: { content: 'clean source' },
    candidate: { content: 'Contact person@example.com.', sensitive: false }
  }), /pipeline_review_sensitive_input/);
  assert.equal(fetchCalls, 0);
});

test('only canonical Wiki revision UUID phone matches pass screening; project scope and other fields remain screened', async () => {
  const revisionId = '0cea8d5f-1c26-4d5a-bd26-3000868773ed';
  const pageId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const hash = 'a'.repeat(64);
  const sourceKey = (projectId = 'org-brain', revision = revisionId) =>
    `wiki:personal:default:${projectId}:${pageId}:${revision}:${hash}`;
  const snapshot = (overrides = {}) => ({
    source_type: 'personal_wiki', tenant_id: 'default', project_id: 'org-brain',
    page_id: pageId, revision_id: revisionId, hash, source_key: sourceKey(),
    text: '検索結果はページの本文に限定する。', ...overrides,
  });
  let fetchCalls = 0;
  const extractor = createOpenRouterPipelineExtractor({ apiKey: 'test-key', fetchImpl: async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({
      model: DEFAULT_PIPELINE_EXTRACTION_MODEL, provider: 'Anthropic',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidate: null }) } }],
    }) };
  } });

  await assert.rejects(extractor({ snapshot: snapshot({ revision_id: `${revisionId}-invalid` }) }), /pipeline_extractor_sensitive_input/);
  const phoneProject = '090-1234-5678';
  await assert.rejects(extractor({ snapshot: snapshot({ project_id: phoneProject, source_key: sourceKey(phoneProject) }) }), /pipeline_extractor_sensitive_input/);
  const secretProject = 'sk-proj-012345678901234567';
  await assert.rejects(extractor({ snapshot: snapshot({ project_id: secretProject, source_key: sourceKey(secretProject) }) }), /pipeline_extractor_sensitive_input/);
  await assert.rejects(extractor({ snapshot: snapshot({ source_key: sourceKey('org-brain', `${revisionId}-invalid`) }) }), /pipeline_extractor_sensitive_input/);
  await assert.rejects(extractor({ snapshot: snapshot({ unrelated_id: revisionId }) }), /pipeline_extractor_sensitive_input/);
  await assert.rejects(extractor({ snapshot: snapshot({ page_id: revisionId, source_key: sourceKey('org-brain', revisionId) }) }), /pipeline_extractor_sensitive_input/);
  await assert.rejects(extractor({ snapshot: snapshot({ text: `Call +1 (202) 555-0100; revision ${revisionId}.` }) }), /pipeline_extractor_sensitive_input/);
  assert.equal(fetchCalls, 0);

  const result = await extractor({ snapshot: snapshot() });
  assert.equal(result.candidate, null);
  assert.equal(fetchCalls, 1);

  const judge = createOpenRouterPipelineJudge({
    apiKey: 'test-key', fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    modelByProfile: Object.fromEntries(MEMORY_PIPELINE_REVIEW_PROFILES.map((profile) => [profile, 'openai/gpt-5.4'])),
  });
  await assert.rejects(judge({
    profile: 'evidence_entailment', snapshot: { content: 'clean source' },
    candidate: { content: `Source id ${revisionId}.`, support_refs: [revisionId] },
  }), /pipeline_review_sensitive_input/);
  assert.equal(fetchCalls, 1);
});

test('a canonical Wiki page UUID that resembles a phone passes only in matched snapshot metadata', async () => {
  const pageId = '22b14a09-1eed-4367-be58-71347257514a';
  const revisionId = 'db3747fd-dfbf-4a15-81b0-f31aa34e5e41';
  const hash = 'a'.repeat(64);
  const snapshot = {
    source_type: 'personal_wiki', tenant_id: 'default', project_id: 'org-brain',
    page_id: pageId, revision_id: revisionId, hash,
    source_key: `wiki:personal:default:org-brain:${pageId}:${revisionId}:${hash}`,
    text: '新しいキュー行の作成後だけワーカーを起動する。',
  };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({
      model: DEFAULT_PIPELINE_EXTRACTION_MODEL, provider: 'Anthropic',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidate: null }) } }],
    }) };
  };
  const extractor = createOpenRouterPipelineExtractor({ apiKey: 'test-key', fetchImpl });
  assert.equal((await extractor({ snapshot })).candidate, null);
  assert.equal(calls, 1);
  for (const changed of [
    { ...snapshot, source_key: snapshot.source_key.replace('org-brain', 'other-project') },
    { ...snapshot, text: `Untrusted prose ${pageId}` },
    { ...snapshot, text: 'Call +1 (202) 555-0100.' },
    { ...snapshot, unrelated_id: pageId },
  ]) await assert.rejects(extractor({ snapshot: changed }), /pipeline_extractor_sensitive_input/);
  assert.equal(calls, 1);
});

test('factory judge screens the canonical Wiki snapshot exception without extending it to candidates', async () => {
  const revisionId = '0cea8d5f-1c26-4d5a-bd26-3000868773ed';
  const pageId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  const hash = 'a'.repeat(64);
  const snapshot = {
    source_type: 'personal_wiki', tenant_id: 'default', project_id: 'org-brain',
    page_id: pageId, revision_id: revisionId, hash,
    source_key: `wiki:personal:default:org-brain:${pageId}:${revisionId}:${hash}`,
    text: '検索結果はページの本文に限定する。',
  };
  let fetchCalls = 0;
  const judge = createOpenRouterPipelineJudge({
    apiKey: 'test-key',
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => ({
        model: 'openai/gpt-5.4', provider: 'OpenAI',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdict: 'pass', confidence: 0.9, reasons: [] }) } }],
      }) };
    },
    modelByProfile: Object.fromEntries(MEMORY_PIPELINE_REVIEW_PROFILES.map((profile) => [profile, 'openai/gpt-5.4'])),
  });

  const result = await judge({ profile: 'evidence_entailment', snapshot, candidate: { content: '本文だけを使う。' } });
  assert.equal(result.verdict, 'pass');
  assert.equal(fetchCalls, 1);

  const cleanSnapshot = { content: 'clean source' };
  const spoofedCandidate = {
    source_type: 'personal_wiki', tenant_id: 'default', project_id: 'org-brain',
    page_id: pageId, revision_id: revisionId, hash,
    source_key: snapshot.source_key,
  };
  let negativeFetchCalls = 0;
  const strictJudge = createOpenRouterPipelineJudge({
    apiKey: 'test-key',
    fetchImpl: async () => {
      negativeFetchCalls += 1;
      throw new Error('sensitive candidate reached fetch');
    },
    modelByProfile: Object.fromEntries(MEMORY_PIPELINE_REVIEW_PROFILES.map((profile) => [profile, 'openai/gpt-5.4'])),
  });
  for (const candidate of [
    spoofedCandidate,
    { content: 'Call +1 (202) 555-0100 about this claim.' },
  ]) {
    await assert.rejects(strictJudge({ profile: 'evidence_entailment', snapshot: cleanSnapshot, candidate }), /pipeline_review_sensitive_input/);
    assert.equal(negativeFetchCalls, 0);
  }
});

test('extractor fails closed on model mismatch, unknown usage, truncation, and oversized input', async () => {
  const base = (overrides = {}) => ({
    model: 'anthropic/claude-haiku-5.5', provider: 'Anthropic',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ candidate: null }) } }],
    ...overrides
  });
  const config = { apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => base() }) };
  await assert.rejects(createOpenRouterPipelineExtractor({ ...config, fetchImpl: async () => ({ ok: true, json: async () => base({ model: 'openai/gpt-5.4' }) }) })({ snapshot: {} }), /pipeline_extractor_model_mismatch/);
  await assert.rejects(createOpenRouterPipelineExtractor({ ...config, fetchImpl: async () => ({ ok: true, json: async () => base({ usage: { prompt_tokens: 1, completion_tokens: 1 } }) }) })({ snapshot: {} }), /pipeline_extractor_usage_invalid/);
  await assert.rejects(createOpenRouterPipelineExtractor({ ...config, fetchImpl: async () => ({ ok: true, json: async () => base({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) }) })({ snapshot: {} }), /pipeline_extractor_incomplete_output/);
  const bounded = createOpenRouterPipelineExtractor({ ...config, maxInputChars: 40, fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(bounded({ snapshot: { text: 'x'.repeat(50) } }), /pipeline_extractor_input_too_large/);
});
