import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn as nativeSpawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hash} from './memory-extraction-router-v33-core.mjs';
import {MEMORY_EXTRACTION_OUTPUT_SCHEMA} from '../packages/shared/src/memory-extraction-provider-contract-runtime.mjs';

export const CLI_REQUEST_CONTRACT = 'memory-utility-cli-request/v2';
export const CLI_ACTIVE_CONTRACT = 'memory-utility-cli-active/v2';
export const CLI_ATTEMPT_CONTRACT = 'memory-utility-cli-attempt/v1';
export const CLI_ATTEMPTS_CONTRACT = 'memory-utility-cli-attempts/v1';
export const CLI_RUNNER_CONTRACT = 'memory-utility-cli-runner/v1';
export const CLI_TIMEOUT_MS = 5 * 60 * 1000;
export const CLI_MAX_ATTEMPTS = 2;
export const CLI_KILL_GRACE_MS = 5_000;
export const CLI_NATIVE_LOG_WAIT_MS = 3_000;
export const CLI_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const CLI_MAX_STDERR_BYTES = 2 * 1024 * 1024;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPPORTED_SCHEMA_KEYS = new Set(['type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'maxItems']);
const OBJECT_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const COMMUNICATION_FAILURE = /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|socket|network|transport|connection\s+(?:reset|refused|closed|timed?\s*out)|rpc|\bHTTP\s+[45]\d\d|\b(?:502|503|504)\b)/iu;
const CONFIG_FAILURE = /(?:unknown\s+(?:option|argument)|invalid\s+(?:option|argument|value)|unrecognized\s+option|usage:|output[- ]schema|schema\s+(?:error|invalid|unsupported)|config(?:uration)?\s+(?:error|invalid|missing)|permission\s+denied|command\s+not\s+found|\bENOENT\b|\bEACCES\b)/iu;

/* The API/CLI structured-output transport supports a deliberately small JSON
 * Schema subset. C's conditional retention rule stays in the source schema and
 * local validator; it is intentionally absent from this transport schema. */
export const C_TRANSPORT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'content', 'condition', 'reason', 'support_ids', 'status', 'storage', 'storage_reason', 'relation', 'target_ids'],
        properties: {
          id: {type: 'string'},
          content: {type: 'string'},
          condition: {type: 'string'},
          reason: {type: 'string'},
          support_ids: {type: 'array', items: {type: 'string'}},
          status: {type: 'string', enum: ['proposed', 'adopted', 'observed', 'unknown']},
          storage: {type: 'string', enum: ['long', 'short', 'none']},
          storage_reason: {type: 'string'},
          relation: {type: 'string', enum: ['create', 'duplicate', 'update', 'conflict']},
          target_ids: {type: 'array', items: {type: 'string'}}
        }
      }
    }
  }
});

export const REPLAY_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'used_memory_ids'],
  properties: {
    answer: {type: 'string'},
    used_memory_ids: {type: 'array', items: {type: 'string'}}
  }
});

const METRICS = ['continuation', 'constraints', 'recurrence_prevention', 'memory_harm'];
const evaluationMetricSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['rating', 'reason', 'support_ids'],
  properties: {
    rating: {type: 'string', enum: ['meets', 'partial', 'fails', 'unknown']},
    reason: {type: 'string'},
    support_ids: {type: 'array', items: {type: 'string'}}
  }
});
export const EVALUATION_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['answers', 'extraction_issues'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'metrics', 'major_memory_errors'],
        properties: {
          id: {type: 'string', enum: ['answer-1', 'answer-2', 'answer-3']},
          metrics: {
            type: 'object',
            additionalProperties: false,
            required: METRICS,
            properties: Object.fromEntries(METRICS.map(metric => [metric, evaluationMetricSchema]))
          },
          major_memory_errors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['description', 'support_ids'],
              properties: {description: {type: 'string'}, support_ids: {type: 'array', items: {type: 'string'}}}
            }
          }
        }
      }
    },
    extraction_issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['answer_id', 'item_id', 'kind', 'reason', 'support_ids'],
        properties: {
          answer_id: {type: 'string'},
          item_id: {type: 'string'},
          kind: {type: 'string', enum: ['unsupported', 'duplicate', 'retention', 'missed_update']},
          reason: {type: 'string'},
          support_ids: {type: 'array', items: {type: 'string'}}
        }
      }
    }
  }
});

export const TRANSPORT_SCHEMAS = Object.freeze({
  'extract-b': MEMORY_EXTRACTION_OUTPUT_SCHEMA,
  'extract-c': C_TRANSPORT_OUTPUT_SCHEMA,
  'calibrate-c': C_TRANSPORT_OUTPUT_SCHEMA,
  replay: REPLAY_OUTPUT_SCHEMA,
  evaluate: EVALUATION_OUTPUT_SCHEMA
});

const runnerSource = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
export const RUNNER_HASH = hash(runnerSource);
export const SCHEMA_HASHES = Object.freeze(Object.fromEntries(Object.entries(TRANSPORT_SCHEMAS).map(([name, schema]) => [name, hash(schema)])));

function fail(code) {
  throw new Error(code);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function ensurePrivatePath(root, file) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(file);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) fail('cli_path_outside_run');
  return resolved;
}

function privateWrite(file, value, options = {}) {
  const data = Buffer.isBuffer(value) ? value : String(value);
  fs.writeFileSync(file, data, {flag: options.flag ?? 'wx', mode: 0o600});
  fs.chmodSync(file, 0o600);
}

function privatePlaceholder(file) {
  if (!fs.existsSync(file)) privateWrite(file, '', {flag: 'wx'});
  else fs.chmodSync(file, 0o600);
}

function fileSha256(file) {
  if (!fs.existsSync(file)) return null;
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function numericOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeUsage(value) {
  const source = record(value);
  const input = numericOrNull(source.input_tokens ?? source.inputTokens);
  const output = numericOrNull(source.output_tokens ?? source.outputTokens);
  const cached = numericOrNull(source.cached_input_tokens ?? source.cachedInputTokens);
  const reasoning = numericOrNull(source.reasoning_tokens ?? source.reasoningTokens);
  const total = numericOrNull(source.total_tokens ?? source.totalTokens);
  return {input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_tokens: reasoning, total_tokens: total};
}

export function usageFromRows(rows, nativeUsage = null) {
  const completed = [...rows].reverse().find(row => row?.type === 'turn.completed' && row.usage);
  const eventUsage = completed ? normalizeUsage(completed.usage) : normalizeUsage(null);
  if (Object.values(eventUsage).some(value => value !== null)) return eventUsage;
  const native = normalizeUsage(nativeUsage);
  return Object.values(native).some(value => value !== null) ? native : normalizeUsage(null);
}

export function assertSupportedOutputSchema(schema) {
  const visit = (value, location = '$') => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`output_schema_invalid:${location}`);
    for (const key of Object.keys(value)) if (!SUPPORTED_SCHEMA_KEYS.has(key)) fail(`output_schema_unsupported:${location}.${key}`);
    if (typeof value.type !== 'string' || !OBJECT_TYPES.has(value.type)) fail(`output_schema_type:${location}`);
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) fail(`output_schema_enum:${location}`);
    if (value.type === 'object') {
      if (value.additionalProperties !== false) fail(`output_schema_additional_properties:${location}`);
      if (!record(value.properties) || !Array.isArray(value.required)) fail(`output_schema_object_shape:${location}`);
      const properties = Object.keys(value.properties);
      if (new Set(value.required).size !== value.required.length || properties.some(key => !value.required.includes(key)) || value.required.some(key => !properties.includes(key))) {
        fail(`output_schema_required_properties:${location}`);
      }
      for (const [key, child] of Object.entries(value.properties)) visit(child, `${location}.properties.${key}`);
    }
    if (value.type === 'array' && value.items !== undefined) visit(value.items, `${location}.items`);
    if (value.type === 'array' && value.items === undefined) fail(`output_schema_items:${location}`);
    if (value.maxItems !== undefined && (!Number.isSafeInteger(value.maxItems) || value.maxItems < 0)) fail(`output_schema_max_items:${location}`);
  };
  visit(schema);
  return schema;
}

export function schemaKeyForJob(job) {
  const stage = job?.private?.stage;
  const method = job?.private?.method;
  if (stage === 'calibrate' && method === 'C') return 'calibrate-c';
  if (stage === 'extract' && method === 'B') return 'extract-b';
  if (stage === 'extract' && method === 'C') return 'extract-c';
  if (stage === 'replay' && ['A', 'B', 'C'].includes(method)) return 'replay';
  if (stage === 'evaluate') return 'evaluate';
  fail('cli_schema_stage_unknown');
}

export function schemaForJob(job) {
  const key = schemaKeyForJob(job);
  const schema = TRANSPORT_SCHEMAS[key];
  assertSupportedOutputSchema(schema);
  return schema;
}

export function schemaHashForJob(job) {
  return SCHEMA_HASHES[schemaKeyForJob(job)];
}

export function buildCodexArgs({schemaPath, outputPath}) {
  if (!path.isAbsolute(schemaPath) || !path.isAbsolute(outputPath)) fail('cli_paths_must_be_absolute');
  return [
    'exec', '-C', ROOT, '-s', 'read-only', '-m', 'gpt-5.6-sol',
    '-c', 'model_reasoning_effort="medium"', '--json', '--output-schema', schemaPath,
    '-o', outputPath, '-'
  ];
}

function lineRows(text) {
  const rows = [];
  const errors = [];
  let offset = 0;
  for (const line of String(text ?? '').split('\n')) {
    const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (raw.trim()) {
      try { rows.push(JSON.parse(raw)); }
      catch { errors.push({offset, text: raw}); }
    }
    offset += line.length + 1;
  }
  return {rows, errors};
}

function eventFinals(rows) {
  return rows.flatMap(row => {
    if (row?.type === 'item.completed' && row.item?.type === 'agent_message' && typeof row.item.text === 'string') return [{text: row.item.text, source: 'events'}];
    if (row?.payload?.type === 'agent_message' && row.payload?.phase === 'final_answer' && typeof row.payload.message === 'string') return [{text: row.payload.message, source: 'events'}];
    return [];
  });
}

function nativeFinals(rows) {
  return rows.flatMap(row => {
    const payload = row?.payload;
    if (row?.type === 'response_item' && payload?.type === 'message' && payload?.role === 'assistant' && (payload.channel === 'final' || payload.phase === 'final_answer')) {
      const content = typeof payload.content === 'string' ? payload.content : (payload.content ?? []).filter(block => ['text', 'output_text', 'input_text'].includes(block.type)).map(block => block.text).join('\n');
      return [{text: content, source: 'native'}];
    }
    return [];
  });
}

function nativeText(rows) {
  return rows.flatMap(row => {
    const payload = row?.payload;
    if (row?.type !== 'response_item' || payload?.type !== 'message') return [];
    return [typeof payload.content === 'string' ? payload.content : (payload.content ?? []).filter(block => ['text', 'output_text', 'input_text'].includes(block.type)).map(block => block.text).join('\n')];
  });
}

function sessionRoot(value) {
  if (value) return path.resolve(value);
  const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
  return path.join(codexHome, 'sessions');
}

export function findSessionLog(sessionId, {sessionsRoot, atMs} = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const base = sessionRoot(sessionsRoot);
  const timestamp = Number.isFinite(atMs) ? atMs : Date.now();
  const dates = [...new Set([0, 9 * 3600000, -9 * 3600000].map(offset => new Date(timestamp + offset).toISOString().slice(0, 10).replaceAll('-', '/')))];
  const files = dates.flatMap(date => {
    const directory = path.join(base, date);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => name.endsWith(`${sessionId}.jsonl`)).map(name => path.join(directory, name));
  });
  return files.length === 1 ? files[0] : null;
}

export function inspectNativeLog(sessionId, {sessionsRoot, atMs} = {}) {
  const logPath = findSessionLog(sessionId, {sessionsRoot, atMs});
  if (!logPath) return {status: 'unavailable', session_id: sessionId ?? null, log: null, finals: [], common_memory_hash: null, usage: normalizeUsage(null)};
  const raw = fs.readFileSync(logPath, 'utf8');
  const parsed = lineRows(raw);
  if (parsed.errors.length) return {status: 'unknown', session_id: sessionId, log: logPath, finals: [], common_memory_hash: null, usage: normalizeUsage(null), parse_errors: parsed.errors.length};
  const commonMemory = nativeText(parsed.rows).filter(text => text.includes('MEMORY_SUMMARY BEGINS'));
  return {
    status: 'available', session_id: sessionId, log: logPath, finals: nativeFinals(parsed.rows),
    common_memory_hash: commonMemory.length === 1 ? hash(commonMemory) : null,
    common_memory_count: commonMemory.length,
    usage: usageFromRows(parsed.rows, parsed.rows.filter(row => row?.type === 'event_msg' && row.payload?.type === 'token_count').at(-1)?.payload?.info?.total_token_usage),
    parse_errors: 0
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForNativeLog(sessionId, options = {}) {
  const timeoutMs = options.timeoutMs ?? CLI_NATIVE_LOG_WAIT_MS;
  const inspect = options.inspect ?? inspectNativeLog;
  const started = Date.now();
  let latest = await inspect(sessionId, options);
  while (latest.status === 'unavailable' && Date.now() - started < timeoutMs) {
    await sleep(Math.min(100, Math.max(10, timeoutMs - (Date.now() - started))));
    latest = await inspect(sessionId, options);
  }
  return latest;
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve({code: child.exitCode, signal: child.signalCode});
  return new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
}

function signalGroup(child, signal) {
  if (!child?.pid) return false;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    try { child.kill(signal); return true; } catch { return false; }
  }
}

function processGroupAlive(child) {
  if (!child?.pid || process.platform === 'win32') return child?.exitCode === null && !child?.signalCode;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; return true; }
}

async function waitForGroupGone(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(child) && Date.now() < deadline) await sleep(Math.min(25, Math.max(5, deadline - Date.now())));
  return !processGroupAlive(child);
}

export async function terminateProcessGroup(child, closePromise, {graceMs = CLI_KILL_GRACE_MS} = {}) {
  if (!child?.pid) return {terminated: false, quiesced: true};
  // The child `close` event only describes the direct CLI process. A detached
  // process group can still contain descendants after that event, so never
  // treat a non-null exitCode/signalCode as proof that the group is gone.
  if (processGroupAlive(child)) signalGroup(child, 'SIGTERM');
  await Promise.race([closePromise, sleep(graceMs)]);
  if (processGroupAlive(child)) {
    signalGroup(child, 'SIGKILL');
    await waitForGroupGone(child, graceMs);
  }
  return {terminated: true, quiesced: !processGroupAlive(child)};
}

async function runSingleAttempt({executable, args, prompt, cwd, env, timeoutMs, spawnImpl = nativeSpawn, stdoutMaxBytes = CLI_MAX_STDOUT_BYTES, stderrMaxBytes = CLI_MAX_STDERR_BYTES, killGraceMs = CLI_KILL_GRACE_MS}) {
  let child;
  try { child = spawnImpl(executable, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32'}); }
  catch (error) { return {stdout: '', stderr: '', code: null, signal: null, timed_out: false, spawn_error: {code: error?.code ?? null, message: error?.message ?? String(error)}, quiesced: true}; }
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let streamError = null;
  let spawnError = null;
  let timedOut = false;
  let killPromise = null;
  let killOutcome = null;
  const closePromise = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  child.once('error', error => { spawnError = {code: error?.code ?? null, message: error?.message ?? String(error)}; });
  child.stdout?.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= stdoutMaxBytes) stdout.push(Buffer.from(chunk));
    else if (!streamError) { streamError = 'stdout_limit_exceeded'; killPromise ??= terminateProcessGroup(child, closePromise, {graceMs: killGraceMs}); }
  });
  child.stderr?.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes <= stderrMaxBytes) stderr.push(Buffer.from(chunk));
    else if (!streamError) { streamError = 'stderr_limit_exceeded'; killPromise ??= terminateProcessGroup(child, closePromise, {graceMs: killGraceMs}); }
  });
  child.stdin?.once('error', error => { if (!streamError) streamError = 'stdin_write_failed'; killPromise ??= terminateProcessGroup(child, closePromise, {graceMs: killGraceMs}); });
  try { child.stdin.end(prompt); }
  catch (error) { streamError = 'stdin_write_failed'; killPromise ??= terminateProcessGroup(child, closePromise, {graceMs: killGraceMs}); }
  const timer = setTimeout(() => { timedOut = true; killPromise ??= terminateProcessGroup(child, closePromise, {graceMs: killGraceMs}); }, timeoutMs);
  const closed = await closePromise;
  clearTimeout(timer);
  if (killPromise) killOutcome = await killPromise;
  const quiesced = killOutcome ? killOutcome.quiesced : await waitForGroupGone(child, killGraceMs);
  return {
    stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
    code: closed.code, signal: closed.signal, timed_out: timedOut, stream_error: streamError,
    spawn_error: spawnError, quiesced, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes
  };
}

export function classifyAttempt(attempt) {
  if (attempt.final_present) return {status: attempt.quiesced === true && !attempt.stream_error ? 'final' : 'held', retryable: false, reason: attempt.quiesced === true && !attempt.stream_error ? 'final_present' : 'final_or_stream_unsettled', proof: 'events_or_output_or_native'};
  if (attempt.stream_error) return {status: 'held', retryable: false, reason: 'stream_error_without_final', proof: attempt.stream_error};
  if (attempt.quiesced !== true) return {status: 'held', retryable: false, reason: 'process_group_not_quiescent', proof: 'surviving_process_group'};
  if (attempt.native_status !== 'available') return {status: 'held', retryable: false, reason: 'native_final_presence_unknown', proof: 'native_log_not_attested'};
  if (attempt.stdout_parse_errors > 0) return {status: 'held', retryable: false, reason: 'events_parse_error', proof: 'event_stream_not_trustworthy'};
  const diagnostics = `${attempt.stderr ?? ''}\n${attempt.spawn_error?.message ?? ''}`;
  if (attempt.spawn_error) return {status: 'held', retryable: false, reason: 'spawn_error', proof: attempt.spawn_error.code ?? 'unknown'};
  if (CONFIG_FAILURE.test(diagnostics)) return {status: 'held', retryable: false, reason: 'config_or_schema_error', proof: 'native_stderr_or_exit'};
  if (attempt.timed_out) return {status: 'communication_failure', retryable: true, reason: 'bounded_timeout_without_final', proof: 'process_group_terminated_and_quiesced'};
  if (COMMUNICATION_FAILURE.test(diagnostics)) return {status: 'communication_failure', retryable: true, reason: 'known_transport_failure_without_final', proof: 'native_stderr_or_exit'};
  return {status: 'held', retryable: false, reason: 'unknown_failure_without_final', proof: 'no_retry_without_transport_proof'};
}

function finalPresence(events, output, native) {
  const eventFinal = eventFinals(events);
  // A non-empty output artifact is evidence that the CLI produced a final
  // payload, even when it is only whitespace or malformed JSON. Preserve it
  // as hold evidence; retrying could silently replace a real response.
  const outputFinal = typeof output === 'string' && output.length > 0 ? [{text: output, source: 'output'}] : [];
  const nativeFinal = native?.finals ?? [];
  const all = [...eventFinal, ...outputFinal, ...nativeFinal];
  return {final_present: all.length > 0, final_sources: [...new Set(all.map(item => item.source))], final_texts: all.map(item => item.text)};
}

function readPrompt(request, job) {
  const prompt = fs.readFileSync(request.prompt_path);
  if (hash(prompt.toString('utf8')) !== request.prompt_hash || prompt.toString('utf8') !== job.prompt) fail('cli_prompt_file_mismatch');
  if ((fs.statSync(request.prompt_path).mode & 0o777) !== 0o600) fail('cli_prompt_file_not_private');
  return prompt;
}

function validateRunnerRequest(request, job, schema, schemaPath) {
  if (request.contract !== CLI_REQUEST_CONTRACT || request.job_hash !== job.content_hash || request.prompt_hash !== hash(job.prompt)
    || request.model !== 'gpt-5.6-sol' || request.effort !== 'medium' || request.cwd !== ROOT || request.sandbox !== 'read-only'
    || request.runner_hash !== RUNNER_HASH || request.schema_hash !== job.schema_hash || request.schema_hash !== hash(schema) || request.schema_path !== schemaPath) fail('cli_request_mismatch');
  assertSupportedOutputSchema(schema);
}

export async function runCli({
  root, request, job, schema, executable = process.env.CODEX_CLI_PATH || 'codex', timeoutMs = CLI_TIMEOUT_MS,
  sessionsRoot, maxAttempts = CLI_MAX_ATTEMPTS, spawnImpl = nativeSpawn, nativeInspector = inspectNativeLog,
  nativeWaitMs = CLI_NATIVE_LOG_WAIT_MS, killGraceMs = CLI_KILL_GRACE_MS
}) {
  const runRoot = path.resolve(root);
  const requestPath = request.path;
  const schemaPath = ensurePrivatePath(runRoot, request.schema_path);
  const prompt = readPrompt(request, job);
  validateRunnerRequest(request, job, schema, schemaPath);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > CLI_TIMEOUT_MS) fail('cli_timeout_invalid');
  if (maxAttempts !== CLI_MAX_ATTEMPTS) fail('cli_attempt_limit_invalid');
  const activePath = ensurePrivatePath(runRoot, request.active_path);
  if (!fs.existsSync(activePath)) fail('cli_active_lock_missing');
  const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
  const {content_hash: activeHash, ...activeBody} = active;
  if (hash(activeBody) !== activeHash || activeBody.contract !== CLI_ACTIVE_CONTRACT || activeBody.job_id !== job.id
    || activeBody.job_hash !== job.content_hash || activeBody.prompt_hash !== request.prompt_hash || activeBody.schema_hash !== request.schema_hash
    || activeBody.runner_hash !== RUNNER_HASH || request.active_hash !== activeHash) fail('cli_active_lock_mismatch');
  const attemptsPath = ensurePrivatePath(runRoot, request.attempts_path);
  if (fs.existsSync(attemptsPath)) fail('cli_execution_already_present');
  const priorAttempt = fs.readdirSync(runRoot).find(name => name.startsWith(`cli-attempt-${job.id}-`) && name.endsWith('.json'));
  if (priorAttempt) fail('cli_execution_already_present');
  const descriptors = [];
  const base = {id: job.id, job_id: job.id, job_hash: job.content_hash, prompt_hash: request.prompt_hash, schema_hash: request.schema_hash, runner_hash: request.runner_hash};
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    const eventsPath = ensurePrivatePath(runRoot, path.join(runRoot, `cli-events-${job.id}-attempt-${attemptNumber}.jsonl`));
    const outputPath = ensurePrivatePath(runRoot, path.join(runRoot, `cli-output-${job.id}-attempt-${attemptNumber}.json`));
    const stderrPath = ensurePrivatePath(runRoot, path.join(runRoot, `cli-stderr-${job.id}-attempt-${attemptNumber}.log`));
    for (const file of [eventsPath, outputPath, stderrPath]) if (fs.existsSync(file)) fail('cli_attempt_file_exists');
    privatePlaceholder(outputPath);
    const args = buildCodexArgs({schemaPath, outputPath});
    const argvHash = hash([executable, ...args]);
    const startedAt = new Date().toISOString();
    const processResult = await runSingleAttempt({executable, args, prompt, cwd: ROOT, env: process.env, timeoutMs, spawnImpl, killGraceMs});
    privateWrite(eventsPath, processResult.stdout);
    privateWrite(stderrPath, processResult.stderr);
    if (!fs.existsSync(outputPath)) privateWrite(outputPath, '');
    else fs.chmodSync(outputPath, 0o600);
    const eventData = lineRows(processResult.stdout);
    const output = fs.readFileSync(outputPath, 'utf8');
    const sessionId = eventData.rows.find(row => row?.type === 'thread.started' && typeof row.thread_id === 'string')?.thread_id ?? null;
    const native = sessionId ? await waitForNativeLog(sessionId, {sessionsRoot, atMs: Date.parse(startedAt), timeoutMs: nativeWaitMs, inspect: nativeInspector}) : {status: 'unavailable', session_id: null, finals: [], common_memory_hash: null, usage: normalizeUsage(null)};
    const presence = finalPresence(eventData.rows, output, native);
    const finishedAt = new Date().toISOString();
    const descriptor = {
      contract: CLI_ATTEMPT_CONTRACT, ...base, attempt: attemptNumber, executable, args, argv_hash: argvHash,
      cwd: ROOT, sandbox: 'read-only', model: 'gpt-5.6-sol', effort: 'medium',
      events_path: eventsPath, output_path: outputPath, stderr_path: stderrPath,
      events_sha256: fileSha256(eventsPath), output_sha256: fileSha256(outputPath), stderr_sha256: fileSha256(stderrPath),
      input_bytes: prompt.byteLength, stdout_bytes: processResult.stdout_bytes, stderr_bytes: processResult.stderr_bytes,
      started_at: startedAt, finished_at: finishedAt, elapsed_ms: Date.parse(finishedAt) - Date.parse(startedAt),
      exit_code: processResult.code, signal: processResult.signal, timed_out: processResult.timed_out,
      stream_error: processResult.stream_error, spawn_error: processResult.spawn_error, quiesced: processResult.quiesced,
      session_id: sessionId, native_status: native.status, native_log: native.log ?? null, common_memory_hash: native.common_memory_hash ?? null,
      final_present: presence.final_present, final_sources: presence.final_sources, final_text_hashes: presence.final_texts.map(text => hash(text)),
      stdout_parse_errors: eventData.errors.length, usage: usageFromRows(eventData.rows, native.usage),
      retry: null
    };
    const decision = classifyAttempt({...descriptor, stderr: processResult.stderr});
    descriptor.retry = decision;
    const sealed = {...descriptor, content_hash: hash(descriptor)};
    privateWrite(ensurePrivatePath(runRoot, path.join(runRoot, `cli-attempt-${job.id}-${attemptNumber}.json`)), JSON.stringify(sealed, null, 2) + '\n');
    descriptors.push(sealed);
    if (!decision.retryable || attemptNumber >= maxAttempts) break;
  }
  const final = descriptors.findLast(descriptor => descriptor.final_present && descriptor.retry?.status === 'final') ?? null;
  const attempts = {contract: CLI_ATTEMPTS_CONTRACT, job_id: job.id, job_hash: job.content_hash, prompt_hash: request.prompt_hash, schema_hash: request.schema_hash, runner_hash: request.runner_hash, max_attempts: maxAttempts, attempts: descriptors.map(({content_hash, ...descriptor}) => ({...descriptor, attempt_hash: content_hash}))};
  privateWrite(attemptsPath, JSON.stringify({...attempts, content_hash: hash(attempts)}, null, 2) + '\n');
  return {status: final ? 'final_available' : 'held', final_attempt: final?.attempt ?? null, attempts_path: attemptsPath, attempts: descriptors};
}

export function readAttempts(root, jobId) {
  const file = path.join(root, `cli-attempts-${jobId}.json`);
  if (!fs.existsSync(file)) fail('cli_attempts_missing');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const {content_hash, ...body} = value;
  if (hash(body) !== content_hash || body.contract !== CLI_ATTEMPTS_CONTRACT || body.job_id !== jobId) fail('cli_attempts_integrity');
  return value;
}

export function readAttempt(root, descriptor) {
  const file = path.join(root, `cli-attempt-${descriptor.job_id}-${descriptor.attempt}.json`);
  if (!fs.existsSync(file)) fail('cli_attempt_descriptor_missing');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const {content_hash, ...body} = value;
  if (hash(body) !== content_hash || body.contract !== CLI_ATTEMPT_CONTRACT || content_hash !== descriptor.attempt_hash) fail('cli_attempt_integrity');
  return value;
}

export {ROOT as CLI_ROOT};
