/* v1.2 binds the new contracts to the already checked v1.1 stdin runner. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from './memory-extraction-router-v33-core.mjs';
import {MEMORY_EXTRACTION_OUTPUT_SCHEMA} from '../packages/shared/src/memory-extraction-provider-contract-runtime.mjs';
import {
  CLI_ACTIVE_CONTRACT,
  CLI_ATTEMPT_CONTRACT,
  CLI_ATTEMPTS_CONTRACT,
  CLI_REQUEST_CONTRACT,
  CLI_RUNNER_CONTRACT,
  CLI_TIMEOUT_MS,
  CLI_MAX_ATTEMPTS,
  RUNNER_HASH,
  assertSupportedOutputSchema,
  buildCodexArgs,
  classifyAttempt,
  findSessionLog,
  inspectNativeLog,
  normalizeUsage,
  readAttempts,
  readAttempt,
  runCli,
  waitForNativeLog,
  CLI_ROOT
} from './memory-utility-v11-cli.mjs';
import {
  V12_C_OUTPUT_SCHEMA,
  V12_EVALUATION_SCHEMA,
  V12_MAX_ITEM_REFS,
  V12_MAX_SPAN_REFS,
  V12_REPLAY_OUTPUT_SCHEMA,
  V12_QUALITY_SCHEMA,
} from './memory-utility-v12-contracts.mjs';

export {
  CLI_ACTIVE_CONTRACT,
  CLI_ATTEMPT_CONTRACT,
  CLI_ATTEMPTS_CONTRACT,
  CLI_REQUEST_CONTRACT,
  CLI_RUNNER_CONTRACT,
  CLI_TIMEOUT_MS,
  CLI_MAX_ATTEMPTS,
  RUNNER_HASH,
  assertSupportedOutputSchema,
  buildCodexArgs,
  classifyAttempt,
  findSessionLog,
  inspectNativeLog,
  normalizeUsage,
  readAttempts,
  readAttempt,
  runCli,
  waitForNativeLog,
  CLI_ROOT
};

export const V12_EXECUTION_TRANSPORT = 'codex_exec_stdin_v1';
export const V12_MODEL = 'gpt-5.6-sol';
export const V12_EFFORT = 'medium';
export const V12_TIMEOUT_MS = CLI_TIMEOUT_MS;
export const V12_MAX_ATTEMPTS = CLI_MAX_ATTEMPTS;
export const V12_RUNNER_HASH = RUNNER_HASH;
export const V12_ENUM_VALUE_LIMIT = 1000;
export const V12_SCHEMA_ENUM_LIMIT = V12_ENUM_VALUE_LIMIT;
export const V12_SCHEMA_ENCODING = 'json_utf8_compact_v1';

export const V12_TRANSPORT_SCHEMAS = Object.freeze({
  'extract-b': MEMORY_EXTRACTION_OUTPUT_SCHEMA,
  'extract-c': V12_C_OUTPUT_SCHEMA,
  'calibrate-c': V12_C_OUTPUT_SCHEMA,
  replay: V12_REPLAY_OUTPUT_SCHEMA,
  evaluate: V12_EVALUATION_SCHEMA,
  quality: V12_QUALITY_SCHEMA
});

export const V12_SCHEMA_HASHES = Object.freeze(
  Object.fromEntries(Object.entries(V12_TRANSPORT_SCHEMAS).map(([name, schema]) => [name, hash(schema)]))
);

function schemaEntries(schemas) {
  if (schemas && typeof schemas === 'object' && typeof schemas.type === 'string') return [['schema', schemas]];
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) throw new Error('v12_schema_preflight_input_invalid');
  return Object.entries(schemas);
}

export function countSchemaEnumValues(schema) {
  let count = 0;
  const visit = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (Array.isArray(value.enum)) count += value.enum.length;
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return count;
}

export function assertV12SchemaPreflight(schemas = V12_TRANSPORT_SCHEMAS) {
  const report = {};
  for (const [name, schema] of schemaEntries(schemas)) {
    assertSupportedOutputSchema(schema);
    const enum_values = countSchemaEnumValues(schema);
    if (enum_values > V12_ENUM_VALUE_LIMIT) throw new Error(`v12_schema_enum_limit:${name}:${enum_values}`);
    report[name] = {
      enum_values,
      enum_limit: V12_ENUM_VALUE_LIMIT,
      schema_bytes: Buffer.byteLength(JSON.stringify(schema), 'utf8'),
      schema_encoding: V12_SCHEMA_ENCODING
    };
  }
  return report;
}

// Run the corpus-level static-schema check at module load. Job-specific
// schemas are checked again after their bounded ordinal lists are narrowed.
export const V12_SCHEMA_PREFLIGHT = Object.freeze(assertV12SchemaPreflight());

const sourcePath = fileURLToPath(import.meta.url);
export const V12_CLI_CODE_HASH = hash(fs.readFileSync(sourcePath, 'utf8'));

export function v12SchemaKey(job) {
  const stage = job?.private?.stage;
  const method = job?.private?.method;
  if (stage === 'extract' && method === 'B') return 'extract-b';
  if ((stage === 'extract' && method === 'C') || (stage === 'calibrate' && method === 'C')) return `${stage}-c`;
  if (stage === 'replay') return 'replay';
  if (stage === 'evaluate') return 'evaluate';
  if (stage === 'quality') return 'quality';
  throw new Error('v12_schema_stage_unknown');
}

function cloneSchema(schema) {
  return JSON.parse(JSON.stringify(schema));
}

function boundedRefs(values, maximum, code) {
  if (!Number.isSafeInteger(values) || values < 0 || values > maximum) throw new Error(`${code}:${values}`);
  return values;
}

function spanIdsForJob(job) {
  const spans = job?.private?.spans;
  if (!Array.isArray(spans) || !spans.length) throw new Error('v12_schema_spans_required');
  const ids = spans.map(span => span?.id);
  if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('v12_schema_span_ids_invalid');
  }
  boundedRefs(ids.length, V12_MAX_SPAN_REFS, 'v12_schema_span_ref_capacity_exceeded');
  return ids;
}

function extractedItemIdsForJob(job) {
  const items = job?.private?.extracted_items;
  if (!Array.isArray(items)) throw new Error('v12_schema_extracted_items_required');
  const ids = items.map(item => item?.id);
  if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('v12_schema_extracted_item_ids_invalid');
  }
  boundedRefs(ids.length, V12_MAX_ITEM_REFS, 'v12_schema_item_ref_capacity_exceeded');
  return ids;
}

// Ordinal references are intentionally validated against the private catalog
// at hydration time. Repeating every `span-N`/`item-N` value in each schema
// field would make large multi-line cases exceed Structured Outputs' enum
// budget; the schema keeps these fields as strings and the runtime enforces
// the configured capacities and exact input order.
function constrainCRefs(schema, count) {
  boundedRefs(count, V12_MAX_SPAN_REFS, 'v12_schema_span_ref_capacity_exceeded');
  return schema;
}

function constrainQualityRefs(schema, spanCount, itemCount) {
  boundedRefs(spanCount, V12_MAX_SPAN_REFS, 'v12_schema_span_ref_capacity_exceeded');
  boundedRefs(itemCount, V12_MAX_ITEM_REFS, 'v12_schema_item_ref_capacity_exceeded');
  return schema;
}

export function v12SchemaForJob(job) {
  const key = v12SchemaKey(job);
  const dynamic = key === 'extract-c' || key === 'calibrate-c' || key === 'quality';
  const schema = dynamic ? cloneSchema(V12_TRANSPORT_SCHEMAS[key]) : V12_TRANSPORT_SCHEMAS[key];
  if (key === 'extract-c' || key === 'calibrate-c') {
    const ids = spanIdsForJob(job);
    constrainCRefs(schema, ids.length);
  }
  if (key === 'quality') {
    const spanIds = spanIdsForJob(job);
    const itemIds = extractedItemIdsForJob(job);
    constrainQualityRefs(schema, spanIds.length, itemIds.length);
  }
  assertV12SchemaPreflight({[key]: schema});
  return schema;
}

export function v12SchemaHashForJob(job) {
  return hash(v12SchemaForJob(job));
}

export function serializeV12Schema(schema) {
  assertSupportedOutputSchema(schema);
  return JSON.stringify(schema);
}

export function v12InputByteAccounting(prompt, schema) {
  if (typeof prompt !== 'string') throw new Error('v12_prompt_required');
  const schemaText = serializeV12Schema(schema);
  const prompt_bytes = Buffer.byteLength(prompt, 'utf8');
  const schema_bytes = Buffer.byteLength(schemaText, 'utf8');
  return {prompt_bytes, schema_bytes, input_bytes: prompt_bytes + schema_bytes, schema_encoding: V12_SCHEMA_ENCODING};
}

export function validateV12Request(request, job, schema) {
  const expectedSchema = v12SchemaForJob(job);
  const expectedSchemaHash = hash(expectedSchema);
  const schemaText = serializeV12Schema(schema);
  const inputBytes = v12InputByteAccounting(job.prompt, schema);
  const schemaFileMatches = typeof request?.schema_path === 'string'
    && fs.existsSync(request.schema_path)
    && fs.readFileSync(request.schema_path, 'utf8') === schemaText;
  if (!request || request.contract !== CLI_REQUEST_CONTRACT
    || request.job_hash !== job.content_hash
    || request.prompt_hash !== hash(job.prompt)
    || request.model !== V12_MODEL
    || request.effort !== V12_EFFORT
    || request.cwd !== CLI_ROOT
    || request.sandbox !== 'read-only'
    || request.runner_hash !== RUNNER_HASH
    || job.schema_hash !== expectedSchemaHash
    || hash(schema) !== expectedSchemaHash
    || request.schema_hash !== expectedSchemaHash
    || request.prompt_bytes !== inputBytes.prompt_bytes
    || request.schema_bytes !== inputBytes.schema_bytes
    || request.input_bytes !== inputBytes.input_bytes
    || request.schema_encoding !== V12_SCHEMA_ENCODING
    || typeof request.schema_path !== 'string'
    || request.schema_path !== path.resolve(request.schema_path)
    || !schemaFileMatches) {
    throw new Error('v12_cli_request_mismatch');
  }
  assertV12SchemaPreflight({[v12SchemaKey(job)]: schema});
  return request;
}
