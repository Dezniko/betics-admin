// Games: list, detail and live controls (on/off, limits, maths option).
import { fail, isInt, text, moneyIs, cached, dropCache, parseOutcome } from '../util.js';
import { requirePerm, stepUp } from '../auth.js';
import { audit } from '../audit.js';
import { bucketExpr } from './money.js';

const view = g => ({ id: g.id, name: g.name, kind: g.kind, enabled: !!g.enabled, maintenanceMessage: g.maintenance_message,
  minStakeCents: g.min_stake_cents, maxStakeCents: g.max_stake_cents, maxWinCents: g.max_win_cents, maxHouseLossCents: g.max_house_loss_cents,
  mathId: g.math_id, configVersion: g.config_version, updatedAt: g.updated_at, createdAt: g.created_at });

export async function listGames(db, real = 1) {
  const rows = await db.prepare(`SELECT g.*, m.label AS math_label, m.rtp_target,
      (SELECT COUNT(*) FROM rounds r WHERE r.game_id = g.id AND ${moneyIs(real, 'r.real_money')} AND r.created_at >= date('now')) AS rounds_today,
      (SELECT COALESCE(SUM(stake_cents - payout_cents),0) FROM rounds r WHERE r.game_id = g.id AND ${moneyIs(real, 'r.real_money')} AND r.created_at >= date('now')) AS profit_today,
      (SELECT COALESCE(SUM(stake_cents),0) FROM rounds r WHERE r.game_id = g.id AND ${moneyIs(real, 'r.real_money')} AND r.created_at >= date('now','-30 days')) AS bet_30,
      (SELECT COALESCE(SUM(payout_cents),0) FROM rounds r WHERE r.game_id = g.id AND ${moneyIs(real, 'r.real_money')} AND r.created_at >= date('now','-30 days')) AS paid_30
    FROM games g LEFT JOIN game_math m ON m.game_id = g.id AND m.id = g.math_id ORDER BY g.sort, g.name`).all();
  return rows.results.map(g => ({ ...view(g), mathLabel: g.math_label, rtpTarget: g.rtp_target, roundsToday: g.rounds_today, profitTodayCents: g.profit_today,
    rtp30: g.bet_30 ? Math.round(g.paid_30 / g.bet_30 * 10000) / 100 : null }));
}

export async function gameDetail(db, id, real = 1) {
  const g = await db.prepare('SELECT * FROM games WHERE id = ?').bind(id).first();
  if (!g) fail(404, 'No game with that id.');
  const [math, series, recent, totals] = await Promise.all([
    db.prepare('SELECT * FROM game_math WHERE game_id = ? ORDER BY rtp_target DESC').bind(id).all(),
    db.prepare(`SELECT ${bucketExpr('day')} AS t, SUM(stake_cents) AS bet, SUM(payout_cents) AS paid, COUNT(*) AS rounds FROM rounds
      WHERE game_id = ? AND ${moneyIs(real)} AND created_at >= date('now','-30 days') GROUP BY t ORDER BY t`).bind(id).all(),
    db.prepare(`SELECT id, player_id, stake_cents, payout_cents, outcome, math_id, country, device, created_at FROM rounds WHERE game_id = ? AND ${moneyIs(real)} ORDER BY created_at DESC LIMIT 20`).bind(id).all(),
    db.prepare(`SELECT COUNT(*) AS rounds, COALESCE(SUM(stake_cents),0) AS bet, COALESCE(SUM(payout_cents),0) AS paid, COUNT(DISTINCT player_id) AS players FROM rounds WHERE game_id = ? AND ${moneyIs(real)}`).bind(id).first(),
  ]);
  return {
    realMoney: !!real,
    game: view(g),
    betLevels: g.kind === 'slot' ? SLOT_BET_LEVELS : null, capMultiple: g.kind === 'slot' ? SLOT_CAP_MULTIPLE : null,
    math: math.results.map(m => ({ id: m.id, label: m.label, description: m.description, rtpMin: m.rtp_min, rtpMax: m.rtp_max, rtpTarget: m.rtp_target })),
    series: series.results.map(s => ({ t: s.t, betCents: s.bet, paidCents: s.paid, profitCents: s.bet - s.paid, rounds: s.rounds,
      rtp: s.bet ? Math.round(s.paid / s.bet * 10000) / 100 : null })),
    recent: recent.results.map(r => ({ ...r, outcome: parseOutcome(r.outcome) })),
    totals: { ...totals, profit: totals.bet - totals.paid, rtp: totals.bet ? Math.round(totals.paid / totals.bet * 10000) / 100 : null },
  };
}

// Every game's id, name and kind: a two-row read, kept 60 s per isolate (the rounds feeds poll every 5 s).
// Used to label rounds and alerts with the game's name instead of its id.
export const gameList = db => cached(db, 'games:list', 60e3, async () => (await db.prepare('SELECT id, name, kind FROM games ORDER BY sort, name').all()).results);
export const gameNameMap = async db => Object.fromEntries((await gameList(db)).map(g => [g.id, g.name]));

const MAX_CENTS = 1_000_000_000_00;
// Slot bet levels: the same list as BET_LEVELS in the game repo's backend/src/games/slotsMath.js (units of 0.01 TICS).
// The game refuses any other stake, so the admin only lets the limits sit on one of these.
export const SLOT_BET_LEVELS = [2000, 4000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
// One slot round can pay this many times the bet (capMultiplier in slotsMath.js); the max win must leave room for it.
export const SLOT_CAP_MULTIPLE = 2000;
// Per-kind limit rules. Roulette keeps its old checks; a slot's stakes must be bet levels.
export function checkLimitsForKind(kind, next) {
  if (next.minStakeCents > next.maxStakeCents) fail(400, 'The minimum bet cannot be above the maximum bet.');
  if (kind !== 'slot') return;
  const levels = SLOT_BET_LEVELS.map(u => (u / 100).toLocaleString('en-US')).join(', ');
  if (!SLOT_BET_LEVELS.includes(next.minStakeCents)) fail(400, `For a slot the minimum bet must be one of its bet levels: ${levels} TICS.`);
  if (!SLOT_BET_LEVELS.includes(next.maxStakeCents)) fail(400, `For a slot the maximum bet must be one of its bet levels: ${levels} TICS.`);
  if (next.maxWinCents < next.minStakeCents * SLOT_CAP_MULTIPLE) fail(400, `A slot round can pay ${SLOT_CAP_MULTIPLE.toLocaleString('en-US')} times the bet: the maximum win must be at least ${(next.minStakeCents * SLOT_CAP_MULTIPLE / 100).toLocaleString('en-US')} TICS for the minimum bet.`);
}
// Bet limits and the maths option decide how much money a spin can move: changing them needs the
// password and a fresh code. Switching a game off or editing its message does not.
const GAME_MONEY_KEYS = ['minStakeCents', 'maxStakeCents', 'maxWinCents', 'maxHouseLossCents', 'mathId'];
export async function updateGame(db, admin, id, input, env = {}) {
  const { code, password, ...body } = input;
  requirePerm(admin, 'game:edit');
  const g = await db.prepare('SELECT * FROM games WHERE id = ?').bind(id).first();
  if (!g) fail(404, 'No game with that id.');
  const next = { ...view(g) };
  if ('enabled' in body) { if (typeof body.enabled !== 'boolean') fail(400, 'enabled must be true or false.'); next.enabled = body.enabled; }
  if ('maintenanceMessage' in body) { if (!text(body.maintenanceMessage, 3, 300)) fail(400, 'The maintenance message needs 3 to 300 characters.'); next.maintenanceMessage = body.maintenanceMessage.trim(); }
  for (const k of ['minStakeCents', 'maxStakeCents', 'maxWinCents', 'maxHouseLossCents']) {
    if (k in body) { if (!isInt(body[k], 1, MAX_CENTS)) fail(400, `${k} must be a whole number of cents above zero.`); next[k] = body[k]; }
  }
  checkLimitsForKind(g.kind, next);
  if ('mathId' in body) {
    const m = await db.prepare('SELECT * FROM game_math WHERE game_id = ? AND id = ?').bind(id, body.mathId).first();
    if (!m) fail(400, 'That maths setting does not exist for this game.');
    if (m.rtp_max >= 100) fail(400, 'A setting that pays back 100% or more would lose money and cannot be used.');
    next.mathId = body.mathId;
  }
  const changed = Object.keys(next).filter(k => JSON.stringify(next[k]) !== JSON.stringify(view(g)[k]) && k !== 'configVersion');
  if (!changed.length) return { game: view(g), changed: [] };
  const before = Object.fromEntries(changed.map(k => [k, view(g)[k]])), after = Object.fromEntries(changed.map(k => [k, next[k]]));
  if (changed.some(k => GAME_MONEY_KEYS.includes(k))) await stepUp(db, env, admin, { code, password });
  await db.batch([
    db.prepare(`UPDATE games SET enabled = ?, maintenance_message = ?, min_stake_cents = ?, max_stake_cents = ?, max_win_cents = ?, max_house_loss_cents = ?,
      math_id = ?, config_version = config_version + 1, updated_at = datetime('now') WHERE id = ?`)
      .bind(next.enabled ? 1 : 0, next.maintenanceMessage, next.minStakeCents, next.maxStakeCents, next.maxWinCents, next.maxHouseLossCents, next.mathId, id),
    audit(db, admin, 'game.update', { target: `game:${id}`, before, after, reason: typeof body.reason === 'string' ? body.reason.slice(0, 300) : null }),
  ]);
  dropCache(db);
  return { game: view(await db.prepare('SELECT * FROM games WHERE id = ?').bind(id).first()), changed };
}
