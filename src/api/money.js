// Money and activity summaries for the Overview and Money screens.
import { periodRange, fail, viewReal, cached, moneyIs, parseOutcome } from '../util.js';
import { gameList } from './games.js';

// 1 = real TICS, 0 = demo. Follows the admin's Real/Demo switch (see viewReal).
export async function moneyMode(db, url) { return viewReal(url); }

const totals = (db, from, to, real, game) => db.prepare(`SELECT COUNT(*) AS rounds, COALESCE(SUM(stake_cents),0) AS bet,
  COALESCE(SUM(payout_cents),0) AS paid, COUNT(DISTINCT player_id) AS players FROM rounds
  WHERE created_at >= ? AND created_at < ? AND ${moneyIs(real)} ${game ? 'AND game_id = ?' : ''}`).bind(...[from, to, ...(game ? [game] : [])]).first();

const shape = t => ({ rounds: t.rounds, betCents: t.bet, paidCents: t.paid, profitCents: t.bet - t.paid,
  rtp: t.bet ? Math.round(t.paid / t.bet * 10000) / 100 : null, players: t.players });

export function bucketExpr(bucket) {
  if (bucket === 'hour') return "strftime('%Y-%m-%d %H:00', created_at)";
  if (bucket === 'week') return "strftime('%Y-W%W', created_at)";
  if (bucket === 'month') return "strftime('%Y-%m', created_at)";
  return "strftime('%Y-%m-%d', created_at)";
}

export async function overview(db, url) {
  const period = url.searchParams.get('period') || 'today';
  const r = periodRange(period);
  const real = await moneyMode(db, url);
  // Period aggregates are kept 60 s (the page polls every 15 s); live rounds and alerts are always fresh.
  const agg = (name, fn) => cached(db, `overview:${period}:${real}:${name}`, 60e3, fn);
  const [now, prev, newPlayers, prevNew, series, games, devices, countries, live, bigWins, alerts, limits] = await Promise.all([
    agg('now', () => totals(db, r.from, r.to, real)), agg('prev', () => totals(db, r.prevFrom, r.prevTo, real)),
    // New players: real = wallets connected for the first time; demo = first visits.
    agg('new', () => db.prepare(real ? 'SELECT COUNT(*) AS n FROM players WHERE first_connected_at >= ? AND first_connected_at < ?' : 'SELECT COUNT(*) AS n FROM players WHERE joined_at >= ? AND joined_at < ?').bind(r.from, r.to).first()),
    agg('prevNew', () => db.prepare(real ? 'SELECT COUNT(*) AS n FROM players WHERE first_connected_at >= ? AND first_connected_at < ?' : 'SELECT COUNT(*) AS n FROM players WHERE joined_at >= ? AND joined_at < ?').bind(r.prevFrom, r.prevTo).first()),
    agg('series', () => db.prepare(`SELECT ${bucketExpr(r.bucket)} AS t, SUM(stake_cents) AS bet, SUM(payout_cents) AS paid, COUNT(*) AS rounds FROM rounds
      WHERE created_at >= ? AND created_at < ? AND ${moneyIs(real)} GROUP BY t ORDER BY t`).bind(r.from, r.to).all()),
    agg('games', () => db.prepare(`SELECT g.id, g.name, g.enabled, g.math_id, m.rtp_target, m.label AS math_label, COUNT(x.id) AS rounds, COALESCE(SUM(x.stake_cents),0) AS bet, COALESCE(SUM(x.payout_cents),0) AS paid
      FROM games g LEFT JOIN game_math m ON m.game_id = g.id AND m.id = g.math_id
      LEFT JOIN rounds x ON x.game_id = g.id AND x.created_at >= ? AND x.created_at < ? AND ${moneyIs(real, 'x.real_money')}
      GROUP BY g.id ORDER BY g.sort, g.name`).bind(r.from, r.to).all()),
    agg('devices', () => db.prepare(`SELECT COALESCE(device,'unknown') AS k, COUNT(DISTINCT player_id) AS n FROM rounds WHERE created_at >= ? AND created_at < ? AND ${moneyIs(real)} GROUP BY k ORDER BY n DESC`).bind(r.from, r.to).all()),
    agg('countries', () => db.prepare(`SELECT COALESCE(country,'??') AS k, COUNT(DISTINCT player_id) AS n, SUM(stake_cents) - SUM(payout_cents) AS profit FROM rounds WHERE created_at >= ? AND created_at < ? AND ${moneyIs(real)} GROUP BY k ORDER BY n DESC LIMIT 8`).bind(r.from, r.to).all()),
    db.prepare(`SELECT id, player_id, game_id, stake_cents, payout_cents, outcome, country, device, created_at FROM rounds WHERE ${moneyIs(real)} ORDER BY created_at DESC, id DESC LIMIT 15`).all(),
    agg('bigWins', () => db.prepare(`SELECT id, player_id, game_id, stake_cents, payout_cents, created_at FROM rounds WHERE created_at >= ? AND created_at < ? AND ${moneyIs(real)} AND payout_cents > stake_cents ORDER BY payout_cents - stake_cents DESC LIMIT 5`).bind(r.from, r.to).all()),
    db.prepare("SELECT id, type, severity, title, details, created_at FROM alerts WHERE status = 'open' ORDER BY id DESC LIMIT 5").all(),
    db.prepare("SELECT value FROM settings WHERE key = 'limits'").first(),
  ]);
  const ticsFloat = real ? await floatSnapshot(db) : null;
  const openAlerts = await db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'").first();
  return {
    period, range: r, realMoney: !!real,
    now: { ...shape(now), newPlayers: newPlayers.n }, prev: { ...shape(prev), newPlayers: prevNew.n },
    series: series.results.map(s => ({ t: s.t, betCents: s.bet, paidCents: s.paid, profitCents: s.bet - s.paid, rounds: s.rounds })),
    games: games.results.map(g => ({ id: g.id, name: g.name, enabled: !!g.enabled, mathId: g.math_id, mathLabel: g.math_label, rtpTarget: g.rtp_target, ...shape({ rounds: g.rounds, bet: g.bet, paid: g.paid, players: null }) })),
    devices: devices.results, countries: countries.results,
    live: live.results.map(x => ({ ...x, outcome: parseOutcome(x.outcome) })),
    bigWins: bigWins.results, alerts: alerts.results, openAlerts: openAlerts.n,
    limits: limits ? JSON.parse(limits.value) : {}, ticsFloat,
  };
}

// Money screen: bet / paid / profit by day, week or month, optionally per game.
export async function money(db, url) {
  const period = url.searchParams.get('period') || '30d';
  const group = url.searchParams.get('group') || 'day';
  if (!['hour', 'day', 'week', 'month'].includes(group)) fail(400, 'Unknown grouping.');
  const r = periodRange(period);
  const real = await moneyMode(db, url);
  const data = await cached(db, `money:${period}:${group}:${real}`, 60e3, async () => {
  const [rows, byGame, total, games] = await Promise.all([
    db.prepare(`SELECT ${bucketExpr(group)} AS t, game_id, COUNT(*) AS rounds, SUM(stake_cents) AS bet, SUM(payout_cents) AS paid, COUNT(DISTINCT player_id) AS players
      FROM rounds WHERE created_at >= ? AND created_at < ? AND ${moneyIs(real)} GROUP BY t, game_id ORDER BY t`).bind(r.from, r.to).all(),
    db.prepare(`SELECT game_id, COUNT(*) AS rounds, SUM(stake_cents) AS bet, SUM(payout_cents) AS paid FROM rounds WHERE created_at >= ? AND created_at < ? AND ${moneyIs(real)} GROUP BY game_id`).bind(r.from, r.to).all(),
    totals(db, r.from, r.to, real),
    gameList(db),
  ]);
  const names = Object.fromEntries(games.map(g => [g.id, g.name]));
  return {
    period, group, realMoney: !!real, total: shape(total), games,
    rows: rows.results.map(x => ({ t: x.t, gameId: x.game_id, gameName: names[x.game_id] || x.game_id, rounds: x.rounds, betCents: x.bet, paidCents: x.paid, profitCents: x.bet - x.paid, players: x.players })),
    byGame: byGame.results.map(g => ({ gameId: g.game_id, gameName: names[g.game_id] || g.game_id, ...shape({ rounds: g.rounds, bet: g.bet, paid: g.paid, players: null }) })),
  };
  });
  // The reserve card (wallet, owed incl. unresolved deposits, protected balance): live, like on Overview. Real mode only.
  return { ...data, ticsFloat: real ? await floatSnapshot(db) : null };
}

export function moneyCsv(data) {
  const lines = ['period,game,rounds,players,bet_tics,paid_out_tics,house_profit_tics'];
  for (const r of data.rows) lines.push([r.t, r.gameId, r.rounds, r.players, (r.betCents / 100).toFixed(2), (r.paidCents / 100).toFixed(2), (r.profitCents / 100).toFixed(2)].join(','));
  return lines.join('\n') + '\n';
}

// What the casino owes (shared rule with the game and payouts Workers):
//   owed = real TICS balances (> 0)
//        + player withdrawals not paid or refunded yet ('holding', 'queued', 'signing', 'sending',
//          'blocked' = stopped before payment, money still held; 'cancelling' = refund not confirmed yet)
//        + treasury sends in flight ('queued', 'signing', 'sending')
//        + unresolved customer deposits (security review F2): TICS that reached the casino wallet from a sender
//          we could not match to a player ('unmatched'), below the minimum ('below_min', refundable), or claimed
//          for a player but not credited yet ('assigned' without credited_at). Owed to someone until an owner
//          assigns them (then the player balance carries the money) or marks them as the house's own funding
//          (status 'ignored', resolution 'house_funding'). Reversed rows never count.
//   free float = wallet token balance - owed - open spin holds (expires_at > now, ms).
// Every part is an indexed read: players_real_tics (partial), chain_withdrawals_kind_status, spin_holds_expiry,
// chain_deposits_status (the statuses are literals so SQLite can use it; EXPLAIN is pinned in a test).
// Player withdrawal statuses that are still owed (same list as OWED_SQL in ~/betics worker/wallet.js).
export const PLAYER_OWED = ['holding', 'queued', 'signing', 'sending', 'blocked', 'cancelling'];
const PLAYER_OWED_STATUSES = `(${PLAYER_OWED.map(x => `'${x}'`).join(',')})`;
// Same rule as UNRESOLVED_DEPOSITS_SQL in ~/betics worker/wallet.js.
export const UNRESOLVED_DEPOSITS_WHERE = "reversed_at IS NULL AND (status IN ('unmatched','below_min') OR (status = 'assigned' AND credited_at IS NULL))";
export const UNRESOLVED_DEPOSITS_SQL = `(SELECT COALESCE(SUM(amount_units),0) FROM chain_deposits WHERE ${UNRESOLVED_DEPOSITS_WHERE})`;
export async function owedBreakdown(db, nowMs = Date.now()) {
  const r = await db.prepare(`SELECT
    (SELECT COALESCE(SUM(real_tics_cents),0) FROM players WHERE real_tics_cents > 0) AS players,
    (SELECT COALESCE(SUM(amount_units),0) FROM chain_withdrawals WHERE kind = 'player' AND status IN ${PLAYER_OWED_STATUSES}) AS pending,
    (SELECT COALESCE(SUM(amount_units),0) FROM chain_withdrawals WHERE kind = 'treasury' AND status IN ('queued','signing','sending')) AS treasury,
    ${UNRESOLVED_DEPOSITS_SQL} AS unresolved,
    (SELECT COALESCE(SUM(units),0) FROM spin_holds WHERE expires_at > ?) AS holds`).bind(nowMs).first();
  return { playersUnits: r.players, pendingUnits: r.pending, treasuryUnits: r.treasury, unresolvedUnits: r.unresolved, holdsUnits: r.holds,
    owedUnits: r.players + r.pending + r.treasury + r.unresolved };
}
export const freeFloat = (tokenUnits, o) => tokenUnits == null ? null : tokenUnits - o.owedUnits - o.holdsUnits;
// The protected part of the wallet balance (security review F1): what the deposit scan has classified as the
// casino's own. The game writes safeTokenUnits into the float snapshot; a snapshot without it (older game code)
// protects nothing, and so does safeUnknown (classification not established yet). Never above the plain balance.
export const protectedUnits = f => f?.tokenUnits == null ? null : f.safeUnknown ? 0 : Math.min(f.tokenUnits, Number.isSafeInteger(f.safeTokenUnits) ? f.safeTokenUnits : 0);
// What may leave for the treasury: the protected balance minus everything owed (unresolved deposits included)
// and open spin holds. The payouts signer computes the same figure from the chain itself and refuses anything above it.
export const freeToSend = (f, o) => { const p = protectedUnits(f); return p == null ? null : p - o.owedUnits - o.holdsUnits; };
// Unresolved deposits as a count and a total (the Treasury page shows both).
export const unresolvedDeposits = db => db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_units),0) AS units FROM chain_deposits WHERE ${UNRESOLVED_DEPOSITS_WHERE}`).first();

// The casino wallet snapshot the game cron caches (chain_state 'float'), with its age.
export async function floatSnapshot(db) {
  const row = await db.prepare("SELECT value, updated_at FROM chain_state WHERE key = 'float'").first().catch(() => null);
  if (!row) return null;
  try {
    const f = JSON.parse(row.value);
    // Owed is read live (as the game does for every real spin), not as of the snapshot.
    const [o, setting] = await Promise.all([
      owedBreakdown(db),
      db.prepare("SELECT json_extract(value, '$.maxSpinExposurePct') AS pct FROM settings WHERE key = 'tics_payments'").first(),
    ]);
    const free = freeFloat(f.tokenUnits ?? null, o), safe = protectedUnits(f), freeSend = freeToSend(f, o);
    const pct = Math.min(100, Math.max(1, Number(setting?.pct) || 25));
    // Max win per spin follows the game's own rule (the protected balance, not the plain one).
    return { at: f.at ?? null, chainId: f.chainId ?? null, wallet: f.wallet ?? null, tokenUnits: f.tokenUnits ?? null, ethWei: f.ethWei != null ? String(f.ethWei) : null,
      safeTokenUnits: Number.isSafeInteger(f.safeTokenUnits) ? f.safeTokenUnits : null, safeUnknown: !!f.safeUnknown, protectedUnits: safe,
      owedUnits: o.owedUnits, holdsUnits: o.holdsUnits, unresolvedUnits: o.unresolvedUnits, owed: o, freeUnits: free, freeToSendUnits: freeSend, exposurePct: pct,
      maxWinUnits: freeSend == null ? null : Math.floor(Math.max(0, freeSend) * pct / 100),
      ageSeconds: f.at ? Math.max(0, Math.round((Date.now() - f.at) / 1000)) : null };
  } catch { return null; }
}
