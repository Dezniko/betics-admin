// Browser QA for the reserve accounting fixes: the Treasury page shows Protected balance, Unresolved deposits and
// Free to send; an owner marks an unmatched deposit as house funding through the step-up dialog; owed drops.
// Needs a state seeded with test/schema.sql + test/browser/qa-seed.sql and a QA owner already set up by tics-qa.mjs
// (its TOTP secret in QA_OUT/qa-totp-secret.txt). Password is the one tics-qa.mjs sets.
// ADMIN_URL=http://127.0.0.1:8790 QA_OUT=dir node test/browser/reserve-qa.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openPage, totp } from './cdp.mjs';

const BASE = process.env.ADMIN_URL || 'http://127.0.0.1:8790';
const OUT = process.env.QA_OUT || '/tmp/admin-qa';
const PASSWORD = 'Correct horse 42 battery';
const secret = readFileSync(`${OUT}/qa-totp-secret.txt`, 'utf8').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { shots: [], checks: {} };

const p = await openPage(1440, 900);
await p.go(`${BASE}/`);
await p.waitFor(`!!document.querySelector('main .page') || !!document.querySelector('input[type=email]')`, 12000);
// A fresh browser profile lands on the sign-in form; wait for the sign-in button before typing the code.
const signedIn = await p.ev(`!!document.querySelector('main .page')`);
if (!signedIn) {
  await p.waitFor(`!!document.querySelector('input[type=email]')`, 12000);
  await p.type('input[type=email]', 'qa@example.com');
  await p.type('input[type=password]', PASSWORD);
  await p.click('form button[type=submit]');
  await p.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Check code and sign in')`, 12000);
  await p.type('input.code', totp(secret));
  await p.click('form button[type=submit]');
  await p.waitFor(`location.hash.startsWith('#/overview') && !!document.querySelector('.kpis')`, 12000);
}
async function visit(hash) {
  await p.go(`${BASE}/#/${hash}`);
  await p.waitFor(`!document.querySelector('.loading') && !!document.querySelector('.page')`, 12000);
  await sleep(700);
  const err = await p.ev(`document.querySelector('.error-box')?.textContent || ''`);
  assert.equal(err, '', `${hash}: ${err}`);
  return p.ev('document.querySelector("main").innerText');
}
const api = path => p.ev(`fetch('/api${path}').then(r => r.json())`);

// 1. Treasury before: the seeded unmatched deposit (250 TICS) is owed; protected balance is below the wallet balance.
let text = await visit('treasury');
assert.match(text, /Protected balance/); assert.match(text, /Unresolved deposits/); assert.match(text, /Free to send/);
assert.match(text, /1 unresolved deposit: 250\.00 TICS/);
assert.match(text, /Includes 250\.00 TICS unresolved deposits/);
assert.ok(!text.includes('Free float'), 'the old label is gone');
let t = await api('/tics/treasury');
report.checks.before = { owed: t.owedUnitsDb, unresolved: t.unresolved, protectedUnits: t.protectedUnitsDb, freeToSend: t.freeToSendUnitsDb, freePlain: t.freeUnitsDb };
assert.equal(t.unresolved.n, 1); assert.equal(t.unresolved.units, 25000);
assert.equal(t.protectedUnitsDb, 45_000_000);
assert.equal(t.freeToSendUnitsDb, 45_000_000 - t.owedUnitsDb - t.owed.holdsUnits);
assert.ok(t.freeUnitsDb > t.freeToSendUnitsDb, 'protected figure is the stricter one');
report.shots.push(await p.shot('reserve-treasury-before'));

// 2. Payments: the unmatched row has both buttons; mark it as house funding through the step-up dialog.
text = await visit('payments');
await p.ev(`[...document.querySelectorAll('.seg button')].find(b => b.textContent === 'Unmatched' && b.closest('section')?.textContent.includes('TICS deposits'))?.click()`); await sleep(900);
assert.ok(await p.ev(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Assign to player')`), 'Assign button');
assert.ok(await p.ev(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Mark as house funding')`), 'house funding button');
assert.match(await p.ev('document.querySelector("main").innerText'), /Counted as owed/);
await p.ev(`[...document.querySelectorAll('h3')].find(h => h.textContent.startsWith('TICS deposits'))?.scrollIntoView()`); await sleep(300);
report.shots.push(await p.shot('reserve-deposits-unmatched'));
await p.ev(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Mark as house funding').click()`);
await p.waitFor(`!!document.querySelector('.modal-wrap .modal') && document.body.innerText.includes('Only do this for money you sent yourself')`, 5000);
const dialogText = await p.ev(`document.querySelector('.modal-wrap .modal').innerText`);
assert.match(dialogText, /Mark 250\.00 TICS as house funding\?/);
assert.match(dialogText, /0x1111111111111111111111111111111111111111/);
assert.match(dialogText, /Customer money must be assigned to the player instead/);
await sleep(500); // let the dialog's entrance animation finish before the picture
report.shots.push(await p.shot('reserve-house-funding-dialog'));
// Fill note, password and a fresh code: the NEXT 30 s step's code (accepted for clock drift) can never be the one used to sign in.
await p.ev(`(() => { const d = document.querySelector('.modal-wrap .modal');
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set(d.querySelector('input[maxlength="200"]'), 'QA: sent from my exchange account');
  set(d.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)});
  set(d.querySelector('input.code') || d.querySelector('input[inputmode=numeric]'), ${JSON.stringify(totp(secret, Date.now() + 30000))}); })()`);
await p.ev(`[...document.querySelectorAll('.modal-wrap .modal button')].find(b => b.textContent === 'Mark as house funding').click()`);
await p.waitFor(`document.body.innerText.includes('Marked 250.00 TICS as house funding') || document.body.innerText.includes('already marked') || !!document.querySelector('.toast.bad')`, 12000);
report.checks.toast = await p.ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`);
assert.ok(!/bad/.test(await p.ev(`[...document.querySelectorAll('.toast')].map(t => t.className).join(' ')`)), `failed: ${report.checks.toast}`);
await sleep(1200);
// The row now shows House funding with who did it; the unresolved count is 0.
await p.ev(`[...document.querySelectorAll('.seg button')].find(b => b.textContent === 'House funding' && b.closest('section')?.textContent.includes('TICS deposits'))?.click()`); await sleep(900);
text = await p.ev('document.querySelector("main").innerText');
assert.match(text, /House funding/); assert.match(text, /by qa@example\.com/); assert.match(text, /QA: sent from my exchange account/);
report.shots.push(await p.shot('reserve-deposits-house-funding'));
const dep = (await api('/tics/payments?deposits=ignored')).deposits[0];
assert.equal(dep.status, 'ignored'); assert.equal(dep.resolution, 'house_funding'); assert.equal(dep.resolved_by, 'qa@example.com');

// 3. Treasury after: nothing unresolved, owed down by 250 TICS, free to send up by the same.
text = await visit('treasury');
t = await api('/tics/treasury');
report.checks.after = { owed: t.owedUnitsDb, unresolved: t.unresolved, freeToSend: t.freeToSendUnitsDb };
assert.deepEqual(t.unresolved, { n: 0, units: 0 });
assert.equal(t.owedUnitsDb, report.checks.before.owed - 25000);
assert.equal(t.freeToSendUnitsDb, report.checks.before.freeToSend + 25000);
assert.ok(!/unresolved deposit:/.test(text), 'banner gone');
report.shots.push(await p.shot('reserve-treasury-after'));
// The alert exists once.
const alerts = await api('/alerts');
const mine = alerts.alerts.filter(a => a.type === 'tics_deposit_house_funding');
assert.equal(mine.length, 1); assert.equal(mine[0].severity, 'info');
// Overview reserve card has the new lines.
text = await visit('overview');
assert.match(text, /Unresolved deposits/); assert.match(text, /Protected balance/); assert.match(text, /Free to send/);
report.errors = p.errors;
await p.close();
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.errors, []);
console.log('PASS reserve browser QA');
