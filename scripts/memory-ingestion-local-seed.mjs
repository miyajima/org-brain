#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureItemPayload, buildMcpLearningBatchRequest } from "../packages/orgbrain-cli/src/hook-memory-bridge.mjs";
import { createCodexSessionImportReport } from "../packages/orgbrain-cli/src/codex-session-import.mjs";
import { buildMemoryIngestionRegressionCorpus, semanticTraceErrors } from "./memory-ingestion-regression.mjs";
import { prepareFixture } from "./memory-ingestion-storage-regression.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "apps/api-gateway");
const WRANGLER_BIN = process.env.WRANGLER_BIN?.trim() || path.join(API_DIR, "node_modules/.bin/wrangler");
const DEFAULT_API_URL = "http://127.0.0.1:8787";
const DEFAULT_TENANT_ID = "default";
const DEFAULT_PROJECT_ID = "org-brain";
const DATASET_PREFIX = "orgbrain-ingestion-v4:";
const BATCH_ID = "orgbrain-ingestion-v4-semantic-local";
const SOURCE = "codex-v4-semantic-regression";
const TRACE_SOURCE = "codex-v4-semantic-trace";
const TRACE_ACTOR = "local-v4-seed";
const TRACE_CONNECTOR = "local-v4-semantic-trace";
const TRACE_ID_PREFIX = "orgbrain-ingestion-v4:trace:";
const TRACE_EPOCH = Date.parse("2026-08-16T00:00:00.000Z");
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_LEARNING_TOOL = "orgbrain_learning_batch_ingest";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseWranglerJson(stdout) {
  const trimmed = stdout.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "[" && trimmed[index] !== "{") continue;
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {
      // Wrangler may print a status line before its JSON response.
    }
  }
  throw new Error(`wrangler_json_missing:${trimmed.slice(0, 500)}`);
}

function localD1Args(command, stateDir, configPath) {
  return [
    "d1", "execute", "open-brain", "--local",
    "--persist-to", stateDir,
    "--config", configPath,
    "--json", "--command", command
  ];
}

function queryLocalD1(command, options) {
  const stdout = execFileSync(
    WRANGLER_BIN,
    localD1Args(command, options.stateDir, options.configPath),
    {
      cwd: API_DIR,
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: options.logDir
      }
    }
  );
  return parseWranglerJson(stdout)?.[0]?.results ?? [];
}

function executeLocalD1(command, options) {
  const stdout = execFileSync(
    WRANGLER_BIN,
    localD1Args(command, options.stateDir, options.configPath),
    {
      cwd: API_DIR,
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: options.logDir
      }
    }
  );
  return parseWranglerJson(stdout);
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function traceKey(externalKey, language, suffix) {
  return digest(`${externalKey}:${language}:${suffix}`).slice(0, 32);
}

function parseObject(raw) {
  if (!raw || typeof raw !== "string") return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function traceTimestamp(key) {
  return TRACE_EPOCH + (Number.parseInt(key.slice(0, 8), 16) % (24 * 60 * 60 * 1000));
}

function traceRows(options, corpus) {
  const caseByExternalKey = new Map(corpus.cases.map((testCase) => [`${DATASET_PREFIX}${testCase.id}`, testCase]));
  const prefix = sqlString(`${DATASET_PREFIX}%`);
  const rows = queryLocalD1(
    `SELECT id, external_key, project_id, kind, learning_json, verification_state, verified_at, confidence_score
     FROM memories
     WHERE tenant_id = ${sqlString(options.tenantId)}
       AND external_key LIKE ${prefix}
       AND lifecycle_state = 'active'
       AND kind IN ('decision', 'pitfall')
     ORDER BY external_key`,
    options
  );
  return rows.flatMap((row) => {
    const testCase = caseByExternalKey.get(String(row.external_key));
    if (!testCase) return [];
    const input = testCase.input && typeof testCase.input === "object" ? testCase.input : {};
    const learning = parseObject(row.learning_json);
    const isFailure = testCase.lesson_type === "failure" || row.kind === "pitfall";
    const key = traceKey(String(row.external_key), testCase.language, "rationale");
    const rationaleId = `${TRACE_ID_PREFIX}rationale:${key}`;
    const conclusion = isFailure
      ? text(input.correction || input.root_cause || learning.correction || learning.root_cause || learning.conclusion)
      : text(input.selected_value || input.decision || learning.selected_value || learning.decision || learning.conclusion);
    const reasonSummary = isFailure
      ? text(input.root_cause || learning.root_cause || input.rationale || learning.rationale)
      : text(input.rationale || learning.rationale || learning.why_it_worked);
    const evidence = Array.isArray(input.evidence_selectors) ? input.evidence_selectors : [];
    const scenarioKey = traceKey(String(row.external_key), testCase.language, "scenario");
    const time = traceTimestamp(scenarioKey);
    const resourceDefinitions = [
      {
        role: "rationale_source",
        kind: "document",
        title: testCase.language === "ja" ? `判断記録 · ${testCase.id}` : `Decision record · ${testCase.id}`,
        text: `${text(input.trigger)}\n${text(input.symptom)}\n${text(input.root_cause)}\n${reasonSummary}\n${text(input.reuse_when || learning.reuse_when)}`
      },
      {
        role: "implementation_artifact",
        kind: "build",
        title: testCase.language === "ja" ? `反映された実装 · ${testCase.id}` : `Reflected implementation · ${testCase.id}`,
        text: text(input.correction || conclusion)
      },
      {
        role: "verification_artifact",
        kind: "test_result",
        title: testCase.language === "ja" ? `検証結果 · ${testCase.id}` : `Verification result · ${testCase.id}`,
        text: isFailure
          ? text(input.verified_outcome || learning.verified_outcome || learning.outcome)
          : text(input.observed_outcome || learning.observed_outcome || learning.outcome
            || (testCase.language === "ja"
              ? "全evidence selectorが決定・理由を支持することを検証した。"
              : "All evidence selectors were verified to support the decision and rationale."))
      }
    ].map((definition) => {
      const resourceKey = traceKey(String(row.external_key), testCase.language, definition.role);
      const resourceId = `${TRACE_ID_PREFIX}resource:${resourceKey}`;
      const versionId = `${TRACE_ID_PREFIX}version:${resourceKey}`;
      const uri = `orgbrain://local/v4/${resourceKey}/${definition.role}`;
      return {
        ...definition,
        resourceId,
        versionId,
        uri,
        text: text(definition.text) || definition.title,
        contentHash: digest(`${definition.title}\n${definition.text}`),
        capturedAt: time
      };
    });
    return [{
      memoryId: String(row.id),
      externalKey: String(row.external_key),
      projectId: row.project_id ? String(row.project_id) : options.projectId,
      language: testCase.language,
      caseId: testCase.id,
      testCase,
      semanticExpectation: testCase.semantic_expectation,
      input,
      learning,
      isFailure,
      rationaleId,
      decisionType: isFailure ? "failure_prevention" : text(input.decision_type || learning.decision_type || "decision"),
      conclusion,
      reasonSummary,
      status: isFailure ? "resolved" : "adopted",
      confirmationState: row.verification_state === "verified" ? "confirmed" : "unconfirmed",
      confidence: Number.isFinite(Number(row.confidence_score)) ? Number(row.confidence_score) : 1,
      createdAt: time,
      confirmedAt: row.verification_state === "verified" ? Number(row.verified_at || time) : null,
      evidence,
      resources: resourceDefinitions
    }];
  });
}

function traceStatements(record, options) {
  const rationaleId = sqlString(record.rationaleId);
  const tenantId = sqlString(options.tenantId);
  const projectId = record.projectId ? sqlString(record.projectId) : "NULL";
  const statements = [
    `INSERT OR IGNORE INTO decision_rationales(
       id, tenant_id, memory_id, project_id, decision_type, conclusion, reason_summary,
       status, confirmation_state, decider_entity_id, confidence_score, created_at,
       confirmed_at, superseded_by
     ) VALUES(${rationaleId}, ${tenantId}, ${sqlString(record.memoryId)}, ${projectId},
       ${sqlString(record.decisionType)}, ${sqlString(record.conclusion)}, ${sqlString(record.reasonSummary)},
       ${sqlString(record.status)}, ${sqlString(record.confirmationState)}, NULL, ${record.confidence},
       ${record.createdAt}, ${record.confirmedAt === null ? "NULL" : record.confirmedAt}, NULL)`
  ];
  for (const [index, selector] of record.evidence.entries()) {
    const evidenceId = `${TRACE_ID_PREFIX}evidence:${traceKey(record.externalKey, record.language, `evidence:${index}`)}`;
    const evidenceRef = text(selector?.ref || selector?.evidence_ref || "");
    const supports = Array.isArray(selector?.supports) ? selector.supports.map(text).filter(Boolean) : [];
    const evidenceHash = digest(evidenceRef);
    const note = text(selector?.note)
      || (selector?.type === "command"
        ? `${evidenceRef.includes("before") ? "exit_code=1" : evidenceRef.includes("after") ? "exit_code=0" : "exit_code=0"}; supports:${supports.join(",")}`
        : null);
    statements.push(
      `INSERT OR IGNORE INTO decision_evidence(
         id, tenant_id, rationale_id, evidence_type, evidence_ref, relation, note,
         weight_score, created_at, content_hash, observed_at, attestation_ref
       ) VALUES(${sqlString(evidenceId)}, ${tenantId}, ${rationaleId}, ${sqlString(text(selector?.type || "other"))},
         ${sqlString(evidenceRef)}, ${sqlString(`supports:${supports.join(",")}`)}, ${note === null ? "NULL" : sqlString(note)}, 1, ${record.createdAt},
         ${sqlString(evidenceHash)}, ${record.createdAt}, ${sqlString(`${TRACE_ID_PREFIX}attestation:${evidenceHash}`)})`
    );
  }
  for (const resource of record.resources) {
    const extractedText = resource.text;
    const excerptDigest = digest(extractedText);
    const locator = resource.role === "rationale_source"
      ? JSON.stringify({ heading: record.isFailure ? "Root cause" : "Rationale" })
      : JSON.stringify({ heading: resource.role === "verification_artifact" ? "Verification" : "Implementation" });
    statements.push(
      `INSERT OR IGNORE INTO knowledge_resources(
         id, tenant_id, project_id, resource_kind, canonical_uri, title, source_system,
         media_type, visibility, permissions_json, current_version_id, lifecycle_state,
         created_by_principal, created_at, updated_at
       ) VALUES(${sqlString(resource.resourceId)}, ${tenantId}, ${projectId}, ${sqlString(resource.kind)},
         ${sqlString(resource.uri)}, ${sqlString(resource.title)}, ${sqlString(TRACE_SOURCE)}, 'text/plain',
         'project', '[]', NULL, 'active', ${sqlString(TRACE_ACTOR)}, ${resource.capturedAt}, ${resource.capturedAt})`,
      `INSERT OR IGNORE INTO knowledge_resource_locations(
         id, tenant_id, resource_id, uri, normalized_uri, location_role, connector_id,
         fetch_enabled, created_at, updated_at
       ) VALUES(${sqlString(`${resource.resourceId}:location`)}, ${tenantId}, ${sqlString(resource.resourceId)},
         ${sqlString(resource.uri)}, ${sqlString(resource.uri)}, 'canonical', ${sqlString(TRACE_CONNECTOR)}, 0,
         ${resource.capturedAt}, ${resource.capturedAt})`,
      `INSERT OR IGNORE INTO knowledge_resource_versions(
         id, tenant_id, resource_id, connector_id, source_version, etag, last_modified,
         content_hash, snapshot_object_ref, extracted_text, extracted_text_hash,
         extraction_state, captured_at, created_by_principal, created_at
       ) VALUES(${sqlString(resource.versionId)}, ${tenantId}, ${sqlString(resource.resourceId)}, ${sqlString(TRACE_CONNECTOR)},
         'v1', NULL, NULL, ${sqlString(resource.contentHash)},
         ${sqlString(`${resource.uri}/snapshot`)}, ${sqlString(extractedText)}, ${sqlString(digest(extractedText))},
         'ready', ${resource.capturedAt}, ${sqlString(TRACE_ACTOR)}, ${resource.capturedAt})`,
      `UPDATE knowledge_resources SET current_version_id = ${sqlString(resource.versionId)}, updated_at = ${resource.capturedAt}
       WHERE tenant_id = ${tenantId} AND id = ${sqlString(resource.resourceId)}`
    );
    const assertionKey = `${TRACE_ID_PREFIX}link:${traceKey(record.externalKey, record.language, resource.role)}`;
    const assertionId = assertionKey;
    statements.push(
      `INSERT OR IGNORE INTO knowledge_assertions(
         id, tenant_id, project_id, assertion_type, subject_type, subject_ref, predicate,
         object_type, object_ref, resource_id, context_json, confidence, confirmation_state,
         idempotency_key, valid_from, valid_until, actor_principal, reviewed_by_principal,
         created_at, updated_at
       ) VALUES(${sqlString(assertionId)}, ${tenantId}, ${projectId}, 'relation', 'decision_rationale', ${rationaleId},
         ${sqlString(resource.role)}, 'knowledge_resource', ${sqlString(resource.resourceId)}, ${sqlString(resource.resourceId)},
         ${sqlString(JSON.stringify({ fixture_case_id: record.caseId, language: record.language }))}, 1, 'confirmed',
         ${sqlString(assertionKey)}, ${resource.capturedAt}, NULL, ${sqlString(TRACE_ACTOR)}, ${sqlString(TRACE_ACTOR)},
         ${resource.capturedAt}, ${resource.capturedAt})`,
      `INSERT OR IGNORE INTO knowledge_assertion_evidence(
         id, tenant_id, assertion_id, resource_id, resource_version_id, locator_json,
         excerpt_digest, note, created_at
       ) VALUES(${sqlString(`${assertionId}:evidence`)}, ${tenantId}, ${sqlString(assertionId)},
         ${sqlString(resource.resourceId)}, ${sqlString(resource.versionId)}, ${sqlString(locator)},
         ${sqlString(excerptDigest)}, ${sqlString(resource.text)}, ${resource.capturedAt})`
    );
  }
  return statements;
}

function traceCounts(options) {
  const tenant = sqlString(options.tenantId);
  const rationale = sqlString(`${TRACE_ID_PREFIX}rationale:%`);
  const evidence = sqlString(`${TRACE_ID_PREFIX}evidence:%`);
  const resource = sqlString(`${TRACE_ID_PREFIX}resource:%`);
  const version = sqlString(`${TRACE_ID_PREFIX}version:%`);
  const assertion = sqlString(`${TRACE_ID_PREFIX}link:%`);
  const assertionEvidence = sqlString(`${TRACE_ID_PREFIX}link:%:evidence`);
  return queryLocalD1(
    `SELECT
       (SELECT COUNT(*) FROM decision_rationales WHERE tenant_id = ${tenant} AND id LIKE ${rationale}) AS rationales,
       (SELECT COUNT(*) FROM decision_evidence WHERE tenant_id = ${tenant} AND id LIKE ${evidence}) AS evidence,
       (SELECT COUNT(*) FROM knowledge_resources WHERE tenant_id = ${tenant} AND id LIKE ${resource}) AS resources,
       (SELECT COUNT(*) FROM knowledge_resource_versions WHERE tenant_id = ${tenant} AND id LIKE ${version}) AS versions,
       (SELECT COUNT(*) FROM knowledge_assertions WHERE tenant_id = ${tenant} AND id LIKE ${assertion}) AS assertions,
       (SELECT COUNT(*) FROM knowledge_assertion_evidence WHERE tenant_id = ${tenant} AND id LIKE ${assertionEvidence}) AS assertion_evidence`,
    options
  )[0] ?? {};
}

function traceSemanticErrors(record) {
  const evidence = record.evidence.map((selector) => ({
    ...selector,
    note: selector.type === "command"
      ? `${String(selector.ref).includes("before") ? "exit_code=1" : "exit_code=0"}; supports:${(selector.supports ?? []).join(",")}`
      : null
  }));
  const errors = semanticTraceErrors(record.testCase, {
    learning: record.learning,
    content: record.conclusion,
    rationale: record.reasonSummary,
    evidence
  });
  const expected = record.semanticExpectation ?? {};
  const learning = record.learning ?? {};
  for (const selector of record.evidence) {
    const supports = Array.isArray(selector.supports) ? selector.supports : [];
    const relation = `supports:${supports.map(text).filter(Boolean).join(",")}`;
    for (const supportedField of supports) {
      if (!relation.split(",").includes(supportedField) && !relation.includes(supportedField)) {
        errors.push(`evidence_support_missing:${supportedField}`);
      }
    }
  }
  const expectedAlternatives = Array.isArray(expected.fields?.alternatives) ? expected.fields.alternatives : [];
  const actualAlternatives = Array.isArray(learning.alternatives) ? learning.alternatives : [];
  for (const expectedAlternative of expectedAlternatives) {
    const matched = actualAlternatives.some((actual) =>
      text(actual?.alternative) === text(expectedAlternative?.alternative)
      && text(actual?.reason_rejected) === text(expectedAlternative?.reason_rejected)
    );
    if (!matched) errors.push("alternative_rejection_mismatch");
  }
  const roles = new Set(record.resources.map((resource) => resource.role));
  for (const role of ["rationale_source", "implementation_artifact", "verification_artifact"]) {
    if (!roles.has(role)) errors.push(`resource_role_missing:${role}`);
  }
  if (record.resources.length !== 3) errors.push("resource_count_mismatch");
  if (record.isFailure) {
    if (!record.evidence.some((item) => String(item.ref).includes("before"))) errors.push("failure_command_missing");
    if (!record.evidence.some((item) => String(item.ref).includes("after"))) errors.push("success_command_missing");
    for (const field of ["symptom", "root_cause", "correction", "verified_outcome", "avoidance_rule"]) {
      if (!text(record.input[field] ?? learning[field])) errors.push(`failure_field_missing:${field}`);
    }
  }
  return [...new Set(errors)];
}

function traceSemanticSummary(records) {
  const failures = records.flatMap((record) => traceSemanticErrors(record).map((error) => ({
    case_id: record.caseId,
    scenario_id: record.testCase.scenario_id,
    language: record.language,
    error
  })));
  const checked = records.length;
  const byLanguage = Object.fromEntries(["en", "ja"].map((language) => {
    const languageRecords = records.filter((record) => record.language === language);
    const languageFailures = failures.filter((item) => item.language === language);
    return [language, {
      cases: languageRecords.length,
      passed: languageRecords.length - new Set(languageFailures.map((item) => item.case_id)).size,
      error_count: languageFailures.length
    }];
  }));
  return {
    cases_checked: checked,
    passed: checked - new Set(failures.map((item) => item.case_id)).size,
    error_count: failures.length,
    by_language: byLanguage,
    failures
  };
}

async function seedTraceFixtures(corpus, options) {
  const records = traceRows(options, corpus);
  const semantic = traceSemanticSummary(records);
  if (semantic.error_count > 0) throw new Error(`local_seed_trace_semantic_mismatch:${JSON.stringify(semantic.failures.slice(0, 12))}`);
  const before = traceCounts(options);
  for (const batch of chunk(records, 8)) {
    const statements = batch.flatMap((record) => traceStatements(record, options));
    if (statements.length === 0) continue;
    // Wrangler's local D1 adapter rejects SQL BEGIN/COMMIT statements. The
    // individual inserts are idempotent, so let D1 execute the batch without
    // an explicit transaction and make replay safety the recovery boundary.
    executeLocalD1(`${statements.join(";\n")};`, options);
  }
  const after = traceCounts(options);
  const numeric = (value) => Number(value ?? 0);
  const created = {
    rationales: numeric(after.rationales) - numeric(before.rationales),
    evidence: numeric(after.evidence) - numeric(before.evidence),
    resources: numeric(after.resources) - numeric(before.resources),
    versions: numeric(after.versions) - numeric(before.versions),
    assertions: numeric(after.assertions) - numeric(before.assertions),
    assertion_evidence: numeric(after.assertion_evidence) - numeric(before.assertion_evidence)
  };
  const counts = {
    rationale: numeric(after.rationales),
    evidence: numeric(after.evidence),
    resource: numeric(after.resources),
    resource_version: numeric(after.versions),
    link: numeric(after.assertions),
    assertion_evidence: numeric(after.assertion_evidence)
  };
  const createdRows = {
    decision_rationale: created.rationales,
    decision_evidence: created.evidence,
    knowledge_resource: created.resources,
    knowledge_resource_version: created.versions,
    knowledge_assertion: created.assertions,
    knowledge_assertion_evidence: created.assertion_evidence
  };
  const languageCounts = Object.fromEntries(["en", "ja"].map((language) => [
    language,
    records.filter((record) => record.language === language).length
  ]));
  const missingFieldCount = records.reduce((count, record) => count + [
    record.conclusion,
    record.reasonSummary,
    record.evidence.length > 0,
    record.resources.length === 3
  ].filter((value) => !value).length, 0);
  return {
    source: TRACE_SOURCE,
    input_records: records.length,
    decision_records: records.filter((record) => !record.isFailure).length,
    failure_records: records.filter((record) => record.isFailure).length,
    language_counts: languageCounts,
    missing_field_count: missingFieldCount,
    semantic,
    before,
    after,
    counts,
    created,
    created_rows: createdRows,
    replay_new_rows: createdRows,
    replay_no_new_rows: Object.values(created).every((value) => value === 0)
  };
}

function existingSeedKeys(options) {
  const prefix = sqlString(`${DATASET_PREFIX}%`);
  const rows = queryLocalD1(
    `SELECT external_key, 'memory' AS source FROM memories WHERE tenant_id = ${sqlString(options.tenantId)} AND external_key LIKE ${prefix}
     UNION ALL
     SELECT external_key, 'candidate' AS source FROM memory_learning_candidates WHERE tenant_id = ${sqlString(options.tenantId)} AND external_key LIKE ${prefix}`,
    options
  );
  return new Set(rows.map((row) => String(row.external_key)));
}

function caseForBatch(batch, caseBySessionHash) {
  return caseBySessionHash.get(batch.session_hash) ?? null;
}

function scenarioTag(value) {
  return String(value ?? "unknown").replace(/[^a-z0-9_-]/giu, "-").slice(0, 48);
}

function activeSeedItem(testCase, item, options) {
  const externalKey = `${DATASET_PREFIX}${testCase.id}`;
  const tags = [
    ...(item.tags ?? []),
    "orgbrain-ingestion-v4",
    "synthetic-regression",
    `language-${testCase.language}`,
    `cohort-${testCase.cohort}`,
    `scenario-${scenarioTag(testCase.scenario_id)}`
  ];
  return captureItemPayload({
    ...item,
    external_key: externalKey,
    project_id: options.projectId,
    business_category_id: null,
    canonical_key: `${externalKey}:canonical`,
    tags: [...new Set(tags)].slice(-16),
    actor_type: "system",
    actor_id: "local-v4-seed",
    captureOrigin: "observed",
    captureRoute: "initial_import",
    captureBatchId: BATCH_ID
  });
}

function reviewSeedCandidate(testCase, candidate, options) {
  const seeded = structuredClone(candidate);
  seeded.external_key = `${DATASET_PREFIX}${testCase.id}:review`;
  seeded.project_id = options.projectId;
  seeded.task_key = `${SOURCE}:${testCase.id}`;
  seeded.import_batch_hash = BATCH_ID;
  if (seeded.item && typeof seeded.item === "object") {
    seeded.item = { ...seeded.item, project_id: options.projectId, business_category_id: null };
  }
  return seeded;
}

async function postDirectCaptureBatch(items, options) {
  const directItems = items.map((item) => ({
    ...item,
    lifecycle_state: "active",
    scope_type: "project",
    scope_key: options.projectId,
    verification_state: item.verification?.state ?? "verified",
    verified_at: item.verification?.verified_at ?? null
  }));
  const response = await fetch(`${options.apiUrl}/v1/memories/capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey
    },
    body: JSON.stringify({
      tenant_id: options.tenantId,
      source: SOURCE,
      actor_type: "system",
      actor_id: "local-v4-seed",
      items: directItems
    }),
    signal: AbortSignal.timeout(options.timeoutMs)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(`local_seed_capture_failed:${response.status}:${JSON.stringify(body)?.slice(0, 500)}`);
  }
  return body.data;
}

async function postMcpLearningBatch(candidates, options) {
  const request = buildMcpLearningBatchRequest(options.tenantId, SOURCE, {
    projectId: options.projectId,
    taskKey: `${SOURCE}:review-batch`,
    quarantineCandidates: candidates
  });
  const response = await fetch(`${options.apiUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "cf-access-client-id": options.mcpClientId,
      "cf-access-client-secret": options.mcpClientSecret,
      "x-orgbrain-tenant": options.tenantId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": MCP_LEARNING_TOOL
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(options.timeoutMs)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error || body?.result?.isError) {
    throw new Error(`local_seed_learning_failed:${response.status}:${JSON.stringify(body)?.slice(0, 700)}`);
  }
  const text = body?.result?.content?.find?.((entry) => entry?.type === "text")?.text;
  if (typeof text !== "string") throw new Error("local_seed_learning_missing_result");
  return JSON.parse(text);
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function parseOptions(argv) {
  const apiUrl = option(argv, "--api-url", process.env.ORGBRAIN_LOCAL_API_URL || DEFAULT_API_URL).replace(/\/+$/u, "");
  const apiKey = option(argv, "--api-key", process.env.ORGBRAIN_LOCAL_API_KEY || "dev-org-brain-api-key");
  if (!LOOPBACK_HOSTS.has(new URL(apiUrl).hostname)) throw new Error("local_seed_requires_loopback_api_url");
  const tenantId = option(argv, "--tenant", process.env.ORGBRAIN_TENANT_ID || DEFAULT_TENANT_ID);
  const projectId = option(argv, "--project", process.env.ORGBRAIN_PROJECT_ID || DEFAULT_PROJECT_ID);
  const stateDir = path.resolve(option(argv, "--state-dir", process.env.ORGBRAIN_LOCAL_STATE_DIR || path.join(ROOT, ".local/production-dump/local-state")));
  const configPath = path.resolve(option(argv, "--config", path.join(ROOT, "apps/api-gateway/wrangler.local.toml")));
  const logDir = path.resolve(option(argv, "--log-dir", path.join(ROOT, ".local/production-dump/wrangler-logs")));
  const reportPath = path.resolve(option(argv, "--report", path.join(ROOT, ".local/memory-ingestion-v4-seed/report.json")));
  return {
    apiUrl, apiKey, tenantId, projectId, stateDir, configPath, logDir, reportPath,
    mcpClientId: option(argv, "--mcp-client-id", process.env.ORGBRAIN_LOCAL_MCP_CLIENT_ID || "local-v4-seed"),
    mcpClientSecret: option(argv, "--mcp-client-secret", process.env.ORGBRAIN_LOCAL_MCP_CLIENT_SECRET || "local-v4-seed-secret"),
    timeoutMs: Number(option(argv, "--timeout-ms", "15000"))
  };
}

export async function seedMemoryIngestionRegressionLocal(options = {}) {
  const resolved = { ...parseOptions([]), ...options };
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "orgbrain-ingestion-local-seed-"));
  await chmod(tempRoot, 0o700);
  try {
    const corpus = await buildMemoryIngestionRegressionCorpus();
    const fixture = await prepareFixture(tempRoot, corpus);
    const env = {
      ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
      ORGBRAIN_ENABLE_ORG_SHARING: "false",
      ORGBRAIN_TENANT_ID: resolved.tenantId,
      ORGBRAIN_WORKSPACES_FILE: path.join(tempRoot, "missing-workspaces.json"),
      ORGBRAIN_HOOK_ENV_FILES: path.join(tempRoot, "missing-hooks.env")
    };
    const importReport = await createCodexSessionImportReport({
      workspaceRoot: fixture.workspace,
      sessionsRoot: fixture.captureSessions,
      env
    });
    const caseBySessionHash = new Map(corpus.cases.map((testCase) => [testCase.session_hash, testCase]));
    const activeItems = importReport.plan.batches.flatMap((batch) => {
      const testCase = caseForBatch(batch, caseBySessionHash);
      return testCase ? (batch.active ?? []).map((item) => activeSeedItem(testCase, item, resolved)) : [];
    });
    const reviewCandidates = importReport.plan.batches.flatMap((batch) => {
      const testCase = caseForBatch(batch, caseBySessionHash);
      return testCase
        ? (batch.quarantine ?? batch.review ?? []).map((candidate) => reviewSeedCandidate(testCase, candidate, resolved))
        : [];
    });
    const existing = existingSeedKeys(resolved);
    const activeToSend = activeItems.filter((item) => !existing.has(item.external_key));
    const reviewToSend = reviewCandidates.filter((candidate) => !existing.has(candidate.external_key));
    const activeResults = [];
    for (const batch of chunk(activeToSend, 3)) {
      activeResults.push(await postDirectCaptureBatch(batch, resolved));
    }
    const reviewResults = [];
    for (const batch of chunk(reviewToSend, 3)) {
      reviewResults.push(await postMcpLearningBatch(batch, resolved));
    }
    const traceReport = await seedTraceFixtures(corpus, resolved);
    const prefix = sqlString(`${DATASET_PREFIX}%`);
    const counts = queryLocalD1(
      `SELECT
         (SELECT COUNT(*) FROM memories WHERE tenant_id = ${sqlString(resolved.tenantId)} AND external_key LIKE ${prefix} AND lifecycle_state = 'active') AS active_memories,
         (SELECT COUNT(*) FROM memory_versions v JOIN memories m ON m.tenant_id = v.tenant_id AND m.id = v.memory_id WHERE v.tenant_id = ${sqlString(resolved.tenantId)} AND m.external_key LIKE ${prefix}) AS memory_versions,
         (SELECT COUNT(*) FROM memory_learning_candidates WHERE tenant_id = ${sqlString(resolved.tenantId)} AND external_key LIKE ${prefix} AND status = 'quarantine') AS quarantine_candidates,
         (SELECT COUNT(*) FROM memories WHERE tenant_id = ${sqlString(resolved.tenantId)} AND external_key LIKE ${prefix} AND kind = 'decision' AND learning_json IS NOT NULL) AS decision_memories`
      , resolved
    )[0] ?? {};
    const report = {
      status: "passed",
      dataset_id: corpus.dataset_id,
      generated_case_count: corpus.cases.length,
      language_counts: corpus.language_counts,
      capture_lane_counts: { active: 225, review: 12, excluded: 200 },
      seed_prefix: DATASET_PREFIX,
      target: { api_url: resolved.apiUrl, tenant_id: resolved.tenantId, project_id: resolved.projectId },
      before: { existing_seed_keys: existing.size, active_to_send: activeToSend.length, review_to_send: reviewToSend.length },
      requests: { active_batches: activeResults.length, review_batches: reviewResults.length },
      created_rows: {
        memory: activeToSend.length,
        memory_version: activeToSend.length,
        review_candidate: reviewToSend.length,
        ...traceReport.created_rows
      },
      replay_new_rows: {
        memory: activeToSend.length,
        memory_version: activeToSend.length,
        review_candidate: reviewToSend.length,
        ...traceReport.replay_new_rows
      },
      trace: traceReport,
      database: {
        active_memories: Number(counts.active_memories ?? 0),
        memory_versions: Number(counts.memory_versions ?? 0),
        quarantine_candidates: Number(counts.quarantine_candidates ?? 0),
        decision_memories: Number(counts.decision_memories ?? 0)
      },
      idempotent_replay_ready: activeToSend.length === 0 && reviewToSend.length === 0
    };
    if (report.database.active_memories !== 225 || report.database.memory_versions !== 225 || report.database.quarantine_candidates !== 12 || report.database.decision_memories !== 75) {
      throw new Error(`local_seed_count_mismatch:${JSON.stringify(report.database)}`);
    }
    await mkdir(path.dirname(resolved.reportPath), { recursive: true, mode: 0o700 });
    await writeFile(resolved.reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(resolved.reportPath, 0o600);
    return report;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === path.resolve(process.argv[1])) {
  seedMemoryIngestionRegressionLocal()
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
