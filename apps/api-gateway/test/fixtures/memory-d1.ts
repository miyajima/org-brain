import type { Env } from '../../src/types';
const runtime = (globalThis as unknown as { process: { getBuiltinModule(name: string): any } }).process;
const { DatabaseSync } = runtime.getBuiltinModule('node:sqlite');
const { readFileSync, readdirSync } = runtime.getBuiltinModule('node:fs');

export function memoryD1Fixture(maxMigration = 9999) {
  const sql = new DatabaseSync(':memory:');
  const directory = new URL('../../../../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name: string) => name.endsWith('.sql') && Number(name.slice(0,4)) <= maxMigration).sort()) sql.exec(readFileSync(new URL(file, directory), 'utf8'));
  const database = { prepare(query: string) {
    let args: any[] = [];
    return { _query: query, bind(...values: any[]) { args = values; return this; },
      async first() { return sql.prepare(query).get(...args) ?? null; },
      async all() { return { results: sql.prepare(query).all(...args) }; },
      _run() { const result = sql.prepare(query).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
      async run() { return this._run(); }
    };
  }, async batch(statements: any[]) { sql.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(statement._run()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } } };
  return { sql, env: { OPEN_BRAIN_DB: database } as unknown as Env };
}
