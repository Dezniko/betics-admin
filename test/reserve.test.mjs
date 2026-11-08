// Reserve accounting (security review F1/F2): unresolved customer deposits are owed, treasury sends are
// checked against the PROTECTED wallet balance, an owner can mark a deposit as house funding with step-up,
// and assigning a deposit moves money from "unresolved" to the player balance without changing total liabilities.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createD1 } from './d1shim.mjs';
import worker from '../src/index.js';
import { hotp } from '../src/totp.js';
import { makeSetupToken } from '../src/auth.js';
import { owedBreakdown, UNRESOLVED_DEPOSITS_SQL, protectedUnits, freeToSend } from '../src/api/money.js';

const MIGRATION = new URL('./schema.sql', import.meta.url).pathname;
const ORIGIN = 'https://admin.betics.io';
const PASSWORD = 'correct horse 42 battery';
const A1 = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const A2 = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const EXCHANGE = '0x1111111111111111111111111111111111111111';
const tx = n => '0x' + n.toString(16).padStart(2, '0').repeat(32);

function setup({ float = 1_000_000, safe = float, safeUnknown = false } = {}) {
  const DB = createD1([MIGRATION]);
  DB.raw.prepare("INSERT INTO chain_state (key, value) VALUES ('float', ?)").run(JSON.stringify({ at: Date.now(), chainId: 1, wallet: A2, tokenUnits: float, safeTokenUnits: safe, safeUnknown, ethWei: '1' }));
  const walletCalls = [], payoutCalls = [];
  const env = {
    DB, SESSION_PEPPER: 'pepper', INTERNAL_SECRET: 'secret', TREASURY_SECRET: 'treasury-secret',
    ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) },
    // The wallet credits the player and (like the real Durable Object's flush) the central players row follows.
    WALLETS: { idFromName: n => n, get: id => ({ fetch: async req => {
      const body = await req.json();
      const dup = walletCalls.some(c => c.body.ref === body.ref);
      walletCalls.push({ id, body });
      if (!dup) DB.raw.prepare('UPDATE players SET real_tics_cents = real_tics_cents + ? WHERE id = ?').run(body.amountCents, body.playerId);
      return Response.json({ duplicate: dup, realTicsCents: DB.raw.prepare('SELECT real_tics_cents AS n FROM players WHERE id = ?').get(body.playerId).n });
    } }) },
    PAYOUTS: { fetch: async req => { payoutCalls.push({ path: new URL(req.url).pathname }); return Response.json({ ok: true, queued: true }); } },
  };
  let cookie = null;
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined }), env);
    const set = res.headers.get('Set-Cookie'); if (set) cookie = set.split(';')[0];
    const raw = await res.text();
    return { status: res.status, raw, data: (res.headers.get('Content-Type') || '').includes('json') ? JSON.parse(raw) : raw };
  };
  const admin = async (email, role) => {
    DB.raw.prepare('INSERT INTO admins (email, name, role) VALUES (?, ?, ?)').run(email, email.split('@')[0], role);
    const id = DB.raw.prepare('SELECT id FROM admins WHERE email = ?').get(email).id;
    const token = await makeSetupToken(DB, id);
    cookie = null;
    const pw = await call('POST', '/api/auth/setup/password', { token, password: PASSWORD });
    const step = Math.floor(Date.now() / 30000);
    assert.equal((await call('POST', '/api/auth/setup/code', { token, code: await hotp(pw.data.secret, step) })).status, 200);
    DB.raw.prepare('UPDATE admins SET treasury_ok_after = NULL WHERE id = ?').run(id);
    return { id, code: d => hotp(pw.data.secret, step + d) };
  };
  const resetCodes = () => DB.raw.prepare("UPDATE settings SET value = '{}' WHERE key = 'admin_totp_steps'").run();
  const stepUp = async a => { resetCodes(); return { password: PASSWORD, code: await a.code(1) }; };
  const setTics = obj => DB.raw.prepare("UPDATE settings SET value = json_patch(value, ?) WHERE key = 'tics_payments'").run(JSON.stringify(obj));
  const player = (id, real = 0) => DB.raw.prepare('INSERT INTO players (id, wallet_address, real_tics_cents) VALUES (?, ?, ?)').run(id, id, real);
  let n = 0;
  const deposit = (status, units, extra = {}) => {
    const id = `1:${tx(++n)}:0`;
    DB.raw.prepare(`INSERT INTO chain_deposits (id, chain_id, tx_hash, log_index, block_number, from_address, to_address, amount_wei, amount_units, status, player_id, credited_at, reversed_at)
      VALUES (?, 1, ?, 0, 21000000, ?, ?, '1', ?, ?, ?, ?, ?)`).run(id, tx(n), extra.from || EXCHANGE, A2, units, status, extra.playerId || null, extra.creditedAt || null, extra.reversedAt || null);
    return id;
  };
  const row = id => DB.raw.prepare('SELECT * FROM chain_deposits WHERE id = ?').get(id);
  const balances = () => DB.raw.prepare('SELECT COALESCE(SUM(real_tics_cents),0) AS n FROM players WHERE real_tics_cents > 0').get().n;
  return { DB, env, call, admin, stepUp, setTics, player, deposit, row, balances, walletCalls, payoutCalls };
}

test('owed includes unresolved deposits (unmatched, below minimum, assigned but not credited), never credited, reversed or house funding; the read uses chain_deposits_status', async () => {
  const s = setup();
  s.player(A1, 1000);
  s.deposit('unmatched', 500); s.deposit('below_min', 20); s.deposit('assigned', 300, { playerId: A1 });
  s.deposit('assigned', 7000, { playerId: A1, creditedAt: '2026-11-01 10:00:00' }); s.deposit('credited', 9000, { playerId: A1, creditedAt: '2026-11-01 10:00:00' });
  s.deposit('unmatched', 4000, { reversedAt: '2026-11-01 10:00:00' });
  s.DB.raw.prepare("UPDATE chain_deposits SET status = 'ignored', resolution = 'house_funding' WHERE amount_units = 20").run();
  s.deposit('below_min', 11);
  const o = await owedBreakdown(s.DB);
  assert.equal(o.unresolvedUnits, 500 + 300 + 11);
  assert.equal(o.owedUnits, 1000 + 811, 'balances plus unresolved deposits');
  const plan = s.DB.raw.prepare(`EXPLAIN QUERY PLAN SELECT ${UNRESOLVED_DEPOSITS_SQL} AS n`).all().map(r => r.detail).join(' | ');
  assert.match(plan, /chain_deposits_status/, plan);
  assert.ok(!/SCAN chain_deposits\b(?! USING)/.test(plan), plan);
  // The protected figures: the plain balance never counts; a snapshot without classification protects nothing.
  assert.equal(protectedUnits({ tokenUnits: 1000, safeTokenUnits: 600 }), 600);
  assert.equal(protectedUnits({ tokenUnits: 500, safeTokenUnits: 600 }), 500);
  assert.equal(protectedUnits({ tokenUnits: 500 }), 0);
  assert.equal(protectedUnits({ tokenUnits: 500, safeTokenUnits: 400, safeUnknown: true }), 0);
  assert.equal(protectedUnits(null), null);
  assert.equal(freeToSend({ tokenUnits: 1000, safeTokenUnits: 600 }, { owedUnits: 100, holdsUnits: 50 }), 450);
});

test('treasury: the precheck uses the protected balance minus owed (unresolved included) minus holds, refuses while the balance is unclassified, and the pages show the new figures', async () => {
  const s = setup({ float: 1_000_000, safe: 600_000 });
  s.player(A1, 100_000);
  s.deposit('unmatched', 50_000);
  s.DB.raw.prepare('INSERT INTO spin_holds (id, player_id, units, expires_at) VALUES (?, ?, ?, ?)').run('h1', A1, 10_000, Date.now() + 60e3);
  s.setTics({ treasuryAddress: A1, casinoWallet: A2 });
  const own = await s.admin('dez@example.com', 'owner');
  const t = (await s.call('GET', '/api/tics/treasury')).data;
  assert.equal(t.owedUnitsDb, 150_000); assert.equal(t.owed.unresolvedUnits, 50_000);
  assert.equal(t.protectedUnitsDb, 600_000); assert.equal(t.freeToSendUnitsDb, 600_000 - 150_000 - 10_000);
  assert.equal(t.freeUnitsDb, 1_000_000 - 150_000 - 10_000, 'the plain figure is still reported');
  assert.deepEqual(t.unresolved, { n: 1, units: 50_000 }); assert.equal(t.safeUnknown, false);
  // 440,000 is the most that may go; one unit more is refused before any code is used or the payouts Worker asked.
  const over = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 440_001, code: await own.code(1) });
  assert.equal(over.status, 400); assert.equal(over.data.code, 'not_free'); assert.match(over.data.error, /4,400\.00 TICS is free to send/);
  // The old plain rule would have allowed this (840,000 free by wallet minus owed): it must not.
  assert.equal((await s.call('POST', '/api/tics/treasury/send', { amountUnits: 700_000, code: await own.code(1) })).data.code, 'not_free');
  assert.equal(s.payoutCalls.length, 1, 'only the status read');
  const ok = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 440_000, code: await own.code(1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const intent = JSON.parse(s.DB.raw.prepare("SELECT after_json FROM admin_audit WHERE action = 'tics.treasury_send_intent'").get().after_json);
  assert.deepEqual([intent.freeUnits, intent.protectedUnits, intent.unresolvedUnits], [440_000, 600_000, 50_000]);
  // Overview and Money reserve cards carry the breakdown and the protected figure; max win follows the protected free figure.
  // (The payouts Worker writes the treasury row itself, so the mock send above changes nothing in this database.)
  const o = (await s.call('GET', '/api/overview?period=today')).data.ticsFloat;
  assert.deepEqual([o.protectedUnits, o.unresolvedUnits, o.freeToSendUnits, o.safeUnknown], [600_000, 50_000, 440_000, false]);
  assert.equal(o.maxWinUnits, Math.floor(Math.max(0, o.freeToSendUnits) * 25 / 100));
  const m = (await s.call('GET', '/api/money?period=30d')).data;
  assert.equal(m.ticsFloat.unresolvedUnits, 50_000);
  assert.equal((await s.call('GET', '/api/money?period=30d&money=play')).data.ticsFloat, null, 'demo view has no reserve card');
  // Not classified yet: nothing can go, with a plain message.
  s.DB.raw.prepare("UPDATE chain_state SET value = json_set(value, '$.safeUnknown', json('true')) WHERE key = 'float'").run();
  const unk = await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1, code: await own.code(2) });
  assert.equal(unk.status, 409); assert.equal(unk.data.code, 'float_unclassified'); assert.match(unk.data.error, /not classified yet/);
  const t2 = (await s.call('GET', '/api/tics/treasury')).data;
  assert.equal(t2.safeUnknown, true); assert.equal(t2.protectedUnitsDb, 0);
  // A snapshot written by older game code (no safeTokenUnits) protects nothing either.
  s.DB.raw.prepare("UPDATE chain_state SET value = json_remove(value, '$.safeUnknown', '$.safeTokenUnits') WHERE key = 'float'").run();
  assert.equal((await s.call('POST', '/api/tics/treasury/send', { amountUnits: 1, code: await own.code(3) })).data.code, 'not_free');
  // Live payouts figures are passed through for the page.
  const live = await s.call('GET', '/api/tics/treasury');
  assert.equal(live.status, 200);
});

test('house funding: owner only with step-up, one conditional update, audit + info alert, idempotent, refused for credited, assigned, reversed rows; no address rule', async () => {
  const s = setup();
  s.player(A1, 1000);
  const id = s.deposit('unmatched', 25_000);
  const path = d => `/api/tics/deposits/${encodeURIComponent(d)}/house-funding`;
  const fin = await s.admin('fin@example.com', 'finance');
  assert.equal((await s.call('POST', path(id), { note: 'from my exchange', ...(await s.stepUp(fin)) })).status, 403, 'finance cannot');
  const own = await s.admin('dez@example.com', 'owner');
  assert.equal((await s.call('POST', path(id), { note: 'x' })).status, 400, 'note required');
  assert.equal((await s.call('POST', path(id), { note: 'from my exchange' })).status, 401, 'password and fresh code required');
  assert.equal((await s.call('POST', path(id), { note: 'from my exchange', password: 'wrong password 1', code: await own.code(1) })).data.code, 'bad_password');
  assert.equal(s.row(id).status, 'unmatched', 'untouched without step-up');
  assert.equal((await s.call('POST', path('1:0xnothing:0'), { note: 'from my exchange', ...(await s.stepUp(own)) })).status, 404);
  const before = await owedBreakdown(s.DB);
  assert.equal(before.owedUnits, 26_000);
  const ok = await s.call('POST', path(id), { note: '  from my exchange account  ', ...(await s.stepUp(own)) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.duplicate, false); assert.equal(ok.data.amount, '250.00 TICS');
  const r = s.row(id);
  assert.equal(r.status, 'ignored'); assert.equal(r.resolution, 'house_funding'); assert.equal(r.resolved_by, 'dez@example.com'); assert.ok(r.resolved_at); assert.equal(r.note, 'from my exchange account');
  assert.equal((await owedBreakdown(s.DB)).owedUnits, 1000, 'no longer owed');
  const a = s.DB.raw.prepare("SELECT * FROM admin_audit WHERE action = 'tics.deposit_house_funding'").all();
  assert.equal(a.length, 1); assert.equal(JSON.parse(a[0].after_json).amountUnits, 25_000); assert.equal(a[0].reason, 'from my exchange account');
  const al = s.DB.raw.prepare("SELECT * FROM alerts WHERE type = 'tics_deposit_house_funding'").all();
  assert.equal(al.length, 1); assert.equal(al[0].severity, 'info'); assert.equal(al[0].dedupe_key, `tics_deposit_house_funding:${id}`);
  assert.match(al[0].title, /^Deposit marked as house funding: 250\.00 TICS from 0x1111/);
  // Idempotent: the same again is a harmless duplicate, with no second audit row or alert, and no step-up spent.
  const again = await s.call('POST', path(id), { note: 'from my exchange account' });
  assert.equal(again.status, 200); assert.equal(again.data.duplicate, true);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'tics.deposit_house_funding'").get().n, 1);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM alerts WHERE type = 'tics_deposit_house_funding'").get().n, 1);
  // No address rule: the next deposit from the same exchange is unmatched and owed like any other.
  const next = s.deposit('unmatched', 100);
  assert.equal((await owedBreakdown(s.DB)).unresolvedUnits, 100);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE '%house%'").get().n, 0);
  // Below minimum works too (refundable customer money the owner says is their own).
  const small = s.deposit('below_min', 40);
  assert.equal((await s.call('POST', path(small), { note: 'test transfer from me', ...(await s.stepUp(own)) })).status, 200);
  assert.equal(s.row(small).resolution, 'house_funding');
  // Refused: credited to a player, assigned and waiting, reversed.
  const credited = s.deposit('credited', 500, { playerId: A1, creditedAt: '2026-11-01 10:00:00' });
  const assigned = s.deposit('assigned', 500, { playerId: A1 });
  const reversed = s.deposit('unmatched', 500, { reversedAt: '2026-11-01 10:00:00' });
  for (const [d, re] of [[credited, /credited to a player/], [assigned, /assigned to a player/], [reversed, /disappeared/]]) {
    const x = await s.call('POST', path(d), { note: 'from my exchange', ...(await s.stepUp(own)) });
    assert.equal(x.status, 409, d); assert.match(x.data.error, re);
  }
  assert.equal(s.row(credited).status, 'credited'); assert.equal(s.row(assigned).status, 'assigned');
  // Race: the row is assigned to a player between the owner's read and the write. The conditional update changes nothing and the call is a 409.
  const prepare = s.DB.prepare;
  s.DB.prepare = q => { if (/SET status = 'ignored'/.test(q)) s.DB.raw.prepare("UPDATE chain_deposits SET status = 'assigned', player_id = ? WHERE id = ?").run(A1, next); return prepare(q); };
  const raced = await s.call('POST', path(next), { note: 'from my exchange', ...(await s.stepUp(own)) });
  s.DB.prepare = prepare;
  assert.equal(raced.status, 409); assert.match(raced.data.error, /changed while you were looking/);
  assert.equal(s.row(next).status, 'assigned'); assert.equal(s.row(next).resolution, null);
  assert.equal(s.DB.raw.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'tics.deposit_house_funding'").get().n, 2);
  // The list shows resolved rows under the ignored filter with who and when.
  const list = (await s.call('GET', '/api/tics/payments?deposits=ignored')).data;
  assert.equal(list.deposits.length, 2); assert.ok(list.deposits.every(d => d.resolution === 'house_funding' && d.resolved_by === 'dez@example.com'));
  assert.deepEqual(list.unresolved, { n: 2, units: 600 }, 'assigned-waiting (500) and the raced row (100)');
  assert.equal((await s.call('GET', '/api/tics/payments?deposits=below_min')).status, 200);
});

test('assigning a deposit preserves total liabilities: the money moves from unresolved to the player balance, and the row records its resolution', async () => {
  const s = setup();
  s.player(A1, 1000);
  const id = s.deposit('unmatched', 25_000);
  const own = await s.admin('dez@example.com', 'owner');
  const liabilities = async () => { const o = await owedBreakdown(s.DB); return { total: s.balances() + o.unresolvedUnits, owed: o.owedUnits, unresolved: o.unresolvedUnits, balances: s.balances() }; };
  const before = await liabilities();
  assert.deepEqual(before, { total: 26_000, owed: 26_000, unresolved: 25_000, balances: 1000 });
  const ok = await s.call('POST', `/api/tics/deposits/${encodeURIComponent(id)}/assign`, { address: A1, note: 'player emailed the tx', ...(await s.stepUp(own)) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const after = await liabilities();
  assert.equal(after.total, before.total, 'player balances + unresolved deposits unchanged');
  assert.equal(after.owed, before.owed, 'owed unchanged: no double count once credited');
  assert.deepEqual([after.unresolved, after.balances], [0, 26_000]);
  const r = s.row(id);
  assert.equal(r.status, 'assigned'); assert.ok(r.credited_at); assert.equal(r.resolution, 'assigned'); assert.equal(r.resolved_by, 'dez@example.com'); assert.ok(r.resolved_at);
  // Lost wallet reply: the row stays assigned and uncredited (still unresolved and owed), then the retry settles it once.
  const id2 = s.deposit('unmatched', 700);
  const wallets = s.env.WALLETS;
  s.env.WALLETS = { idFromName: n => n, get: () => ({ fetch: async () => { throw new Error('lost'); } }) };
  assert.equal((await s.call('POST', `/api/tics/deposits/${encodeURIComponent(id2)}/assign`, { address: A1, note: 'second one', ...(await s.stepUp(own)) })).status, 502);
  s.env.WALLETS = wallets;
  assert.equal((await owedBreakdown(s.DB)).unresolvedUnits, 700, 'claimed but not credited: still owed');
  assert.equal(s.row(id2).resolution, null);
  const mid = await liabilities();
  assert.equal((await s.call('POST', `/api/tics/deposits/${encodeURIComponent(id2)}/assign`, { address: A1, note: 'second one', ...(await s.stepUp(own)) })).status, 200);
  const end = await liabilities();
  assert.equal(end.total, mid.total); assert.equal(end.unresolved, 0); assert.equal(s.row(id2).resolution, 'assigned');
  assert.equal(s.walletCalls.length, 2);
});

test('UI: the deposits list offers Mark as house funding with the warning, and every owed figure shows the unresolved line', () => {
  const read = f => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
  const tics = read('views/tics.js'), lib = read('lib.js'), moneyView = read('views/money.js');
  assert.match(tics, /'Mark as house funding'/);
  assert.match(tics, /Only do this for money you sent yourself\. Customer money must be assigned to the player instead\./);
  assert.match(tics, /\/house-funding`/);
  assert.match(tics, /ctx\.can\('deposit:house_funding'\)/);
  assert.match(tics, /'Protected balance'/); assert.match(tics, /'Free to send'/); assert.match(tics, /'Unresolved deposits'/);
  assert.match(tics, /\['below_min', 'Below minimum'\]/); assert.match(tics, /'House funding'/);
  assert.match(lib, /Money that reached the casino wallet from senders we could not match to a player yet\. It is owed to someone until you assign it or mark it as your own funding\./);
  assert.match(lib, /row\('Unresolved deposits'/); assert.match(lib, /row\('Protected balance'/); assert.match(lib, /row\('Free to send'/);
  assert.match(moneyView, /floatCard\(d\.ticsFloat, ctx\)/);
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /route\('POST', '\/api\/tics\/deposits\/:id\/house-funding'/);
});
