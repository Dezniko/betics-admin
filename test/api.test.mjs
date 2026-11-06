import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createD1 } from './d1shim.mjs';
import worker from '../src/index.js';
import { hotp } from '../src/totp.js';
import { makeSetupToken } from '../src/auth.js';
import { runChecks, sendTelegram } from '../src/api/alerts.js';
import { sendScheduled } from '../src/api/messages.js';

const MIGRATION = new URL('./schema.sql', import.meta.url).pathname // copy of betics migrations (scripts/sync-schema.sh);
const ORIGIN = 'https://admin.betics.io';

function setup() {
  const DB = createD1([MIGRATION]);
  const adjustments = [];
  const env = {
    DB, SESSION_PEPPER: 'pepper', INTERNAL_SECRET: 'secret',
    ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) },
    WALLETS: { idFromName: (n) => n, get: (id) => ({ fetch: async (req) => {
      assert.equal(req.headers.get('X-Internal-Secret'), 'secret');
      const body = await req.json(); adjustments.push({ id, body, path: new URL(req.url).pathname });
      if (new URL(req.url).pathname === '/internal/withdraw-release') {
        DB.raw.prepare('UPDATE players SET real_balance_cents = real_balance_cents + ? WHERE id = ?').run(body.amountCents, id);
        return Response.json({ realBalanceCents: DB.raw.prepare('SELECT real_balance_cents FROM players WHERE id = ?').get(id).real_balance_cents });
      }
      const p = DB.raw.prepare('SELECT balance_cents FROM players WHERE id = ?').get(id);
      const next = p.balance_cents + body.amountCents;
      if (next < 0) return Response.json({ error: 'balance cannot go below zero' }, { status: 400 });
      DB.raw.prepare('UPDATE players SET balance_cents = ? WHERE id = ?').run(next, id);
      return Response.json({ balanceCents: next });
    } }) },
  };
  let cookie = null;
  const call = async (method, path, body, { origin = ORIGIN, useCookie = true } = {}) => {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}),
      ...(useCookie && cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
    const set = res.headers.get('Set-Cookie'); if (set) cookie = set.split(';')[0];
    const type = res.headers.get('Content-Type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  const addAdmin = async (email, role) => {
    DB.raw.prepare('INSERT INTO admins (email, name, role) VALUES (?, ?, ?)').run(email, email.split('@')[0], role);
    const id = DB.raw.prepare('SELECT id FROM admins WHERE email = ?').get(email).id;
    return makeSetupToken(DB, id);
  };
  const finishSetup = async (token, password = 'correct horse 42 battery') => {
    const pw = await call('POST', '/api/auth/setup/password', { token, password });
    assert.equal(pw.status, 200, JSON.stringify(pw.data));
    const code = await hotp(pw.data.secret, Math.floor(Date.now() / 30000));
    const done = await call('POST', '/api/auth/setup/code', { token, code });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    return pw.data.secret;
  };
  const seedPlayer = (id, extra = {}) => DB.raw.prepare(`INSERT INTO players (id, country, device, balance_cents, total_bet_cents, total_paid_cents, rounds) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, extra.country || 'GB', extra.device || 'mobile', extra.balance ?? 100000, extra.bet ?? 0, extra.paid ?? 0, extra.rounds ?? 0);
  // Demo rounds unless real = 1 (alerts only count real play).
  const seedRound = (id, player, stake, payout, when = null, real = 0) => DB.raw.prepare(`INSERT INTO rounds (id, player_id, game_id, math_id, config_version, stake_cents, payout_cents, outcome, bets_json, fairness_json, currency, real_money, country, device, created_at)
    VALUES (?, ?, 'roulette', 'standard', 1, ?, ?, '{"pocket":7,"color":"red"}', '[]', '{}', 'USDT', ?, 'GB', 'mobile', COALESCE(?, datetime('now')))`).run(id, player, stake, payout, real, when);
  return { DB, env, call, addAdmin, finishSetup, seedPlayer, seedRound, adjustments, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

test('owner setup needs a strong password and a working authenticator code, then signs in', async () => {
  const s = setup();
  const token = await s.addAdmin('dez@example.com', 'owner');
  assert.equal((await s.call('POST', '/api/auth/setup/info', { token })).data.email, 'dez@example.com');
  assert.equal((await s.call('POST', '/api/auth/setup/password', { token, password: 'short' })).status, 400);
  const pw = await s.call('POST', '/api/auth/setup/password', { token, password: 'correct horse 42 battery' });
  assert.match(pw.data.uri, /^otpauth:\/\/totp\/qu-BETICS%20Admin:dez%40example.com\?secret=/);
  assert.equal((await s.call('POST', '/api/auth/setup/code', { token, code: '000000' })).status, 400);
  const code = await hotp(pw.data.secret, Math.floor(Date.now() / 30000));
  assert.equal((await s.call('POST', '/api/auth/setup/code', { token, code })).status, 200);
  assert.equal((await s.call('GET', '/api/me')).data.admin.role, 'owner');
  // The setup link is single use.
  assert.equal((await s.call('POST', '/api/auth/setup/info', { token })).status, 400);
});

test('login requires password and code; wrong attempts lock out; logout ends the session', async () => {
  const s = setup();
  const secret = await s.finishSetup(await s.addAdmin('dez@example.com', 'owner'));
  await s.call('POST', '/api/auth/logout', {});
  assert.equal((await s.call('GET', '/api/me')).status, 401);
  assert.deepEqual((await s.call('POST', '/api/auth/login', { email: 'dez@example.com', password: 'correct horse 42 battery' })).data, { needCode: true });
  assert.equal((await s.call('POST', '/api/auth/login', { email: 'dez@example.com', password: 'nope', code: '123456' })).status, 401);
  // The setup code (this step) cannot sign in again (L7): the next code does.
  const reused = await s.call('POST', '/api/auth/login', { email: 'dez@example.com', password: 'correct horse 42 battery', code: await hotp(secret, Math.floor(Date.now() / 30000)) });
  assert.equal(reused.status, 401); assert.equal(reused.data.code, 'code_used');
  const code = await hotp(secret, Math.floor(Date.now() / 30000) + 1);
  assert.equal((await s.call('POST', '/api/auth/login', { email: 'DEZ@example.com', password: 'correct horse 42 battery', code })).status, 200);
  assert.equal((await s.call('GET', '/api/me')).status, 200);
  for (let i = 0; i < 5; i++) await s.call('POST', '/api/auth/login', { email: 'dez@example.com', password: 'wrong', code: '1' }, { useCookie: false });
  assert.equal((await s.call('POST', '/api/auth/login', { email: 'dez@example.com', password: 'correct horse 42 battery', code }, { useCookie: false })).status, 429);
});

test('state-changing requests from another site are refused', async () => {
  const s = setup();
  await s.finishSetup(await s.addAdmin('dez@example.com', 'owner'));
  assert.equal((await s.call('PUT', '/api/games/roulette', { enabled: false }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await s.call('PUT', '/api/games/roulette', { enabled: false }, { origin: null })).status, 403);
  assert.equal(s.DB.raw.prepare("SELECT enabled FROM games WHERE id='roulette'").get().enabled, 1);
});

test('game changes are validated, bump the config version and are audited', async () => {
  const s = setup();
  const secret = await s.finishSetup(await s.addAdmin('dez@example.com', 'owner'));
  assert.equal((await s.call('PUT', '/api/games/roulette', { mathId: 'nope' })).status, 400);
  assert.equal((await s.call('PUT', '/api/games/roulette', { minStakeCents: 500, maxStakeCents: 100 })).status, 400);
  const v0 = s.DB.raw.prepare("SELECT config_version FROM games WHERE id='roulette'").get().config_version;
  // L4: bet limits and the maths option need the password + a fresh code; on/off and the message do not.
  assert.equal((await s.call('PUT', '/api/games/roulette', { maxWinCents: 100000 })).data.code, 'bad_password');
  assert.equal((await s.call('PUT', '/api/games/roulette', { maintenanceMessage: 'Short break' })).status, 200);
  const r = await s.call('PUT', '/api/games/roulette', { enabled: false, maintenanceMessage: 'Back at 6pm', mathId: 'straight34', maxWinCents: 100000,
    password: 'correct horse 42 battery', code: await hotp(secret, Math.floor(Date.now() / 30000) + 1) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.changed.sort(), ['enabled', 'maintenanceMessage', 'mathId', 'maxWinCents'].sort());
  const g = s.DB.raw.prepare("SELECT * FROM games WHERE id='roulette'").get();
  assert.equal(g.enabled, 0); assert.equal(g.math_id, 'straight34'); assert.equal(g.config_version, v0 + 2);
  const a = s.DB.raw.prepare("SELECT * FROM admin_audit WHERE action = 'game.update' ORDER BY id DESC").get();
  assert.equal(JSON.parse(a.before_json).mathId, 'standard');
  assert.equal(JSON.parse(a.after_json).mathId, 'straight34');
  const detail = (await s.call('GET', '/api/games/roulette')).data;
  assert.equal(detail.math.length, 2);
});

test('roles: read only can look but not change; support can pause players but not ban or change balances', async () => {
  const s = setup();
  s.seedPlayer('p1');
  await s.finishSetup(await s.addAdmin('viewer@example.com', 'readonly'));
  assert.equal((await s.call('GET', '/api/overview?period=today')).status, 200);
  assert.equal((await s.call('PUT', '/api/games/roulette', { enabled: false })).status, 403);
  assert.equal((await s.call('POST', '/api/players/p1/status', { status: 'frozen', reason: 'checking' })).status, 403);
  assert.equal((await s.call('GET', '/api/settings')).data.admins, null);
  s.cookie = null;
  await s.finishSetup(await s.addAdmin('help@example.com', 'support'));
  assert.equal((await s.call('POST', '/api/players/p1/status', { status: 'frozen', reason: 'checking' })).status, 200);
  assert.equal((await s.call('POST', '/api/players/p1/status', { status: 'banned', reason: 'fraud' })).status, 403);
  assert.equal((await s.call('POST', '/api/players/p1/adjust', { amountCents: 100, reason: 'nice' })).status, 404);
  assert.equal((await s.call('POST', '/api/admins', { email: 'x@y.z', name: 'x', role: 'owner' })).status, 403);
  assert.equal(s.adjustments.length, 0);
});

test('balance adjustments are gone: even an owner gets 404 and the wallet is never asked', async () => {
  const s = setup();
  s.seedPlayer('p1', { balance: 1000 });
  await s.finishSetup(await s.addAdmin('dez@example.com', 'owner'));
  assert.equal((await s.call('POST', '/api/players/p1/adjust', { amountCents: 2500, reason: 'goodwill credit' })).status, 404);
  assert.equal(s.adjustments.length, 0);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action LIKE 'player.adjust%'").get().n, 0);
});

test('overview adds up money correctly and separates periods', async () => {
  const s = setup();
  s.seedPlayer('p1'); s.seedPlayer('p2', { country: 'TR', device: 'desktop' });
  s.seedRound('r1', 'p1', 1000, 0); s.seedRound('r2', 'p2', 1000, 3600); s.seedRound('r3', 'p1', 500, 1000);
  s.seedRound('old', 'p1', 99999, 0, '2020-01-01 00:00:00');
  await s.finishSetup(await s.addAdmin('dez@example.com', 'owner'));
  // These are demo rounds: the Real view shows none of them, the Demo view all of them.
  const real = (await s.call('GET', '/api/overview?period=today')).data;
  assert.equal(real.realMoney, true);
  assert.equal(real.now.betCents, 0);
  assert.equal(real.live.length, 0);
  const o = (await s.call('GET', '/api/overview?period=today&money=play')).data;
  assert.equal(o.realMoney, false);
  assert.equal(o.now.betCents, 2500);
  assert.equal(o.now.paidCents, 4600);
  assert.equal(o.now.profitCents, -2100);
  assert.equal(o.now.players, 2);
  assert.equal(o.now.rtp, 184);
  assert.equal(o.live.length, 4);
  const csv = await s.call('GET', '/api/money.csv?period=all&group=month&money=play');
  assert.match(csv.data, /^period,game,rounds,players,bet_tics,paid_out_tics,house_profit_tics\n/);
  assert.match(csv.data, /2020-01,roulette,1,1,999.99,0.00,999.99/);
});

test('alerts: big wins, players far up and daily losses are raised once and sent to Telegram once', async () => {
  const s = setup();
  // Alert limits are in 0.01 TICS units (migration 0003): big win 200,000 TICS, daily loss 1,000,000 TICS.
  s.seedPlayer('p1', { bet: 1000, paid: 200000000 });
  s.seedRound('r1', 'p1', 1000, 200000000, null, 1);
  const n1 = await runChecks(s.DB);
  const types = s.DB.raw.prepare('SELECT type FROM alerts ORDER BY type').all().map(a => a.type);
  assert.deepEqual(types, ['big_win', 'daily_loss', 'game_loss', 'player_up']);
  s.DB.raw.prepare("UPDATE settings SET value = '\"2000-01-01 00:00:00\"' WHERE key = 'alerts_mark'").run();
  await runChecks(s.DB);
  assert.equal(s.DB.raw.prepare('SELECT COUNT(*) AS n FROM alerts').get().n, 4, 'no duplicates');
  const sent = [];
  const fake = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{}'); };
  assert.equal(await sendTelegram(s.DB, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '42' }, fake), 4);
  assert.equal(await sendTelegram(s.DB, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '42' }, fake), 0);
  assert.equal(sent[0].chat_id, '42');
  assert.ok(n1 >= 4);
});

test('messages: audience preview, immediate delivery to chosen players, scheduled send and trigger permissions', async () => {
  const s = setup();
  s.seedPlayer('p1'); s.seedPlayer('p2'); s.seedPlayer('p3', { country: 'TR' });
  s.DB.raw.prepare("UPDATE players SET status = 'banned' WHERE id = 'p2'").run();
  await s.finishSetup(await s.addAdmin('dez@example.com', 'owner'));
  assert.equal((await s.call('POST', '/api/messages/audience', { audience: { type: 'all' } })).data.count, 2);
  assert.equal((await s.call('POST', '/api/messages/audience', { audience: { type: 'segment', filters: { country: 'tr' } } })).data.count, 1);
  const now = await s.call('POST', '/api/messages', { title: 'Welcome', body: 'Hello there', audience: { type: 'players', ids: ['p1', 'p2'] }, buttonUrl: '/', buttonLabel: 'Play' });
  assert.equal(now.data.delivered, 1, 'banned players never receive messages');
  assert.equal((await s.call('POST', '/api/messages', { title: 'Bad', body: 'link', audience: { type: 'all' }, buttonUrl: 'javascript:alert(1)' })).status, 400);
  const later = await s.call('POST', '/api/messages', { title: 'Soon', body: 'Promo', audience: { type: 'all' }, trigger: 'scheduled', sendAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(later.data.status, 'active');
  s.DB.raw.prepare("UPDATE messages SET send_at = datetime('now','-1 minute') WHERE id = ?").run(later.data.id);
  assert.equal(await sendScheduled(s.DB), 1);
  assert.equal(s.DB.raw.prepare('SELECT COUNT(*) AS n FROM message_deliveries WHERE message_id = ?').get(later.data.id).n, 2);
  s.cookie = null;
  await s.finishSetup(await s.addAdmin('help@example.com', 'support'));
  assert.equal((await s.call('POST', '/api/messages', { title: 'Auto', body: 'Hi', audience: { type: 'all' }, trigger: 'wallet_connect' })).status, 403);
  assert.equal((await s.call('POST', '/api/messages', { title: 'Now', body: 'Hi', audience: { type: 'all' } })).status, 200);
});

test('the last owner cannot be removed, and real money mode stays locked until payments exist', async () => {
  const s = setup();
  const secret = await s.finishSetup(await s.addAdmin('dez@example.com', 'owner'));
  const me = (await s.call('GET', '/api/me')).data.admin;
  assert.equal((await s.call('PUT', `/api/admins/${me.id}`, { role: 'readonly' })).status, 400);
  assert.equal((await s.call('PUT', '/api/settings/mode', { mode: 'real' })).status, 400);
  const made = await s.call('POST', '/api/admins', { email: 'fin@example.com', name: 'Fin', role: 'finance', password: 'correct horse 42 battery', code: await hotp(secret, Math.floor(Date.now() / 30000) + 1) });
  assert.match(made.data.setupLink, /^https:\/\/admin\.betics\.io\/#\/setup\/[a-f0-9]{48}$/);
  assert.equal((await s.call('PUT', '/api/settings/currency', { symbol: 'USDC', name: 'USD Coin', contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, usdRate: 1, confirm: 'nope' })).status, 400);
  assert.equal((await s.call('PUT', '/api/settings/currency', { symbol: 'USDC', name: 'USD Coin', network: 'ethereum', contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, usdRate: 1, confirm: 'USDC' })).status, 200);
});

test('every response carries strict security headers', async () => {
  const s = setup();
  const res = await s.call('GET', '/');
  assert.match(res.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.equal((await s.call('GET', '/api/overview')).status, 401);
});

import { bank, rawToCents } from '../src/api/bank.js';
import { checkBank } from '../src/api/alerts.js';

test('bank: on-chain balances convert exactly and the cover check is right', async () => {
  assert.equal(rawToCents('0x' + (1234567891n).toString(16), 6), 123456); // 1,234.567891 USDT -> 1234.56
  assert.equal(rawToCents('0x0', 6), 0);
  const s = setup();
  const secret = await s.finishSetup(await s.addAdmin('dez@example.com', 'owner'));
  assert.equal((await s.call('PUT', '/api/bank', { wallets: [{ label: 'Hot', address: '0x123' }] })).status, 400);
  const hot = { wallets: [{ label: 'Hot wallet', chain: 'ethereum', address: '0xF977814e90dA44bFA03b6295A0616a897441aceC' }], reservePct: 20 };
  assert.equal((await s.call('PUT', '/api/bank', hot)).data.code, 'bad_password', 'L4: bank settings need the step-up');
  assert.equal((await s.call('PUT', '/api/bank', { ...hot, password: 'correct horse 42 battery', code: await hotp(secret, Math.floor(Date.now() / 30000) + 1) })).status, 200);
  // Real money owed: one player with a real-money ledger balance of $1,000.
  s.seedPlayer('p9'); s.DB.raw.prepare("UPDATE players SET real_balance_cents = 80000 WHERE id = 'p9'").run();
  s.DB.raw.prepare(`INSERT INTO withdrawals (id, player_id, amount_cents, network, currency, address, status) VALUES ('w1','p9',20000,'tron','USDT','Tx','requested')`).run();
  const chain = held => async (url, init) => { const b = JSON.parse(init.body); return Response.json({ result: b.method === 'eth_call' ? '0x' + (BigInt(held) * 10n ** 16n).toString(16) : '0x0' }); };
  let b = await bank(s.DB, {}, { fetchImpl: chain(110000), now: 1 });
  assert.equal(b.owedCents, 100000); assert.equal(b.heldCents, 110000); assert.equal(b.state, 'low'); assert.equal(b.topUpCents, 10000);
  b = await bank(s.DB, {}, { fetchImpl: chain(150000), now: 20001 });
  assert.equal(b.state, 'healthy'); assert.equal(b.spareCents, 30000);
  b = await bank(s.DB, {}, { fetchImpl: chain(90000), now: 40001 });
  assert.equal(b.state, 'short');
  assert.equal(await checkBank(s.DB, {}, { fetchImpl: chain(90000), now: 40001 }), 'short');
  assert.equal(s.DB.raw.prepare("SELECT severity FROM alerts WHERE type = 'bank_low'").get().severity, 'critical');
  // Support cannot change bank settings.
  s.cookie = null;
  await s.finishSetup(await s.addAdmin('help@example.com', 'support'));
  assert.equal((await s.call('PUT', '/api/bank', { reservePct: 0 })).status, 403);
});

test('withdrawals: finance approves and records the transaction; reject returns the money; support cannot touch them', async () => {
  const s = setup();
  s.seedPlayer('p1');
  const add = (id, amount) => s.DB.raw.prepare(`INSERT INTO withdrawals (id, player_id, amount_cents, fee_cents, network, currency, address, status) VALUES (?, 'p1', ?, 100, 'tron', 'USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'requested')`).run(id, amount);
  add('w-ok', 5000); add('w-no', 3000);
  await s.finishSetup(await s.addAdmin('help@example.com', 'support'));
  assert.equal((await s.call('POST', '/api/withdrawals/w-ok', { action: 'approve' })).status, 403);
  s.cookie = null;
  await s.finishSetup(await s.addAdmin('fin@example.com', 'finance'));
  const queue = (await s.call('GET', '/api/payments')).data;
  assert.equal(queue.withdrawals.length, 2);
  assert.equal(queue.totals.pending_cents, 8000);
  assert.equal((await s.call('POST', '/api/withdrawals/w-ok', { action: 'approve' })).data.withdrawal.status, 'approved');
  assert.equal((await s.call('POST', '/api/withdrawals/w-ok', { action: 'sent', txHash: 'nope' })).status, 400);
  const sent = await s.call('POST', '/api/withdrawals/w-ok', { action: 'sent', txHash: 'a'.repeat(64) });
  assert.equal(sent.data.withdrawal.status, 'sent');
  assert.equal((await s.call('POST', '/api/withdrawals/w-ok', { action: 'reject', reason: 'too late' })).status, 400, 'a sent withdrawal cannot be rejected');
  assert.equal((await s.call('POST', '/api/withdrawals/w-no', { action: 'reject' })).status, 400, 'reason required');
  const rej = await s.call('POST', '/api/withdrawals/w-no', { action: 'reject', reason: 'Address looks wrong, please check it' });
  assert.equal(rej.data.withdrawal.status, 'rejected');
  assert.equal(s.adjustments.at(-1).path, '/internal/withdraw-release');
  assert.equal(s.adjustments.at(-1).body.ref, 'wdr:w-no');
  assert.equal(s.DB.raw.prepare("SELECT real_balance_cents FROM players WHERE id='p1'").get().real_balance_cents, 3000);
  assert.deepEqual(s.DB.raw.prepare("SELECT action FROM admin_audit WHERE action LIKE 'withdrawal.%' ORDER BY id").all().map(a => a.action), ['withdrawal.approve', 'withdrawal.sent', 'withdrawal.reject_intent', 'withdrawal.reject']);
  // Finance cannot open payments; that is owner only.
  assert.equal((await s.call('PUT', '/api/payments/settings', { withdrawalsOpen: true })).status, 403);
  await runChecks(s.DB);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM alerts WHERE type = 'withdrawal_request'").get().n, 0, 'none left waiting');
});

test('admin panel code is only sent to a signed-in admin; the sign-in page loads for anyone', async () => {
  const s = setup();
  const served = [];
  s.env.ASSETS = { fetch: async (req) => { served.push(new URL(req.url).pathname); return new Response('// file', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' } }); } };
  for (const p of ['/', '/index.html', '/styles.css', '/robots.txt', '/js/signin.js', '/js/signin-core.js', '/js/views/auth.js', '/js/qr.js', '/js/theme-boot.js']) {
    assert.equal((await s.call('GET', p, null, { useCookie: false })).status, 200, p);
  }
  const before = served.length;
  for (const p of ['/js/app.js', '/js/lib.js', '/js/views/overview.js', '/js/views/tics.js', '/js/charts.js', '/js//app.js', '/js/./app.js', '/%6As/app.js', '/js/%61pp.js', '/JS/app.js', '/js/views/../app.js', '/anything', '/js/views/auth.js/../overview.js']) {
    const r = await s.call('GET', p, null, { useCookie: false });
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get('Cache-Control'), 'no-store', p);
  }
  assert.equal(served.length, before, 'no protected file was read for a stranger');
  // A forged cookie gets nothing either.
  s.cookie = 'noir_admin=forged';
  assert.equal((await s.call('GET', '/js/app.js')).status, 404);
  assert.equal((await s.call('POST', '/js/app.js', {}, {})).status, 404);
  // A real signed-in admin gets the panel, never cached by anyone else.
  s.cookie = null;
  const token = await s.addAdmin('gate@example.com', 'owner');
  await s.finishSetup(token);
  const ok = await s.call('GET', '/js/app.js');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(ok.headers.get('X-Frame-Options'), 'DENY');
  assert.equal((await s.call('GET', '/js/views/overview.js')).status, 200);
});
