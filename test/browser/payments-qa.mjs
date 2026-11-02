// Local end-to-end: signed deposit callback credits real money, player requests a
// withdrawal, admin sees it, approves, marks sent; second one rejected and refunded.
// Needs local core with NOWPAYMENTS_IPN_SECRET=local-ipn-secret in .dev.vars.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openPage } from './cdp.mjs';
const A = 'http://127.0.0.1:8790', G = 'http://127.0.0.1:8789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;
const d1 = sql => JSON.parse(execFileSync('wrangler', ['d1', 'execute', 'betics-db', '--local', '--json', '--command', sql], { cwd: process.env.HOME + '/betics', env: { ...process.env, CI: 'true' } }).toString())[0].results;
const out = {};
const a = await openPage(1440, 950), g = await openPage(390, 844, true);
await a.go(`${A}/#/overview`); await sleep(1500);
// Owner opens withdrawals (deposits too; provider shows connected locally).
assert.equal(await a.ev(`fetch('${A}/api/payments/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({depositsOpen:true,withdrawalsOpen:true})}).then(r=>r.status)`), 200);
await g.go(G); await sleep(2500);
const info0 = await g.ev(`fetch('/api/payments').then(r=>r.json())`);
out.statusBefore = await g.ev(`fetch('/api/payments/status').then(r=>r.json())`);
const play0 = await g.ev(`fetch('/api/wallet/1').then(r=>r.json()).then(d=>d.balanceCents)`);
await sleep(1500);
const [player] = d1('SELECT id FROM players ORDER BY last_seen_at DESC LIMIT 1');
const depId = crypto.randomUUID();
d1(`INSERT INTO deposits (id, player_id, provider, provider_ref, status, network, pay_currency, pay_address, pay_amount, requested_cents) VALUES ('${depId}', '${player.id}', 'nowpayments', 'qa-${Date.now()}', 'waiting', 'tron', 'usdttrc20', 'TQA', '100', 10000)`);
const [dep] = d1(`SELECT provider_ref FROM deposits WHERE id = '${depId}'`);
const body = { payment_id: dep.provider_ref, order_id: depId, payment_status: 'finished', actually_paid: 100.2, pay_currency: 'usdttrc20', payin_hash: 'b'.repeat(64) };
const sig = createHmac('sha512', 'local-ipn-secret').update(JSON.stringify(sortKeys(body))).digest('hex');
for (const s of ['0'.repeat(128), sig, sig]) out[`hook_${s.slice(0, 3)}`] = (await fetch(`${G}/api/payments/webhook/nowpayments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nowpayments-sig': s }, body: JSON.stringify(body) })).status;
const info1 = await g.ev(`fetch('/api/payments').then(r=>r.json())`);
out.real = [info0.realBalanceCents, info1.realBalanceCents];
assert.equal(info1.realBalanceCents - info0.realBalanceCents, 10000);
assert.equal(await g.ev(`fetch('/api/wallet/1').then(r=>r.json()).then(d=>d.balanceCents)`), play0, 'play money untouched');
const wd = addr => g.ev(`fetch('/api/payments/withdraw',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amountCents:4000,address:'${addr}'})}).then(async r=>({s:r.status,b:await r.json()}))`);
out.badAddr = (await wd('Tbad')).s;
const w1 = await wd('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), w2 = await wd('TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G');
assert.equal(w1.s, 200); assert.equal(w2.s, 200);
out.afterHolds = w2.b.realBalanceCents;
await sleep(1500);
// Admin Payments page.
await a.go(`${A}/#/payments`);
await a.waitFor(`document.querySelectorAll('.table tbody tr').length >= 2`, 12000);
out.queueRows = await a.ev(`document.querySelector('.card .table tbody').children.length`);
out.provider = await a.ev(`[...document.querySelectorAll('.pill')].map(p=>p.textContent).filter(t=>/Connected|Not connected/.test(t))`);
await a.shot('payments-queue');
const act = (id, body) => a.ev(`fetch('${A}/api/withdrawals/${id}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})}).then(async r=>({s:r.status,b:await r.json()}))`);
out.approve = (await act(w1.b.withdrawalId, { action: 'approve' })).s;
out.sent = (await act(w1.b.withdrawalId, { action: 'sent', txHash: 'c'.repeat(64) })).b.withdrawal?.status;
out.reject = (await act(w2.b.withdrawalId, { action: 'reject', reason: 'QA check, money returned' })).b.withdrawal?.status;
const info2 = await g.ev(`fetch('/api/payments').then(r=>r.json())`);
out.realAfterReject = info2.realBalanceCents;
assert.equal(info2.realBalanceCents, info1.realBalanceCents - 4000);
// Bank with a Tron wallet + owed includes real balances.
assert.equal(await a.ev(`fetch('${A}/api/bank',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({wallets:[{label:'Tron test (public)',chain:'tron',address:'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G'}],reservePct:20})}).then(r=>r.status)`), 200);
await a.go(`${A}/#/bank`);
await a.waitFor(`!!document.querySelector('.bank-hero') && document.querySelector('.kpis .big').textContent !== '-'`, 20000); await sleep(800);
out.bank = await a.ev(`[...document.querySelectorAll('.kpis .big')].map(e=>e.textContent)`);
out.bankRow = await a.ev(`document.querySelector('.table tbody tr')?.innerText`);
await a.shot('bank-tron');
await a.ev(`fetch('${A}/api/bank',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({wallets:[]})})`);
await a.go(`${A}/#/players/${player.id}`); await sleep(2500); await a.shot('player-real');
await a.go(`${A}/#/payments`); await sleep(2000); await a.ev(`document.querySelector('.seg [data-v=all]')?.click()`); await sleep(1500); await a.shot('payments-all');
// Close payments again locally.
await a.ev(`fetch('${A}/api/payments/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({depositsOpen:false,withdrawalsOpen:false})})`);
out.errors = [...a.errors, ...g.errors];
console.log(JSON.stringify(out, null, 1));
assert.deepEqual(out.errors, []);
console.log('PASS payments QA');
await a.close(); await g.close();
