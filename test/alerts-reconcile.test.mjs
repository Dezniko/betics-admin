// Security re-audit R2: the balance reconciliation covered demo money only. Real $TICS now has its own check
// (players.real_tics_cents vs the newest real_money = 1 / TICS ledger row), reported as 'reconcile_real' (critical)
// only when the same mismatch is seen on two runs in a row, because the wallet copies ledger rows and the
// balance to the central database in separate steps. The demo check ('reconcile') is unchanged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createD1 } from './d1shim.mjs';
import { runChecks, CHECK_EVERY_MS } from '../src/api/alerts.js';

const MIGRATION = new URL('./schema.sql', import.meta.url).pathname;
const sql = d => d.toISOString().slice(0, 19).replace('T', ' ');

function setup() {
  const DB = createD1([MIGRATION]);
  const t0 = new Date(Date.now() - 3600e3); // an hour ago: the runs below move forward from here
  const at = (ms = 0) => new Date(t0.getTime() + ms);
  let n = 0;
  const player = (id, { demo = 100000, real = 0 } = {}) => DB.raw.prepare('INSERT INTO players (id, balance_cents, real_tics_cents, last_seen_at) VALUES (?, ?, ?, ?)').run(id, demo, real, sql(at(-60e3)));
  const ledger = (id, { real, after, currency = 'TICS', type = 'bet' }) => DB.raw.prepare(`INSERT INTO ledger (id, player_id, type, amount_cents, balance_after_cents, currency, real_money, created_at)
    VALUES (?, ?, ?, -1, ?, ?, ?, ?)`).run(`${id}:${++n}`, id, type, after, currency, real ? 1 : 0, sql(at(-30e3)));
  const touch = (id, now) => DB.raw.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?').run(sql(now), id);
  const alerts = type => DB.raw.prepare('SELECT * FROM alerts WHERE type = ? ORDER BY id').all(type);
  const state = () => JSON.parse(DB.raw.prepare("SELECT value FROM settings WHERE key = 'alerts_rounds'").get().value);
  // Runs are 10 minutes apart, like the cron; players are kept "seen" (on the run's own clock) so each run looks at them.
  let runs = 0;
  const run = async () => { const now = at(runs++ * CHECK_EVERY_MS); for (const p of DB.raw.prepare('SELECT id FROM players').all()) touch(p.id, now); return runChecks(DB, now); };
  return { DB, player, ledger, alerts, state, run };
}

test('R2: a stable real $TICS mismatch raises nothing on the first run and exactly one critical reconcile_real on the second, with the player and both figures', async () => {
  const s = setup();
  s.player('p1', { real: 50000 });
  s.ledger('p1', { real: true, after: 48000 });
  assert.ok(await s.run() >= 0);
  assert.equal(s.alerts('reconcile_real').length, 0, 'first sighting: the central copy may still be catching up');
  assert.deepEqual(s.state().realMismatch, { p1: '48000:50000' }, 'the first sighting is kept in the alerts state');
  await s.run();
  const a = s.alerts('reconcile_real');
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'critical'); assert.equal(a[0].player_id, 'p1');
  assert.equal(a[0].dedupe_key, 'reconcile_real:p1:48000:50000');
  assert.equal(a[0].title, "A player's real $TICS balance does not match their ledger");
  assert.match(a[0].details, /ledger says 480\.00 TICS, the player record says 500\.00 TICS/);
  assert.equal(s.alerts('reconcile').length, 0, 'the demo figures agree: no demo alert');
  // Still there on the third run: the dedupe key stops a second copy.
  await s.run();
  assert.equal(s.alerts('reconcile_real').length, 1);
  // A different pair of figures is a new sighting: not reported until it too is seen twice.
  s.DB.raw.prepare("UPDATE players SET real_tics_cents = 51000 WHERE id = 'p1'").run();
  await s.run();
  assert.equal(s.alerts('reconcile_real').length, 1);
  assert.deepEqual(s.state().realMismatch, { p1: '48000:51000' });
  await s.run();
  assert.equal(s.alerts('reconcile_real').length, 2);
  assert.equal(s.alerts('reconcile_real')[1].dedupe_key, 'reconcile_real:p1:48000:51000');
});

test('R2: a correctly reconciled real balance raises nothing, on any number of runs; USDT real rows and players without real rows are left alone', async () => {
  const s = setup();
  s.player('ok', { real: 12345 });
  s.ledger('ok', { real: true, after: 10000 });
  s.ledger('ok', { real: true, after: 12345 }); // newest row wins
  s.player('usdt', { real: 0 });
  s.ledger('usdt', { real: true, after: 777, currency: 'USDT' }); // another currency's real row is not the TICS balance
  s.player('fresh', { real: 0 }); // never had a real row
  s.ledger('fresh', { real: false, after: 100000 });
  for (let i = 0; i < 3; i++) await s.run();
  assert.equal(s.alerts('reconcile_real').length, 0);
  assert.equal(s.alerts('reconcile').length, 0);
  assert.deepEqual(s.state().realMismatch, {});
});

test('R2: an equivalent demo mismatch still raises reconcile at once (first run), never reconcile_real', async () => {
  const s = setup();
  s.player('d1', { demo: 50000, real: 0 });
  s.ledger('d1', { real: false, after: 48000 });
  await s.run();
  const a = s.alerts('reconcile');
  assert.equal(a.length, 1); assert.equal(a[0].severity, 'critical'); assert.equal(a[0].player_id, 'd1');
  assert.equal(a[0].dedupe_key, 'reconcile:d1:48000:50000');
  assert.equal(s.alerts('reconcile_real').length, 0);
  await s.run();
  assert.equal(s.alerts('reconcile').length, 1, 'dedupe key');
});

test('R2: a partial central copy that catches up before the second run raises nothing and leaves no sighting behind', async () => {
  const s = setup();
  // The ledger rows landed, the balance update has not yet (or the other way round).
  s.player('p2', { real: 50000 });
  s.ledger('p2', { real: true, after: 48000 });
  await s.run();
  assert.equal(s.alerts('reconcile_real').length, 0);
  assert.deepEqual(s.state().realMismatch, { p2: '48000:50000' });
  s.DB.raw.prepare("UPDATE players SET real_tics_cents = 48000 WHERE id = 'p2'").run();
  await s.run();
  assert.equal(s.alerts('reconcile_real').length, 0);
  assert.deepEqual(s.state().realMismatch, {}, 'a mismatch that went away is forgotten');
  // And the mirror case: the balance moved first, the ledger row arrives a run later.
  s.DB.raw.prepare("UPDATE players SET real_tics_cents = 47000 WHERE id = 'p2'").run();
  await s.run();
  s.ledger('p2', { real: true, after: 47000 });
  await s.run();
  await s.run();
  assert.equal(s.alerts('reconcile_real').length, 0);
});

test('R2: both reconciliation reads are one pass over players_last_seen with one ledger_player_money step per newest row (EXPLAIN QUERY PLAN)', () => {
  const s = setup();
  const q = `SELECT p.id, p.balance_cents, p.real_tics_cents,
      (SELECT l.balance_after_cents FROM ledger l WHERE l.player_id = p.id AND l.real_money = 0 ORDER BY l.rowid DESC LIMIT 1) AS last,
      (SELECT l.balance_after_cents FROM ledger l WHERE l.player_id = p.id AND l.real_money = 1 AND l.currency = 'TICS' ORDER BY l.rowid DESC LIMIT 1) AS last_real
    FROM players p WHERE p.last_seen_at >= ?`;
  const plan = s.DB.raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all('2026-11-08 00:00:00').map(r => r.detail);
  assert.match(plan[0], /SEARCH p USING INDEX players_last_seen/, plan.join(' | '));
  assert.equal(plan.filter(d => /SEARCH l USING INDEX ledger_player_money \(player_id=\? AND real_money=\?\)/.test(d)).length, 2, plan.join(' | '));
  assert.ok(!plan.some(d => /SCAN/.test(d)), plan.join(' | '));
  // The same text is what runChecks runs: the scan captures it.
  const seen = [];
  const prepare = s.DB.prepare;
  s.DB.prepare = sqlText => { seen.push(sqlText); return prepare(sqlText); };
  return runChecks(s.DB, new Date()).then(() => {
    s.DB.prepare = prepare;
    const mine = seen.find(t => /last_real/.test(t));
    assert.ok(mine, 'runChecks runs the real reconciliation');
    assert.equal(mine.replace(/\s+/g, ' ').trim(), q.replace(/\s+/g, ' ').trim());
  });
});
