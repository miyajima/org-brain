import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('benchmark jobs use maintained Node 22 and explicitly probe required FTS5', () => {
  const workflow = readFileSync(new URL('../.github/workflows/benchmark.yml', import.meta.url), 'utf8');
  const versions = [...workflow.matchAll(/node-version:\s*"([^"]+)"/gu)].map(match => match[1]);
  assert.deepEqual(versions, ['22', '22', '22']);
  assert.equal((workflow.match(/name: Verify SQLite FTS5 runtime/gu) ?? []).length, 3);
  assert.doesNotMatch(workflow, /node-version:\s*"22\.13"/u);
});

test('the local evaluation runtime supports the FTS5 table required by memory retrieval', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE runtime_probe USING fts5(content)');
    db.prepare('INSERT INTO runtime_probe(content) VALUES (?)').run('grounded memory');
    assert.equal(db.prepare("SELECT count(*) AS n FROM runtime_probe WHERE runtime_probe MATCH 'grounded'").get().n, 1);
  } finally { db.close(); }
});
