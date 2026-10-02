import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

test('real Stop path preserves observed lessons and never invents checked outcomes', () => {
  const replay = JSON.parse(execFileSync(process.execPath, ['--no-warnings',
    resolve('scripts/fixtures/memory-lesson-confirmation-replay.mjs'), process.cwd()], { encoding: 'utf8' }));
  assert.equal(replay.cases.length, 9);
  assert.equal(replay.network_calls, 0);
  for (const result of replay.cases) assert.equal(result.passed, true, JSON.stringify(result));
  const unobserved = replay.cases.find(item => item.id === 'unobserved_rule_pitfall');
  assert.equal(unobserved.rule_complete_candidates, 1);
  assert.equal(unobserved.deterministically_verified_observations, 0);
  assert.equal(unobserved.confirmation_eligible, 0);
  for (const id of ['observed_success', 'observed_failure']) {
    const observed = replay.cases.find(item => item.id === id);
    assert.equal(observed.deterministically_verified_observations, 1);
    assert.equal(observed.confirmation_eligible, 1);
    assert.equal(observed.saved_memories, 0, 'eligibility is not approval or activation');
  }
});
