// Rounds and players: search, detail and status.
import { fail, isInt, text, viewReal, moneyIs, moneyIsPlayer, parseOutcome } from '../util.js';
import { requirePerm, can } from '../auth.js';
import { audit, writeAudit } from '../audit.js';
import { PLAYER_OWED } from './money.js';
import { gameList, gameList as gameListFn } from './games.js';

const clampLimit = v => Math.max(1, Math.min(200, Math.trunc(Number(v)) || 50));
const clampOffset = v => Math.max(0, Math.min(100000, Math.trunc(Number(v)) || 0));

// Personal data is for roles with 'pii:view' (owners). Others see that it exists, not what it is.
export const maskEmail = e => {
  if (e == null) return e;
  const [user, domain = ''] = String(e).split('@');
  const [host, ...tld] = domain.split('.');
  return `${user.slice(0, 1)}***@${host ? host.slice(0, 1) + '***' : '***'}${tld.length ? '.' + tld.join('.') : ''}`;
};
const maskText = v => v == null ? v : 'hidden';

export async function listRounds(db, url) {
  const q = url.searchParams, real = viewReal(url), args = [];
  // One player's rounds: rounds_player (the + keeps the planner off the time index); the live feed: literal, so Real uses rounds_real_time.
  const where = [q.get('player') ? moneyIsPlayer(real) : moneyIs(real)];
  // Game filter: rounds_game (game_id, created_at) serves "one game, newest first" directly (checked with
  // EXPLAIN QUERY PLAN in test/slots.test.mjs), so no new index is needed.
  if (q.get('game')) { where.push('game_id = ?'); args.push(q.get('game')); }
  if (q.get('player')) { where.push('player_id = ?'); args.push(q.get('player')); }
  if (q.get('from')) { where.push('created_at >= ?'); args.push(q.get('from')); }
  if (q.get('to')) { where.push('created_at < ?'); args.push(q.get('to')); }
  if (q.get('outcome') === 'player_won') where.push('payout_cents > stake_cents');
  if (q.get('outcome') === 'house_won') where.push('payout_cents <= stake_cents');
  if (q.get('minStake')) { where.push('stake_cents >= ?'); args.push(Number(q.get('minStake')) || 0); }
  if (q.get('minWin')) { where.push('payout_cents - stake_cents >= ?'); args.push(Number(q.get('minWin')) || 0); }
  if (q.get('before')) { where.push('created_at < ?'); args.push(q.get('before')); }
  const limit = clampLimit(q.get('limit'));
  const rows = await db.prepare(`SELECT id, player_id, game_id, math_id, stake_cents, payout_cents, outcome, country, device, real_money, created_at FROM rounds
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...args, limit).all();
  return { rounds: rows.results.map(r => ({ ...r, outcome: parseOutcome(r.outcome) })), limit, realMoney: !!real, games: await gameList(db) };
}

const parseOr = (text, fallback) => { try { return text == null ? fallback : JSON.parse(text); } catch { return fallback; } };

export async function roundDetail(db, id) {
  const r = await db.prepare('SELECT * FROM rounds WHERE id = ?').bind(id).first();
  if (!r) fail(404, 'No round with that id.');
  const ledger = await db.prepare('SELECT * FROM ledger WHERE round_id = ? ORDER BY created_at').bind(id).all();
  const games = await gameList(db);
  const game = games.find(g => g.id === r.game_id) || null;
  return { round: { ...r, outcome: parseOutcome(r.outcome), bets: parseOr(r.bets_json, null), fairness: parseOr(r.fairness_json, {}) },
    ledger: ledger.results, games, game: game ? { id: game.id, name: game.name, kind: game.kind } : null };
}

// Per-player totals for ONE kind of money (real TICS or demo), from the rounds.
// Each subquery is one rounds_player range: "+r.real_money" can never pick the partial time index.
const STATS = `(SELECT COUNT(*) FROM rounds r WHERE r.player_id = p.id AND +r.real_money = ?) AS m_rounds,
  (SELECT COALESCE(SUM(r.stake_cents),0) FROM rounds r WHERE r.player_id = p.id AND +r.real_money = ?) AS m_bet,
  (SELECT COALESCE(SUM(r.payout_cents),0) FROM rounds r WHERE r.player_id = p.id AND +r.real_money = ?) AS m_paid`;
const SORTS = { last_seen: 'p.last_seen_at DESC', joined: 'p.joined_at DESC', house_profit: '(m_bet - m_paid) DESC',
  player_up: '(m_paid - m_bet) DESC', bet: 'm_bet DESC', balance: 'p.balance_cents DESC',
  real: 'p.real_tics_cents DESC', holdings: 'p.holdings_usd DESC', connected: 'p.last_connected_at DESC' };
const REAL_ONLY_SORTS = ['real', 'holdings', 'connected'], DEMO_ONLY_SORTS = ['balance'];
const EMAIL = "(SELECT value FROM player_identities i WHERE i.player_id = p.id AND i.kind = 'email' ORDER BY i.created_at DESC LIMIT 1)";
const CONSENT = "(SELECT consent FROM player_identities i WHERE i.player_id = p.id AND i.kind = 'email' ORDER BY i.created_at DESC LIMIT 1)";
const DEPOSITED = "EXISTS (SELECT 1 FROM chain_deposits d WHERE d.player_id = p.id AND d.status IN ('credited','assigned'))";
const yesNo = v => v === 'yes' ? true : v === 'no' ? false : null;
const usdParam = v => { if (v == null || v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < 0) fail(400, 'Holdings must be a dollar amount, zero or more.'); return n; };

// Filters shared by the list and the CSV export.
export function playerFilters(q, pii = true) {
  const where = [], args = [];
  const search = (q.get('q') || '').trim();
  if (search) {
    if (search.length > 100) fail(400, 'That search is too long.');
    const like = search.toLowerCase().replace(/[%_\\]/g, m => '\\' + m);
    // Searching by email or Telegram would reveal them one guess at a time: only with 'pii:view'.
    const kinds = pii ? "'wallet','email','telegram'" : "'wallet'";
    where.push(`(p.id LIKE ? ESCAPE '\\' OR p.wallet_address LIKE ? ESCAPE '\\' OR p.id IN (SELECT player_id FROM player_identities WHERE kind IN (${kinds}) AND lower(value) LIKE ? ESCAPE '\\'))`);
    args.push(`${like}%`, `%${like}%`, `%${like}%`);
  }
  if (['active', 'frozen', 'banned'].includes(q.get('status'))) { where.push('p.status = ?'); args.push(q.get('status')); }
  if (q.get('country')) { where.push('p.country = ?'); args.push(q.get('country').trim().toUpperCase()); }
  if (q.get('device')) { where.push('p.device = ?'); args.push(q.get('device')); }
  const hasEmail = yesNo(q.get('hasEmail'));
  if (hasEmail != null) where.push(`${hasEmail ? '' : 'NOT '}EXISTS (SELECT 1 FROM player_identities i WHERE i.player_id = p.id AND i.kind = 'email')`);
  const consent = yesNo(q.get('consent'));
  if (consent != null) where.push(`${consent ? '' : 'NOT '}EXISTS (SELECT 1 FROM player_identities i WHERE i.player_id = p.id AND i.kind = 'email' AND i.consent = 1)`);
  const min = usdParam(q.get('holdingsMin')), max = usdParam(q.get('holdingsMax'));
  if (min != null) { where.push('p.holdings_usd >= ?'); args.push(min); }
  if (max != null) { where.push('p.holdings_usd <= ?'); args.push(max); }
  const deposited = yesNo(q.get('deposited'));
  if (deposited != null) where.push(`${deposited ? '' : 'NOT '}${DEPOSITED}`);
  if (q.get('wallet') === 'yes') where.push('p.wallet_address IS NOT NULL');
  if (q.get('connectedDays')) {
    const n = Number(q.get('connectedDays'));
    if (!Number.isInteger(n) || n < 1 || n > 3650) fail(400, 'Last connected must be 1 to 3650 days.');
    where.push("p.last_connected_at >= datetime('now', ?)"); args.push(`-${n} days`);
  }
  // Real view: only players who connected a wallet (only they can hold real TICS).
  const real = q.get('money') === 'play' ? 0 : 1;
  if (real) where.push('p.wallet_address IS NOT NULL');
  let sortKey = SORTS[q.get('sort')] ? q.get('sort') : 'last_seen';
  if ((!real && REAL_ONLY_SORTS.includes(sortKey)) || (real && DEMO_ONLY_SORTS.includes(sortKey))) sortKey = 'last_seen';
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', args, sort: SORTS[sortKey], real };
}

export async function listPlayers(db, url, admin) {
  const q = url.searchParams;
  const pii = can(admin, 'pii:view');
  const f = playerFilters(q, pii);
  const limit = clampLimit(q.get('limit')), offset = clampOffset(q.get('offset'));
  const [rows, count] = await Promise.all([
    db.prepare(`SELECT p.*, ${EMAIL} AS email, ${CONSENT} AS email_consent, ${STATS} FROM players p ${f.where} ORDER BY ${f.sort} LIMIT ? OFFSET ?`).bind(f.real, f.real, f.real, ...f.args, limit, offset).all(),
    db.prepare(`SELECT COUNT(*) AS n FROM players p ${f.where}`).bind(...f.args).first(),
  ]);
  const view = pii ? playerView : p => maskPlayer(playerView(p));
  return { players: rows.results.map(view), total: count.n, limit, offset, realMoney: !!f.real, piiMasked: !pii };
}

// CSV cell: quoted when needed, and never starting with a spreadsheet formula character.
const cell = v => {
  if (v == null) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const units2 = u => ((u || 0) / 100).toFixed(2);
export const PLAYER_CSV_HEADER = ['address', 'email', 'consent', 'country', 'city', 'first_connected_at', 'last_connected_at', 'holdings_usd', 'top_assets', 'deposited_tics', 'withdrawn_tics', 'rounds', 'net_result_tics'];

export async function playersCsv(db, url, admin) {
  const pii = can(admin, 'pii:view');
  const f = playerFilters(url.searchParams, pii);
  const rows = await db.prepare(`SELECT p.id, p.wallet_address, p.country, p.city, p.first_connected_at, p.last_connected_at, p.holdings_usd, ${STATS},
    ${EMAIL} AS email, ${CONSENT} AS email_consent,
    (SELECT COALESCE(SUM(amount_units),0) FROM chain_deposits d WHERE d.player_id = p.id AND d.status IN ('credited','assigned')) AS deposited,
    (SELECT COALESCE(SUM(amount_units),0) FROM chain_withdrawals w WHERE w.player_id = p.id AND w.kind = 'player' AND w.status = 'sent') AS withdrawn
    FROM players p ${f.where} ORDER BY ${f.sort} LIMIT 50000`).bind(f.real, f.real, f.real, ...f.args).all();
  const top = await db.prepare(`SELECT player_id, symbol, usd_value FROM (SELECT player_id, symbol, usd_value, ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY usd_value DESC) AS rn
    FROM wallet_holdings WHERE hidden = 0 AND usd_value IS NOT NULL) WHERE rn <= 5 ORDER BY player_id, rn`).all();
  const assets = new Map();
  for (const t of top.results) { if (!assets.has(t.player_id)) assets.set(t.player_id, []); assets.get(t.player_id).push(`${t.symbol || '?'}:${Number(t.usd_value).toFixed(2)}`); }
  const lines = [PLAYER_CSV_HEADER.join(',')];
  for (const p of rows.results) lines.push([p.wallet_address || p.id, pii ? p.email : maskEmail(p.email), p.email == null ? '' : p.email_consent ? 'yes' : 'no', p.country, pii ? p.city : maskText(p.city), p.first_connected_at, p.last_connected_at,
    p.holdings_usd == null ? '' : Number(p.holdings_usd).toFixed(2), (assets.get(p.id) || []).join(';'), units2(p.deposited), units2(p.withdrawn), p.m_rounds,
    units2(p.m_paid - p.m_bet)].map(cell).join(','));
  return { csv: lines.join('\n') + '\n', count: rows.results.length };
}

const playerView = p => ({ id: p.id, status: p.status, statusReason: p.status_reason, country: p.country, city: p.city, device: p.device, os: p.os,
  browser: p.browser, language: p.language, balanceCents: p.balance_cents, realBalanceCents: p.real_balance_cents ?? 0, totalBetCents: p.total_bet_cents, totalPaidCents: p.total_paid_cents,
  ...(p.m_rounds !== undefined ? { totalBetCents: p.m_bet, totalPaidCents: p.m_paid, houseProfitCents: p.m_bet - p.m_paid, rounds: p.m_rounds }
    : { houseProfitCents: p.total_bet_cents - p.total_paid_cents, rounds: p.rounds }),
  joinedAt: p.joined_at, lastSeenAt: p.last_seen_at,
  firstReferrer: p.first_referrer, firstCampaign: p.first_campaign,
  walletAddress: p.wallet_address ?? null, firstConnectedAt: p.first_connected_at ?? null, lastConnectedAt: p.last_connected_at ?? null, termsAcceptedAt: p.terms_accepted_at ?? null,
  realTicsCents: p.real_tics_cents ?? 0, holdingsUsd: p.holdings_usd ?? null, holdingsUpdatedAt: p.holdings_updated_at ?? null,
  ...(p.email !== undefined ? { email: p.email, emailConsent: p.email == null ? null : !!p.email_consent } : {}) });

// Without 'pii:view': emails masked, Telegram ids hidden, no city/os/browser/language, no connection log details.
const maskPlayer = v => ({ ...v, city: maskText(v.city), os: maskText(v.os), browser: maskText(v.browser), language: maskText(v.language),
  firstReferrer: maskText(v.firstReferrer), firstCampaign: maskText(v.firstCampaign), ...('email' in v ? { email: maskEmail(v.email) } : {}) });

export async function playerDetail(db, id, real = 1, admin = null) {
  const p = await db.prepare(`SELECT p.*, ${STATS} FROM players p WHERE p.id = ?`).bind(real, real, real, id).first();
  if (!p) fail(404, 'No player with that id.');
  const [identities, ledger, rounds, sameNetwork, limits, games] = await Promise.all([
    db.prepare('SELECT kind, value, verified, consent, created_at FROM player_identities WHERE player_id = ? ORDER BY created_at').bind(id).all(),
    db.prepare('SELECT id, type, amount_cents, balance_after_cents, round_id, meta, real_money, created_at FROM ledger WHERE player_id = ? AND real_money = ? ORDER BY rowid DESC LIMIT 60').bind(id, real).all(),
    db.prepare('SELECT id, game_id, stake_cents, payout_cents, outcome, device, created_at FROM rounds WHERE player_id = ? AND +real_money = ? ORDER BY created_at DESC LIMIT 40').bind(id, real).all(),
    p.ip_hash ? db.prepare(`SELECT id, wallet_address, status, country, city, device, os, browser, joined_at, last_seen_at,
        (SELECT COUNT(*) FROM rounds r WHERE r.player_id = players.id AND +r.real_money = ?) AS rounds
      FROM players WHERE ip_hash = ? AND id != ? ORDER BY last_seen_at DESC LIMIT 50`).bind(real, p.ip_hash, id).all() : { results: [] },
    db.prepare("SELECT value FROM settings WHERE key = 'limits'").first(),
    db.prepare(`SELECT game_id, COUNT(*) AS rounds, SUM(stake_cents) AS bet, SUM(payout_cents) AS paid FROM rounds WHERE player_id = ? AND +real_money = ? GROUP BY game_id`).bind(id, real).all(),
  ]);
  const [deposits, withdrawals, connections, holdings, chainDeposits, chainWithdrawals, email, settings] = await Promise.all([
    db.prepare('SELECT id, status, requested_cents, credited_cents, created_at FROM deposits WHERE player_id = ? ORDER BY created_at DESC LIMIT 20').bind(id).all(),
    db.prepare('SELECT id, status, amount_cents, address, tx_hash, created_at FROM withdrawals WHERE player_id = ? ORDER BY created_at DESC LIMIT 20').bind(id).all(),
    db.prepare('SELECT id, address, country, city, device, os, browser, language, created_at FROM wallet_connections WHERE player_id = ? ORDER BY created_at DESC, id DESC LIMIT 50').bind(id).all(),
    db.prepare('SELECT network, token, symbol, name, decimals, amount, usd_price, usd_value, hidden, updated_at FROM wallet_holdings WHERE player_id = ? ORDER BY hidden, usd_value DESC').bind(id).all(),
    db.prepare('SELECT id, chain_id, tx_hash, log_index, block_number, from_address, amount_units, status, note, credited_at, created_at FROM chain_deposits WHERE player_id = ? OR (? IS NOT NULL AND from_address = ?) ORDER BY created_at DESC LIMIT 50')
      .bind(id, p.wallet_address ?? null, p.wallet_address ?? null).all(),
    db.prepare("SELECT id, amount_units, fee_units, send_units, status, release_at, tx_hash, attempts, last_error, created_at, sent_at FROM chain_withdrawals WHERE player_id = ? AND kind = 'player' ORDER BY created_at DESC LIMIT 50").bind(id).all(),
    db.prepare("SELECT value, consent, verified, created_at FROM player_identities WHERE player_id = ? AND kind = 'email' ORDER BY created_at DESC LIMIT 1").bind(id).first(),
    db.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").first(),
  ]);
  const pii = can(admin, 'pii:view');
  const gameList = await gameListFn(db), names = Object.fromEntries(gameList.map(g => [g.id, g.name]));
  const view = pii ? playerView(p) : maskPlayer(playerView(p)), lim = limits ? JSON.parse(limits.value) : {};
  const flags = [];
  if (-view.houseProfitCents >= (lim.playerUpAlertCents || Infinity)) flags.push({ type: 'player_up', text: 'This player is unusually far up against the house.' });
  const sameNet = sameNetwork.results || [];
  if (sameNet.length > 0) flags.push({ type: 'same_network', text: `${sameNet.length} other player account${sameNet.length > 1 ? 's' : ''} used the same network. Could be family or a shared Wi-Fi, or one person with several accounts.`,
    players: sameNet.map(x => ({ id: x.id, walletAddress: x.wallet_address ?? null, status: x.status, country: x.country, city: pii ? x.city : maskText(x.city), device: x.device, os: pii ? x.os : maskText(x.os), browser: pii ? x.browser : maskText(x.browser),
      joinedAt: x.joined_at, lastSeenAt: x.last_seen_at, rounds: x.rounds })) });
  const sums = (rows, f) => rows.reduce((t, x) => t + (f(x) || 0), 0);
  return {
    realMoney: !!real,
    player: view,
    piiMasked: !pii,
    identities: identities.results.map(i => ({ ...i, value: i.kind === 'guest' ? 'This browser (cookie)' : pii || i.kind === 'wallet' ? i.value : i.kind === 'email' ? maskEmail(i.value) : maskText(i.value) })),
    ledger: ledger.results.map(l => ({ ...l, meta: l.meta ? JSON.parse(l.meta) : null })),
    rounds: rounds.results.map(r => ({ ...r, outcome: parseOutcome(r.outcome) })),
    games: games.results.map(g => ({ gameId: g.game_id, gameName: names[g.game_id] || g.game_id, rounds: g.rounds, betCents: g.bet, paidCents: g.paid })),
    gameList,
    deposits: deposits.results, withdrawals: withdrawals.results,
    connections: pii ? connections.results : connections.results.map(c => ({ id: c.id, address: c.address, country: c.country, created_at: c.created_at, city: null, device: null, os: null, browser: null, language: null })),
    holdings: holdings.results,
    holdingsTotalUsd: holdings.results.filter(x => !x.hidden).reduce((s, x) => s + (Number(x.usd_value) || 0), 0),
    chainDeposits: chainDeposits.results, chainWithdrawals: chainWithdrawals.results,
    depositedUnits: sums(chainDeposits.results.filter(x => ['credited', 'assigned'].includes(x.status)), x => x.amount_units),
    withdrawnUnits: sums(chainWithdrawals.results.filter(x => x.status === 'sent'), x => x.amount_units),
    pendingWithdrawalUnits: sums(chainWithdrawals.results.filter(x => PLAYER_OWED.includes(x.status)), x => x.amount_units),
    email: email ? { address: pii ? email.value : maskEmail(email.value), consent: !!email.consent, verified: !!email.verified, addedAt: email.created_at } : null,
    chainId: (() => { try { return JSON.parse(settings?.value || '{}').chainId || 1; } catch { return 1; } })(),
    flags,
  };
}

export async function setPlayerStatus(db, admin, id, body) {
  if (!['active', 'frozen', 'banned'].includes(body.status)) fail(400, 'Status must be active, frozen or banned.');
  // Support can pause and unpause; banning, and lifting a ban, is owner only.
  requirePerm(admin, body.status === 'banned' ? 'player:ban' : 'player:status');
  const p = await db.prepare('SELECT * FROM players WHERE id = ?').bind(id).first();
  if (!p) fail(404, 'No player with that id.');
  if (p.status === 'banned' && !can(admin, 'player:ban')) fail(403, 'Only the owner can lift a ban.');
  if (!text(body.reason, 3, 300)) fail(400, 'Write a short reason (3 to 300 characters).');
  if (p.status === body.status) return { status: p.status };
  await db.batch([
    db.prepare('UPDATE players SET status = ?, status_reason = ? WHERE id = ?').bind(body.status, body.reason.trim(), id),
    audit(db, admin, 'player.status', { target: `player:${id}`, before: { status: p.status }, after: { status: body.status }, reason: body.reason.trim() }),
  ]);
  return { status: body.status };
}
