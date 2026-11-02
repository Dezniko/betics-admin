// Browser QA for the TICS admin screens: Treasury, Payments (TICS), Players list,
// search and profile, in dark and light themes and at 390px phone width.
// ADMIN_URL=http://127.0.0.1:8890 CDP_PORT=9355 SETUP_LINK=... QA_OUT=dir node test/browser/tics-qa.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { openPage, totp } from './cdp.mjs';

const BASE = process.env.ADMIN_URL || 'http://127.0.0.1:8890';
const OUT = process.env.QA_OUT || '/tmp/admin-qa';
const SECRET_FILE = `${OUT}/qa-totp-secret.txt`; // local throwaway QA account only
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { shots: [], overflow: [], checks: {} };
const A1 = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';

const p = await openPage(1440, 900);
await p.go(`${BASE}/`);
if (process.env.SETUP_LINK && !existsSync(SECRET_FILE)) {
  await p.go(process.env.SETUP_LINK);
  await p.waitFor(`!!document.querySelector('input[type=password]')`);
  await p.type('input[autocomplete=new-password]', 'Correct horse 42 battery');
  await p.ev(`document.querySelectorAll('input[autocomplete=new-password]')[1].value='Correct horse 42 battery'`);
  await p.click('form button[type=submit]');
  await p.waitFor(`!!document.querySelector('.qr svg')`);
  report.checks.qr = await p.ev(`(async()=>{ if(!('BarcodeDetector' in window)) return 'no-detector';
    const svg=document.querySelector('.qr svg'); const img=new Image(); img.src='data:image/svg+xml;base64,'+btoa(new XMLSerializer().serializeToString(svg));
    await img.decode(); const c=document.createElement('canvas'); c.width=img.width; c.height=img.height; c.getContext('2d').drawImage(img,0,0);
    const r=await new BarcodeDetector({formats:['qr_code']}).detect(c); return r[0]?.rawValue ? 'decoded' : 'unreadable'; })()`);
  const secret = (await p.ev(`document.querySelector('.qr ~ details .mono').textContent`)).replace(/\s/g, '');
  writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  await p.type('input.code', totp(secret));
  await p.click('form button[type=submit]');
  await p.waitFor(`location.hash.startsWith('#/overview') && !!document.querySelector('.kpis')`, 12000);
}
const secret = readFileSync(SECRET_FILE, 'utf8').trim();

async function settle() {
  await p.waitFor(`!document.querySelector('.loading') && !!document.querySelector('.page')`, 12000);
  await sleep(600);
}
async function overflowCheck(page, name) {
  // Anything wider than the viewport that is not inside a horizontally scrolling table.
  const r = await page.ev(`(()=>{const vw=document.documentElement.clientWidth;const bad=[];
    for(const el of document.querySelectorAll('main *')){ if(el.closest('.table-wrap,.seg')) continue; const b=el.getBoundingClientRect(); if(b.width===0) continue;
      if(b.right>vw+1||b.left<-1) bad.push((el.className||el.tagName)+':'+Math.round(b.right)); }
    return {vw, docW: document.documentElement.scrollWidth, bad: bad.slice(0,8)}})()`);
  if (r.docW > r.vw + 1 || r.bad.length) report.overflow.push({ name, ...r });
}
async function visit(page, hash, name, check) {
  await page.go(`${BASE}/#/${hash}`);
  await page.waitFor(`!document.querySelector('.loading') && !!document.querySelector('.page')`, 12000);
  await sleep(700);
  const err = await page.ev(`document.querySelector('.error-box')?.textContent || ''`);
  assert.equal(err, '', `${name}: ${err}`);
  if (check) await check(page);
  await overflowCheck(page, name);
  report.shots.push(await page.shot(name));
}

for (const theme of ['dark', 'light']) {
  await p.ev(`localStorage.setItem('noir-admin-theme', '${theme}')`);
  await visit(p, 'treasury', `treasury-${theme}`, async pg => {
    const text = await pg.ev('document.querySelector("main").innerText');
    assert.match(text, /Payouts service unavailable/);
    assert.match(text, /Automatic payouts are paused/);
    assert.match(text, /TICS/);
    assert.ok(!text.includes('$'), 'no dollar signs on Treasury');
    assert.ok(!text.includes('QA-CIPHERTEXT'), 'key never shown');
    assert.equal(await pg.ev(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Send to treasury').disabled`), true);
  });
  await p.ev('window.scrollTo(0, 99999)'); await sleep(300); report.shots.push(await p.shot(`treasury-bottom-${theme}`));
  await visit(p, 'fees', `fees-${theme}`, async pg => {
    const text = await pg.ev('document.querySelector("main").innerText');
    assert.match(text, /Players pay the network fee on withdrawals/);
    report.checks[`fees-${theme}`] = await pg.ev(`[...document.querySelectorAll('.card')].find(c=>c.textContent.includes('Fee quote'))?.innerText`);
  });
  await visit(p, 'payments', `payments-${theme}`, async pg => {
    const text = await pg.ev('document.querySelector("main").innerText');
    assert.match(text, /TICS payouts/); assert.match(text, /USDT on Tron \(switched off\)/);
    assert.ok(await pg.ev(`[...document.querySelectorAll('button')].some(b=>b.textContent==='Cancel')`), 'cancel on queued');
  });
  await p.ev(`[...document.querySelectorAll('.seg button')].find(b=>b.textContent==='All' && b.closest('section')?.textContent.includes('TICS deposits'))?.click()`); await sleep(800);
  await p.ev(`[...document.querySelectorAll('h3')].find(h=>h.textContent.startsWith('TICS deposits'))?.scrollIntoView()`); await sleep(300);
  report.shots.push(await p.shot(`payments-deposits-${theme}`));
  await visit(p, 'players', `players-${theme}`);
  await visit(p, `players/${A1}`, `player-${theme}`, async pg => {
    const text = await pg.ev('document.querySelector("main").innerText');
    assert.match(text, /Wallet holdings/); assert.match(text, /Connection log/); assert.match(text, /ana\.qa@example\.com/);
    assert.ok(!/FREE-AIRDROP/.test(text), 'hidden holdings stay hidden');
  });
  await p.ev(`[...document.querySelectorAll('h3')].find(h=>h.textContent.startsWith('Wallet holdings'))?.scrollIntoView()`); await sleep(300);
  report.shots.push(await p.shot(`player-holdings-${theme}`));
}
// Show hidden toggle, search by part of an address in capitals.
await p.ev(`document.querySelector('.card h3 .check input')?.click()`); await sleep(200);
report.checks.hiddenShown = await p.ev(`document.querySelector('main').innerText.includes('FREE-AIRDROP')`);
await p.go(`${BASE}/#/players`); await settle();
await p.type('input[type=search]', '6053F3E94C');
await p.click('form.filters button.btn.primary'); await sleep(900);
report.checks.searchRows = await p.ev(`document.querySelectorAll('tbody tr').length`);
assert.equal(report.checks.searchRows, 1);
await p.ev(`document.querySelector('.more-filters').open = true`); await sleep(200);
report.shots.push(await p.shot('players-search-light'));
// Overview with the float snapshot.
await visit(p, 'overview', 'overview-light', async pg => assert.match(await pg.ev('document.querySelector("main").innerText'), /Casino wallet float/));
// Mobile 390px, dark.
await p.ev(`localStorage.setItem('noir-admin-theme', 'dark')`);
const m = await openPage(390, 844, true);
await m.go(`${BASE}/`);
for (const [hash, name] of [['treasury', 'm-treasury'], ['fees', 'm-fees'], ['payments', 'm-payments'], ['players', 'm-players'], [`players/${A1}`, 'm-player']]) {
  await visit(m, hash, name);
  await m.ev('window.scrollTo(0, 1400)'); await sleep(300); report.shots.push(await m.shot(`${name}-2`));
}
await m.ev(`localStorage.setItem('noir-admin-theme', 'light')`);
await visit(m, 'treasury', 'm-treasury-light');
report.errors = [...p.errors, ...m.errors];
await m.close(); await p.close();
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.errors, []);
console.log(report.overflow.length ? 'OVERFLOW FOUND' : 'PASS tics browser QA');
