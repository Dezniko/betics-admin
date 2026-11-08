// Alerts: rules checked every few minutes, shown in the panel and sent to Telegram.
//
// Read budget (D1 bills every row a query touches): the cron runs every 2 minutes for
// scheduled messages and Telegram, but the checks below run at most every 10 minutes and
// only look at what is NEW. Rounds are read once each, by rowid watermark (late copies from a
// wallet retry are still seen exactly once); per-day, per-game sums for the last 30 days are
// kept in the settings row 'alerts_rounds', so daily loss and payback drift need no rescans.
// Only REAL rounds (real_money = 1) count: demo play starts every player with 100,000 TICS and lets them bet up to
// 10,000 TICS a spin, so a demo slot hit would otherwise page the owners with a false URGENT loss. Demo rows still
// move the watermark (read once, skipped), so no demo alert exists at all, not even an info one.
import { fail, isInt, tics, usdt, sqlTime } from '../util.js';
import { requirePerm, stepUp } from '../auth.js';
import { audit, raiseAlert, raiseAlertIf } from '../audit.js';
import { bank } from './bank.js';
import { gameList } from './games.js';

// slotBigWinMultiple: a slot round pays up to 2,000 times the bet, and free spins often pay tens of times the bet,
// so a slot win only counts as a big win when it is ALSO at least this many times the bet (roulette pays at most
// 36 times, so its amount limit alone is enough). 100 = 5% of the slot's cap.
// rtpDriftPctSlot / rtpDriftMinRoundsSlot: a slot's payback swings far more than roulette's (one 2,000x hit moves a
// 5,000-round sample by 40 points), so slots get their own wider band and a much bigger sample before drift is reported.
export const DEFAULT_LIMITS = { dailyHouseLossAlertCents: 200000, bigWinAlertCents: 500000, playerUpAlertCents: 300000, rtpDriftPct: 3, rtpDriftMinRounds: 500, slotBigWinMultiple: 100,
  rtpDriftPctSlot: 8, rtpDriftMinRoundsSlot: 20000 };
// The drift rule for one game kind: slots use the slot band and sample, every other game the standard ones.
export const driftRule = (limits, kind) => kind === 'slot'
  ? { pct: limits.rtpDriftPctSlot ?? DEFAULT_LIMITS.rtpDriftPctSlot, minRounds: limits.rtpDriftMinRoundsSlot ?? DEFAULT_LIMITS.rtpDriftMinRoundsSlot }
  : { pct: limits.rtpDriftPct, minRounds: limits.rtpDriftMinRounds };
// Big-win rule shared by the scan and the tests: net win over the amount limit, and for a slot also over the multiple.
export const isBigWin = (r, limits, kind) => r.payout_cents - r.stake_cents >= limits.bigWinAlertCents
  && (kind !== 'slot' || r.payout_cents >= r.stake_cents * (limits.slotBigWinMultiple || 1));
export const CHECK_EVERY_MS = 10 * 60e3;
const RECONCILE_WINDOW_MS = 15 * 60e3, DRIFT_DAYS = 30, PAGE = 5000, MAX_PAGES = 10;
const STATE_KEY = 'alerts_rounds';

async function getLimits(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'limits'").first();
  return { ...DEFAULT_LIMITS, ...(row ? JSON.parse(row.value) : {}) };
}
async function getMark(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}
const setMark = (db, key, value) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(key, JSON.stringify(value));
const raise = raiseAlert;
const parseSql = t => Date.parse(String(t).replace(' ', 'T') + 'Z');
const addTo = (days, day, game, n, bet, paid) => {
  const d = (days[day] ||= {}); const g = (d[game] ||= [0, 0, 0]);
  g[0] += n; g[1] += bet; g[2] += paid;
};

// New rounds since the watermark, folded into the per-day sums. Also returns the rounds
// themselves (for big wins) and which players played (for the 'player is far up' check).
async function scanRounds(db, now, limits) {
  const cutoffDay = sqlTime(new Date(now - DRIFT_DAYS * 864e5)).slice(0, 10);
  const maxRid = (await db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM rounds').first()).m;
  let state = await getMark(db, STATE_KEY);
  const prevRid = state ? state.rid : null;
  const big = [], players = new Set();
  let bootstrap = false;
  if (!state || state.rid > maxRid) {
    // First run (or the table was rebuilt): one pass over the last 30 days of REAL rounds (the literal real_money = 1
    // puts both queries on the partial index rounds_real_time, checked with EXPLAIN in the tests), then only new rows.
    bootstrap = true;
    state = { rid: maxRid, days: {} };
    const agg = await db.prepare(`SELECT substr(created_at, 1, 10) AS d, game_id, COUNT(*) AS n, COALESCE(SUM(stake_cents),0) AS bet, COALESCE(SUM(payout_cents),0) AS paid
      FROM rounds WHERE created_at >= ? AND +rowid <= ? AND real_money = 1 GROUP BY d, game_id`).bind(`${cutoffDay} 00:00:00`, maxRid).all();
    for (const r of agg.results) addTo(state.days, r.d, r.game_id, r.n, r.bet, r.paid);
    const wins = await db.prepare(`SELECT id, player_id, game_id, stake_cents, payout_cents FROM rounds WHERE created_at >= ? AND +rowid <= ? AND real_money = 1 AND payout_cents - stake_cents >= ?`)
      .bind(sqlTime(new Date(now - 864e5)), maxRid, limits.bigWinAlertCents).all();
    big.push(...wins.results);
  } else {
    for (let page = 0; page < MAX_PAGES; page++) {
      // Pages of raw rows by rowid (each row read once, at most PAGE x MAX_PAGES a run). Demo rows only move the
      // watermark: filtering them in SQL under the LIMIT would let one page read an unbounded run of demo rows.
      const rows = (await db.prepare(`SELECT rowid AS rid, id, player_id, game_id, stake_cents, payout_cents, real_money, created_at FROM rounds WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .bind(state.rid, PAGE).all()).results;
      for (const r of rows) {
        state.rid = r.rid;
        if (Number(r.real_money) !== 1) continue;
        const day = String(r.created_at).slice(0, 10);
        if (day >= cutoffDay) addTo(state.days, day, r.game_id, 1, r.stake_cents, r.payout_cents);
        if (r.payout_cents - r.stake_cents >= limits.bigWinAlertCents) big.push(r);
        players.add(r.player_id);
      }
      if (rows.length < PAGE) break;
    }
  }
  for (const day of Object.keys(state.days)) if (day < cutoffDay) delete state.days[day];
  return { state, prevRid, big, players: [...players], bootstrap };
}

// Looks at everything new since the last run. Safe to run repeatedly: every alert has a dedupe key.
// Returns the number of checks queued, or null when skipped (ran less than 10 minutes ago, or another run is busy).
export async function runChecks(db, now = new Date(), { force = false } = {}) {
  const nowMs = now.getTime();
  const nowSql = sqlTime(now);
  const mark = await getMark(db, 'alerts_mark');
  if (!force && mark && nowMs - parseSql(mark) < CHECK_EVERY_MS - 30e3) return null;
  const since = mark || sqlTime(new Date(nowMs - 864e5));
  const limits = await getLimits(db);
  const scan = await scanRounds(db, nowMs, limits);
  // Two rows, kept 60 s: alerts name the game and the slot rule needs its kind.
  const gamesById = Object.fromEntries((await gameList(db)).map(g => [g.id, g]));
  const gameName = id => gamesById[id]?.name || id;
  const multiple = r => r.stake_cents ? `${(r.payout_cents / r.stake_cents).toLocaleString('en-US', { maximumFractionDigits: 1 })} times the bet` : '';
  // Claim this run: the state row only moves forward from the watermark we read, so two runs at once cannot
  // both count the same rounds. The claim, every alert and the run mark go in ONE batch (all or nothing):
  // if the batch fails, the watermark stays where it was and the next run raises the same alerts again.
  // Each alert insert only happens if this run's claim won (the state row carries this run's id).
  const run = crypto.randomUUID();
  const claimFor = state => {
    const json = JSON.stringify({ ...state, run });
    return scan.prevRid == null
      ? db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(STATE_KEY, json)
      : db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ? AND json_extract(value, '$.rid') = ?").bind(json, STATE_KEY, scan.prevRid);
  };
  const WON = "SELECT 1 FROM settings WHERE key = ? AND json_extract(value, '$.run') = ?";
  const raise = (_db, a) => raiseAlertIf(db, a, WON, [STATE_KEY, run]);
  const out = [];
  for (const r of scan.big) {
    if (!isBigWin(r, limits, gamesById[r.game_id]?.kind)) continue;
    out.push(raise(db, { type: 'big_win', key: `big_win:${r.id}`, playerId: r.player_id, gameId: r.game_id, roundId: r.id,
      title: `Big win: ${tics(r.payout_cents - r.stake_cents)} on ${gameName(r.game_id)}`,
      details: `Player ${r.player_id.slice(0, 8)} bet ${tics(r.stake_cents)} on ${gameName(r.game_id)} and was paid ${tics(r.payout_cents)} (${multiple(r)}).` }));
  }
  // Players far up: totals only change when they play, so only check who played since the last run (everyone once, on the first run).
  const upRows = [];
  if (scan.bootstrap) upRows.push(...(await db.prepare('SELECT id, total_bet_cents, total_paid_cents FROM players WHERE total_paid_cents - total_bet_cents >= ?').bind(limits.playerUpAlertCents).all()).results);
  else for (let i = 0; i < scan.players.length; i += 90) {
    const ids = scan.players.slice(i, i + 90);
    upRows.push(...(await db.prepare(`SELECT id, total_bet_cents, total_paid_cents FROM players WHERE id IN (${ids.map(() => '?').join(',')}) AND total_paid_cents - total_bet_cents >= ?`)
      .bind(...ids, limits.playerUpAlertCents).all()).results);
  }
  for (const p of upRows) {
    const ahead = p.total_paid_cents - p.total_bet_cents, step = Math.floor(ahead / limits.playerUpAlertCents);
    out.push(raise(db, { type: 'player_up', key: `player_up:${p.id}:${step}`, playerId: p.id, title: `Player ${p.id.slice(0, 8)} is ${tics(ahead)} up`,
      details: 'This player has won much more than they have bet overall. Worth a look at their rounds.' }));
  }
  const day = nowSql.slice(0, 10);
  const today = Object.entries(scan.state.days[day] || {}).map(([game_id, [, bet, paid]]) => ({ game_id, profit: bet - paid }));
  const totalToday = today.reduce((s, g) => s + g.profit, 0);
  if (totalToday <= -limits.dailyHouseLossAlertCents) out.push(raise(db, { type: 'daily_loss', severity: 'critical', key: `daily_loss:${day}`,
    title: `The casino is ${tics(-totalToday)} down today`, details: `Players have won ${tics(-totalToday)} more than they bet so far today (UTC).` }));
  for (const g of today) if (g.profit <= -limits.dailyHouseLossAlertCents) out.push(raise(db, { type: 'game_loss', severity: 'critical', key: `game_loss:${g.game_id}:${day}`, gameId: g.game_id,
    title: `${gameName(g.game_id)} is ${tics(-g.profit)} down today`, details: 'One game has lost more than your daily limit.' }));
  // Payback drift over 30 days from the kept sums; only the (tiny) games table is read. The band and the
  // sample depend on the game's kind (slots: wider band, far more rounds).
  const sums = {};
  for (const d of Object.values(scan.state.days)) for (const [g, [n, bet, paid]] of Object.entries(d)) { const s = (sums[g] ||= { n: 0, bet: 0, paid: 0 }); s.n += n; s.bet += bet; s.paid += paid; }
  const targets = (await db.prepare('SELECT g.id, g.kind, m.rtp_target FROM games g JOIN game_math m ON m.game_id = g.id AND m.id = g.math_id').all()).results;
  for (const g of targets) {
    const s = sums[g.id], rule = driftRule(limits, g.kind);
    if (!s || s.n < rule.minRounds || !s.bet) continue;
    const rtp = s.paid / s.bet * 100;
    if (Math.abs(rtp - g.rtp_target) > rule.pct) out.push(raise(db, { type: 'rtp_drift', key: `rtp_drift:${g.id}:${day}`, gameId: g.id,
      title: `${gameName(g.id)} payback is ${rtp.toFixed(1)}%, target ${g.rtp_target}%`, details: `Over the last 30 days (${s.n} real-money rounds) the game paid back ${rtp.toFixed(1)}%. Short runs vary; a big gap over many rounds can mean a bug or abuse.` }));
  }
  const problems = await db.prepare(`SELECT id, type, player_id, meta FROM events WHERE type IN ('fairness_fail','round_error') AND created_at >= ? AND created_at <= ?`).bind(since, nowSql).all();
  for (const e of problems.results) out.push(raise(db, { type: e.type, severity: e.type === 'fairness_fail' ? 'critical' : 'warning', key: `${e.type}:${e.id}`, playerId: e.player_id,
    title: e.type === 'fairness_fail' ? 'A player\'s fairness check failed' : 'A round could not be completed', details: e.meta || null }));
  // Central copy vs wallet: the newest ledger balance must match the player's balance, for demo money
  // (balance_cents vs the newest real_money = 0 row) and for real $TICS (real_tics_cents vs the newest
  // real_money = 1, currency 'TICS' row; security re-audit R2). Only players seen since the last run (at
  // least the last 15 minutes, at most a day), one players read for both; each newest ledger row is one
  // step of index ledger_player_money (player_id, real_money), EXPLAIN pinned in the tests.
  // The wallet copies ledger rows and the balance to the central database in separate steps, so a real
  // mismatch is only reported when the SAME pair of figures is seen on two runs in a row (10 minutes apart):
  // the first sighting is kept in the alerts state (claimed with the rest of this run), a changed or gone
  // mismatch starts over. The demo check reports at once, as before.
  const activeSince = sqlTime(new Date(Math.max(nowMs - 864e5, Math.min(parseSql(since) || nowMs, nowMs - RECONCILE_WINDOW_MS))));
  const mismatch = await db.prepare(`SELECT p.id, p.balance_cents, p.real_tics_cents,
      (SELECT l.balance_after_cents FROM ledger l WHERE l.player_id = p.id AND l.real_money = 0 ORDER BY l.rowid DESC LIMIT 1) AS last,
      (SELECT l.balance_after_cents FROM ledger l WHERE l.player_id = p.id AND l.real_money = 1 AND l.currency = 'TICS' ORDER BY l.rowid DESC LIMIT 1) AS last_real
    FROM players p WHERE p.last_seen_at >= ?`).bind(activeSince).all();
  const seenBefore = scan.state.realMismatch || {}, realMismatch = {};
  for (const p of mismatch.results) {
    if (p.last != null && p.last !== p.balance_cents) out.push(raise(db, { type: 'reconcile', severity: 'critical', key: `reconcile:${p.id}:${p.last}:${p.balance_cents}`, playerId: p.id,
      title: `Balance records disagree for player ${p.id.slice(0, 8)}`, details: `Ledger says ${tics(p.last)}, player record says ${tics(p.balance_cents)}. It usually fixes itself within a minute; if not, check the wallet.` }));
    if (p.last_real == null || p.last_real === p.real_tics_cents) continue;
    const pair = `${p.last_real}:${p.real_tics_cents}`;
    realMismatch[p.id] = pair;
    if (seenBefore[p.id] !== pair) continue; // first sighting: give the central copy one more run to catch up
    out.push(raise(db, { type: 'reconcile_real', severity: 'critical', key: `reconcile_real:${p.id}:${pair}`, playerId: p.id,
      title: 'A player\'s real $TICS balance does not match their ledger',
      details: `Player ${p.id.slice(0, 8)}: the ledger says ${tics(p.last_real)}, the player record says ${tics(p.real_tics_cents)}, on two checks in a row. Real money is involved: check the wallet and the player's ledger before any payout.` }));
  }
  scan.state.realMismatch = realMismatch;
  const wds = await db.prepare(`SELECT id, player_id, amount_cents FROM withdrawals WHERE status = 'requested' AND created_at >= ? AND created_at <= ?`).bind(since, nowSql).all();
  for (const w of wds.results) out.push(raise(db, { type: 'withdrawal_request', severity: 'info', key: `withdrawal:${w.id}`, playerId: w.player_id,
    title: `Withdrawal to approve: ${usdt(w.amount_cents)}`, details: `Player ${w.player_id.slice(0, 8)} asked to withdraw ${usdt(w.amount_cents)}. Approve or reject it on the Payments screen.` }));
  const partial = await db.prepare(`SELECT id, player_id, requested_cents, actually_paid FROM deposits WHERE status = 'partially_paid' AND updated_at >= ?`).bind(since).all();
  for (const d of partial.results) out.push(raise(db, { type: 'deposit_partial', key: `deposit_partial:${d.id}`, playerId: d.player_id,
    title: `A deposit was only partly paid`, details: `Player ${d.player_id.slice(0, 8)} was asked for ${usdt(d.requested_cents)} but sent ${d.actually_paid}. Nothing was credited. Check it in NOWPayments.` }));
  const markStmt = db.prepare(`INSERT INTO settings (key, value) SELECT ?, ? WHERE EXISTS (${WON})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind('alerts_mark', JSON.stringify(nowSql), STATE_KEY, run);
  // The state row written with the claim carries the real-mismatch sightings gathered above.
  await db.batch([claimFor(scan.state), ...out, markStmt]);
  const won = await db.prepare("SELECT json_extract(value, '$.run') AS run FROM settings WHERE key = ?").bind(STATE_KEY).first();
  if (won?.run !== run) return null; // another run got here first (its alerts are its own)
  return out.length;
}

// Most urgent first (critical, then warning, then info), oldest first within each: a burst of
// big-win notices can never hold back a 'new owner' or 'bank short' alert.
// A critical alert is sent even when someone marked it resolved before it went out (once: telegram_sent
// still flips to 1), so whoever changed the treasury address cannot silence the alert by resolving it.
// Resolved ones older than a day are not sent (an old backlog from before Telegram was set up).
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
export async function sendTelegram(db, env, fetchImpl = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return 0;
  // Both use index alerts_unsent (telegram_sent, status, id).
  const [open, resolved] = await Promise.all([
    db.prepare(`SELECT * FROM alerts WHERE telegram_sent = 0 AND status = 'open'
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, id LIMIT 10`).all(),
    db.prepare(`SELECT * FROM alerts WHERE telegram_sent = 0 AND status = 'resolved' AND severity = 'critical' AND created_at >= ? ORDER BY id LIMIT 10`)
      .bind(sqlTime(new Date(Date.now() - 864e5))).all(),
  ]);
  const pending = [...open.results, ...resolved.results]
    .sort((x, y) => (SEVERITY_ORDER[x.severity] ?? 2) - (SEVERITY_ORDER[y.severity] ?? 2) || x.id - y.id).slice(0, 10);
  let sent = 0;
  for (const a of pending) {
    const icon = a.severity === 'critical' ? 'URGENT' : 'Alert';
    const done = a.status === 'resolved' ? `\nAlready marked resolved by ${a.resolved_by || 'someone'}. If that was not you, check it now.` : '';
    const textMsg = `qu-BETICS ${icon}: ${a.title}\n${a.details || ''}${done}\nOpen: https://admin.betics.io/#/alerts`;
    const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: textMsg, disable_web_page_preview: true }) });
    if (res.ok) { await db.prepare('UPDATE alerts SET telegram_sent = 1 WHERE id = ? AND telegram_sent = 0').bind(a.id).run(); sent++; }
  }
  return sent;
}

export async function listAlerts(db, url) {
  const status = url.searchParams.get('status') === 'resolved' ? 'resolved' : 'open';
  const rows = await db.prepare('SELECT * FROM alerts WHERE status = ? ORDER BY id DESC LIMIT 200').bind(status).all();
  const counts = await db.prepare("SELECT status, COUNT(*) AS n FROM alerts GROUP BY status").all();
  return { alerts: rows.results, counts: Object.fromEntries(counts.results.map(c => [c.status, c.n])), limits: await getLimits(db) };
}

export async function resolveAlert(db, admin, id) {
  requirePerm(admin, 'alert:resolve');
  const a = await db.prepare('SELECT * FROM alerts WHERE id = ?').bind(id).first();
  if (!a) fail(404, 'No alert with that id.');
  // Critical alerts (treasury, owners, codes locked, money short) are for the owners to close.
  if (a.severity === 'critical') requirePerm(admin, 'alert:resolve_critical');
  await db.batch([
    db.prepare("UPDATE alerts SET status = 'resolved', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?").bind(admin.email, id),
    audit(db, admin, 'alert.resolve', { target: `alert:${id}`, before: { status: a.status }, after: { status: 'resolved' } }),
  ]);
  return { ok: true };
}

// Alert levels decide when the owners hear about money going out: changing them needs the password and a fresh code.
export async function updateLimits(db, admin, input, env = {}) {
  requirePerm(admin, 'settings:edit');
  const { code, password, ...body } = input;
  const before = await getLimits(db), next = { ...before };
  for (const k of ['dailyHouseLossAlertCents', 'bigWinAlertCents', 'playerUpAlertCents']) if (k in body) {
    if (!isInt(body[k], 100, 1e13)) fail(400, 'Alert amounts must be at least 1 TICS.'); next[k] = body[k];
  }
  if ('rtpDriftPct' in body) { if (typeof body.rtpDriftPct !== 'number' || body.rtpDriftPct < 0.5 || body.rtpDriftPct > 50) fail(400, 'Payback drift must be between 0.5 and 50 points.'); next.rtpDriftPct = body.rtpDriftPct; }
  if ('slotBigWinMultiple' in body) { if (!isInt(body.slotBigWinMultiple, 1, 2000)) fail(400, 'The slot big-win multiple must be between 1 and 2,000 times the bet.'); next.slotBigWinMultiple = body.slotBigWinMultiple; }
  if ('rtpDriftMinRounds' in body) { if (!isInt(body.rtpDriftMinRounds, 50, 1e9)) fail(400, 'Minimum rounds must be at least 50.'); next.rtpDriftMinRounds = body.rtpDriftMinRounds; }
  if ('rtpDriftPctSlot' in body) { if (typeof body.rtpDriftPctSlot !== 'number' || body.rtpDriftPctSlot < 1 || body.rtpDriftPctSlot > 50) fail(400, 'Slot payback drift must be between 1 and 50 points.'); next.rtpDriftPctSlot = body.rtpDriftPctSlot; }
  if ('rtpDriftMinRoundsSlot' in body) { if (!isInt(body.rtpDriftMinRoundsSlot, 1000, 1e6)) fail(400, 'Slot minimum rounds must be between 1,000 and 1,000,000.'); next.rtpDriftMinRoundsSlot = body.rtpDriftMinRoundsSlot; }
  if (JSON.stringify(next) === JSON.stringify(before)) return next;
  await stepUp(db, env, admin, { code, password });
  await db.batch([setMark(db, 'limits', next), audit(db, admin, 'settings.limits', { target: 'settings:limits', before, after: next })]);
  return next;
}

// The bank must cover what players are owed plus the safety buffer.
export async function checkBank(db, env, opts) {
  const b = await bank(db, env, opts);
  if (!b.owedCents || !['short', 'low'].includes(b.state)) return null;
  const day = new Date().toISOString().slice(0, 10);
  await raise(db, { type: 'bank_low', severity: b.state === 'short' ? 'critical' : 'warning', key: `bank_${b.state}:${day}`,
    title: b.state === 'short' ? `The bank cannot cover player balances: top up ${tics(b.topUpCents)}` : `The bank is below the safety buffer: top up ${tics(b.topUpCents)}`,
    details: `Casino wallets hold ${tics(b.heldCents)}. Players are owed ${tics(b.owedCents)}, plus a ${b.reservePct}% buffer.` }).run();
  return b.state;
}
