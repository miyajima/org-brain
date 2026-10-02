#!/usr/bin/env node
// Offline synthetic regression replay. Never reads private or production histories.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessLessonCapture, lessonCaptureCases } from './fixtures/memory-lesson-capture.mjs';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--baseline-root') || !args.includes('--output')) {
  throw new Error('Usage: node scripts/memory-lesson-capture-evaluate.mjs --baseline-root <checkout> --output <json>');
}
const roots = { baseline: resolve(option('--baseline-root')), candidate: resolve(import.meta.dirname, '..') };
const sourceFiles = ['packages/shared/src/memory-capture-v2-runtime.mjs', 'packages/shared/src/memory-capture-profile-runtime.mjs',
  'packages/orgbrain-cli/src/hook-memory-bridge.mjs', 'packages/orgbrain-cli/src/lib/memory-learning-transcript.mjs',
  'packages/orgbrain-cli/src/lib/memory-confirmation-hints.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { schema: 'memory-lesson-capture-replay/v1', generated_at: new Date().toISOString(),
  scope: 'Synthetic same-fixture regression replay; direct shared extraction plus actual Stop adapter in disposable local stores.',
  limits: ['Not held out; no live user histories or production rollout.', 'Fixture tool outcomes test provenance gates, not real task success.',
    'Rule-complete candidates are not verified outcomes. Confirmation eligibility is not user approval or memory activation.',
    'No new memory save is approved in this replay. Provider cost, task-time savings, and user billing are not measured.'],
  fixture_sha256: hash(await readFile(new URL('./fixtures/memory-lesson-capture.mjs', import.meta.url))),
  stop_fixture_sha256: hash(await readFile(new URL('./fixtures/memory-lesson-confirmation-replay.mjs', import.meta.url))),
  variants: {} };
for (const [name, root] of Object.entries(roots)) {
  const load = file => import(pathToFileURL(join(root, file)).href);
  const { extractDurableMemoryDrafts } = await load('packages/shared/src/memory-capture-v2-runtime.mjs');
  const { MEMORY_CAPTURE_HOOK_PROFILE } = await load('packages/shared/src/memory-capture-profile.generated.mjs');
  const captures = lessonCaptureCases.map(fixture => assessLessonCapture(extractDurableMemoryDrafts, MEMORY_CAPTURE_HOOK_PROFILE, fixture));
  const confirmations = JSON.parse(execFileSync(process.execPath, ['--no-warnings',
    join(roots.candidate, 'scripts/fixtures/memory-lesson-confirmation-replay.mjs'), root], { encoding: 'utf8' }));
  const sourceSha256 = {};
  for (const file of sourceFiles) sourceSha256[file] = hash(await readFile(join(root, file)));
  report.variants[name] = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    source_sha256: sourceSha256, captures, confirmations: confirmations.cases, summary: {
      capture_cases_passed: captures.filter(item => item.passed).length, capture_cases: captures.length,
      expected_atomic_lessons: captures.reduce((n, item) => n + item.expected_atomic_lessons, 0),
      fully_preserved_atomic_lessons: captures.reduce((n, item) => n + item.preserved_atomic_lessons, 0),
      stop_cases_passed: confirmations.cases.filter(item => item.passed).length, stop_cases: confirmations.cases.length,
      unsupported_failure_confirmations: confirmations.cases.find(item => item.id === 'unobserved_rule_pitfall').confirmation_eligible,
      saved_memories: confirmations.cases.reduce((n, item) => n + item.saved_memories, 0),
      activated_verified_memories: confirmations.cases.reduce((n, item) => n + item.activated_verified_memories, 0),
      network_calls: confirmations.network_calls
    } };
}
const output = resolve(option('--output'));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.variants).map(([name, value]) => [name, value.summary])), null, 2));
if (!report.variants.candidate.captures.every(item => item.passed) || !report.variants.candidate.confirmations.every(item => item.passed)) process.exitCode = 1;
