// Gods of Power (slot) in the admin: games validation per kind, slot round data, game filters,
// by-game analytics, alert wording and the slot maths mirror.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createD1 } from './d1shim.mjs';
import worker from '../src/index.js';
import { hotp } from '../src/totp.js';
import { makeSetupToken } from '../src/auth.js';
import { runChecks, DEFAULT_LIMITS, isBigWin } from '../src/api/alerts.js';
import { SLOT_BET_LEVELS, SLOT_CAP_MULTIPLE, checkLimitsForKind } from '../src/api/games.js';
import { listRounds } from '../src/api/players.js';
import { dropCache } from '../src/util.js';
import * as mirror from '../public/js/slotMath.js';

const MIGRATION = new URL('./schema.sql', import.meta.url).pathname;
const ORIGIN = 'https://admin.betics.io';
const PASSWORD = 'correct horse 42 battery';

function setup() {
  const DB = createD1([MIGRATION]);
  const env = { DB, SESSION_PEPPER: 'pepper', INTERNAL_SECRET: 'secret', ASSETS: { fetch: async () => new Response('<html></html>') } };
  let cookie = null, codeStep = 0, secret = null;
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined }), env);
    const set = res.headers.get('Set-Cookie'); if (set) cookie = set.split(';')[0];
    const type = res.headers.get('Content-Type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
  const signIn = async (email = 'dez@example.com', role = 'owner') => {
    DB.raw.prepare('INSERT INTO admins (email, name, role) VALUES (?, ?, ?)').run(email, 'Dez', role);
    const token = await makeSetupToken(DB, DB.raw.prepare('SELECT id FROM admins WHERE email = ?').get(email).id);
    const pw = await call('POST', '/api/auth/setup/password', { token, password: PASSWORD });
    secret = pw.data.secret;
    codeStep = Math.floor(Date.now() / 30000);
    const done = await call('POST', '/api/auth/setup/code', { token, code: await hotp(secret, codeStep) });
    assert.equal(done.status, 200, JSON.stringify(done.data));
  };
  // Each step-up needs a code not used before: forget the used steps (as the other suites do) and use the next step's code.
  const stepUp = async () => { DB.raw.prepare("UPDATE settings SET value = '{}' WHERE key = 'admin_totp_steps'").run(); return { password: PASSWORD, code: await hotp(secret, codeStep + 1) }; };
  const seedPlayer = id => DB.raw.prepare('INSERT INTO players (id, country, device, balance_cents) VALUES (?, ?, ?, ?)').run(id, 'GB', 'mobile', 100000);
  const seedRound = ({ id, player = 'p1', game = 'roulette', stake, payout, outcome, bets = '[]', real = 0, when = null }) =>
    DB.raw.prepare(`INSERT INTO rounds (id, player_id, game_id, math_id, config_version, stake_cents, payout_cents, outcome, bets_json, fairness_json, currency, real_money, country, device, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, '{"serverSeed":"s","serverSeedHash":"h","clientSeed":"c","nonce":1}', 'TICS', ?, 'GB', 'mobile', COALESCE(?, datetime('now')))`)
      .run(id, player, game, game === 'roulette' ? 'standard' : 'gods92', stake, payout, outcome, bets, real, when);
  return { DB, env, call, signIn, stepUp, seedPlayer, seedRound };
}

const SLOT_OUTCOME = (spins, extra = {}) => JSON.stringify({ game: 'godsofpower', spins, freeSpinsAwarded: spins.filter(s => s.free).length, freeSpinsPlayed: spins.filter(s => s.free).length, capped: false, ...extra });
const BASE_SPIN = { free: false, stops: [0, 1, 2, 3, 4], lineWins: [{ line: 0, symbol: 'K', count: 3, pay: 4 }], scatterCount: 0, scatterPay: 0, multiplier: 1, winUnits: 400, freeSpinsAdded: 0 };
const FREE_SPIN = { free: true, stops: [16, 16, 16, 16, 16], lineWins: [], scatterCount: 5, scatterPay: 50, multiplier: 2, winUnits: 200000, freeSpinsAdded: 10 };

test('schema has the Gods of Power game and its maths option', () => {
  const s = setup();
  const g = s.DB.raw.prepare("SELECT * FROM games WHERE id = 'godsofpower'").get();
  assert.equal(g.kind, 'slot'); assert.equal(g.math_id, 'gods92'); assert.equal(g.min_stake_cents, 2000); assert.equal(g.max_win_cents, 2000000000);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM game_math WHERE game_id = 'godsofpower'").get().n, 1);
});

test('slot maths mirror matches the game repo (when it is checked out beside this repo)', async () => {
  const path = new URL('../../betics/backend/src/games/slotsMath.js', import.meta.url).pathname;
  if (!existsSync(path)) { console.log('  game repo not found, mirror check skipped'); return; }
  const game = await import(pathToFileURL(path).href);
  assert.deepEqual(mirror.STRIPS.map(s => [...s]), game.SLOT_MATH.strips.map(s => [...s]), 'STRIPS drifted from slotsMath.js');
  assert.deepEqual(mirror.LINES.map(l => [...l]), game.SLOT_MATH.lines.map(l => [...l]), 'LINES drifted from slotsMath.js');
  assert.deepEqual(mirror.SYMBOLS.map(s => ({ ...s })), game.SYMBOLS.map(s => ({ ...s })), 'SYMBOLS drifted from slotsMath.js');
  assert.equal(mirror.ROWS, game.SLOT_MATH.rows); assert.equal(mirror.STOPS, game.SLOT_MATH.stops); assert.equal(mirror.LINE_COUNT, game.SLOT_MATH.lineCount);
  assert.deepEqual([...SLOT_BET_LEVELS], [...game.BET_LEVELS], 'SLOT_BET_LEVELS in src/api/games.js drifted from BET_LEVELS');
  assert.equal(SLOT_CAP_MULTIPLE, game.SLOT_MATH.capMultiplier);
  const engine = await import(pathToFileURL(new URL('../../betics/backend/src/games/slots.js', import.meta.url).pathname).href);
  for (const stops of [[0, 0, 0, 0, 0], [31, 30, 5, 16, 1], [16, 16, 16, 16, 16]]) assert.deepEqual(mirror.gridFor(stops), engine.gridFor(stops, game.SLOT_MATH));
});

test('slot helpers: grid from stops, lit cells, summary text; bad data never throws', () => {
  const grid = mirror.gridFor([0, 1, 2, 3, 4]);
  assert.equal(grid.length, 3); assert.equal(grid[0].length, 5);
  assert.equal(grid[0][0], 'A'); assert.equal(grid[1][0], 'K'); assert.equal(grid[2][0], 'K'); // reel 1 strip starts A K K
  assert.equal(grid[0][1], 'Q'); // reel 2 at stop 1
  assert.equal(mirror.gridFor([0, 1]), null); assert.equal(mirror.gridFor(null), null); assert.equal(mirror.gridFor([0, 1, 2, 3, 'x']), null);
  const lit = mirror.winningCells({ stops: [0, 1, 2, 3, 4], lineWins: [{ line: 1, symbol: 'K', count: 3, pay: 4 }] });
  assert.deepEqual([...lit].sort(), ['0,0', '0,1', '0,2']); // line 2 is the top row
  const scat = mirror.winningCells(FREE_SPIN); // stop 16 is the scatter on every reel, top row
  assert.deepEqual([...scat].sort(), ['0,0', '0,1', '0,2', '0,3', '0,4']);
  assert.equal(mirror.winningCells(null).size, 0);
  const o = JSON.parse(SLOT_OUTCOME([BASE_SPIN, FREE_SPIN, FREE_SPIN], { capped: true }));
  assert.equal(mirror.slotSummaryText(o, c => `${c / 100} TICS`, { stakeCents: 2000, payoutCents: 4000000 }), '20 TICS bet, 40000 TICS paid, 3 spins (2 free), capped');
  assert.equal(mirror.slotSummaryText({ game: 'godsofpower' }), '0 spins');
  assert.equal(mirror.slotSummaryText(null), '0 spins');
  assert.equal(mirror.isSlotOutcome({ pocket: 7, color: 'red' }), false); assert.equal(mirror.isSlotOutcome(o), true);
  assert.equal(mirror.symbolName('W'), 'Gods of Power'); assert.equal(mirror.symbolName('?'), '?');
});

test('slot limits must sit on the bet levels and leave room for the 2,000x cap; roulette rules unchanged', async () => {
  assert.throws(() => checkLimitsForKind('slot', { minStakeCents: 2500, maxStakeCents: 1000000, maxWinCents: 2000000000 }), /bet levels/);
  assert.throws(() => checkLimitsForKind('slot', { minStakeCents: 2000, maxStakeCents: 999999, maxWinCents: 2000000000 }), /bet levels/);
  assert.throws(() => checkLimitsForKind('slot', { minStakeCents: 4000, maxStakeCents: 1000000, maxWinCents: 7999999 }), /maximum win must be at least 80,000/);
  assert.doesNotThrow(() => checkLimitsForKind('slot', { minStakeCents: 4000, maxStakeCents: 1000000, maxWinCents: 8000000 }));
  assert.doesNotThrow(() => checkLimitsForKind('roulette', { minStakeCents: 2500, maxStakeCents: 999999, maxWinCents: 1 }));
  assert.throws(() => checkLimitsForKind('roulette', { minStakeCents: 5, maxStakeCents: 1 }), /minimum bet cannot be above/);

  const s = setup();
  await s.signIn();
  const put = (id, body) => s.call('PUT', `/api/games/${id}`, body);
  assert.equal((await put('godsofpower', { minStakeCents: 2500, ...(await s.stepUp()) })).status, 400);
  assert.equal((await put('godsofpower', { maxWinCents: 100000, ...(await s.stepUp()) })).status, 400, 'max win below min stake x 2000');
  assert.equal((await put('godsofpower', { minStakeCents: 4000 })).status, 401, 'limits need the step-up, like roulette');
  assert.equal((await put('godsofpower', { enabled: false })).status, 200, 'switching off is one click');
  assert.equal((await put('godsofpower', { maintenanceMessage: 'Back soon, gods are resting' })).status, 200);
  const v0 = s.DB.raw.prepare("SELECT config_version FROM games WHERE id = 'godsofpower'").get().config_version;
  const ok = await put('godsofpower', { minStakeCents: 4000, maxStakeCents: 500000, maxWinCents: 1000000000, ...(await s.stepUp()) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.changed.sort(), ['maxStakeCents', 'maxWinCents', 'minStakeCents']);
  const g = s.DB.raw.prepare("SELECT * FROM games WHERE id = 'godsofpower'").get();
  assert.equal(g.min_stake_cents, 4000); assert.equal(g.config_version, v0 + 1);
  const a = s.DB.raw.prepare("SELECT * FROM admin_audit WHERE action = 'game.update' AND target = 'game:godsofpower' ORDER BY id DESC").get();
  assert.equal(JSON.parse(a.after_json).minStakeCents, 4000);
  assert.equal((await put('godsofpower', { mathId: 'standard', ...(await s.stepUp()) })).status, 400, 'roulette maths cannot be put on the slot');
  // Roulette still accepts any whole amount.
  assert.equal((await put('roulette', { minStakeCents: 2500, ...(await s.stepUp()) })).status, 200);
  const detail = (await s.call('GET', '/api/games/godsofpower')).data;
  assert.deepEqual(detail.betLevels, SLOT_BET_LEVELS); assert.equal(detail.capMultiple, 2000); assert.equal(detail.math[0].id, 'gods92');
  assert.equal((await s.call('GET', '/api/games/roulette')).data.betLevels, null);
  const list = (await s.call('GET', '/api/games')).data.games;
  assert.deepEqual(list.map(x => x.id), ['roulette', 'godsofpower']);
  assert.equal(list[1].mathLabel, 'Gods of Power 92');
});

test('rounds: game filter stays on rounds_game, lists carry game names, slot and odd outcomes never crash', async () => {
  const s = setup();
  await s.signIn();
  s.seedPlayer('p1');
  s.seedRound({ id: 'r1', stake: 1000, payout: 0, outcome: '{"pocket":7,"color":"red"}' });
  s.seedRound({ id: 'g1', game: 'godsofpower', stake: 2000, payout: 200400, outcome: SLOT_OUTCOME([BASE_SPIN, FREE_SPIN]), bets: '{"stake":2000,"lines":20}' });
  s.seedRound({ id: 'x1', game: 'dice', stake: 100, payout: 0, outcome: 'not json at all' });
  s.seedRound({ id: 'g2', game: 'godsofpower', stake: 2000, payout: 0, outcome: SLOT_OUTCOME([{ ...BASE_SPIN, lineWins: [], winUnits: 0 }]), bets: '{"stake":2000,"lines":20}', real: 1 });
  const all = (await s.call('GET', '/api/rounds?money=play')).data;
  assert.deepEqual(all.rounds.map(r => r.id).sort(), ['g1', 'r1', 'x1']);
  assert.deepEqual(all.games.map(g => [g.id, g.name, g.kind]), [['roulette', 'Roulette', 'table'], ['godsofpower', 'Gods of Power', 'slot']]);
  assert.deepEqual(all.rounds.find(r => r.id === 'x1').outcome, { raw: 'not json at all' });
  const slot = (await s.call('GET', '/api/rounds?money=play&game=godsofpower')).data;
  assert.deepEqual(slot.rounds.map(r => r.id), ['g1']);
  assert.equal(slot.rounds[0].outcome.spins.length, 2);
  assert.deepEqual((await s.call('GET', '/api/rounds?money=real&game=godsofpower')).data.rounds.map(r => r.id), ['g2']);
  assert.deepEqual((await s.call('GET', '/api/rounds?money=play&game=roulette')).data.rounds.map(r => r.id), ['r1']);
  // Round detail: slot bets are an object, fairness is read safely, and the game is named.
  const d = (await s.call('GET', '/api/rounds/g1')).data;
  assert.deepEqual(d.round.bets, { stake: 2000, lines: 20 }); assert.equal(d.game.name, 'Gods of Power'); assert.equal(d.game.kind, 'slot');
  assert.equal((await s.call('GET', '/api/rounds/x1')).status, 200);
  // The player page carries the game list for labels too.
  const pd = (await s.call('GET', '/api/players/p1?money=play')).data;
  assert.equal(pd.gameList.length, 2); assert.equal(pd.games.find(g => g.gameId === 'godsofpower').gameName, 'Gods of Power');
  // Planner: the game filter (Real and Demo, with or without a time bound) uses rounds_game, not a scan.
  const plans = [];
  const spy = { prepare: q => ({ bind: (...a) => ({ all: async () => { plans.push({ q, a }); return { results: [] }; } }) }) };
  for (const u of ['/api/rounds?money=real&game=godsofpower', '/api/rounds?money=play&game=godsofpower&limit=100', '/api/rounds?money=play&game=roulette&before=2026-01-01']) {
    await listRounds(Object.assign(spy, { __x: 1 }), new URL(ORIGIN + u)).catch(() => {});
  }
  dropCache(spy);
  for (const { q, a } of plans) {
    const plan = s.DB.raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...a).map(r => r.detail).join(' | ');
    assert.match(plan, /USING INDEX rounds_game/, plan);
    assert.doesNotMatch(plan, /SCAN rounds\b(?! USING)/, plan);
  }
});

test('money and analytics name every game; By game lists a zero row for a game nobody played', async () => {
  const s = setup();
  await s.signIn();
  s.seedPlayer('p1');
  s.seedRound({ id: 'r1', stake: 1000, payout: 3600, outcome: '{"pocket":7,"color":"red"}' });
  s.seedRound({ id: 'g1', game: 'godsofpower', stake: 2000, payout: 400, outcome: SLOT_OUTCOME([BASE_SPIN]) });
  const m = (await s.call('GET', '/api/money?period=7d&money=play')).data;
  assert.deepEqual(m.byGame.map(g => [g.gameId, g.gameName, g.profitCents]).sort(), [['godsofpower', 'Gods of Power', 1600], ['roulette', 'Roulette', -2600]]);
  assert.equal(m.rows.find(r => r.gameId === 'godsofpower').gameName, 'Gods of Power');
  assert.equal(m.games.length, 2);
  const a = (await s.call('GET', '/api/analytics?period=7d&money=play')).data;
  assert.deepEqual(a.games.map(g => [g.gameId, g.gameName, g.rounds, g.betCents, g.paidCents, g.profitCents]), [['roulette', 'Roulette', 1, 1000, 3600, -2600], ['godsofpower', 'Gods of Power', 1, 2000, 400, 1600]]);
  const real = (await s.call('GET', '/api/analytics?period=7d&money=real')).data;
  assert.deepEqual(real.games.map(g => [g.gameId, g.rounds, g.betCents, g.rtp]), [['roulette', 0, 0, null], ['godsofpower', 0, 0, null]], 'every game is listed even with no rounds');
});

test('alerts name the game; a slot round is a big win only when it is also many times the bet', async () => {
  assert.equal(isBigWin({ stake_cents: 1000000, payout_cents: 1600000 }, DEFAULT_LIMITS, 'roulette'), true, 'roulette: amount alone');
  assert.equal(isBigWin({ stake_cents: 1000000, payout_cents: 1600000 }, DEFAULT_LIMITS, 'slot'), false, 'slot: 1.6x the bet is an ordinary free-spin round');
  assert.equal(isBigWin({ stake_cents: 10000, payout_cents: 1500000 }, DEFAULT_LIMITS, 'slot'), true, 'slot: 150x and over the amount');
  assert.equal(isBigWin({ stake_cents: 2000, payout_cents: 400000 }, DEFAULT_LIMITS, 'slot'), false, '200x but under the amount limit');
  const s = setup();
  await s.signIn();
  // The schema seeds its own alert limits; use the code defaults (big win 5,000 TICS, daily loss 2,000 TICS) here.
  s.DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('limits', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(DEFAULT_LIMITS));
  s.seedPlayer('p1'); s.seedPlayer('p2'); s.seedPlayer('p3');
  s.seedRound({ id: 'big-slot', player: 'p1', game: 'godsofpower', stake: 10000, payout: 1500000, outcome: SLOT_OUTCOME([BASE_SPIN, FREE_SPIN]) });
  s.seedRound({ id: 'dull-slot', player: 'p2', game: 'godsofpower', stake: 1000000, payout: 1600000, outcome: SLOT_OUTCOME([BASE_SPIN, FREE_SPIN]) });
  s.seedRound({ id: 'big-wheel', player: 'p3', stake: 100000, payout: 3600000, outcome: '{"pocket":7,"color":"red"}' });
  const n = await runChecks(s.DB, new Date(), { force: true });
  assert.ok(n >= 3, `checks queued ${n}`);
  const alerts = s.DB.raw.prepare("SELECT type, title, details, game_id, round_id FROM alerts ORDER BY id").all();
  const big = alerts.filter(a => a.type === 'big_win');
  assert.deepEqual(big.map(a => a.round_id).sort(), ['big-slot', 'big-wheel']);
  const slot = big.find(a => a.round_id === 'big-slot');
  assert.equal(slot.title, 'Big win: 14,900.00 TICS on Gods of Power');
  assert.match(slot.details, /on Gods of Power and was paid 15,000\.00 TICS \(150 times the bet\)/);
  assert.equal(big.find(a => a.round_id === 'big-wheel').title, 'Big win: 35,000.00 TICS on Roulette');
  const loss = alerts.filter(a => a.type === 'game_loss').map(a => a.title).sort();
  assert.deepEqual(loss, ['Gods of Power is 20,900.00 TICS down today', 'Roulette is 35,000.00 TICS down today']);
  assert.ok(!alerts.some(a => /godsofpower/.test(a.title)), 'no raw game ids in titles');
  // The multiple is a setting (step-up like the other alert limits) with bounds.
  assert.equal((await s.call('PUT', '/api/settings/limits', { slotBigWinMultiple: 0, ...(await s.stepUp()) })).status, 400);
  assert.equal((await s.call('PUT', '/api/settings/limits', { slotBigWinMultiple: 2001, ...(await s.stepUp()) })).status, 400);
  assert.equal((await s.call('PUT', '/api/settings/limits', { slotBigWinMultiple: 50 })).status, 401);
  const r = await s.call('PUT', '/api/settings/limits', { slotBigWinMultiple: 50, ...(await s.stepUp()) });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.slotBigWinMultiple, 50);
  assert.equal((await s.call('GET', '/api/alerts')).data.limits.slotBigWinMultiple, 50);
});
