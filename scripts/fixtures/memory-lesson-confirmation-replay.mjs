// Isolated synthetic Stop replay; no user history, provider, or network calls.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const runtimeRoot = resolve(process.argv[2]);
const load = file => import(pathToFileURL(join(runtimeRoot, file)).href);
let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error('network forbidden in synthetic replay'); };
const { ingestHookEvent, normalizeRecord, prepareMemoryRecordsV2, prepareObservedLearningRecords } = await load('packages/orgbrain-cli/src/hook-memory-bridge.mjs');
const { observeMemoryContractV2Event } = await load('packages/shared/src/memory-contract-v2-runtime.mjs');
const directory = await mkdtemp(join(tmpdir(), 'orgbrain-lesson-confirm-'));
const results = [];
const rationale = 'Concurrent writers contend on the same local SQLite database and cannot safely overlap.';
const reuse = 'When diagnostics share one local database, run checks sequentially; independent databases may run concurrently.';
const rule = (kind) => `## Conclusion\n${kind === 'pitfall' ? 'The workaround is to serialize SQLite diagnostics.' : 'We decided to serialize SQLite diagnostics.'}\n## Reason\n${rationale}\n## Reuse\n${reuse}\n## Evidence\nsrc/diagnostics.mjs\ndocs/checks.md`;
const commandRows = (id, cmd, exitCode) => [
  { payload: { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd }) } },
  { payload: { type: 'function_call_output', call_id: id, output: JSON.stringify({ exit_code: exitCode, output: exitCode ? 'database locked' : '0 failures' }) } }
];
const cases = [
  { id: 'unobserved_rule_pitfall', text: rule('pitfall'), expectedQueue: 0 },
  { id: 'source_backed_decision_question', text: rule('decision'), expectedQueue: 1, category: 'decision' },
  { id: 'observed_success', lesson: 'success', expectedQueue: 1, category: 'success' },
  { id: 'observed_failure', lesson: 'failure', expectedQueue: 1, category: 'failure' },
  { id: 'failure_without_recovery', lesson: 'failure', omitSuccess: true, expectedQueue: 0 },
  { id: 'success_without_result', lesson: 'success', omitSuccess: true, expectedQueue: 0 },
  { id: 'rejected_observation', lesson: 'failure', rejected: true, expectedQueue: 0 },
  { id: 'failure_with_unresolved_gap', lesson: 'failure', gap: true, expectedQueue: 0 },
  { id: 'previous_turn_outcomes', lesson: 'failure', stale: true, expectedQueue: 0 }
];
try {
  for (const fixture of cases) {
    const root = join(directory, fixture.id);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-c', 'user.name=Synthetic fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Synthetic initial state'], { cwd: root });
    await writeFile(join(root, 'src/diagnostics.mjs'), 'export const serializedDiagnostics = true;\n');
    await writeFile(join(root, 'docs/checks.md'), 'Serialized diagnostics avoid shared database write contention.\n');
    const dbPath = join(root, 'memory.sqlite');
    const envFile = join(root, 'hooks.env');
    const workspaces = join(root, 'workspaces.json');
    await writeFile(envFile, 'ORGBRAIN_LOCAL_HOOK_CAPTURE=true\n');
    await writeFile(workspaces, JSON.stringify({ version: 3, workspaces: { [root]: { tenant_id: 'fixture', project_id: 'lesson-capture', memory_learning_mode: 'confirm', memory_capture_v2_mode: 'on' } } }));
    Object.assign(process.env, { ORGBRAIN_HOOK_ENV_FILES: envFile, ORGBRAIN_WORKSPACES_FILE: workspaces, ORGBRAIN_LOCAL_DB: dbPath,
      ORGBRAIN_ENABLE_CLOUD_MEMORY: 'false', ORGBRAIN_ENABLE_ORG_SHARING: 'false', ORGBRAIN_MEMORY_EXTRACTION_MODE: 'off',
      ORGBRAIN_TENANT_ID: 'fixture', ORGBRAIN_USE_SYNC: 'off', ORGBRAIN_USE_COLLECT: 'off', ORGBRAIN_USE_CONTEXT: 'off', ORGBRAIN_USE_RANKING: 'off' });
    const text = fixture.text ?? 'The scoped diagnostic check is complete.';
    const marker = turn => ({ type: 'turn_context', payload: { type: 'turn_context', turn_id: turn, cwd: root } });
    const rows = [marker('current')];
    let expectedOutcome = null;
    if (fixture.lesson) {
      expectedOutcome = 'The scoped diagnostic checker reported 0 failures.';
      const observation = { record_type: 'learning_observation', schema_version: 2, lesson_type: fixture.lesson,
        capture_intent: fixture.gap ? 'review' : 'verify', trigger: 'Diagnosing SQLite lock contention',
        applicability: { target_files: ['src/diagnostics.mjs'], components: ['sqlite-diagnostics'] },
        evidence_selectors: [{ type: 'file', ref: 'src/diagnostics.mjs', supports: ['procedure', 'correction'] },
          ...(fixture.lesson === 'failure' ? [{ type: 'command', ref: 'node scripts/check-parallel.mjs', supports: ['failed_approach'] }] : []),
          { type: 'command', ref: 'node scripts/check-serial.mjs', supports: [fixture.lesson === 'failure' ? 'verified_outcome' : 'observed_outcome'] }],
        gaps: fixture.gap ? ['The recovery still needs review.'] : [],
        ...(fixture.lesson === 'success' ? { procedure: 'Use serializedDiagnostics for shared SQLite diagnostics.', why_it_worked: rationale, observed_outcome: expectedOutcome, reuse_when: reuse }
          : { symptom: 'Parallel diagnostics reported database locked.', failed_approach: 'Run parallel checks against one database.', root_cause: rationale,
            correction: 'Use serializedDiagnostics for shared SQLite diagnostics.', verified_outcome: expectedOutcome, avoidance_rule: reuse }) };
      const response = await observeMemoryContractV2Event(observation, { workspaceRoot: root });
      if (!response.accepted) throw new Error(`fixture normalization failed: ${JSON.stringify(response)}`);
      const actions = [...(fixture.lesson === 'failure' ? commandRows('fail', 'node scripts/check-parallel.mjs', 1) : []),
        ...(!fixture.omitSuccess ? commandRows('pass', 'node scripts/check-serial.mjs', 0) : [])];
      if (fixture.stale) rows.unshift(marker('previous'), ...actions); else rows.push(...actions);
      rows.push({ payload: { type: 'function_call', call_id: 'observe', name: 'orgbrain_memory_observe', arguments: JSON.stringify(observation) } },
        { payload: { type: 'function_call_output', call_id: 'observe', output: JSON.stringify(fixture.rejected ? { ...response, accepted: false } : response) } });
    }
    rows.push({ payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } });
    const transcript = join(root, 'turn.jsonl');
    await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const result = await ingestHookEvent('codex-stop', JSON.stringify({ hook_event_name: 'Stop', session_id: fixture.id, turn_id: 'current', cwd: root, transcript_path: transcript, last_assistant_message: text }), { emit: false });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let queued, stored;
    try {
      queued = db.prepare('SELECT * FROM memory_confirmation_prompts').all();
      stored = Number(db.prepare('SELECT COUNT(*) AS count FROM memories').get().count);
    } finally { db.close(); }
    const candidates = queued.map(row => JSON.parse(row.candidate_json));
    const body = JSON.stringify(candidates);
    const actualOutcomePreserved = !fixture.category || fixture.category === 'decision' || body.includes(expectedOutcome);
    const categoryPreserved = !fixture.category || candidates.every(candidate => candidate.category === fixture.category);
    const completeLearningPreserved = !fixture.category || fixture.category === 'decision' || candidates.every(candidate => candidate.reuse_rule === reuse && candidate.reason.includes(rationale) && candidate.reason.includes(expectedOutcome));
    const workspace = { projectId: 'lesson-capture', workspaceRoot: root, memoryLearningMode: 'confirm', sensitiveMemory: { mode: 'deny', allowed_principals: [] } };
    const record = normalizeRecord('codex-stop', JSON.stringify({ session_id: fixture.id, turn_id: 'current', cwd: root, last_assistant_message: text }));
    const extracted = await prepareMemoryRecordsV2(record, workspace, 'fixture', { rows, requireFullTurn: true });
    const observed = await prepareObservedLearningRecords(record, workspace, 'fixture', { rows });
    results.push({ id: fixture.id, rule_complete_candidates: extracted.records.length,
      deterministically_verified_observations: observed.report.observed_count,
      confirmation_continuation: result.confirmation_continuation, confirmation_eligible: queued.length, expected_confirmation_eligible: fixture.expectedQueue,
      actual_outcome_preserved: actualOutcomePreserved, complete_learning_preserved: completeLearningPreserved, category_preserved: categoryPreserved,
      saved_memories: stored, activated_verified_memories: stored,
      passed: queued.length === fixture.expectedQueue && stored === 0 && actualOutcomePreserved && completeLearningPreserved && categoryPreserved,
      transcript_sha256: createHash('sha256').update(JSON.stringify(rows).replaceAll(root, '<fixture-root>')).digest('hex') });
  }
  console.log(JSON.stringify({ cases: results, network_calls: networkCalls }));
} finally { await rm(directory, { recursive: true, force: true }); }
