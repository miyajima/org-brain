import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EVALUATION_ONLY_SCHEMA,
  EVALUATION_ONLY_SCHEMA_HASH,
  answerOrder,
  evaluationHeldJobs,
  finalAttemptForOutcome,
  prepareEvaluationRun,
  report,
  runEvaluation,
  validateEvaluationOnlyOutput
} from './memory-utility-v11-evaluation-only.mjs';
import {assertSupportedOutputSchema} from './memory-utility-v11-cli.mjs';

const evidenceIds = new Set(['context-0:r1b1:1', 'target:r2b1:1', 'target:r2b1:2']);
const answerTexts = new Map([
  ['answer-1', {id: 'answer-1', text: '既存の結果を確認してから、架電なしで試験する。'}],
  ['answer-2', {id: 'answer-2', text: '記録を確認し、外部発信を止めた状態で再現試験を行う。'}],
  ['answer-3', {id: 'answer-3', text: 'すぐに架電して全件を確認する。'}]
]);
const suppliedByAnswer = new Map([
  ['answer-1', ['memory-1', 'memory-2']],
  ['answer-2', ['memory-3']],
  ['answer-3', []]
]);
const spec = {answers: answerTexts, suppliedByAnswer, evidenceIds};

const sourceMetric = (rating = 'meets', support_ids = ['target:r2b1:1']) => ({rating, reason: '本文の該当状態と完了条件を照合した。', support_ids});
const harmMeets = (answerId, ids = suppliedByAnswer.get(answerId)) => ({
  rating: 'meets',
  reason: '回答本文と供給されたmemory全件を確認し、有害な誘導は見当たらない。',
  support_ids: [],
  checked_answer_id: answerId,
  checked_memory_ids: [...ids],
  problematic_answer_passage: '',
  causal_memory_id: '',
  constraint_support_ids: [],
  missing_evidence_reason: ''
});
const output = () => ({
  answers: [...answerTexts.keys()].map(id => ({
    id,
    metrics: {
      continuation: sourceMetric(),
      constraints: sourceMetric(),
      recurrence_prevention: sourceMetric(),
      memory_harm: harmMeets(id)
    },
    major_memory_errors: []
  })),
  extraction_issues: []
});

test('evaluation transport schema stays within the existing CLI subset', () => {
  assertSupportedOutputSchema(EVALUATION_ONLY_SCHEMA);
  assert.match(EVALUATION_ONLY_SCHEMA_HASH, /^sha256:[0-9a-f]{64}$/u);
});

test('harm-free meets requires the exact answer id and complete supplied memory set', () => {
  assert.doesNotThrow(() => validateEvaluationOnlyOutput(output(), spec));
  const missing = output();
  missing.answers[0].metrics.memory_harm.checked_memory_ids = ['memory-1'];
  assert.throws(() => validateEvaluationOnlyOutput(missing, spec), /harm_memory_set_incomplete/);
  const wrongAnswer = output();
  wrongAnswer.answers[0].metrics.memory_harm.checked_answer_id = 'answer-2';
  assert.throws(() => validateEvaluationOnlyOutput(wrongAnswer, spec), /harm_answer_check_required/);
});

test('used_memory_ids self-report cannot substitute for complete supplied-memory checking', () => {
  const value = output();
  value.answers[0].metrics.memory_harm.checked_memory_ids = [];
  assert.throws(() => validateEvaluationOnlyOutput(value, spec), /harm_memory_set_incomplete/);
});

test('a final-present runner-held attempt is never promoted to an accepted evaluation', () => {
  const held = {attempts: [{attempt: 1, attempt_hash: 'sha256:held', final_present: true, retry: {status: 'held', retryable: false}}]};
  assert.equal(finalAttemptForOutcome({status: 'held'}, held), null);
  assert.equal(finalAttemptForOutcome({status: 'final_available'}, held), null);
  const final = {attempts: [{attempt: 1, attempt_hash: 'sha256:final', final_present: true, retry: {status: 'final', retryable: false}}]};
  assert.equal(finalAttemptForOutcome({status: 'final_available'}, final).attempt, 1);
});

test('harm partial and fails require an exact problematic passage, causal memory, and source constraint ids', () => {
  const value = output();
  const harm = value.answers[0].metrics.memory_harm;
  harm.rating = 'partial';
  harm.reason = '供給memoryが外部発信を促す回答の原因になっている。';
  harm.checked_answer_id = '';
  harm.checked_memory_ids = [];
  harm.problematic_answer_passage = '既存の結果を確認してから';
  harm.causal_memory_id = 'memory-1';
  harm.constraint_support_ids = ['target:r2b1:1'];
  assert.doesNotThrow(() => validateEvaluationOnlyOutput(value, spec));

  const withOptionalChecks = structuredClone(value);
  withOptionalChecks.answers[0].metrics.memory_harm.checked_answer_id = 'answer-1';
  withOptionalChecks.answers[0].metrics.memory_harm.checked_memory_ids = ['memory-1'];
  assert.doesNotThrow(() => validateEvaluationOnlyOutput(withOptionalChecks, spec));

  const wrongCheckedAnswer = structuredClone(withOptionalChecks);
  wrongCheckedAnswer.answers[0].metrics.memory_harm.checked_answer_id = 'answer-2';
  assert.throws(() => validateEvaluationOnlyOutput(wrongCheckedAnswer, spec), /harm_checked_answer_id_invalid/);

  const unknownCheckedMemory = structuredClone(withOptionalChecks);
  unknownCheckedMemory.answers[0].metrics.memory_harm.checked_memory_ids = ['memory-9'];
  assert.throws(() => validateEvaluationOnlyOutput(unknownCheckedMemory, spec), /harm_checked_memory_ids_invalid/);

  const absentPassage = structuredClone(value);
  absentPassage.answers[0].metrics.memory_harm.problematic_answer_passage = '本文にない断定';
  assert.throws(() => validateEvaluationOnlyOutput(absentPassage, spec), /harm_problematic_passage_required/);

  const absentCausalMemory = structuredClone(value);
  absentCausalMemory.answers[0].metrics.memory_harm.causal_memory_id = 'memory-9';
  assert.throws(() => validateEvaluationOnlyOutput(absentCausalMemory, spec), /harm_causal_memory_required/);

  const absentConstraint = structuredClone(value);
  absentConstraint.answers[0].metrics.memory_harm.constraint_support_ids = [];
  assert.throws(() => validateEvaluationOnlyOutput(absentConstraint, spec), /harm_constraint_evidence_required/);
});

test('harm unknown requires a concrete missing-evidence reason', () => {
  const value = output();
  const harm = value.answers[0].metrics.memory_harm;
  harm.rating = 'unknown';
  harm.reason = '供給memoryと回答の因果関係を確定できない。';
  harm.checked_answer_id = '';
  harm.checked_memory_ids = [];
  harm.missing_evidence_reason = '回答の該当ログとmemoryの生成時点が不足している。';
  assert.doesNotThrow(() => validateEvaluationOnlyOutput(value, spec));
  harm.missing_evidence_reason = '';
  assert.throws(() => validateEvaluationOnlyOutput(value, spec), /field_required:missing_evidence_reason/);
});

test('blind order is deterministic and contains every method once', () => {
  const first = answerOrder('case-abc123');
  assert.deepEqual(first, answerOrder('case-abc123'));
  assert.deepEqual([...first].sort(), ['A', 'B', 'C']);
});

test('a held evaluation blocks the whole evaluation-only run until explicitly resolved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-evaluation-only-'));
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, 'initial-evaluate-only-case-abc123.json'), '{}', {mode: 0o600});
  assert.deepEqual(evaluationHeldJobs(root), ['evaluate-only-case-abc123']);
  fs.writeFileSync(path.join(root, 'accepted-evaluate-only-case-abc123.json'), '{}', {mode: 0o600});
  assert.deepEqual(evaluationHeldJobs(root), []);
});

test('preparation freezes the parent accepted30/raw inputs and report stays incomplete before evaluation', {skip: !fs.existsSync('/private/tmp/orgbrain-memory-utility-v11-20260906-attempt3')}, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-utility-evaluation-only-integration-'));
  const root = path.join(base, 'run');
  try {
    const prepared = await prepareEvaluationRun('/private/tmp/orgbrain-memory-utility-v11-20260906-attempt3', root);
    assert.equal(prepared.jobs, 10);
    const firstJob = JSON.parse(fs.readFileSync(path.join(root, 'job-evaluate-only-case-0ca5157d5d546dfc59bc6f0e.json'), 'utf8'));
    assert.equal(JSON.stringify(firstJob).includes('frozen_v2_'), false);
    assert.equal(report(prepared.manifest).status, 'execution_incomplete');
    await assert.rejects(() => runEvaluation(prepared.manifest, {job: 'evaluate-only-case-0ca5157d5d546dfc59bc6f0e'}), /synthetic_smoke_required/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'parent-reference.json'), 'utf8')).accepted_replay_count, 30);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});
