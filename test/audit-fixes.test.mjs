// Audit findings (2026-10-30): step-up for admin changes, settings bounds, atomic rate limits,
// lockout by email + network, personal data masking, code reuse, audit paging, the shared
// owed / free float rule, one open treasury send, the 48 hour delays, sign-in auditing and
// the D1 read load of the cron and dashboard.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createD1 } from './d1shim.mjs';
import worker from '../src/index.js';
import { hotp } from '../src/totp.js';
import { makeSetupToken, login, networkOf, DAILY_CODE_LIMIT, confirmSensitive } from '../src/auth.js';
import { runChecks, CHECK_EVERY_MS, sendTelegram } from '../src/api/alerts.js';
import { bank } from '../src/api/bank.js';
import { validUrl } from '../src/api/messages.js';
import { updateAdmin } from '../src/api/settings.js';
import { listPlayers, listRounds, playerDetail } from '../src/api/players.js';
import { overview, owedBreakdown } from '../src/api/money.js';

const MIGRATION = new URL('./schema.sql', import.meta.url).pathname;
const ORIGIN = 'https://admin.betics.io';
const PASSWORD = 'correct horse 42 battery';
const A1 = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const A2 = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const TREASURY = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';
const step = () => Math.floor(Date.now() / 30000);

function setup({ float = 1_000_000 } = {}) {
  const DB = createD1([MIGRATION]);
  if (float != null) DB.raw.prepare("INSERT INTO chain_state (key, value) VALUES ('float', ?)").run(JSON.stringify({ at: Date.now(), chainId: 1, wallet: A2, tokenUnits: float, ethWei: '1' }));
  const payoutCalls = [], walletCalls = [];
  const env = {
    DB, SESSION_PEPPER: 'pepper', INTERNAL_SECRET: 'secret', TREASURY_SECRET: 'treasury-secret',
    ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) },
    WALLETS: { idFromName: n => n, get: id => ({ fetch: async req => { walletCalls.push({ id, body: await req.json() }); if (env.walletDown) throw new Error('down'); return Response.json({ balanceCents: 5 }); } }) },
    PAYOUTS: { fetch: async req => { const path = new URL(req.url).pathname; payoutCalls.push({ path, body: req.method === 'POST' ? await req.json() : null }); return Response.json({ ok: true }); } },
  };
  // Cookie jar: the session cookie, plus this browser's signed device cookie (device: false = a new browser with none).
  let cookie = null, device = null;
  const call = async (method, path, body, { ua = 'test-browser', ip = '1.1.1.1', keepCookie = true, device: sendDevice = true } = {}) => {
    const jar = [cookie, sendDevice ? device : null].filter(Boolean).join('; ');
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: ORIGIN, 'User-Agent': ua, 'CF-Connecting-IP': ip,
      ...(jar ? { Cookie: jar } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
    if (keepCookie) for (const set of res.headers.getSetCookie()) {
      const pair = set.split(';')[0];
      if (pair.startsWith('__Host-admin_device=')) { if (sendDevice) device = pair; } else cookie = pair;
    }
    const type = res.headers.get('Content-Type') || '';
    const raw = await res.text();
    return { status: res.status, raw, headers: res.headers, data: type.includes('json') ? JSON.parse(raw) : raw };
  };
  // Sign up an admin through the real setup flow. Codes: use next(d) for a fresh code (steps only move forward).
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
    return { id, email, secret: pw.data.secret, code: d => hotp(pw.data.secret, st + d) };
  };
  const resetCodes = () => DB.raw.prepare("UPDATE settings SET value = '{}' WHERE key = 'admin_totp_steps'").run();
  // A fresh code (and a clean slate of wrong tries: these tests make many on purpose).
  const stepUp = async a => { resetCodes(); DB.raw.prepare("DELETE FROM admin_login_attempts WHERE key LIKE 'confirm:%' OR key LIKE 'codes:%'").run(); return { password: PASSWORD, code: await a.code(1) }; };
  const setTics = obj => DB.raw.prepare(`INSERT INTO settings (key, value) VALUES ('tics_payments', ?) ON CONFLICT(key) DO UPDATE SET value = json_patch(value, excluded.value)`).run(JSON.stringify(obj));
  const tics = () => JSON.parse(DB.raw.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").get()?.value || '{}');
  const alerts = type => DB.raw.prepare('SELECT * FROM alerts WHERE type = ? ORDER BY id').all(type);
  const audits = action => DB.raw.prepare('SELECT * FROM admin_audit WHERE action = ? ORDER BY id').all(action);
  return { DB, env, call, admin, resetCodes, stepUp, setTics, tics, alerts, audits, payoutCalls, walletCalls, set cookie(v) { cookie = v; }, get cookie() { return cookie; }, set device(v) { device = v; }, get device() { return device; } };
}

// ---------- H3: admin changes need the password + a fresh code ----------
test('H3: creating, re-inviting, raising and reactivating admins need password + fresh code; owner invites and setups alert', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  assert.equal(s.alerts('admin_setup').length, 1, 'finishing setup raises a critical alert');
  assert.equal(s.alerts('admin_setup')[0].severity, 'critical');
  const add = body => s.call('POST', '/api/admins', { email: 'new@example.com', name: 'New', role: 'owner', ...body });
  assert.equal((await add({})).status, 401, 'no password or code: refused');
  assert.equal((await add({ password: PASSWORD })).data.code, 'bad_code', 'password but no code: refused');
  assert.equal((await add({ password: 'wrong password 9', code: await own.code(1) })).data.code, 'bad_password');
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM admins WHERE email = 'new@example.com'").get().n, 0);
  const made = await add(await s.stepUp(own));
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const inv = s.alerts('admin_owner_invited');
  assert.equal(inv.length, 1); assert.equal(inv[0].severity, 'critical'); assert.match(inv[0].title, /new@example.com/);
  // Re-invite (setup link) needs it too.
  assert.equal((await s.call('POST', `/api/admins/${made.data.id}/setup-link`, {})).status, 401);
  assert.equal((await s.call('POST', `/api/admins/${made.data.id}/setup-link`, await s.stepUp(own))).status, 200);
  assert.equal(s.alerts('admin_owner_invited').length, 2, 're-inviting an owner alerts again');
  // A readonly admin: raising needs step-up, lowering and removing do not, reactivating does.
  const ro = s.DB.raw.prepare("INSERT INTO admins (email, name, role) VALUES ('ro@example.com', 'ro', 'readonly') RETURNING id").get().id;
  assert.equal((await s.call('PUT', `/api/admins/${ro}`, { role: 'finance' })).status, 401);
  assert.equal((await s.call('PUT', `/api/admins/${ro}`, { role: 'finance', ...(await s.stepUp(own)) })).status, 200);
  assert.equal((await s.call('PUT', `/api/admins/${ro}`, { role: 'support' })).status, 200, 'lowering: no step-up');
  assert.equal((await s.call('PUT', `/api/admins/${ro}`, { active: false })).status, 200, 'removing: no step-up');
  assert.equal((await s.call('PUT', `/api/admins/${ro}`, { active: true })).status, 401, 'reactivating needs step-up');
  assert.equal((await s.call('PUT', `/api/admins/${ro}`, { active: true, ...(await s.stepUp(own)) })).status, 200);
  // Raising to owner: alert + 48 hour treasury wait.
  assert.equal((await s.call('PUT', `/api/admins/${ro}`, { role: 'owner', ...(await s.stepUp(own)) })).status, 200);
  assert.ok(s.DB.raw.prepare('SELECT treasury_ok_after FROM admins WHERE id = ?').get(ro).treasury_ok_after > new Date().toISOString().replace('T', ' ').slice(0, 19));
  assert.equal(s.alerts('admin_owner_invited').length, 3);
});

test('H3: a newly set up owner cannot send to the treasury or change its address for 48 hours', async () => {
  const s = setup();
  s.setTics({ treasuryAddress: A1, casinoWallet: A2 });
  const fresh = await s.admin('new-owner@example.com', 'owner', { fresh: true });
  const send = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 100, code: await fresh.code(1) });
  assert.equal(send.status, 403); assert.equal(send.data.code, 'owner_too_new'); assert.match(send.data.error, /UTC/);
  const addr = await s.call('PUT', '/api/tics/treasury/address', { address: TREASURY, ...(await s.stepUp(fresh)) });
  assert.equal(addr.data.code, 'owner_too_new');
  const page = await s.call('GET', '/api/tics/treasury');
  assert.ok(page.data.adminTreasuryOkAt, 'the page shows when it opens');
  assert.equal(s.payoutCalls.filter(c => c.path === '/treasury').length, 0);
  // 48 hours later it works.
  s.DB.raw.prepare("UPDATE admins SET treasury_ok_after = datetime('now', '-1 minute') WHERE id = ?").run(fresh.id);
  s.resetCodes();
  assert.equal((await s.call('POST', '/api/tics/treasury/send', { amountUnits: 100, code: await fresh.code(1) })).status, 200);
});

// ---------- M2: settings bounds and step-up ----------
test('M2: payout settings bounds, and the risky ones need password + fresh code', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  const put = body => s.call('PUT', '/api/tics/settings', body);
  for (const bad of [{ confirmations: 5 }, { quickConfirmations: 1 }, { confirmations: 6, quickConfirmations: 7 }, { quickDepositMaxUnits: 100_000_001 },
    { quickDailyMaxUnits: 100_000_001 }, { quickDailyMaxUnits: -1 }, { maxSpinExposurePct: 51 }, { maxSpinExposurePct: 0 }, { coolingSeconds: 59 }, { fallbackFeeUnits: 10_000_000 }, { minWithdrawalUnits: 50000 }, { treasuryAddressSetAt: '2020-01-01T00:00:00Z' }])
    assert.equal((await put({ ...bad, ...(await s.stepUp(own)) })).status, 400, JSON.stringify(bad));
  for (const k of [['realEnabled', true], ['withdrawalsOpen', false], ['confirmations', 20], ['quickConfirmations', 4], ['quickDepositMaxUnits', 5000], ['quickDailyMaxUnits', 20000], ['maxSpinExposurePct', 10], ['coolingSeconds', 300]]) {
    s.resetCodes(); s.DB.raw.prepare('DELETE FROM admin_login_attempts').run();
    const r = await put({ [k[0]]: k[1] });
    assert.equal(r.status, 401, `${k[0]} needs step-up`);
    assert.equal((await put({ [k[0]]: k[1], ...(await s.stepUp(own)) })).status, 200, k[0]);
    assert.deepEqual(s.tics()[k[0]], k[1]);
  }
  assert.equal((await put({ quickDepositMaxUnits: 100_000_000, ...(await s.stepUp(own)) })).status, 200, '1,000,000 TICS is allowed');
  // Re-audit 3 F5: alert levels, fees on/off and the smallest deposit need it too; only the demo start balance does not.
  for (const k of [['largeWithdrawalAlertUnits', 7], ['feesEnabled', false], ['minDepositUnits', 500], ['lowFloatUnits', 1000], ['highFloatUnits', 900000], ['lowEthWei', '1']]) {
    s.resetCodes(); s.DB.raw.prepare('DELETE FROM admin_login_attempts').run();
    assert.equal((await put({ [k[0]]: k[1] })).status, 401, `${k[0]} needs step-up`);
    assert.equal((await put({ [k[0]]: k[1], ...(await s.stepUp(own)) })).status, 200, k[0]);
    assert.deepEqual(s.tics()[k[0]], k[1]);
  }
  assert.equal((await put({ demoStartUnits: 5000 })).status, 200, 'play money start balance needs no step-up');
  assert.equal((await put({ confirmations: 20 })).status, 200, 'unchanged sensitive value: nothing to confirm');
});

// ---------- M3 / M4: rate limits ----------
test('M3: parallel wrong sign-ins cannot slip past the limit (claim and count are one statement)', async () => {
  const s = setup();
  await s.admin('dez@example.com', 'owner');
  s.cookie = null;
  const tries = await Promise.all(Array.from({ length: 20 }, () => s.call('POST', '/api/auth/login', { email: 'dez@example.com', password: 'wrong wrong 1' }, { keepCookie: false })));
  const by = code => tries.filter(t => t.status === code).length;
  assert.equal(by(401), 5, 'only 5 tries reach the password check');
  assert.equal(by(429), 15);
  // Step-up confirmations are claimed the same way.
  const s2 = setup();
  const own = await s2.admin('o@example.com', 'owner');
  const confirms = await Promise.all(Array.from({ length: 12 }, () => s2.call('POST', '/api/admins', { email: 'x@example.com', name: 'X', role: 'readonly', password: 'nope nope 12', code: '000000' })));
  assert.equal(confirms.filter(t => t.status === 401).length, 5);
  assert.equal(confirms.filter(t => t.status === 429).length, 7);
  assert.equal(own.email, 'o@example.com');
});

test('M4: a lockout is per email AND network; the email-wide limit only slows down', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  s.cookie = null;
  for (let i = 0; i < 5; i++) await s.call('POST', '/api/auth/login', { email: 'dez@example.com', password: 'wrong 123456789' }, { ip: '6.6.6.6', keepCookie: false, device: false });
  assert.equal((await s.call('POST', '/api/auth/login', { email: 'dez@example.com', password: PASSWORD }, { ip: '6.6.6.6', keepCookie: false })).status, 429, 'attacker network locked');
  assert.deepEqual((await s.call('POST', '/api/auth/login', { email: 'dez@example.com', password: PASSWORD }, { ip: '2.2.2.2', keepCookie: false })).data, { needCode: true }, 'owner on another network still gets in');
  // 10+ failures from many networks: one try per 30 seconds for that email, never a full lock.
  for (let i = 0; i < 6; i++) await s.call('POST', '/api/auth/login', { email: 'dez@example.com', password: 'wrong 123456789' }, { ip: `9.9.9.${i}`, keepCookie: false, device: false });
  const req = ip => new Request(`${ORIGIN}/api/auth/login`, { headers: { 'CF-Connecting-IP': ip } });
  await assert.rejects(login(s.DB, s.env, req('3.3.3.3'), { email: 'dez@example.com', password: PASSWORD }), e => e.status === 429);
  const later = await login(s.DB, s.env, req('3.3.3.3'), { email: 'dez@example.com', password: PASSWORD }, Date.now() + 31e3);
  assert.deepEqual(later, { needCode: true });
  assert.ok(own.id);
});

// ---------- L7 / L9 / M6: sign-in ----------
test('L7/L9/M6: setup codes work once, unknown and unfinished accounts get the same answer, sign-ins are audited, owner on a new device alerts', async () => {
  const s = setup();
  // Setup with a code step already used: refused.
  s.DB.raw.prepare("INSERT INTO admins (email, name, role) VALUES ('a@example.com', 'a', 'owner')").run();
  const id = s.DB.raw.prepare("SELECT id FROM admins WHERE email = 'a@example.com'").get().id;
  const token = await makeSetupToken(s.DB, id);
  const pw = await s.call('POST', '/api/auth/setup/password', { token, password: PASSWORD });
  s.DB.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_totp_steps', ?)").run(JSON.stringify({ [id]: step() }));
  const used = await s.call('POST', '/api/auth/setup/code', { token, code: await hotp(pw.data.secret, step()) });
  assert.equal(used.status, 400); assert.equal(used.data.code, 'code_used');
  assert.equal(s.audits('auth.setup_password').length, 1);
  // Not set up yet / unknown email / wrong password: one generic answer.
  s.cookie = null;
  const a = await s.call('POST', '/api/auth/login', { email: 'a@example.com', password: PASSWORD });
  const b = await s.call('POST', '/api/auth/login', { email: 'nobody@example.com', password: PASSWORD });
  const c = await s.call('POST', '/api/auth/login', { email: 'a@example.com', password: 'wrong password 1' });
  assert.deepEqual([a.status, b.status, c.status], [401, 401, 401]);
  assert.equal(a.data.error, b.data.error); assert.equal(b.data.error, c.data.error); assert.equal(a.data.code, 'bad_login');
  assert.equal(s.audits('auth.login_failed').length, 3);
  // Finish setup, then sign in from the same browser (known device) and from a new one (alert).
  const done = await s.call('POST', '/api/auth/setup/code', { token, code: await hotp(pw.data.secret, step() + 1) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(s.audits('auth.setup_complete').length, 1);
  assert.equal(s.audits('auth.session_new').length, 1);
  s.resetCodes(); s.cookie = null;
  assert.equal((await s.call('POST', '/api/auth/login', { email: 'a@example.com', password: PASSWORD, code: await hotp(pw.data.secret, step()) })).status, 200);
  assert.equal(s.alerts('admin_new_device').length, 0, 'same browser as setup (signed device cookie)');
  s.resetCodes(); s.cookie = null;
  assert.equal((await s.call('POST', '/api/auth/login', { email: 'a@example.com', password: PASSWORD, code: await hotp(pw.data.secret, step()) }, { ua: 'other-browser', ip: '5.5.5.5', device: false })).status, 200);
  const nd = s.alerts('admin_new_device');
  assert.equal(nd.length, 1); assert.equal(nd[0].severity, 'critical');
  assert.equal(s.audits('auth.login').length, 2);
  assert.equal(JSON.parse(s.audits('auth.login')[1].after_json).newDevice, true);
});

// ---------- M5 / L10: personal data and the audit log ----------
test('M5/L10: personal data is masked without pii:view; the audit log needs its permission and clamps the limit', async () => {
  const s = setup();
  s.DB.raw.prepare(`INSERT INTO players (id, wallet_address, country, city, os, browser, language, first_connected_at, last_connected_at) VALUES (?, ?, 'DE', 'Berlin', 'iOS', 'Safari', 'de', datetime('now'), datetime('now'))`).run(A1, A1);
  s.DB.raw.prepare("INSERT INTO player_identities (kind, value, player_id, consent) VALUES ('email', 'ana@example.com', ?, 1), ('telegram', '@ana_tg', ?, 0), ('wallet', ?, ?, 0)").run(A1, A1, A1, A1);
  s.DB.raw.prepare("INSERT INTO wallet_connections (player_id, address, country, city, device, os, browser) VALUES (?, ?, 'DE', 'Berlin', 'mobile', 'iOS', 'Safari')").run(A1, A1);
  await s.admin('help@example.com', 'support');
  const list = (await s.call('GET', '/api/players?limit=99999&offset=-4')).data;
  assert.equal(list.limit, 200); assert.equal(list.offset, 0);
  assert.equal(list.players[0].email, 'a***@e***.com'); assert.equal(list.players[0].city, 'hidden');
  const d = (await s.call('GET', `/api/players/${A1}`)).data;
  assert.equal(d.piiMasked, true);
  assert.equal(d.email.address, 'a***@e***.com');
  assert.deepEqual(d.identities.map(i => [i.kind, i.value]).sort(), [['email', 'a***@e***.com'], ['telegram', 'hidden'], ['wallet', A1]].sort());
  assert.deepEqual([d.connections[0].city, d.connections[0].device, d.connections[0].browser], [null, null, null]);
  assert.ok(!JSON.stringify(d).includes('ana@example.com') && !JSON.stringify(d).includes('@ana_tg') && !JSON.stringify(d).includes('Berlin'));
  assert.equal((await s.call('GET', '/api/audit')).status, 403, 'support cannot read the audit log');
  await s.admin('dez@example.com', 'owner');
  const full = (await s.call('GET', `/api/players/${A1}`)).data;
  assert.equal(full.email.address, 'ana@example.com'); assert.equal(full.connections[0].city, 'Berlin'); assert.equal(full.piiMasked, false);
  for (let i = 0; i < 520; i++) s.DB.raw.prepare("INSERT INTO admin_audit (admin_email, action) VALUES ('system', 'test.fill')").run();
  const n = async q => (await s.call('GET', `/api/audit${q}`)).data.entries.length;
  assert.equal(await n('?limit=-5'), 1);
  assert.equal(await n('?limit=0'), 100);
  assert.equal(await n('?limit=abc'), 100);
  assert.equal(await n('?limit=100000'), 500);
  assert.equal(await n('?limit=2.9'), 2);
});

// ---------- owed / free float, one open treasury send, 48 hour address delay ----------
test('treasury: free float = wallet - owed (balances, holding/queued withdrawals, treasury in flight) - open spin holds; one open send; 48h after an address change', async () => {
  const s = setup({ float: 1_000_000 });
  s.DB.raw.prepare('INSERT INTO players (id, wallet_address, real_tics_cents) VALUES (?, ?, 300000), (?, ?, 0)').run(A1, A1, A2, A2);
  const wd = (id, kind, status, units) => s.DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, send_units, status, release_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, datetime('now'))`)
    .run(id, kind, kind === 'player' ? A1 : null, A1, units, units, status);
  wd('w-hold', 'player', 'holding', 100000); wd('w-q', 'player', 'queued', 50000); wd('w-sent', 'player', 'sent', 777777); wd('t-done', 'treasury', 'sent', 888888);
  s.DB.raw.prepare('INSERT INTO spin_holds (id, player_id, units, expires_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)').run('h1', A1, 30000, Date.now() + 60e3, 'h2', A1, 99999, Date.now() - 1000);
  s.setTics({ treasuryAddress: A1, casinoWallet: A2 });
  const own = await s.admin('dez@example.com', 'owner');
  let t = (await s.call('GET', '/api/tics/treasury')).data;
  assert.equal(t.owedUnitsDb, 450000, '300,000 balances + 100,000 holding + 50,000 queued');
  assert.equal(t.freeUnitsDb, 1_000_000 - 450000 - 30000, 'minus the open spin hold only');
  const o = (await s.call('GET', '/api/overview?period=today')).data.ticsFloat;
  assert.deepEqual([o.owedUnits, o.freeUnits, o.holdsUnits], [450000, 520000, 30000]);
  // More than the free float: refused here, before any code is used or the payouts Worker is asked.
  const tooMuch = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 520001, code: await own.code(1) });
  assert.equal(tooMuch.status, 400); assert.equal(tooMuch.data.code, 'not_free'); assert.match(tooMuch.data.error, /5,200\.00 TICS/);
  assert.equal(s.payoutCalls.filter(c => c.path === '/treasury').length, 0);
  // A treasury send in flight counts as owed, and blocks a second one.
  wd('t-open', 'treasury', 'sending', 70000);
  t = (await s.call('GET', '/api/tics/treasury')).data;
  assert.equal(t.owedUnitsDb, 520000); assert.equal(t.openSend.id, 't-open');
  const busy = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1, code: await own.code(1) });
  assert.equal(busy.status, 409); assert.equal(busy.data.code, 'treasury_busy');
  s.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'sent' WHERE id = 't-open'").run();
  // Change the address: stamped, and sends wait 48 hours with a clear time.
  const ch = await s.call('PUT', '/api/tics/treasury/address', { address: TREASURY, ...(await s.stepUp(own)) });
  assert.equal(ch.status, 200, JSON.stringify(ch.data));
  const setAt = s.tics().treasuryAddressSetAt;
  assert.ok(Math.abs(Date.parse(setAt) - Date.now()) < 5000);
  assert.ok(Date.parse(ch.data.sendableAt) - Date.parse(setAt) === 48 * 3600e3);
  assert.match(s.alerts('tics_treasury_changed')[0].details, /open at .* UTC/);
  s.resetCodes();
  const early = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 100, code: await own.code(1) });
  assert.equal(early.status, 409); assert.equal(early.data.code, 'treasury_address_new'); assert.match(early.data.error, /open at \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.ok((await s.call('GET', '/api/tics/treasury')).data.treasurySendableAt);
  s.setTics({ treasuryAddressSetAt: new Date(Date.now() - 49 * 3600e3).toISOString() });
  s.resetCodes();
  const ok = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 100, code: await own.code(1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // L12: the intent row is written before the payouts Worker is called.
  const intent = s.audits('tics.treasury_send_intent'), done = s.audits('tics.treasury_send');
  assert.equal(intent.length, 1); assert.ok(intent[0].id < done[0].id);
  // Payouts list: 'holding' rows are open and listed.
  const list = (await s.call('GET', '/api/tics/payments?status=open')).data;
  assert.ok(list.withdrawals.some(w => w.id === 'w-hold' && w.status === 'holding'));
});

// ---------- L11 / L12 / L14 / L15 / L13 / L16 ----------
test('L11/L12: legacy withdrawals check status and the tx hash; balance changes and rejects write the intent first', async () => {
  const s = setup();
  s.DB.raw.prepare("INSERT INTO players (id, balance_cents) VALUES ('p1', 100)").run();
  const add = (id, status = 'requested') => s.DB.raw.prepare(`INSERT INTO withdrawals (id, player_id, amount_cents, fee_cents, network, currency, address, status) VALUES (?, 'p1', 5000, 100, 'tron', 'USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', ?)`).run(id, status);
  add('w1'); add('w2'); add('w3', 'rejected');
  await s.admin('dez@example.com', 'owner');
  for (const bad of ['0x' + 'a'.repeat(63), 'g'.repeat(64), '0'.repeat(64), 'a'.repeat(65)])
    assert.equal((await s.call('POST', '/api/withdrawals/w1', { action: 'sent', txHash: bad })).status, 400, bad);
  assert.equal((await s.call('POST', '/api/withdrawals/w1', { action: 'sent', txHash: '0x' + 'B'.repeat(64) })).status, 200);
  assert.equal(s.DB.raw.prepare("SELECT tx_hash FROM withdrawals WHERE id = 'w1'").get().tx_hash, 'b'.repeat(64));
  assert.equal((await s.call('POST', '/api/withdrawals/w3', { action: 'sent', txHash: 'c'.repeat(64) })).status, 400, 'a rejected one cannot be marked sent');
  // L7: reject when the wallet reply is lost: intent on record, and the row is parked for review
  // (never back to requested/approved, where it could be sent AND refunded), still counted as owed.
  s.env.walletDown = true;
  const lost = await s.call('POST', '/api/withdrawals/w2', { action: 'reject', reason: 'wrong address' });
  assert.equal(lost.status, 502); assert.equal(lost.data.code, 'needs_review');
  const w2 = s.DB.raw.prepare("SELECT status, reason FROM withdrawals WHERE id = 'w2'").get();
  assert.equal(w2.status, 'failed'); assert.match(w2.reason, /^Needs review/);
  assert.equal(s.audits('withdrawal.reject_intent').length, 1);
  assert.equal(s.audits('withdrawal.reject_review').length, 1);
  assert.equal((await s.call('POST', '/api/withdrawals/w2', { action: 'sent', txHash: 'c'.repeat(64) })).status, 400, 'a row under review cannot be marked sent');
  assert.equal((await bank(s.DB, {})).pendingWithdrawalsCents, 5000, 'still counted as owed');
});

test('L14: message buttons link only to betics.io or our Telegram unless an owner sends them', () => {
  const support = { role: 'support' }, owner = { role: 'owner' };
  for (const ok of ['/', '/how-it-works', 'https://betics.io/promo', 'https://www.betics.io/x?y=1', 'https://t.me/Betics_casino', 'https://t.me/Betics_casino/12'])
    assert.ok(validUrl(ok, support), ok);
  for (const bad of ['https://evil.example', 'https://betics.io.evil.example/', 'https://t.me/other', 'https://t.me/Betics_casino_fake', 'http://betics.io/', 'javascript:alert(1)', '//evil.example', 'https://user@betics.io/'])
    assert.throws(() => validUrl(bad, support), bad);
  assert.equal(validUrl('https://partner.example/offer', owner), 'https://partner.example/offer');
  assert.throws(() => validUrl('http://partner.example/', owner));
});

test('L15/L13/L16: HSTS covers subdomains; the invite script hides the link and ends sessions; tooltips escape data', async () => {
  const s = setup();
  const r = await s.call('GET', '/');
  assert.equal(r.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
  assert.match(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'), /Strict-Transport-Security: max-age=31536000; includeSubDomains/);
  const sh = readFileSync(new URL('../scripts/invite-owner.sh', import.meta.url), 'utf8');
  assert.match(sh, /DELETE FROM admin_sessions WHERE admin_id = \(SELECT id FROM admins WHERE email/);
  assert.ok(!/^\s*echo[^\n]*TOKEN/m.test(sh), 'the setup link is never echoed');
  assert.match(sh, /umask 077/); assert.match(sh, /chmod 600/);
  const players = readFileSync(new URL('../public/js/views/players.js', import.meta.url), 'utf8');
  const payments = readFileSync(new URL('../public/js/views/payments.js', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../public/js/signin-core.js', import.meta.url), 'utf8');
  assert.ok(!/tip: p\.walletAddress/.test(players)); assert.ok(!/tip: a \}/.test(payments));
  assert.match(lib, /k === 'tipText'\) el\.dataset\.tip = esc\(v\)/);
});

// ---------- D1 read load ----------
const seedRound = (s, id, player, stake, payout, when = null, real = 0) => s.DB.raw.prepare(`INSERT INTO rounds (id, player_id, game_id, math_id, config_version, stake_cents, payout_cents, outcome, bets_json, fairness_json, currency, real_money, created_at)
  VALUES (?, ?, 'roulette', 'standard', 1, ?, ?, '{}', '[]', '{}', 'TICS', ?, COALESCE(?, datetime('now')))`).run(id, player, stake, payout, real, when);

test('read load: checks run at most every 10 minutes, read each round once (late copies too), and keep 30-day sums in one row', async () => {
  const s = setup();
  s.DB.raw.prepare("INSERT INTO players (id, total_bet_cents, total_paid_cents) VALUES ('p1', 0, 0)").run();
  const t0 = new Date();
  seedRound(s, 'r1', 'p1', 1000, 2000);
  assert.ok(await runChecks(s.DB, t0) >= 0);
  assert.equal(await runChecks(s.DB, new Date(t0.getTime() + 60e3)), null, 'skipped: ran a minute ago');
  assert.ok(await runChecks(s.DB, new Date(t0.getTime() + 60e3), { force: true }) >= 0, 'the Check now button forces it');
  const state = () => JSON.parse(s.DB.raw.prepare("SELECT value FROM settings WHERE key = 'alerts_rounds'").get().value);
  const day = t0.toISOString().slice(0, 10);
  assert.deepEqual(state().days[day].roulette, [1, 1000, 2000]);
  // A copy that arrives late with an old timestamp is still seen (by rowid), exactly once.
  const yesterday = new Date(t0.getTime() - 864e5).toISOString().slice(0, 19).replace('T', ' ');
  seedRound(s, 'late-big', 'p1', 100, 300_000_000, yesterday);
  s.DB.raw.prepare("UPDATE players SET total_paid_cents = 300002000, total_bet_cents = 1100 WHERE id = 'p1'").run();
  const t1 = new Date(t0.getTime() + 60e3 + CHECK_EVERY_MS);
  await runChecks(s.DB, t1);
  assert.equal(s.alerts('big_win').length, 1, 'the late big win is caught');
  assert.equal(s.alerts('player_up').length, 1, 'the player who played is checked');
  assert.deepEqual(state().days[yesterday.slice(0, 10)].roulette, [1, 100, 300_000_000]);
  await runChecks(s.DB, new Date(t1.getTime() + CHECK_EVERY_MS));
  assert.deepEqual(state().days[day].roulette, [1, 1000, 2000], 'nothing counted twice');
  // Two runs at the same moment: only one counts.
  seedRound(s, 'r3', 'p1', 500, 0);
  const t2 = new Date(t1.getTime() + 3 * CHECK_EVERY_MS);
  const both = await Promise.all([runChecks(s.DB, t2), runChecks(s.DB, t2)]);
  assert.equal(both.filter(x => x == null).length >= 1, true);
  assert.deepEqual(state().days[day].roulette, [2, 1500, 2000]);
});

test('read load: the balance check only looks at players seen since the last run (at least 15 minutes)', async () => {
  const s = setup();
  const now = new Date();
  const ago = m => new Date(now.getTime() - m * 60e3).toISOString().slice(0, 19).replace('T', ' ');
  s.DB.raw.prepare('INSERT INTO players (id, balance_cents, last_seen_at) VALUES (?, 500, ?), (?, 500, ?)').run('recent', ago(5), 'old', ago(60 * 24));
  for (const id of ['recent', 'old']) s.DB.raw.prepare(`INSERT INTO ledger (id, player_id, type, amount_cents, balance_after_cents, currency, real_money, created_at) VALUES (?, ?, 'bet', -1, 999, 'TICS', 0, datetime('now'))`).run(`${id}:1`, id);
  s.DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('alerts_mark', ?)").run(JSON.stringify(ago(10)));
  await runChecks(s.DB, now);
  assert.deepEqual(s.alerts('reconcile').map(a => a.player_id), ['recent']);
});

test('read load: hot queries use indexes (EXPLAIN QUERY PLAN)', () => {
  const s = setup();
  const plan = sql => s.DB.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.match(/\?/g) || []).map(() => '2026-10-30 00:00:00')).map(r => r.detail).join(' | ');
  const cases = [
    ["SELECT p.id, (SELECT l.balance_after_cents FROM ledger l WHERE l.player_id = p.id AND l.real_money = 0 ORDER BY l.rowid DESC LIMIT 1) FROM players p WHERE p.last_seen_at >= ?", /players_last_seen.*ledger_player_money/],
    ['SELECT rowid, id FROM rounds WHERE rowid > ? ORDER BY rowid LIMIT 5000', /SEARCH rounds USING INTEGER PRIMARY KEY/],
    ["SELECT type, COUNT(*) FROM ledger WHERE type IN ('deposit','withdrawal') AND created_at >= ? GROUP BY type", /ledger_type_time/],
    ['SELECT SUM(stake_cents - payout_cents) FROM rounds WHERE created_at >= ? AND real_money = 1', /USING INDEX rounds_real_time/],
    ['SELECT SUM(stake_cents - payout_cents) FROM rounds WHERE created_at >= ? AND +real_money = 0', /USING INDEX rounds_time/],
    ['SELECT SUM(real_tics_cents) FROM players WHERE real_tics_cents > 0', /players_real_tics/],
    ["SELECT SUM(amount_units) FROM chain_withdrawals WHERE kind = 'player' AND status IN ('holding','queued','signing','sending')", /chain_withdrawals_kind_status/],
    ["SELECT * FROM alerts WHERE telegram_sent = 0 AND status = 'open' ORDER BY id LIMIT 10", /alerts_unsent/],
    ['SELECT id FROM rounds WHERE real_money = 1 ORDER BY created_at DESC, id DESC LIMIT 15', /rounds_real_time/],
    ['SELECT id FROM rounds WHERE +real_money = 0 ORDER BY created_at DESC, id DESC LIMIT 15', /SCAN rounds USING INDEX rounds_time/],
  ];
  for (const [sql, re] of cases) assert.match(plan(sql), re, sql);
});

test('read load: bank aggregates are cached for 60 seconds', async () => {
  const s = setup();
  s.DB.raw.prepare('INSERT INTO players (id, balance_cents) VALUES (?, 700)').run('p1');
  const a = await bank(s.DB, {});
  s.DB.raw.prepare("UPDATE players SET balance_cents = 900 WHERE id = 'p1'").run();
  const b = await bank(s.DB, {});
  assert.equal(a.play.owedCents, 700); assert.equal(b.play.owedCents, 700, 'served from the cache');
});


// ==================== re-audit, round 2 ====================

// H1: run the real code, capture the SQL it sends, and check the plan WITHOUT ANALYZE (D1 has no stats either).
test('H1: Real feeds use rounds_real_time (literal real_money = 1), Demo uses rounds_time, per-player queries stay on rounds_player', async () => {
  const s = setup();
  for (let i = 0; i < 300; i++) seedRound(s, `r${i}`, `p${i % 30}`, 100, 0, null, i % 10 === 0 ? 1 : 0);
  for (let i = 0; i < 30; i++) s.DB.raw.prepare("INSERT INTO players (id, wallet_address) VALUES (?, ?)").run(`p${i}`, i % 2 ? `0x${String(i).padStart(40, '0')}` : null);
  assert.equal(s.DB.raw.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'").get(), undefined, 'no ANALYZE statistics');
  const seen = [];
  const db = { ...s.DB, prepare: q => { const st = s.DB.prepare(q); return { ...st, bind: (...a) => { seen.push({ q, a }); return st.bind(...a); }, all: () => { seen.push({ q, a: [] }); return st.all(); }, first: c => { seen.push({ q, a: [] }); return st.first(c); } }; } };
  const plans = () => seen.filter(x => /\brounds\b/.test(x.q)).map(x => ({ q: x.q.replace(/\s+/g, ' '), plan: s.DB.raw.prepare('EXPLAIN QUERY PLAN ' + x.q).all(...x.a).map(r => r.detail).join(' | ') }));
  const U = q => new URL(`${ORIGIN}/api/x?${q}`), owner = { id: 1, role: 'owner' };
  const run = async fn => { seen.length = 0; await fn(); return plans(); };
  for (const money of ['real', 'play']) {
    const list = await run(() => listPlayers(db, U(`money=${money}&limit=50`), owner));
    assert.match(list[0].plan, /SEARCH r USING INDEX rounds_player \(player_id=\?\).*rounds_player.*rounds_player/, `${money} player list: ${list[0].plan}`);
    assert.doesNotMatch(list[0].plan, /rounds_real_time|rounds_time/);
    for (const x of await run(() => playerDetail(db, 'p1', money === 'real' ? 1 : 0, owner))) assert.match(x.plan, /rounds_player/, x.q);
    const one = await run(() => listRounds(db, U(`money=${money}&player=p1`)));
    assert.match(one[0].plan, /rounds_player/);
  }
  const realFeed = await run(() => listRounds(db, U('money=real')));
  assert.match(realFeed[0].q, /real_money = 1/); assert.match(realFeed[0].plan, /SCAN rounds USING INDEX rounds_real_time/);
  const demoFeed = await run(() => listRounds(db, U('money=play')));
  assert.match(demoFeed[0].plan, /SCAN rounds USING INDEX rounds_time/);
  const ov = await run(() => overview(db, U('money=real&period=today')));
  const live = ov.find(x => /LIMIT 15/.test(x.q));
  assert.match(live.plan, /SCAN rounds USING INDEX rounds_real_time/);
  for (const x of ov.filter(x => !/JOIN|LEFT/.test(x.q))) assert.match(x.plan, /rounds_real_time/, x.q);
  const ovDemo = await run(() => overview(db, U('money=play&period=7d')));
  assert.match(ovDemo.find(x => /LIMIT 15/.test(x.q)).plan, /SCAN rounds USING INDEX rounds_time/, 'demo live feed: no full scan + sort');
  for (const x of ovDemo) assert.doesNotMatch(x.plan, /SCAN rounds(?! USING)/, x.q);
  // L1: the alerts bootstrap reads 30 days through the time index, not the whole table by rowid.
  const boot = await run(() => runChecks(db, new Date(), { force: true }));
  for (const x of boot.filter(x => /\+rowid <= \?/.test(x.q))) assert.match(x.plan, /USING (COVERING )?INDEX rounds_time/, x.q);
  assert.equal(boot.filter(x => /\+rowid <= \?/.test(x.q)).length, 2);
});

test('H2/N4: the email-wide slow-down skips networks where the admin already signed in; refused tries are not audited', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  s.resetCodes(); s.cookie = null;
  // Dez signs in at home once (2.2.2.2).
  assert.equal((await s.call('POST', '/api/auth/login', { email: own.email, password: PASSWORD, code: await own.code(0) }, { ip: '2.2.2.2' })).status, 200);
  s.cookie = null;
  const auditsBefore = s.DB.raw.prepare('SELECT COUNT(*) AS n FROM admin_audit').get().n;
  // An attacker hammers from many networks: 10 wrong tries, then the email-wide slow-down kicks in elsewhere.
  for (let i = 0; i < 12; i++) await s.call('POST', '/api/auth/login', { email: own.email, password: 'wrong 123456789' }, { ip: `9.9.${i}.1`, keepCookie: false, device: false });
  const req = ip => new Request(`${ORIGIN}/api/auth/login`, { headers: { 'CF-Connecting-IP': ip } });
  await assert.rejects(login(s.DB, s.env, req('3.3.3.3'), { email: own.email, password: PASSWORD }), e => e.status === 429 && /30 seconds/.test(e.message) && /other networks/.test(e.message));
  // ...but not at home.
  assert.deepEqual(await login(s.DB, s.env, req('2.2.2.2'), { email: own.email, password: PASSWORD }), { needCode: true }, 'usual network is never slowed down');
  // Per-network lock message no longer promises "30 seconds" (email slow-down cleared, so the network limit answers).
  s.DB.raw.prepare("DELETE FROM admin_login_attempts WHERE key LIKE 'email:%'").run();
  for (let i = 0; i < 6; i++) await s.call('POST', '/api/auth/login', { email: own.email, password: 'wrong 123456789' }, { ip: '6.6.6.6', keepCookie: false });
  const locked = await s.call('POST', '/api/auth/login', { email: own.email, password: PASSWORD }, { ip: '6.6.6.6', keepCookie: false });
  assert.equal(locked.status, 429); assert.match(locked.data.error, /this network\. Wait 15 minutes/); assert.doesNotMatch(locked.data.error, /30 seconds/);
  // N4: rate-limited answers write nothing to the audit log (the tries that reached the password check are there).
  const failed = s.DB.raw.prepare("SELECT after_json FROM admin_audit WHERE action = 'auth.login_failed' AND id > 0").all().map(r => JSON.parse(r.after_json).reason);
  assert.equal(failed.filter(r => r === 'rate_limited').length, 0);
  const added = s.DB.raw.prepare('SELECT COUNT(*) AS n FROM admin_audit').get().n - auditsBefore;
  assert.ok(added <= 12 + 5, `only the tries that got through are audited (${added})`);
});

test('N1: button links are judged as parsed URLs; tabs, backslashes and other tricks cannot leave the site', () => {
  const support = { role: 'support' }, owner = { role: 'owner' };
  for (const bad of ['/\t/evil.example', '/\n/evil.example', '/\\evil.example', '/\\/evil.example', '/ /evil.example', '/..//evil.example', 'https://www.betics.io//evil.example',
    '/\u0000/x', 'https:\\\\evil.example', 'https:/evil.example', ' https://evil.example', 'https://www.betics.io\t.evil.example/', 'HTTPS://evil.example', 'https://evil.example\u2028'])
    assert.throws(() => validUrl(bad, support), JSON.stringify(bad));
  assert.throws(() => validUrl('/\t/evil.example', owner), 'owners too');
  assert.equal(validUrl('/promo/../how-it-works?x=1#top', support), '/how-it-works?x=1#top', 'stored normalised');
  assert.equal(validUrl('https://BETICS.io/Promo', support), 'https://betics.io/Promo');
  assert.equal(validUrl('https://t.me/Betics_casino', support), 'https://t.me/Betics_casino');
});

test('N2: removing or demoting an owner needs the step-up and alerts; "one active owner" holds even when two owners remove each other at once', async () => {
  const s = setup();
  const a = await s.admin('a@example.com', 'owner');
  const b = await s.admin('b@example.com', 'owner');
  s.cookie = null; s.resetCodes();
  assert.equal((await s.call('POST', '/api/auth/login', { email: a.email, password: PASSWORD, code: await a.code(0) })).status, 200);
  assert.equal((await s.call('PUT', `/api/admins/${b.id}`, { role: 'finance' })).data.code, 'bad_password', 'demoting an owner needs the step-up');
  assert.equal((await s.call('PUT', `/api/admins/${b.id}`, { active: false })).data.code, 'bad_password', 'removing an owner needs the step-up');
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND active = 1").get().n, 2);
  // Both owners remove each other at the same moment: exactly one wins.
  s.resetCodes(); s.DB.raw.prepare('DELETE FROM admin_login_attempts').run();
  const me = id => ({ id, email: id === a.id ? a.email : b.email, role: 'owner' });
  const res = await Promise.allSettled([
    updateAdmin(s.DB, s.env, me(a.id), b.id, { active: false, password: PASSWORD, code: await a.code(1) }),
    updateAdmin(s.DB, s.env, me(b.id), a.id, { active: false, password: PASSWORD, code: await b.code(1) })]);
  assert.equal(res.filter(r => r.status === 'fulfilled').length, 1, JSON.stringify(res.map(r => r.reason?.message)));
  assert.equal(res.find(r => r.status === 'rejected').reason.code, 'last_owner');
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND active = 1").get().n, 1);
  const al = s.alerts('admin_owner_removed');
  assert.equal(al.length, 1); assert.equal(al[0].severity, 'critical');
});

test('N3: if the alert batch fails, the watermark does not move and the alerts come on the next run', async () => {
  const s = setup();
  s.DB.raw.prepare("INSERT INTO players (id, total_bet_cents, total_paid_cents) VALUES ('p1', 0, 0)").run();
  const t0 = new Date();
  await runChecks(s.DB, t0);
  seedRound(s, 'big', 'p1', 100, 900_000_000);
  s.DB.state.failNext = true;
  await assert.rejects(runChecks(s.DB, new Date(t0.getTime() + CHECK_EVERY_MS)));
  assert.equal(s.alerts('big_win').length, 0);
  const state = JSON.parse(s.DB.raw.prepare("SELECT value FROM settings WHERE key = 'alerts_rounds'").get().value);
  assert.ok(state.rid < s.DB.raw.prepare("SELECT rowid FROM rounds WHERE id = 'big'").get().rowid, 'watermark not moved past the unalerted round');
  assert.ok(await runChecks(s.DB, new Date(t0.getTime() + CHECK_EVERY_MS)) >= 1, 'not skipped: the failed run left no mark');
  assert.equal(s.alerts('big_win').length, 1, 'the big win is raised on the retry');
});

test('L2: Telegram sends critical alerts first, then by id', async () => {
  const s = setup();
  const add = (sev, key) => s.DB.raw.prepare("INSERT INTO alerts (type, severity, title, dedupe_key) VALUES ('x', ?, ?, ?)").run(sev, key, key);
  for (let i = 0; i < 12; i++) add('info', `info${i}`);
  add('warning', 'warn1'); add('critical', 'crit1');
  const sent = [];
  await sendTelegram(s.DB, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }, async (url, init) => { sent.push(JSON.parse(init.body).text.split('\n')[0]); return new Response('{}'); });
  assert.equal(sent.length, 10);
  assert.match(sent[0], /URGENT: crit1/); assert.match(sent[1], /warn1/); assert.match(sent[2], /info0/);
});

test('L3/L5: a reused (right) code gives the step-up slot back; wrong codes are capped per admin per day with an alert', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  const row = { id: own.id };
  // L3: six "code already used" answers in a row do not lock the confirmations.
  s.resetCodes();
  await confirmSensitive(s.DB, s.env, row, { code: await own.code(0) });
  for (let i = 0; i < 6; i++) await assert.rejects(confirmSensitive(s.DB, s.env, row, { code: await own.code(0) }), e => e.code === 'code_used');
  await confirmSensitive(s.DB, s.env, row, { code: await own.code(1) });
  // L5: DAILY_CODE_LIMIT wrong codes in 24 hours (spread out, so the 15-minute limit never hits): every code refused, one critical alert.
  const base = Math.floor(Date.now() / 864e5) * 864e5 + 3600e3; // 01:00 UTC today: the whole run stays inside one UTC day (alerts dedupe per day)
  for (let i = 0; i < DAILY_CODE_LIMIT; i++) {
    const at = base + i * 16 * 60e3;
    await assert.rejects(confirmSensitive(s.DB, s.env, row, { code: '000000' }, at), e => e.code === 'bad_code');
  }
  assert.equal(s.alerts('admin_codes_locked').length, 1);
  assert.equal(s.alerts('admin_codes_locked')[0].severity, 'critical');
  const later = base + DAILY_CODE_LIMIT * 16 * 60e3;
  await assert.rejects(confirmSensitive(s.DB, s.env, row, { code: '000000' }, later), e => e.status === 429 && e.code === 'codes_locked');
  // Separate pools: wrong codes inside a signed-in session (or from a known network) never use up the
  // pool for unknown networks, and the other way round, so someone with only the password cannot lock
  // the owner's own codes.
  const r = await login(s.DB, s.env, new Request(`${ORIGIN}/api/auth/login`, { headers: { 'CF-Connecting-IP': '4.4.4.4' } }), { email: own.email, password: PASSWORD, code: '000000' }, later).catch(e => e);
  assert.equal(r.code, 'bad_code');
  assert.equal(s.alerts('admin_codes_locked').length, 1, 'one alert per day');
  // A day after the first wrong code, slots free up again.
  await assert.rejects(confirmSensitive(s.DB, s.env, row, { code: '000000' }, base + 864e5 + 60e3), e => e.code === 'bad_code');
});

test('L5: IPv6 addresses count per /64 network', async () => {
  assert.equal(networkOf('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(networkOf('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(networkOf('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(networkOf('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(networkOf('1.2.3.4'), '1.2.3.4');
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  s.cookie = null;
  for (let i = 0; i < 5; i++) await s.call('POST', '/api/auth/login', { email: own.email, password: 'wrong 123456789' }, { ip: `2001:db8:1:2::${i + 10}`, keepCookie: false });
  assert.equal((await s.call('POST', '/api/auth/login', { email: own.email, password: PASSWORD }, { ip: '2001:db8:1:2:dead:beef:0:1', keepCookie: false })).status, 429, 'same /64: same limit');
  assert.equal((await s.call('POST', '/api/auth/login', { email: own.email, password: PASSWORD }, { ip: '2001:db8:1:3::1', keepCookie: false })).status, 200, 'another /64');
});

test('L6: "new device" follows a signed long-lived device cookie, not the IP', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  const signIn = async opts => { s.resetCodes(); s.cookie = null; return s.call('POST', '/api/auth/login', { email: own.email, password: PASSWORD, code: await own.code(0) }, opts); };
  const first = await signIn({ ip: '10.0.0.1' });
  assert.equal(first.status, 200);
  const dc = first.headers.getSetCookie().find(c => c.startsWith('__Host-admin_device='));
  assert.match(dc, /^__Host-admin_device=[a-f0-9]{32}\.[a-f0-9]{32}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d{7,}$/);
  assert.ok(first.headers.getSetCookie().some(c => c.startsWith('__Host-admin_session=')));
  assert.equal(s.alerts('admin_new_device').length, 0, 'same browser as setup');
  // Phone on mobile data: new IP and even a new browser version, same device cookie -> no alert.
  assert.equal((await signIn({ ip: '100.64.9.9', ua: 'test-browser 2' })).status, 200);
  assert.equal(s.alerts('admin_new_device').length, 0);
  // A forged device cookie is treated as a new device.
  const saved = s.device;
  s.device = saved.replace(/\.[a-f0-9]{32}$/, '.' + '0'.repeat(32));
  assert.equal((await signIn({ ip: '10.0.0.1' })).status, 200);
  assert.equal(s.alerts('admin_new_device').length, 1);
  // A browser with no device cookie: alert.
  s.device = saved;
  assert.equal((await signIn({ ip: '10.0.0.1', device: false })).status, 200);
  assert.equal(s.alerts('admin_new_device').length, 2);
});

test('L4: money-affecting settings need the step-up; the minimum withdrawal is capped', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  const put = (path, body) => s.call('PUT', path, body);
  for (const [k, v] of [['startBlock', 123], ['minWithdrawalUnits', 5_000_000], ['fallbackFeeUnits', 40000], ['gasFeeMarginPct', 30], ['depositsOpen', false], ['quickDailyMaxUnits', 10_000]]) {
    assert.equal((await put('/api/tics/settings', { [k]: v })).status, 401, `${k} needs the step-up`);
    assert.equal((await put('/api/tics/settings', { [k]: v, ...(await s.stepUp(own)) })).status, 200, k);
  }
  assert.equal((await put('/api/tics/settings', { minWithdrawalUnits: 10_000_001, ...(await s.stepUp(own)) })).status, 400, 'at most 100,000 TICS');
  assert.equal((await put('/api/tics/settings', { minWithdrawalUnits: 10_000_000, ...(await s.stepUp(own)) })).status, 200);
  assert.equal((await put('/api/tics/settings', { quickDailyMaxUnits: null, ...(await s.stepUp(own)) })).status, 200, 'empty = same as one quick deposit');
  assert.equal((await put('/api/tics/settings', { quickDailyMaxUnits: 100_000_001, ...(await s.stepUp(own)) })).status, 400);
  assert.equal((await put('/api/settings/limits', { bigWinAlertCents: 999900 })).status, 401, 'alert limits need the step-up');
  assert.equal((await put('/api/settings/limits', { bigWinAlertCents: 999900, ...(await s.stepUp(own)) })).status, 200);
  assert.equal((await put('/api/games/roulette', { maxStakeCents: 12345 })).status, 401, 'game limits need the step-up');
  assert.equal((await put('/api/games/roulette', { maxStakeCents: 12345, ...(await s.stepUp(own)) })).status, 200);
  assert.equal((await put('/api/games/roulette', { enabled: false })).status, 200, 'switching a game off stays one click');
  assert.equal((await put('/api/bank', { reservePct: 30 })).status, 401, 'bank settings need the step-up');
  assert.equal((await put('/api/bank', { reservePct: 30, ...(await s.stepUp(own)) })).status, 200);
});

test('status contract: blocked and cancelling are owed and labelled; "Failed, money returned" is only for failed', async () => {
  const s = setup();
  s.DB.raw.prepare("INSERT INTO players (id, wallet_address, real_tics_cents) VALUES (?, ?, 1000)").run(A1, A1);
  const add = (id, status, units) => s.DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at)
    VALUES (?, 'player', ?, 1, ?, ?, 0, ?, ?, datetime('now'))`).run(id, A1, A1, units, units, status);
  add('w-b', 'blocked', 200); add('w-c', 'cancelling', 30); add('w-f', 'failed', 4); add('w-x', 'cancelled', 5); add('w-q', 'queued', 1);
  const o = await owedBreakdown(s.DB);
  assert.equal(o.pendingUnits, 231); assert.equal(o.owedUnits, 1231);
  await s.admin('dez@example.com', 'owner');
  const open = (await s.call('GET', '/api/tics/payments?status=open')).data.withdrawals.map(w => w.status).sort();
  assert.deepEqual(open, ['blocked', 'cancelling', 'failed', 'queued']);
  assert.equal((await s.call('GET', '/api/tics/payments?status=blocked')).data.withdrawals.length, 1);
  assert.equal((await s.call('GET', `/api/players/${A1}`)).data.pendingWithdrawalUnits, 231);
  const lib = readFileSync(new URL('../public/js/lib.js', import.meta.url), 'utf8');
  assert.match(lib, /blocked: \['off', 'Stopped, needs review', '[^']*money is still held[^']*'\]/);
  assert.match(lib, /cancelling: \['warn', 'Cancelling'/);
  const ui = ['lib.js', 'views/tics.js', 'views/players.js', 'views/payments.js'].map(f => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.deepEqual(ui.match(/[a-z_]+: \['[a-z]+', 'Failed, money returned'/g), ["failed: ['off', 'Failed, money returned'"]);
  const tics = readFileSync(new URL('../public/js/views/tics.js', import.meta.url), 'utf8');
  for (const k of ['startBlock', 'minWithdrawalUnits', 'fallbackFeeUnits', 'gasFeeMarginPct', 'depositsOpen', 'quickDailyMaxUnits']) assert.match(tics.match(/const SENSITIVE = \[[^\]]+\]/)[0], new RegExp(`'${k}'`));
});
