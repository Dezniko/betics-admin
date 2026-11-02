// $TICS admin features: treasury, payout settings, payouts queue, deposits,
// wallet players search/export, and that the encrypted key never leaks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createD1 } from './d1shim.mjs';
import worker from '../src/index.js';
import { hotp } from '../src/totp.js';
import { makeSetupToken } from '../src/auth.js';
import { feeQuote } from '../src/api/tics.js';
import { normAddress, keccak256, toChecksumAddress } from '../src/eth.js';

const MIGRATION = new URL('./schema.sql', import.meta.url).pathname;
const ORIGIN = 'https://admin.betics.io';
const PASSWORD = 'correct horse 42 battery';
const KEY_CT = 'CIPHERTEXT-must-never-leave-9f8e7d';
const A1 = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const A2 = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const TREASURY_CHECKSUM = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';
const TX = '0x' + 'ab'.repeat(32);

function setup({ payouts = true, float = 10_000_000 } = {}) {
  const DB = createD1([MIGRATION]);
  DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('casino_key_ct', ?)").run(JSON.stringify(KEY_CT));
  if (float != null) DB.raw.prepare("INSERT INTO chain_state (key, value) VALUES ('float', ?)").run(JSON.stringify({ at: Date.now(), chainId: 1, wallet: A2, tokenUnits: float, ethWei: '1' }));
  const payoutCalls = [], walletCalls = [];
  const payoutReplies = { '/status': () => Response.json({ casinoWallet: A2, treasuryAddress: null, paused: false, pausedReason: null, chainId: 1, queue: { queued: 1 },
    keyConfigured: true, tokenUnits: 500000, ethWei: '20000000000000000', owedUnits: 120000, freeUnits: 380000, casino_key_ct: KEY_CT, privateKey: KEY_CT }) };
  const env = {
    DB, SESSION_PEPPER: 'pepper', INTERNAL_SECRET: 'secret', TREASURY_SECRET: 'treasury-secret',
    ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) },
    WALLETS: { idFromName: n => n, get: id => ({ fetch: async req => {
      assert.equal(req.headers.get('X-Internal-Secret'), 'secret');
      const body = await req.json(); const path = new URL(req.url).pathname;
      const dup = walletCalls.some(c => c.body.ref === body.ref);
      walletCalls.push({ id, path, body });
      return Response.json({ duplicate: dup, realTicsCents: body.amountCents });
    } }) },
    ...(payouts ? { PAYOUTS: { fetch: async req => {
      const path = new URL(req.url).pathname;
      const body = req.method === 'POST' ? await req.json() : null;
      payoutCalls.push({ path, body, secret: req.headers.get('X-Internal-Secret'), treasurySecret: req.headers.get('X-Treasury-Secret'), method: req.method });
      if (req.headers.get('X-Internal-Secret') !== 'secret') return Response.json({ error: 'not found' }, { status: 404 });
      if (payoutReplies[path]) return payoutReplies[path](body);
      return Response.json({ ok: true, sent: 0 });
    } } } : {}),
  };
  let cookie = null;
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined }), env);
    const set = res.headers.get('Set-Cookie'); if (set) cookie = set.split(';')[0];
    const type = res.headers.get('Content-Type') || '';
    const raw = await res.text();
    return { status: res.status, raw, data: type.includes('json') ? JSON.parse(raw) : raw };
  };
  // fresh: keep the 48 hour wait a brand-new owner has before treasury actions (most tests skip it).
  const admin = async (email, role, { fresh = false } = {}) => {
    DB.raw.prepare('INSERT INTO admins (email, name, role) VALUES (?, ?, ?)').run(email, email.split('@')[0], role);
    const id = DB.raw.prepare('SELECT id FROM admins WHERE email = ?').get(email).id;
    const token = await makeSetupToken(DB, id);
    cookie = null;
    const pw = await call('POST', '/api/auth/setup/password', { token, password: PASSWORD });
    const step = Math.floor(Date.now() / 30000);
    assert.equal((await call('POST', '/api/auth/setup/code', { token, code: await hotp(pw.data.secret, step) })).status, 200);
    if (!fresh) DB.raw.prepare('UPDATE admins SET treasury_ok_after = NULL WHERE id = ?').run(id);
    return { id, secret: pw.data.secret, step, code: d => hotp(pw.data.secret, step + d) };
  };
  const resetCodes = () => DB.raw.prepare("UPDATE settings SET value = '{}' WHERE key = 'admin_totp_steps'").run();
  const setTics = obj => DB.raw.prepare("UPDATE settings SET value = json_patch(value, ?) WHERE key = 'tics_payments'").run(JSON.stringify(obj));
  const tics = () => JSON.parse(DB.raw.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").get().value);
  const player = (id, extra = {}) => DB.raw.prepare(`INSERT INTO players (id, wallet_address, country, city, real_tics_cents, holdings_usd, first_connected_at, last_connected_at, total_bet_cents, total_paid_cents, rounds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, extra.wallet === undefined ? id : extra.wallet, extra.country || 'DE', extra.city || 'Berlin', extra.real ?? 0, extra.holdings ?? null,
    extra.first || '2026-10-01 10:00:00', extra.last ?? "2026-10-27 10:00:00", extra.bet ?? 0, extra.paid ?? 0, extra.rounds ?? 0);
  return { DB, env, call, admin, resetCodes, setTics, tics, player, payoutCalls, walletCalls, payoutReplies };
}

test('eth: keccak256 and EIP-55 checksums match known vectors', () => {
  assert.equal(keccak256(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', TREASURY_CHECKSUM, '0x551ecFDBa071cB6541f642cB90a073c8c158Df05'])
    assert.equal(toChecksumAddress(a), a);
  assert.equal(normAddress('0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), null, 'bad checksum refused');
  assert.equal(normAddress(A1.toUpperCase().replace('0X', '0x')), A1);
  assert.equal(normAddress('0x123'), null);
});

test('treasury send: owner only, fresh code every time, calls the payouts Worker with the secret, audited', async () => {
  const s = setup();
  const fin = await s.admin('fin@example.com', 'finance');
  assert.equal((await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1000, code: await fin.code(1) })).status, 403);
  assert.equal((await s.call('GET', '/api/tics/treasury')).status, 403);
  const own = await s.admin('dez@example.com', 'owner');
  assert.equal((await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1000, code: await own.code(1) })).status, 400, 'no treasury address yet');
  s.setTics({ treasuryAddress: A1, casinoWallet: A2 });
  assert.equal((await s.call('POST', '/api/tics/treasury/send', { amountUnits: 0, code: await own.code(1) })).status, 400);
  assert.equal((await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1000 })).status, 401, 'code required');
  assert.equal((await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1000, code: '000000' })).data.code, 'bad_code');
  // The code used to sign in cannot also send money.
  const reuse = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1000, code: await own.code(0) });
  assert.equal(reuse.status, 401); assert.equal(reuse.data.code, 'code_used');
  assert.equal(s.payoutCalls.filter(c => c.path === '/treasury').length, 0);
  const ok = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 123450, code: await own.code(1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const sent = s.payoutCalls.find(c => c.path === '/treasury');
  assert.equal(sent.secret, 'secret');
  assert.equal(sent.body.amountUnits, 123450);
  assert.equal(sent.body.requestedBy, 'dez@example.com');
  assert.match(sent.body.id, /^[0-9a-f-]{36}$/);
  const a = s.DB.raw.prepare("SELECT * FROM admin_audit WHERE action = 'tics.treasury_send'").get();
  assert.equal(JSON.parse(a.after_json).amountUnits, 123450);
  assert.equal(JSON.parse(a.after_json).to, A1);
  // Same code again: refused, and the payouts Worker is not called a second time.
  assert.equal((await s.call('POST', '/api/tics/treasury/send', { amountUnits: 100, code: await own.code(1) })).data.code, 'code_used');
  assert.equal(s.payoutCalls.filter(c => c.path === '/treasury').length, 1);
  // A refusal from the payouts Worker (e.g. more than the free float) is shown and audited.
  s.resetCodes();
  s.payoutReplies['/treasury'] = () => Response.json({ error: 'Only 3,800.00 TICS is free. The rest is owed to players.' }, { status: 400 });
  const refused = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 900000, code: await own.code(1) });
  assert.equal(refused.status, 400); assert.match(refused.data.error, /is free/);
  assert.ok(s.DB.raw.prepare("SELECT 1 FROM admin_audit WHERE action = 'tics.treasury_send_refused'").get());
});

test('treasury page shows the live status, and a clear problem when the payouts Worker is missing or refuses', async () => {
  const s = setup({ payouts: false });
  await s.admin('dez@example.com', 'owner');
  let t = await s.call('GET', '/api/tics/treasury');
  assert.equal(t.status, 200);
  assert.equal(t.data.status, null);
  assert.equal(t.data.statusProblem.problem, 'not_connected');
  const s2 = setup();
  await s2.admin('dez@example.com', 'owner');
  t = await s2.call('GET', '/api/tics/treasury');
  assert.equal(t.data.status.freeUnits, 380000);
  assert.equal(t.data.status.privateKey, undefined, 'only known status fields pass through');
  s2.env.INTERNAL_SECRET = 'wrong';
  s2.env.WALLETS = s2.env.WALLETS; // unchanged
  t = await s2.call('GET', '/api/tics/treasury');
  assert.equal(t.data.statusProblem.problem, 'refused');
  s2.env.PAYOUTS = { fetch: async () => { throw new Error('network'); } };
  t = await s2.call('GET', '/api/tics/treasury');
  assert.equal(t.data.statusProblem.problem, 'unreachable');
});

test('treasury address: needs password and a fresh code, validates the address, stores lowercase, raises a critical alert', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  s.setTics({ casinoWallet: A2 });
  const put = body => s.call('PUT', '/api/tics/treasury/address', body);
  assert.equal((await put({ address: '0x1234', password: PASSWORD, code: await own.code(1) })).status, 400);
  assert.equal((await put({ address: '0xdbf03B407c01E7cD3CBea99509d93f8DDDC8C6FB', password: PASSWORD, code: await own.code(1) })).status, 400, 'bad checksum');
  assert.equal((await put({ address: A2, password: PASSWORD, code: await own.code(1) })).status, 400, 'not the casino wallet');
  assert.equal((await put({ address: TREASURY_CHECKSUM, password: 'wrong password 1', code: await own.code(1) })).data.code, 'bad_password');
  assert.equal((await put({ address: TREASURY_CHECKSUM, password: PASSWORD })).data.code, 'bad_code');
  assert.equal(s.tics().treasuryAddress, null);
  const ok = await put({ address: TREASURY_CHECKSUM, password: PASSWORD, code: await own.code(1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(s.tics().treasuryAddress, TREASURY_CHECKSUM.toLowerCase());
  const alert = s.DB.raw.prepare("SELECT * FROM alerts WHERE type = 'tics_treasury_changed'").get();
  assert.equal(alert.severity, 'critical');
  assert.match(alert.details, new RegExp(TREASURY_CHECKSUM.toLowerCase()));
  const a = s.DB.raw.prepare("SELECT * FROM admin_audit WHERE action = 'tics.treasury_address'").get();
  assert.equal(JSON.parse(a.after_json).treasuryAddress, TREASURY_CHECKSUM.toLowerCase());
  assert.equal((await put({ address: A1, password: PASSWORD, code: await own.code(1) })).data.code, 'code_used');
  // Finance cannot change it at all.
  const fin = await s.admin('fin@example.com', 'finance');
  assert.equal((await put({ address: A1, password: PASSWORD, code: await fin.code(1) })).status, 403);
});

test('TICS settings are validated, audited with before and after, and never overwrite a pause set meanwhile', async () => {
  const s = setup();
  const own = await s.admin('dez@example.com', 'owner');
  const put = body => s.call('PUT', '/api/tics/settings', body);
  for (const bad of [{ confirmations: 0 }, { coolingSeconds: -1 }, { minDepositUnits: 0 }, { minWithdrawalUnits: 1.5 }, { minWithdrawalUnits: 0 }, { withdrawalFeeUnits: 100 }, { feeMode: 'fixed' }, { feesEnabled: 'no' }, { fallbackFeeUnits: -1 },
    { gasFeeMarginPct: 201 }, { minFeeMultiple: 5 }, { gasFeeMarginPct: -1 }, { lowEthWei: '1e18' }, { lowEthWei: 5 }, { startBlock: -3 }, { realEnabled: 'yes' },
    { lowFloatUnits: 5000, highFloatUnits: 4000 }, { treasuryAddress: A1 }, { casinoWallet: A1 }, { payoutsPaused: true }, { somethingElse: 1 }, { casino_key_ct: 'x' }])
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  // The payouts Worker pauses itself between our read and write: the pause must survive.
  s.setTics({ payoutsPaused: true, pausedReason: 'balance check failed' });
  s.resetCodes();
  const ok = await put({ password: PASSWORD, code: await own.code(1), confirmations: 6, coolingSeconds: 60, realEnabled: true, minWithdrawalUnits: 2000, feesEnabled: false, gasFeeMarginPct: 35,
    fallbackFeeUnits: 1000, lowEthWei: '1000000000000000', startBlock: 21000000, highFloatUnits: 9000000, lowFloatUnits: 100000 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const t = s.tics();
  assert.equal(t.confirmations, 6); assert.equal(t.coolingSeconds, 60); assert.equal(t.feesEnabled, false); assert.equal(t.minWithdrawalUnits, 2000); assert.equal(t.gasFeeMarginPct, 35);
  assert.equal(t.fallbackFeeUnits, 1000); assert.equal(t.payoutsPaused, true); assert.equal(t.pausedReason, 'balance check failed');
  const a = s.DB.raw.prepare("SELECT * FROM admin_audit WHERE action = 'settings.tics_payments'").get();
  assert.equal(JSON.parse(a.before_json).confirmations, 12);
  assert.equal(JSON.parse(a.after_json).confirmations, 6);
  assert.equal(JSON.parse(a.after_json).payoutsPaused, undefined);
  // Pause and resume are owner actions, audited, and resume nudges the queue.
  assert.equal((await s.call('POST', '/api/tics/payouts/pause', { paused: true })).status, 400, 'reason needed');
  assert.equal((await s.call('POST', '/api/tics/payouts/pause', { paused: false })).status, 401, 'resume needs the password and a fresh code');
  s.resetCodes();
  assert.equal((await s.call('POST', '/api/tics/payouts/pause', { paused: false, password: PASSWORD, code: await own.code(1) })).status, 200);
  assert.equal(s.tics().payoutsPaused, false);
  assert.ok(s.payoutCalls.some(c => c.path === '/process'));
  assert.equal((await s.call('POST', '/api/tics/payouts/pause', { paused: true, reason: 'sending from MetaMask' })).status, 200);
  assert.equal(s.tics().pausedReason, 'sending from MetaMask');
  assert.deepEqual(s.DB.raw.prepare("SELECT action FROM admin_audit WHERE action LIKE 'tics.payouts_%' ORDER BY id").all().map(r => r.action), ['tics.payouts_resume', 'tics.payouts_pause']);
  await s.admin('help@example.com', 'support');
  assert.equal((await put({ confirmations: 5 })).status, 403);
  assert.equal((await s.call('POST', '/api/tics/payouts/pause', { paused: false })).status, 403);
});

test('fee quote: live gas priced in TICS with the margin, off switch and stale data fallback', () => {
  const now = 1_800_000_000_000;
  const settings = { feesEnabled: true, gasFeeMarginPct: 20, fallbackFeeUnits: 50000 };
  const gas = { at: now - 60e3, baseFeeWei: '10000000000', tipWei: '1000000000' };
  const prices = { at: now - 60e3, ticsEth: 0.00001, ticsUsd: 0.03, source: 'alchemy' };
  const q = feeQuote(settings, gas, prices, now);
  // 52000 * (1.25*10 gwei + 1 gwei) = 0.000702 ETH = 70.2 TICS, +20% = 84.24 TICS.
  assert.ok(q.feeUnits === 8424 || q.feeUnits === 8425, String(q.feeUnits));
  assert.equal(q.source, 'alchemy');
  assert.equal(feeQuote({ ...settings, gasFeeMarginPct: 0 }, gas, prices, now).feeUnits, 7020);
  assert.deepEqual(feeQuote({ ...settings, feesEnabled: false }, gas, prices, now), { feeUnits: 0, source: 'off' });
  const staleGas = feeQuote(settings, { ...gas, at: now - 11 * 60e3 }, prices, now);
  assert.equal(staleGas.source, 'fallback'); assert.equal(staleGas.feeUnits, 50000); assert.equal(staleGas.gasStale, true);
  const stalePrice = feeQuote(settings, gas, { ...prices, at: now - 61 * 60e3 }, now);
  assert.equal(stalePrice.source, 'fallback'); assert.equal(stalePrice.priceStale, true);
  assert.equal(feeQuote(settings, gas, { ...prices, at: now - 59 * 60e3 }, now).source, 'alchemy');
  assert.equal(feeQuote(settings, null, null, now).source, 'fallback');
});

test('fees page: owner only, only fee keys, validated and audited', async () => {
  const s = setup();
  await s.admin('fin@example.com', 'finance');
  assert.equal((await s.call('GET', '/api/tics/fees')).status, 403);
  assert.equal((await s.call('PUT', '/api/tics/fees', { feesEnabled: false })).status, 403);
  const own = await s.admin('dez@example.com', 'owner');
  const now = Date.now();
  s.DB.raw.prepare("INSERT INTO chain_state (key, value) VALUES ('gas', ?), ('prices', ?)").run(JSON.stringify({ at: now - 60e3, baseFeeWei: '10000000000', tipWei: '1000000000' }),
    JSON.stringify({ at: now - 60e3, ticsEth: 0.00001, ticsUsd: 0.03, source: 'alchemy' }));
  const f = await s.call('GET', '/api/tics/fees');
  assert.equal(f.status, 200);
  assert.deepEqual(f.data.settings, { feesEnabled: true, gasFeeMarginPct: 20, fallbackFeeUnits: 50000, minWithdrawalUnits: 10000000 });
  assert.ok(f.data.quote.feeUnits >= 8424);
  assert.equal((await s.call('PUT', '/api/tics/fees', { minWithdrawalUnits: 5 })).status, 400, 'minimum withdrawal belongs to the TICS settings');
  assert.equal((await s.call('PUT', '/api/tics/fees', { gasFeeMarginPct: 250 })).status, 400);
  // L4: the fallback fee and the margin decide what players are charged: password + fresh code.
  assert.equal((await s.call('PUT', '/api/tics/fees', { feesEnabled: false, gasFeeMarginPct: 10, fallbackFeeUnits: 30000 })).data.code, 'bad_password');
  assert.equal(s.tics().fallbackFeeUnits, 50000, 'nothing saved without the step-up');
  const off = await s.call('PUT', '/api/tics/fees', { feesEnabled: false, gasFeeMarginPct: 10, fallbackFeeUnits: 30000, password: PASSWORD, code: await own.code(1) });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.deepEqual(off.data.quote, { feeUnits: 0, source: 'off' });
  assert.equal(s.tics().fallbackFeeUnits, 30000);
  const a = s.DB.raw.prepare("SELECT * FROM admin_audit WHERE action = 'settings.tics_payments' ORDER BY id DESC").get();
  assert.deepEqual(JSON.parse(a.before_json), { feesEnabled: true, gasFeeMarginPct: 20, fallbackFeeUnits: 50000 });
  assert.deepEqual(JSON.parse(a.after_json), { feesEnabled: false, gasFeeMarginPct: 10, fallbackFeeUnits: 30000 });
});

test('payouts queue: lists fee and send amounts, cancel calls the payouts Worker for queued only, audited', async () => {
  const s = setup();
  s.player(A1, { real: 5000 });
  const add = (id, status) => s.DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, attempts, last_error)
    VALUES (?, 'player', ?, 1, ?, 20000, 1500, 18500, ?, datetime('now','+2 minutes'), 1, 'temporary rpc error')`).run(id, A1, A1, status);
  add('11111111-1111-4111-8111-111111111111', 'queued'); add('22222222-2222-4222-8222-222222222222', 'sending');
  await s.admin('help@example.com', 'support');
  assert.equal((await s.call('POST', '/api/tics/withdrawals/11111111-1111-4111-8111-111111111111/cancel', {})).status, 403);
  await s.admin('fin@example.com', 'finance');
  const list = await s.call('GET', '/api/tics/payments?status=open');
  assert.equal(list.status, 200);
  assert.equal(list.data.withdrawals.length, 2);
  const w = list.data.withdrawals.find(x => x.status === 'queued');
  assert.equal(w.fee_units, 1500); assert.equal(w.send_units, 18500); assert.equal(w.last_error, 'temporary rpc error');
  assert.equal((await s.call('GET', '/api/tics/payments?status=sending')).data.withdrawals.length, 1);
  assert.equal((await s.call('GET', '/api/tics/payments?status=bogus')).status, 400);
  assert.equal((await s.call('POST', '/api/tics/withdrawals/22222222-2222-4222-8222-222222222222/cancel', {})).status, 409);
  assert.equal(s.payoutCalls.filter(c => c.path === '/cancel').length, 0, 'not called for a payout already sending');
  const ok = await s.call('POST', '/api/tics/withdrawals/11111111-1111-4111-8111-111111111111/cancel', {});
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const c = s.payoutCalls.find(x => x.path === '/cancel');
  assert.deepEqual(c.body, { id: '11111111-1111-4111-8111-111111111111', by: 'fin@example.com' });
  assert.equal(c.secret, 'secret');
  assert.ok(s.DB.raw.prepare("SELECT 1 FROM admin_audit WHERE action = 'tics.withdrawal_cancel' AND target = 'chain_withdrawal:11111111-1111-4111-8111-111111111111'").get());
  // The payouts Worker says it is too late: shown as a conflict.
  s.DB.raw.prepare("UPDATE chain_withdrawals SET status = 'queued' WHERE id = '22222222-2222-4222-8222-222222222222'").run();
  s.payoutReplies['/cancel'] = () => Response.json({ error: 'Only a withdrawal that has not been sent yet can be cancelled.' }, { status: 409 });
  assert.equal((await s.call('POST', '/api/tics/withdrawals/22222222-2222-4222-8222-222222222222/cancel', {})).status, 409);
});

test('unmatched deposit: owner assigns it to an existing player through the wallet with the exact ref, once', async () => {
  const s = setup();
  s.player(A1);
  const id = `1:${TX}:3`;
  s.DB.raw.prepare(`INSERT INTO chain_deposits (id, chain_id, tx_hash, log_index, block_number, from_address, to_address, amount_wei, amount_units, status)
    VALUES (?, 1, ?, 3, 21000000, ?, ?, '250000000000000000000', 25000, 'unmatched')`).run(id, TX, A2, A2);
  const path = `/api/tics/deposits/${encodeURIComponent(id)}/assign`;
  await s.admin('fin@example.com', 'finance');
  assert.equal((await s.call('POST', path, { address: A1, note: 'player emailed the tx' })).status, 403);
  const own = await s.admin('dez@example.com', 'owner');
  const up = async () => { s.resetCodes(); return { password: PASSWORD, code: await own.code(1) }; };
  assert.equal((await s.call('POST', path, { address: A1 })).status, 400, 'note required');
  assert.equal((await s.call('POST', path, { address: '0xnope', note: 'x player' })).status, 400);
  assert.equal((await s.call('POST', path, { address: '0x' + '1'.repeat(40), note: 'unknown wallet' })).status, 404);
  // Real TICS move: password and a fresh code (re-audit 3 F2).
  assert.equal((await s.call('POST', path, { address: A1, note: 'player emailed the tx' })).status, 401, 'needs password and code');
  assert.equal((await s.call('POST', path, { address: A1, note: 'player emailed the tx', password: 'wrong password 1', code: await own.code(1) })).data.code, 'bad_password');
  assert.equal(s.walletCalls.length, 0);
  assert.equal(s.DB.raw.prepare('SELECT status FROM chain_deposits WHERE id = ?').get(id).status, 'unmatched', 'not claimed without step-up');
  const ok = await s.call('POST', path, { address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', note: 'player emailed the tx', ...(await up()) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(s.walletCalls.length, 1);
  assert.equal(s.walletCalls[0].id, A1);
  assert.equal(s.walletCalls[0].path, '/internal/tics-deposit');
  assert.equal(s.walletCalls[0].body.ref, `td:1-${TX}-3`);
  assert.equal(s.walletCalls[0].body.amountCents, 25000);
  assert.equal(s.walletCalls[0].body.playerId, A1);
  assert.equal(s.walletCalls[0].body.note, 'player emailed the tx');
  const row = s.DB.raw.prepare('SELECT * FROM chain_deposits WHERE id = ?').get(id);
  assert.equal(row.status, 'assigned'); assert.equal(row.player_id, A1); assert.ok(row.credited_at); assert.equal(row.note, 'player emailed the tx');
  // Second call: no second credit.
  const again = await s.call('POST', path, { address: A1, note: 'player emailed the tx' });
  assert.equal(again.status, 200); assert.equal(again.data.duplicate, true);
  assert.equal(s.walletCalls.length, 1);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'tics.deposit_assign'").get().n, 1);
  // Another player cannot take it now.
  s.player(A2);
  assert.equal((await s.call('POST', path, { address: A2, note: 'wrong person' })).status, 409);
  // A clear refusal from the wallet (4xx) leaves the deposit unmatched so it can be tried again.
  const id2 = `1:${'0x' + 'cd'.repeat(32)}:0`;
  s.DB.raw.prepare(`INSERT INTO chain_deposits (id, chain_id, tx_hash, log_index, block_number, from_address, to_address, amount_wei, amount_units, status)
    VALUES (?, 1, ?, 0, 21000001, ?, ?, '1', 500, 'unmatched')`).run(id2, '0x' + 'cd'.repeat(32), A2, A2);
  const wallets = s.env.WALLETS;
  s.env.WALLETS = { idFromName: n => n, get: () => ({ fetch: async () => Response.json({ error: 'boom' }, { status: 400 }) }) };
  assert.equal((await s.call('POST', `/api/tics/deposits/${encodeURIComponent(id2)}/assign`, { address: A1, note: 'try one', ...(await up()) })).status, 502);
  assert.equal(s.DB.raw.prepare('SELECT status FROM chain_deposits WHERE id = ?').get(id2).status, 'unmatched');
  s.env.WALLETS = wallets;
  const list = await s.call('GET', '/api/tics/payments?deposits=unmatched');
  assert.equal(list.data.deposits.length, 1);
});

test('players: search by part of a wallet address in any case, wallet filters and the CSV export', async () => {
  const s = setup();
  s.player(A1, { holdings: 1520.5, real: 12345, bet: 10000, paid: 4000, rounds: 7, country: 'DE', city: 'Berlin, Mitte' });
  s.player(A2, { holdings: 12, country: 'TR', city: 'Istanbul', last: '2020-01-01 00:00:00' });
  s.player('guest-1', { wallet: null, country: 'GB' });
  s.DB.raw.prepare("INSERT INTO player_identities (kind, value, player_id, consent) VALUES ('email', 'ana@example.com', ?, 1)").run(A1);
  s.DB.raw.prepare("INSERT INTO player_identities (kind, value, player_id, consent) VALUES ('email', '=cmd@example.com', ?, 0)").run(A2);
  s.DB.raw.prepare(`INSERT INTO chain_deposits (id, chain_id, tx_hash, log_index, block_number, from_address, to_address, amount_wei, amount_units, player_id, status, credited_at)
    VALUES ('d1', 1, ?, 0, 1, ?, ?, '1', 50000, ?, 'credited', datetime('now'))`).run(TX, A1, A2, A1);
  s.DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at) VALUES ('w1', 'player', ?, 1, ?, 20000, 500, 19500, 'sent', datetime('now'))`).run(A1, A1);
  for (const [sym, usd, hidden] of [['ETH', 900, 0], ['USDC', 500, 0], ['TICS', 100, 0], ['A', 10, 0], ['B', 6, 0], ['C', 4.5, 0], ['SPAM', 99999, 1]])
    s.DB.raw.prepare("INSERT INTO wallet_holdings (player_id, network, token, symbol, name, decimals, amount, usd_price, usd_value, hidden) VALUES (?, 'eth-mainnet', ?, ?, ?, 18, '1', 1, ?, ?)").run(A1, sym, sym, sym, usd, hidden);
  s.DB.raw.prepare("INSERT INTO wallet_connections (player_id, address, country, city, device) VALUES (?, ?, 'DE', 'Berlin', 'desktop')").run(A1, A1);
  // Totals per kind of money come from the rounds: one real round (bet 100, paid 40) and one demo round that must not count.
  const round = (id, real, stake, paid) => s.DB.raw.prepare(`INSERT INTO rounds (id, player_id, game_id, math_id, config_version, stake_cents, payout_cents, outcome, bets_json, fairness_json, currency, real_money, created_at)
    VALUES (?, ?, 'roulette', 'standard', 1, ?, ?, '{"pocket":1}', '[]', '{}', 'TICS', ?, datetime('now'))`).run(id, A1, stake, paid, real);
  round('real-1', 1, 10000, 4000); round('demo-1', 0, 999900, 0);
  await s.admin('help@example.com', 'support');
  const find = async qs => (await s.call('GET', `/api/players?${qs}`)).data;
  let d = await find('q=' + encodeURIComponent('6053F3E94C'));
  assert.deepEqual(d.players.map(p => p.id), [A1]);
  assert.equal(d.players[0].walletAddress, A1);
  // Support has no 'pii:view': the email is masked, its consent still shows.
  assert.equal(d.players[0].email, 'a***@e***.com');
  assert.equal(d.players[0].emailConsent, true);
  assert.equal(d.piiMasked, true);
  assert.equal((await find('q=ana%40example')).total, 0, 'no searching by email without pii:view');
  assert.equal(d.players[0].realTicsCents, 12345);
  assert.equal(d.players[0].holdingsUsd, 1520.5);
  assert.deepEqual((await find(`q=${A2.toUpperCase().replace('0X', '0x')}`)).players.map(p => p.id), [A2]);
  assert.equal((await find('q=' + encodeURIComponent('%'))).total, 0, 'LIKE wildcards are literal');
  assert.equal((await find('hasEmail=yes')).total, 2);
  assert.equal((await find('hasEmail=no')).total, 0, 'the Real view lists wallet players only');
  assert.equal((await find('hasEmail=no&money=play')).total, 1, 'the Demo view includes guests');
  assert.deepEqual((await find('consent=yes')).players.map(p => p.id), [A1]);
  assert.deepEqual((await find('country=tr')).players.map(p => p.id), [A2]);
  assert.deepEqual((await find('holdingsMin=100')).players.map(p => p.id), [A1]);
  assert.deepEqual((await find('holdingsMax=100')).players.map(p => p.id), [A2]);
  assert.deepEqual((await find('deposited=yes')).players.map(p => p.id), [A1]);
  assert.equal((await find('deposited=no')).total, 1);
  assert.equal((await find('deposited=no&money=play')).total, 2);
  assert.ok(!(await find('connectedDays=30')).players.some(p => p.id === A2));
  assert.equal((await s.call('GET', '/api/players?connectedDays=abc')).status, 400);
  // Support cannot export; finance can.
  assert.equal((await s.call('GET', '/api/players.csv')).status, 403);
  await s.admin('fin@example.com', 'finance');
  const csv = await s.call('GET', '/api/players.csv?hasEmail=yes&sort=holdings');
  assert.equal(csv.status, 200);
  const lines = csv.data.trim().split('\n');
  assert.equal(lines[0], 'address,email,consent,country,city,first_connected_at,last_connected_at,holdings_usd,top_assets,deposited_tics,withdrawn_tics,rounds,net_result_tics');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], `${A1},a***@e***.com,yes,DE,hidden,2026-10-01 10:00:00,2026-10-27 10:00:00,1520.50,ETH:900.00;USDC:500.00;TICS:100.00;A:10.00;B:6.00,500.00,200.00,1,-60.00`);
  assert.match(lines[2], /^0xfb69.*,'=\*\*\*@e\*\*\*\.com,no,TR,/, 'formula characters are neutralised');
  // An owner sees the real values.
  await s.admin('boss@example.com', 'owner');
  const ownerCsv = (await s.call('GET', '/api/players.csv?hasEmail=yes&sort=holdings')).data.trim().split('\n');
  assert.equal(ownerCsv[1], `${A1},ana@example.com,yes,DE,"Berlin, Mitte",2026-10-01 10:00:00,2026-10-27 10:00:00,1520.50,ETH:900.00;USDC:500.00;TICS:100.00;A:10.00;B:6.00,500.00,200.00,1,-60.00`);
  assert.match(ownerCsv[2], /^0xfb69.*,'=cmd@example.com,no,TR,/);
  assert.equal((await find('q=ana%40example')).total, 1, 'owners can search by email');
  // Profile: wallet details.
  const p = (await s.call('GET', `/api/players/${A1}`)).data;
  assert.equal(p.player.walletAddress, A1);
  assert.equal(p.connections.length, 1);
  assert.equal(p.holdings.length, 7);
  assert.equal(p.holdingsTotalUsd, 1520.5);
  assert.equal(p.chainDeposits[0].amount_units, 50000);
  assert.equal(p.chainWithdrawals[0].fee_units, 500);
  assert.deepEqual({ address: p.email.address, consent: p.email.consent }, { address: 'ana@example.com', consent: true });
  assert.equal(p.chainId, 1);
  assert.equal(p.depositedUnits, 50000);
  assert.equal(p.withdrawnUnits, 20000);
  assert.deepEqual([p.player.rounds, p.player.totalBetCents, p.rounds.length], [1, 10000, 1], 'real view: real rounds only');
  const demo = (await s.call('GET', `/api/players/${A1}?money=play`)).data;
  assert.deepEqual([demo.realMoney, demo.player.rounds, demo.player.totalBetCents, demo.rounds.map(r => r.id)], [false, 1, 999900, ['demo-1']]);
});

test('the encrypted casino key never appears in any response', async () => {
  const s = setup({ float: null });
  s.player(A1);
  s.DB.raw.prepare("INSERT INTO chain_state (key, value) VALUES ('float', ?)").run(JSON.stringify({ at: Date.now() - 5000, chainId: 1, wallet: A2, tokenUnits: 500000, ethWei: '20000000000000000', owedUnits: 120000, freeUnits: 380000 }));
  const own = await s.admin('dez@example.com', 'owner');
  s.setTics({ casinoWallet: A2, treasuryAddress: A1, casino_key_ct: KEY_CT });
  const gets = ['/api/me', '/api/overview?period=today', '/api/money?period=30d', '/api/money.csv?period=all', '/api/bank', '/api/tics/treasury', '/api/tics/fees', '/api/tics/payments?status=all',
    '/api/games', '/api/games/roulette', '/api/rounds', '/api/players', `/api/players/${A1}`, '/api/players.csv', '/api/analytics?period=30d', '/api/alerts', '/api/messages',
    '/api/settings', '/api/audit'];
  const responses = [];
  for (const g of gets) { const r = await s.call('GET', g); assert.ok(r.status < 500, `${g} ${r.status}`); responses.push([g, r.raw]); }
  responses.push(['PUT settings', (await s.call('PUT', '/api/tics/settings', { confirmations: 7 })).raw]);
  responses.push(['pause', (await s.call('POST', '/api/tics/payouts/pause', { paused: true, reason: 'test pause' })).raw]);
  responses.push(['send', (await s.call('POST', '/api/tics/treasury/send', { amountUnits: 100, code: await own.code(1) })).raw]);
  responses.push(['audit after', (await s.call('GET', '/api/audit')).raw]);
  for (const [name, raw] of responses) {
    assert.ok(!raw.includes(KEY_CT), `${name} leaked the key ciphertext`);
    assert.ok(!raw.includes('casino_key_ct'), `${name} mentions casino_key_ct`);
  }
  const o = JSON.parse(responses[1][1]);
  assert.equal(o.ticsFloat.freeUnits, o.ticsFloat.tokenUnits - o.ticsFloat.owedUnits, "free float uses live owed balances");
  assert.equal(o.ticsFloat.maxWinUnits, Math.floor(Math.max(0, o.ticsFloat.freeUnits) * 25 / 100));
  assert.ok(o.ticsFloat.ageSeconds >= 4);
  assert.equal(JSON.parse(responses[4][1]).ticsFloat.tokenUnits, 500000);
});

test('a stopped (blocked) withdrawal: only an owner with password + code can return it, through the payouts Worker', async () => {
  const s = setup();
  s.player(A1, { real: 5000 });
  s.DB.raw.prepare(`INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, attempts, last_error)
    VALUES ('33333333-3333-4333-8333-333333333333', 'player', ?, 1, ?, 20000, 0, 20000, 'blocked', datetime('now'), 1, 'refused: hold did not match')`).run(A1, A1);
  await s.admin('fin@example.com', 'finance');
  assert.equal((await s.call('POST', '/api/tics/withdrawals/33333333-3333-4333-8333-333333333333/release', {})).status, 403);
  const own = await s.admin('owner2@example.com', 'owner');
  const bad = await s.call('POST', '/api/tics/withdrawals/33333333-3333-4333-8333-333333333333/release', {});
  assert.ok([400, 401].includes(bad.status), 'needs password + code: ' + bad.status);
  assert.equal(s.payoutCalls.filter(c => c.path === '/resolve').length, 0);
  const ok = await s.call('POST', '/api/tics/withdrawals/33333333-3333-4333-8333-333333333333/release', { password: PASSWORD, code: await own.code(1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(s.payoutCalls.find(c => c.path === '/resolve').body, { id: '33333333-3333-4333-8333-333333333333', by: 'owner2@example.com' });
});
