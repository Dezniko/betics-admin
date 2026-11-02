// Minimal Cloudflare D1 stand-in over node:sqlite for unit tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function createD1(migrationPaths = []) {
  const db = new DatabaseSync(':memory:');
  for (const path of migrationPaths) db.exec(readFileSync(path, 'utf8'));
  const state = { failNext: false };
  const statement = (query, args = []) => ({
    bind: (...values) => statement(query, values),
    first: async (column) => { const row = db.prepare(query).get(...args); return row ? (column ? row[column] : { ...row }) : null; },
    all: async () => ({ results: db.prepare(query).all(...args).map((r) => ({ ...r })) }),
    run: async () => { const info = db.prepare(query).run(...args); return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; },
    _exec: () => db.prepare(query).run(...args),
  });
  return {
    raw: db, state,
    prepare: (query) => statement(query),
    batch: async (statements) => {
      if (state.failNext) { state.failNext = false; throw new Error('injected D1 failure'); }
      db.exec('BEGIN');
      try { for (const s of statements) s._exec(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return statements.map(() => ({ success: true }));
    },
    exec: async (sql) => db.exec(sql),
  };
}
