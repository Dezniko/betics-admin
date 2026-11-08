// Re-audit 3 (2026-10-30) regression tests: critical alerts reach Telegram before anyone can resolve
// them, assigning a deposit needs step-up and never pays twice, only owners close critical alerts,
// a reactivated owner waits 48 hours, money settings need step-up, an owner on a new network is not
// locked out of codes, bad ids are 400, strangers cannot map the API, treasury sends carry the
// treasury secret.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createD1 } from './d1shim.mjs';
import worker from '../src/index.js';
import { hotp } from '../src/totp.js';
import { makeSetupToken, DAILY_CODE_LIMIT } from '../src/auth.js';
import { sendTelegram } from '../src/api/alerts.js';

const MIGRATION = new URL('./schema.sql', import.meta.url).pathname;
const ORIGIN = 'https://admin.betics.io';
const PASSWORD = 'correct horse 42 battery';
const A1 = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const A2 = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const TREASURY = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';
const TX = '0x' + 'ab'.repeat(32);
const step = () => Math.floor(Date.now() / 30000);

function setup({ float = 10_000_000, telegram = false, safe = null } = {}) {
  const DB = createD1([MIGRATION]);
  if (float != null) DB.raw.prepare("INSERT INTO chain_state (key, value) VALUES ('float', ?)").run(JSON.stringify({ at: Date.now(), chainId: 1, wallet: A2, tokenUnits: float, safeTokenUnits: safe ?? float, safeUnknown: false, ethWei: '1' }));
  const payoutCalls = [], walletCalls = [], credited = new Set();
  const env = {
    DB, SESSION_PEPPER: 'pepper', INTERNAL_SECRET: 'secret', TREASURY_SECRET: 'treasury-secret',
    ...(telegram ? { TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: '1' } : {}),
    ASSETS: { fetch: async () => new Response('PANEL', { headers: { 'Content-Type': 'text/javascript' } }) },
    // walletMode: 'ok' | 'throw' (reply lost after crediting) | '500' (credited, then an error) | '400' (refused, nothing credited)
    walletMode: 'ok',
    WALLETS: { idFromName: n => n, get: id => ({ fetch: async req => {
      const body = await req.json();
      walletCalls.push({ id, body });
      if (env.walletMode === '400') return Response.json({ error: 'refused' }, { status: 400 });
      const dup = credited.has(body.ref);
      credited.add(body.ref);
      if (env.walletMode === 'throw') throw new Error('connection lost');
      if (env.walletMode === '500') return Response.json({ error: 'boom' }, { status: 500 });
      return Response.json({ duplicate: dup, realTicsCents: body.amountCents });
    } }) },
    PAYOUTS: { fetch: async req => {
      const path = new URL(req.url).pathname;
      payoutCalls.push({ path, body: req.method === 'POST' ? await req.json() : null, secret: req.headers.get('X-Internal-Secret'), treasurySecret: req.headers.get('X-Treasury-Secret') });
      return Response.json({ ok: true });
    } },
  };
  let cookie = null, device = null;
  const call = async (method, path, body, { ip = '1.1.1.1', keepCookie = true, device: sendDevice = true, cookie: forced } = {}) => {
    const jar = forced ?? [cookie, sendDevice ? device : null].filter(Boolean).join('; ');
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: ORIGIN, 'User-Agent': 'test-browser', 'CF-Connecting-IP': ip,
      ...(jar ? { Cookie: jar } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
    if (keepCookie) for (const set of res.headers.getSetCookie()) {
      const pair = set.split(';')[0];
      if (pair.startsWith('__Host-admin_device=')) { if (sendDevice) device = pair; } else cookie = pair;
    }
    const type = res.headers.get('Content-Type') || '';
    const raw = await res.text();
    return { status: res.status, raw, data: type.includes('json') ? JSON.parse(raw) : raw };
  };
  const admin = async (email, role, { fresh = false } = {}) => {
    DB.raw.prepare('INSERT INTO admins (email, name, role) VALUES (?, ?, ?)').run(email, email.split('@')[0], role);
    const id = DB.raw.prepare('SELECT id FROM admins WHERE email = ?').get(email).id;
    const token = await makeSetupToken(DB, id);
    cookie = null;
    const pw = await call('POST', '/api/auth/setup/password', { token, password: PASSWORD });
    const st = step();
    const done = await call('POST', '/api/auth/setup/code', { token, code: await hotp(pw.data.secret, st) });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    if (!fresh) DB.raw.prepare('UPDATE admins SET treasury_ok_after = NULL WHERE id = ?').run(id);
    return { id, email, secret: pw.data.secret, code: d => hotp(pw.data.secret, st + d), cookie, device };
  };
  const resetCodes = () => DB.raw.prepare("UPDATE settings SET value = '{}' WHERE key = 'admin_totp_steps'").run();
  const stepUp = async a => { resetCodes(); DB.raw.prepare("DELETE FROM admin_login_attempts WHERE key LIKE 'confirm:%' OR key LIKE 'codes:%'").run(); return { password: PASSWORD, code: await a.code(1) }; };
  const setTics = obj => DB.raw.prepare(`INSERT INTO settings (key, value) VALUES ('tics_payments', ?) ON CONFLICT(key) DO UPDATE SET value = json_patch(value, excluded.value)`).run(JSON.stringify(obj));
  const tics = () => JSON.parse(DB.raw.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").get()?.value || '{}');
  const alerts = type => DB.raw.prepare('SELECT * FROM alerts WHERE type = ? ORDER BY id').all(type);
  const player = id => DB.raw.prepare('INSERT INTO players (id, wallet_address, country) VALUES (?, ?, ?)').run(id, id, 'DE');
  return { DB, env, call, admin, resetCodes, stepUp, setTics, tics, alerts, player, payoutCalls, walletCalls,
    set cookie(v) { cookie = v; }, get cookie() { return cookie; }, set device(v) { device = v; }, get device() { return device; } };
}

// Telegram calls made by the code under test (global fetch), recorded instead of sent.
async function withTelegram(fn) {
  const sent = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.telegram.org/')) { sent.push(JSON.parse(init.body).text); return Response.json({ ok: true }); }
    return real(url, init);
  };
  try { await fn(sent); } finally { globalThis.fetch = real; }
}

// ---------- F1: critical alerts go out at once, and even when resolved first ----------
test('F1: the treasury-change alert is sent to Telegram during the request, before anyone can resolve it', async () => {
  await withTelegram(async sent => {
    const s = setup({ telegram: true });
    const own = await s.admin('dez@example.com', 'owner');
    s.DB.raw.prepare('UPDATE alerts SET telegram_sent = 1').run();
    sent.length = 0;
    const r = await s.call('PUT', '/api/tics/treasury/address', { address: TREASURY, ...(await s.stepUp(own)) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const [a] = s.alerts('tics_treasury_changed');
    assert.equal(a.telegram_sent, 1, 'pushed while the request ran');
    assert.equal(sent.filter(t => /treasury address was changed/.test(t)).length, 1);
  });
});

test('F1: a critical alert resolved before Telegram ran is still sent, once; resolved warnings are not', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  s.DB.raw.prepare('UPDATE alerts SET telegram_sent = 1').run();
  // No Telegram on the request (not set up here), then the owner (or an attacker with the session) resolves it.
  assert.equal((await s.call('PUT', '/api/tics/treasury/address', { address: TREASURY, ...(await s.stepUp(own)) })).status, 200);
  const [a] = s.alerts('tics_treasury_changed');
  assert.equal(a.telegram_sent, 0);
  assert.equal((await s.call('POST', `/api/alerts/${a.id}/resolve`)).status, 200);
  s.DB.raw.prepare("INSERT INTO alerts (type, severity, title, dedupe_key, status) VALUES ('big_win', 'warning', 'w', 'w1', 'resolved')").run();
  s.DB.raw.prepare("INSERT INTO alerts (type, severity, title, dedupe_key, status, created_at) VALUES ('admin_setup', 'critical', 'old', 'old1', 'resolved', '2020-01-01 00:00:00')").run();
  const texts = [];
  const fake = async (url, init) => { texts.push(JSON.parse(init.body).text); return new Response('{}'); };
  const tg = { ...s.env, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' };
  assert.equal(await sendTelegram(s.DB, tg, fake), 1);
  assert.match(texts[0], /treasury address was changed/);
  assert.match(texts[0], /Already marked resolved by dez@example\.com/);
  assert.equal(s.alerts('tics_treasury_changed')[0].telegram_sent, 1);
  assert.equal(await sendTelegram(s.DB, tg, fake), 0, 'sent once only');
  assert.equal(s.alerts('big_win')[0].telegram_sent, 0, 'a resolved warning stays unsent');
});

test('F1: treasury send, return to player and resuming payouts raise critical alerts that go out during the request', async () => {
  await withTelegram(async sent => {
    const s = setup({ telegram: true });
    const own = await s.admin('dez@example.com', 'owner');
    s.setTics({ treasuryAddress: A1, casinoWallet: A2, payoutsPaused: true, pausedReason: 'check' });
    sent.length = 0;
    assert.equal((await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1000, code: (await s.stepUp(own)).code })).status, 200);
    assert.equal(s.alerts('tics_treasury_send').length, 1);
    assert.equal(s.alerts('tics_treasury_send')[0].severity, 'critical');
    assert.equal(s.alerts('tics_treasury_send')[0].telegram_sent, 1);
    assert.equal((await s.call('POST', '/api/tics/payouts/pause', { paused: false, ...(await s.stepUp(own)) })).status, 200);
    assert.equal(s.alerts('tics_payouts_resumed')[0].telegram_sent, 1);
    s.DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at)
      VALUES ('33333333-3333-4333-8333-333333333333', 'player', ?, 1, ?, 5000, 0, 5000, 'blocked', datetime('now'))`).run(A1, A1);
    const rel = await s.call('POST', '/api/tics/withdrawals/33333333-3333-4333-8333-333333333333/release', await s.stepUp(own));
    assert.equal(rel.status, 200, JSON.stringify(rel.data));
    assert.equal(s.alerts('tics_withdrawal_returned')[0].telegram_sent, 1);
    assert.ok(sent.some(t => /Treasury send started/.test(t)) && sent.some(t => /resumed/.test(t)) && sent.some(t => /returned to the player/.test(t)));
  });
});

// ---------- F2: assigning a deposit ----------
function deposit(s, id = `1:${TX}:3`) {
  s.DB.raw.prepare(`INSERT INTO chain_deposits (id, chain_id, tx_hash, log_index, block_number, from_address, to_address, amount_wei, amount_units, status)
    VALUES (?, 1, ?, 3, 21000000, ?, ?, '250000000000000000000', 25000, 'unmatched')`).run(id, TX, A2, A2);
  return { id, path: `/api/tics/deposits/${encodeURIComponent(id)}/assign` };
}

test('F2: assigning a deposit needs the password and a fresh code', async () => {
  const s = setup();
  s.player(A1);
  const { id, path } = deposit(s);
  const own = await s.admin('dez@example.com', 'owner');
  assert.equal((await s.call('POST', path, { address: A1, note: 'their email' })).status, 401);
  assert.equal((await s.call('POST', path, { address: A1, note: 'their email', code: (await s.stepUp(own)).code })).data.code, 'bad_password', 'code alone is not enough');
  assert.equal(s.walletCalls.length, 0);
  assert.equal(s.DB.raw.prepare('SELECT status FROM chain_deposits WHERE id = ?').get(id).status, 'unmatched');
  const ok = await s.call('POST', path, { address: A1, note: 'their email', ...(await s.stepUp(own)) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(s.walletCalls.length, 1);
});

for (const mode of ['throw', '500']) test(`F2: a lost wallet answer (${mode}) keeps the deposit with that player; another wallet cannot get it, a retry for the same player credits once`, async () => {
  const s = setup();
  s.player(A1); s.player(A2);
  const { id, path } = deposit(s);
  const own = await s.admin('dez@example.com', 'owner');
  s.env.walletMode = mode;
  const lost = await s.call('POST', path, { address: A1, note: 'their email', ...(await s.stepUp(own)) });
  assert.equal(lost.status, 502);
  assert.equal(lost.data.error, 'We could not confirm the credit. Try again for the same player.');
  assert.equal(lost.data.code, 'credit_unconfirmed');
  let row = s.DB.raw.prepare('SELECT * FROM chain_deposits WHERE id = ?').get(id);
  assert.equal(row.status, 'assigned'); assert.equal(row.player_id, A1); assert.equal(row.credited_at, null);
  s.env.walletMode = 'ok';
  // Someone tries to give it to a different wallet: refused before any code is asked or any credit made.
  const other = await s.call('POST', path, { address: A2, note: 'actually theirs', ...(await s.stepUp(own)) });
  assert.equal(other.status, 409); assert.equal(other.data.code, 'assigned_other');
  assert.equal(s.walletCalls.filter(c => c.id === A2).length, 0, 'never credited to a second wallet');
  // Retry for the same player: the wallet sees the same ref, so it is not paid twice.
  const retry = await s.call('POST', path, { address: A1, note: 'their email', ...(await s.stepUp(own)) });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.duplicate, true, 'the first try had already credited it');
  assert.deepEqual([...new Set(s.walletCalls.map(c => c.body.ref))], [`td:1-${TX}-3`]);
  row = s.DB.raw.prepare('SELECT * FROM chain_deposits WHERE id = ?').get(id);
  assert.ok(row.credited_at);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'tics.deposit_assign_unconfirmed'").get().n, 1);
});

test('F2: a clear wallet refusal (4xx) puts the deposit back to unmatched', async () => {
  const s = setup();
  s.player(A1);
  const { id, path } = deposit(s);
  const own = await s.admin('dez@example.com', 'owner');
  s.env.walletMode = '400';
  const r = await s.call('POST', path, { address: A1, note: 'their email', ...(await s.stepUp(own)) });
  assert.equal(r.status, 502); assert.match(r.data.error, /Nothing was changed/);
  assert.equal(s.DB.raw.prepare('SELECT status, player_id FROM chain_deposits WHERE id = ?').get(id).status, 'unmatched');
});

// ---------- F3: only owners close critical alerts ----------
test('F3: support can resolve warnings but not critical alerts; owners can', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  s.DB.raw.prepare("INSERT INTO alerts (type, severity, title, dedupe_key) VALUES ('admin_codes_locked', 'critical', 'c', 'c1'), ('big_win', 'warning', 'w', 'w1')").run();
  const crit = s.DB.raw.prepare("SELECT id FROM alerts WHERE dedupe_key = 'c1'").get().id, warn = s.DB.raw.prepare("SELECT id FROM alerts WHERE dedupe_key = 'w1'").get().id;
  await s.admin('help@example.com', 'support');
  const r = await s.call('POST', `/api/alerts/${crit}/resolve`);
  assert.equal(r.status, 403); assert.equal(r.data.code, 'forbidden');
  assert.equal(s.DB.raw.prepare('SELECT status FROM alerts WHERE id = ?').get(crit).status, 'open');
  assert.equal((await s.call('POST', `/api/alerts/${warn}/resolve`)).status, 200);
  s.cookie = own.cookie;
  assert.equal((await s.call('POST', `/api/alerts/${crit}/resolve`)).status, 200);
  assert.equal(s.DB.raw.prepare('SELECT status FROM alerts WHERE id = ?').get(crit).status, 'resolved');
});

// ---------- F4: a reactivated owner waits 48 hours ----------
test('F4: switching an owner back on restarts the 48 hour treasury wait and alerts', async () => {
  const s = setup();
  const a = await s.admin('a@example.com', 'owner');
  const b = await s.admin('b@example.com', 'owner');
  s.cookie = a.cookie;
  assert.equal((await s.call('PUT', `/api/admins/${b.id}`, { active: false, ...(await s.stepUp(a)) })).status, 200);
  assert.equal(s.DB.raw.prepare('SELECT treasury_ok_after FROM admins WHERE id = ?').get(b.id).treasury_ok_after, null);
  assert.equal((await s.call('PUT', `/api/admins/${b.id}`, { active: true, ...(await s.stepUp(a)) })).status, 200);
  const after = s.DB.raw.prepare('SELECT treasury_ok_after FROM admins WHERE id = ?').get(b.id).treasury_ok_after;
  assert.ok(after, 'wait set');
  const ms = Date.parse(after.replace(' ', 'T') + 'Z') - Date.now();
  assert.ok(ms > 47 * 3600e3 && ms <= 48 * 3600e3, String(ms));
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM alerts WHERE dedupe_key LIKE 'admin_owner_reactivated:%' AND severity = 'critical'").get().n, 1);
  // b signs in again and tries a treasury send: refused until the wait is over.
  s.setTics({ treasuryAddress: A1, casinoWallet: A2 });
  s.cookie = null;
  s.resetCodes();
  assert.equal((await s.call('POST', '/api/auth/login', { email: b.email, password: PASSWORD, code: await b.code(1) })).status, 200);
  const send = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 100, code: await b.code(2) });
  assert.equal(send.status, 403); assert.equal(send.data.code, 'owner_too_new');
  // Reactivating a non-owner sets no wait.
  const f = await s.admin('f@example.com', 'finance');
  s.cookie = a.cookie;
  assert.equal((await s.call('PUT', `/api/admins/${f.id}`, { active: false, ...(await s.stepUp(a)) })).status, 200);
  assert.equal((await s.call('PUT', `/api/admins/${f.id}`, { active: true, ...(await s.stepUp(a)) })).status, 200);
  assert.equal(s.DB.raw.prepare('SELECT treasury_ok_after FROM admins WHERE id = ?').get(f.id).treasury_ok_after, null);
});

// ---------- F5: money settings need step-up ----------
test('F5: legacy USDT payment settings need the password and a fresh code', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  assert.equal((await s.call('PUT', '/api/payments/settings', { withdrawalFeeCents: 50 })).status, 401);
  const fee = () => JSON.parse(s.DB.raw.prepare("SELECT value FROM settings WHERE key = 'payments'").get()?.value || '{}').withdrawalFeeCents;
  assert.notEqual(fee(), 50, 'not saved');
  const ok = await s.call('PUT', '/api/payments/settings', { withdrawalFeeCents: 50, ...(await s.stepUp(own)) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.withdrawalFeeCents, 50); assert.equal(fee(), 50);
  assert.equal(ok.data.code, undefined, 'the code is not stored');
  assert.equal((await s.call('PUT', '/api/payments/settings', { withdrawalFeeCents: 50 })).status, 200, 'unchanged: nothing to confirm');
  assert.equal((await s.call('PUT', '/api/payments/settings', { minWithdrawalCents: 1 })).status, 400, 'still validated before asking');
});

test('F5: fee on/off on the Fees page needs step-up', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  assert.equal((await s.call('PUT', '/api/tics/fees', { feesEnabled: false })).status, 401);
  assert.equal((await s.call('PUT', '/api/tics/fees', { feesEnabled: false, ...(await s.stepUp(own)) })).status, 200);
  assert.equal(s.tics().feesEnabled, false);
});

// ---------- F6: owner on a new network is not locked out of codes ----------
test('F6: with the other pool used up, the owner signs in from a new network in their own browser; a password-only attacker stays locked', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  const ownerDevice = s.device;
  // The attacker (password only, other networks, no device cookie) used up the untrusted pool.
  for (let i = 0; i < DAILY_CODE_LIMIT; i++) s.DB.raw.prepare('INSERT INTO admin_login_attempts (key, created_at) VALUES (?, datetime(\'now\'))').run(`codes:${own.id}`);
  s.resetCodes(); s.cookie = null;
  const attacker = await s.call('POST', '/api/auth/login', { email: own.email, password: PASSWORD, code: await own.code(1) }, { ip: '8.8.8.8', device: false, keepCookie: false });
  assert.equal(attacker.status, 429); assert.equal(attacker.data.code, 'codes_locked');
  const forged = await s.call('POST', '/api/auth/login', { email: own.email, password: PASSWORD, code: await own.code(1) },
    { ip: '8.8.4.4', keepCookie: false, cookie: `__Host-admin_device=${'a'.repeat(32)}.${'b'.repeat(32)}` });
  assert.equal(forged.status, 429, 'a forged device cookie does not count');
  // The owner, travelling (new network), with this browser's signed device cookie.
  assert.ok(ownerDevice);
  const owner = await s.call('POST', '/api/auth/login', { email: own.email, password: PASSWORD, code: await own.code(1) }, { ip: '7.7.7.7', keepCookie: false, cookie: ownerDevice });
  assert.equal(owner.status, 200, JSON.stringify(owner.data));
  // The attacker's pool is still full afterwards.
  s.resetCodes();
  assert.equal((await s.call('POST', '/api/auth/login', { email: own.email, password: PASSWORD, code: await own.code(2) }, { ip: '8.8.8.9', device: false, keepCookie: false })).status, 429);
});

// ---------- F7: bad ids ----------
test('F7: a path id with a broken %-escape is a 400, not a 500', async () => {
  const s = setup();
  await s.admin('dez@example.com', 'owner');
  for (const [m, p] of [['POST', '/api/tics/withdrawals/%E0%A4%A/cancel'], ['POST', '/api/tics/withdrawals/%E0%A4%A/release'], ['POST', '/api/tics/deposits/%ZZ/assign'], ['GET', '/api/rounds/%E0%A4%A']]) {
    const r = await s.call(m, p, m === 'POST' ? {} : undefined);
    assert.equal(r.status, 400, `${m} ${p} ${r.raw}`);
    assert.equal(r.data.code, 'bad_id');
  }
});

// ---------- F8: strangers cannot map the API ----------
test('F8: strangers get 401 for known and unknown API paths alike; sign-in and setup routes still work; admins get 404', async () => {
  const s = setup();
  for (const [m, p] of [['GET', '/api/overview'], ['GET', '/api/nope'], ['GET', '/api/tics/secret-route'], ['POST', '/api/tics/nope'], ['GET', '/api/'], ['GET', '/api/auth/login'], ['PUT', '/api/me']]) {
    const r = await s.call(m, p, m === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.data.code, 'signed_out');
  }
  assert.equal((await s.call('POST', '/api/auth/setup/info', { token: 'x' })).status, 400, 'setup route open to strangers');
  assert.equal((await s.call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever 1' })).status, 401);
  assert.equal((await s.call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever 1' })).data.code, 'bad_login');
  assert.equal((await s.call('POST', '/api/auth/logout', {})).status, 200);
  // The panel's static files stay gated for strangers; the sign-in files load.
  assert.equal((await s.call('GET', '/js/app.js')).status, 404);
  assert.equal((await s.call('GET', '/js/signin.js')).status, 200);
  await s.admin('dez@example.com', 'owner');
  assert.equal((await s.call('GET', '/api/nope')).status, 404);
  assert.equal((await s.call('GET', '/js/app.js')).status, 200);
});

// ---------- F9: treasury sends carry the treasury secret ----------
test('F9: a treasury send carries X-Treasury-Secret; without TREASURY_SECRET it is a clear 503 and no code is used', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  s.setTics({ treasuryAddress: A1, casinoWallet: A2 });
  const secret = s.env.TREASURY_SECRET;
  delete s.env.TREASURY_SECRET;
  const code = (await s.stepUp(own)).code;
  const no = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1000, code });
  assert.equal(no.status, 503); assert.equal(no.data.error, 'Treasury sends are not set up yet.');
  assert.equal(s.payoutCalls.filter(c => c.path === '/treasury').length, 0);
  s.env.TREASURY_SECRET = secret;
  const ok = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1000, code });
  assert.equal(ok.status, 200, `the same code still works: ${ok.raw}`);
  const call = s.payoutCalls.find(c => c.path === '/treasury');
  assert.equal(call.treasurySecret, 'treasury-secret');
  assert.equal(call.secret, 'secret', 'the internal secret is still sent');
  // Other payouts calls do not get the treasury secret.
  assert.ok(s.payoutCalls.filter(c => c.path !== '/treasury').every(c => c.treasurySecret == null));
});
