import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudIoError,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  REVIEW_MODELS,
  buildReviewRequest,
  createCloudClient,
  profileReviewRequest,
  validateReview,
} from "./memory-extraction-router-v33-cloud.mjs";

function makeCase({
  id = "case-1",
  role = "user",
  content = "採用する方針は監査ログを残すこと。理由は障害の再発時に原因を追跡できるため。",
  ...extra
} = {}) {
  return {
    id,
    source_hash: "must-not-leak",
    gold_label: "not_useful",
    model_prediction: { model: "old-model", usefulness: "not_useful" },
    ai_draft: { usefulness: "excluded" },
    turns: [{
      id: `${id}-turn-1`,
      role,
      content,
      label: "must-not-leak",
      tool_output: { usefulness: "excluded" },
    }],
    ...extra,
  };
}

function durableAnnotation(caseItem, overrides = {}) {
  const content = caseItem.turns[0].content;
  return {
    usefulness: "durable_memory",
    review_status: "accepted",
    lesson_types: ["decision"],
    evidence_spans: [{ turn_id: caseItem.turns[0].id, start: 0, end: content.length, quote: content }],
    future_use: "同じ障害対応方針を決めるときに、監査可能性の判断根拠として再利用する。",
    outcome: "candidate",
    confidence: "high",
    exclusion_reason: "",
    ...overrides,
  };
}

function responseDocument(annotation, overrides = {}) {
  return {
    id: "resp_123",
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "gpt-5.6-sol",
    reasoning: { effort: "high" },
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(annotation) }],
    }],
    usage: { input_tokens: 100, output_tokens: 80, total_tokens: 180 },
    ...overrides,
  };
}

function mockResponse(payload, { status = 200, requestId = "req_123", redirected = false, json } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    headers: { get: (name) => name.toLowerCase() === "x-request-id" ? requestId : null },
    json: json ?? (async () => payload),
  };
}

function unitVector(dimension = 0) {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index === dimension ? 1 : 0);
}

function assertCloudError(error, code, retryable) {
  assert.ok(error instanceof CloudIoError);
  assert.equal(error.code, code);
  assert.equal(error.retryable, retryable);
  return true;
}

test('explicit diagnostic budget preserves default and is reflected in actual request and failure metadata', async () => {
  const c = makeCase();
  assert.equal(buildReviewRequest(c, REVIEW_MODELS[1]).max_output_tokens, 8192);
  assert.equal(buildReviewRequest(c, REVIEW_MODELS[1], { maxOutputTokens: 16384 }).max_output_tokens, 16384);
  assert.throws(() => buildReviewRequest(c, REVIEW_MODELS[1], { maxOutputTokens: 32768 }), /review_output_budget_invalid/);
  const client = createCloudClient({ apiKey: 'test', fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).max_output_tokens, 16384);
    return mockResponse(responseDocument({}, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
  } });
  await assert.rejects(client.review(c, REVIEW_MODELS[1], { maxOutputTokens: 16384 }), e => e.diagnostics.max_output_tokens === 16384);
});

test('incomplete response retains exact failure diagnostics privately without retrying', async () => {
  const c = makeCase();
  const payload = responseDocument(durableAnnotation(c), { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 800, output_tokens: 8192, output_tokens_details: { reasoning_tokens: 8192 } } });
  let calls = 0;
  const client = createCloudClient({ apiKey: 'test-key', fetchImpl: async () => { calls++; return mockResponse(payload); } });
  await assert.rejects(client.review(c, REVIEW_MODELS[0]), error => {
    assertCloudError(error, 'review_output_limit_exceeded', false);
    assert.equal(error.diagnostics.incomplete_reason, 'max_output_tokens');
    assert.equal(error.diagnostics.reasoning_tokens, 8192);
    assert.equal(error.diagnostics.max_output_tokens, 8192);
    assert.equal(error.request_id, 'req_123');
    assert.deepEqual(error.raw_response, payload);
    assert.equal(JSON.stringify(error.diagnostics).includes('test-key'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test("review request is blind, sanitized, tool-free, strict, and conservatively profiled", () => {
  const source = makeCase({
    content: "方針を採用する。理由を記録する。<private-tag> /tmp/private.log",
    prior_ai_exposure: "ai_assisted",
    labels: { durable: true },
  });
  const request = buildReviewRequest(source, REVIEW_MODELS[0]);
  const supplied = JSON.parse(request.input[1].content[0].text);
  assert.deepEqual(Object.keys(supplied), ["id", "turns"]);
  assert.deepEqual(Object.keys(supplied.turns[0]), ["content", "id", "role"]);
  assert.equal(JSON.stringify(supplied).includes("gold_label"), false);
  assert.equal(JSON.stringify(supplied).includes("old-model"), false);
  assert.equal(JSON.stringify(supplied).includes("prior_ai_exposure"), false);
  assert.equal(JSON.stringify(supplied).includes("private.log"), false);
  assert.equal(JSON.stringify(supplied).includes("private-tag"), false);
  assert.deepEqual(request.tools, []);
  assert.equal(request.tool_choice, "none");
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 8_192);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.match(request.input[0].content[0].text, /merely completed is not durable memory/u);
  assert.match(request.input[0].content[0].text, /assistant role/u);
  assert.equal(Object.hasOwn(request, "conversation"), false);
  assert.equal(Object.hasOwn(request, "previous_response_id"), false);
  const profile = profileReviewRequest(request);
  assert.equal(profile.token_profile, "utf8_byte_upper_bound_v1");
  assert.equal(profile.estimated_input_tokens_upper_bound, profile.utf8_bytes);
  assert.equal(profile.within_limit, true);
  assert.match(profile.request_sha256, /^sha256:[a-f0-9]{64}$/u);
});

test("review request rejects an unsupported runtime and oversized input without truncation", () => {
  assert.throws(() => buildReviewRequest(makeCase(), { id: "gpt-5.6-sol", effort: "low" }), (error) =>
    assertCloudError(error, "review_model_invalid", false));
  const huge = makeCase({ content: "x".repeat(130_000) });
  assert.throws(() => buildReviewRequest(huge, REVIEW_MODELS[0]), (error) =>
    assertCloudError(error, "review_input_too_large", false));
});

test("exact assistant-only evidence is accepted and extra output keys are rejected", () => {
  const source = makeCase({ role: "assistant" });
  const annotation = durableAnnotation(source);
  assert.deepEqual(validateReview(annotation, source), annotation);
  assert.throws(() => validateReview({ ...annotation, case_id: source.id }, source), (error) =>
    assertCloudError(error, "review_annotation_schema_invalid", true));
});

test("uncertain output still requires exact quotes and offsets", () => {
  const source = makeCase();
  const invalid = durableAnnotation(source, {
    review_status: "uncertain",
    evidence_spans: [{ turn_id: source.turns[0].id, start: 1, end: source.turns[0].content.length, quote: source.turns[0].content }],
  });
  assert.throws(() => validateReview(invalid, source), (error) =>
    assertCloudError(error, "review_evidence_not_exact", true));
});

test("non-durable outputs cannot smuggle durable support", () => {
  const source = makeCase({ content: "今回の処理が完了した。" });
  const operational = {
    usefulness: "operational_history_only",
    review_status: "accepted",
    lesson_types: [],
    evidence_spans: [],
    future_use: "",
    outcome: "episode_fragment",
    confidence: "high",
    exclusion_reason: "",
  };
  assert.deepEqual(validateReview(operational, source), operational);
  assert.throws(() => validateReview({ ...operational, future_use: "今後も使う" }, source), (error) =>
    assertCloudError(error, "review_non_durable_support_present", true));
});

test("preflight performs exactly three serial model GETs on fixed OpenAI endpoints", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const id = decodeURIComponent(url.split("/").at(-1));
    return mockResponse({ id }, { requestId: `req_${calls.length}` });
  };
  const result = await createCloudClient({ apiKey: "test-key", fetchImpl }).preflight();
  assert.equal(result.verified, true);
  assert.deepEqual(result.models, ["gpt-5.6-sol", "gpt-5.6-luna", EMBEDDING_MODEL]);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.openai.com/v1/models/gpt-5.6-sol",
    "https://api.openai.com/v1/models/gpt-5.6-luna",
    "https://api.openai.com/v1/models/text-embedding-3-large",
  ]);
  assert.ok(calls.every((call) => call.options.method === "GET" && call.options.redirect === "error" && call.options.body === undefined));
});

test("missing key fails explicitly before preflight transport", async () => {
  let called = false;
  const client = createCloudClient({ apiKey: "", fetchImpl: async () => { called = true; } });
  await assert.rejects(() => client.preflight(), (error) => assertCloudError(error, "openai_api_key_missing", false));
  assert.equal(called, false);
});

test("review makes one HTTP attempt and returns the full response with audit metadata", async () => {
  const source = makeCase();
  const document = responseDocument(durableAnnotation(source));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return mockResponse(document, { requestId: "req_review" });
  };
  const result = await createCloudClient({ apiKey: "test-key", fetchImpl }).review(source, REVIEW_MODELS[0]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].options.method, "POST");
  const sent = JSON.parse(calls[0].options.body);
  assert.deepEqual(sent.tools, []);
  assert.equal(sent.tool_choice, "none");
  assert.equal(sent.store, false);
  assert.equal(result.raw.response, document);
  assert.equal(result.raw.response_id, "resp_123");
  assert.equal(result.raw.request_id, "req_review");
  assert.equal(result.raw.model, REVIEW_MODELS[0].id);
  assert.equal(result.raw.reasoning_effort, REVIEW_MODELS[0].effort);
  assert.deepEqual(result.raw.usage, document.usage);
  assert.match(result.raw.input_hash, /^sha256:/u);
});

test("auth and model failures do not fall back or leak a secret response body", async () => {
  const source = makeCase();
  const secretBody = "sk-secret-in-response";
  let authCalls = 0;
  const authClient = createCloudClient({
    apiKey: "sk-secret-key",
    fetchImpl: async () => {
      authCalls += 1;
      return mockResponse(null, { status: 401, json: async () => { throw new Error(secretBody); } });
    },
  });
  await assert.rejects(() => authClient.review(source, REVIEW_MODELS[0]), (error) => {
    assertCloudError(error, "openai_auth_failed", false);
    assert.doesNotMatch(error.message, /secret/u);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(authCalls, 1);

  let modelCalls = 0;
  const mismatch = responseDocument(durableAnnotation(source), { model: "gpt-5.6-luna" });
  const modelClient = createCloudClient({ apiKey: "test-key", fetchImpl: async () => {
    modelCalls += 1;
    return mockResponse(mismatch);
  } });
  await assert.rejects(() => modelClient.review(source, REVIEW_MODELS[0]), (error) =>
    assertCloudError(error, "openai_model_mismatch", false));
  assert.equal(modelCalls, 1);
});

test("missing effort, incomplete status, and tool calls fail closed", async (t) => {
  const source = makeCase();
  const annotation = durableAnnotation(source);
  const cases = [
    ["missing effort", responseDocument(annotation, { reasoning: {} }), "openai_reasoning_effort_unverified", true],
    ["incomplete", responseDocument(annotation, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), "review_output_limit_exceeded", false],
    ["tool call", responseDocument(annotation, { output: [{ type: "function_call", name: "leak" }] }), "review_tool_call_rejected", true],
  ];
  for (const [name, document, code, retryable] of cases) {
    await t.test(name, async () => {
      const client = createCloudClient({ apiKey: "test-key", fetchImpl: async () => mockResponse(document) });
      await assert.rejects(() => client.review(source, REVIEW_MODELS[0]), (error) => assertCloudError(error, code, retryable));
    });
  }
});

test("embedding chunks emoji by Unicode code points, normalizes, pools, and retains raw responses", async () => {
  const text = "😀".repeat(4_001);
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    return mockResponse({
      object: "list",
      model: EMBEDDING_MODEL,
      data: body.input.map((_, index) => ({ object: "embedding", index, embedding: unitVector(index) })),
      usage: { prompt_tokens: 10, total_tokens: 10 },
    }, { requestId: "req_embed" });
  };
  const result = await createCloudClient({ apiKey: "test-key", fetchImpl }).embed(text);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.openai.com/v1/embeddings");
  assert.deepEqual(requests[0].body.input.map((chunk) => [...chunk].length), [1_500, 1_500, 1_001]);
  assert.equal(requests[0].body.dimensions, EMBEDDING_DIMENSIONS);
  assert.equal(result.vector.length, EMBEDDING_DIMENSIONS);
  assert.ok(Math.abs(Math.hypot(...result.vector) - 1) < 1e-12);
  assert.equal(result.raw.response, undefined);
  assert.equal(result.raw.responses[0].response.model, EMBEDDING_MODEL);
  assert.deepEqual(result.raw.chunk_code_points, [1_500, 1_500, 1_001]);
});

test("embedding batches at eight serially and resumes saved successful batches without re-sending", async () => {
  const text = "x".repeat(1_500 * 9);
  const saved = new Map();
  const requestBatchSizes = [];
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async (_url, options) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const body = JSON.parse(options.body);
    requestBatchSizes.push(body.input.length);
    await Promise.resolve();
    active -= 1;
    return mockResponse({
      model: EMBEDDING_MODEL,
      data: body.input.map((_, index) => ({ index, embedding: unitVector(index) })),
      usage: { total_tokens: body.input.length },
    }, { requestId: `req_batch_${requestBatchSizes.length}` });
  };
  const client = createCloudClient({ apiKey: "test-key", fetchImpl });
  const first = await client.embed(text, {
    loadBatch: async ({ batch_key: key }) => saved.get(key),
    saveBatch: async ({ batch_key: key }, checkpoint) => { saved.set(key, structuredClone(checkpoint)); },
  });
  assert.deepEqual(requestBatchSizes, [8, 1]);
  assert.equal(maxActive, 1);
  assert.equal(saved.size, 2);
  const firstRequestCount = requestBatchSizes.length;
  const resumed = await client.embed(text, {
    loadBatch: async ({ batch_key: key }) => saved.get(key),
    saveBatch: async () => assert.fail("a valid saved batch must not be re-saved"),
  });
  assert.equal(requestBatchSizes.length, firstRequestCount);
  assert.deepEqual(resumed.vector, first.vector);
  assert.ok(resumed.raw.responses.every((item) => item.resumed === true));
  assert.ok([...saved.values()].every((item) => item.raw.response.model === EMBEDDING_MODEL));
});

test("embedding rejects corrupted checkpoints and malformed vectors without fallback", async (t) => {
  const text = "test";
  await t.test("checkpoint vector hash", async () => {
    const client = createCloudClient({ apiKey: "test-key", fetchImpl: async () => assert.fail("must not send on corrupt checkpoint") });
    await assert.rejects(() => client.embed(text, {
      loadBatch: async ({ batch_key, input_hash, chunk_hashes }) => ({
        batch_key,
        input_hash,
        chunk_hashes,
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        vectors: [unitVector(0)],
        vectors_sha256: "sha256:wrong",
        raw: {},
      }),
    }), (error) => assertCloudError(error, "embedding_checkpoint_invalid", false));
  });

  const invalids = [
    ["wrong dimensions", [1, 0]],
    ["zero vector", Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0)],
    ["non-finite", Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index === 0 ? Number.NaN : 0)],
  ];
  for (const [name, vector] of invalids) {
    await t.test(name, async () => {
      let calls = 0;
      const client = createCloudClient({ apiKey: "test-key", fetchImpl: async () => {
        calls += 1;
        return mockResponse({ model: EMBEDDING_MODEL, data: [{ index: 0, embedding: vector }] });
      } });
      await assert.rejects(() => client.embed(text), (error) => assertCloudError(error, "embedding_vector_invalid", true));
      assert.equal(calls, 1);
    });
  }
});

test("HTTP retryability is limited to transport, 429, 5xx, and response schema failures", async (t) => {
  const source = makeCase();
  const cases = [
    ["transport", async () => { throw new Error("secret transport detail"); }, "openai_transport_error", true],
    ["429", async () => mockResponse({ secret: true }, { status: 429 }), "openai_rate_limited", true],
    ["503", async () => mockResponse({ secret: true }, { status: 503 }), "openai_server_error", true],
    ["400", async () => mockResponse({ secret: true }, { status: 400 }), "openai_http_error", false],
    ["schema", async () => mockResponse(null, { json: async () => { throw new SyntaxError("secret body"); } }), "openai_response_schema_invalid", true],
    ["redirect", async () => mockResponse({}, { redirected: true }), "openai_redirect_rejected", false],
  ];
  for (const [name, fetchImpl, code, retryable] of cases) {
    await t.test(name, async () => {
      const client = createCloudClient({ apiKey: "sk-secret", fetchImpl });
      await assert.rejects(() => client.review(source, REVIEW_MODELS[0]), (error) => {
        assertCloudError(error, code, retryable);
        assert.doesNotMatch(error.message, /secret/u);
        return true;
      });
    });
  }
});
