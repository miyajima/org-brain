import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'packages/orgbrain-cli/src/local-memory.mjs');

async function runIsolatedCli(t, args) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-extraction-cli-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const env = {
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ORGBRAIN_LOCAL_DB: path.join(root, 'memory.sqlite'),
    ORGBRAIN_SESSION_EXTRACTION_QUEUE: path.join(root, 'queue'),
    ORGBRAIN_SESSION_EXTRACTION_PROJECTS: '',
  };
  return spawnSync(process.execPath, ['--no-warnings', cliPath, ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('session extraction worker status accepts the documented bare --worker flag', async (t) => {
  const result = await runIsolatedCli(t, [
    'memory', 'extraction', 'status', '--project-id', 'test-project', '--worker',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {active: false, latest: null});
});

test('session extraction run accepts bare --all-projects and an empty allowlist', async (t) => {
  const result = await runIsolatedCli(t, [
    'memory', 'extraction', 'run', '--all-projects', '--execute',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    processed: 0,
    saved: 0,
    failed: 0,
    status: 'idle',
    projects: [],
  });
});
