// QA for: live rounds auto refresh + button, round "Table view", Bank page.
// ADMIN_URL=... GAME_URL=... node test/browser/features-qa.mjs  (needs a signed-in owner session in the QA Chrome)
import assert from 'node:assert/strict';
import { openPage } from './cdp.mjs';
const A = process.env.ADMIN_URL || 'http://127.0.0.1:8790', G = process.env.GAME_URL || 'http://127.0.0.1:8789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = {};
const a = await openPage(1440, 950);
await a.go(`${A}/#/overview`);
await a.ev(`localStorage.removeItem('noir-admin-autorefresh')`);
await a.waitFor(`document.querySelectorAll('.feed a.row').length > 0`, 12000);
out.before = await a.ev(`document.querySelector('.feed a.row')?.getAttribute('href')`);
// Play one round on the game without touching the admin page.
const g = await openPage(390, 844, true);
await g.go(G); await sleep(2500);
const spun = await g.ev(`(async()=>{const c=await (await fetch('/api/fairness/commitment/1')).json();
  const ent=[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const r=await fetch('/api/games/roulette/spin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:1,bets:[{type:'straight',value:17,amountCents:500},{type:'split',value:[17,20],amountCents:300},{type:'corner',value:[13,14,16,17],amountCents:200},{type:'street',value:[13,14,15],amountCents:200},{type:'red',amountCents:1000},{type:'dozen2',amountCents:500},{type:'column2',amountCents:300}],requestId:crypto.randomUUID(),expectedCommitment:c,clientEntropy:ent})});return r.status})()`);
assert.equal(spun, 200);
await a.send('Page.bringToFront');
await sleep(7000); // auto refresh is 5 s
out.after = await a.ev(`document.querySelector('.feed a.row')?.getAttribute('href')`);
assert.notEqual(out.after, out.before, 'new round appeared without reloading the page');
out.freshHighlight = await a.ev(`!!document.querySelector('.feed a.row.fresh')`);
out.stamp = await a.ev(`document.querySelector('.feed-tools .muted')?.textContent`);
await a.clickText('↻ Refresh'); await sleep(800);
await a.shot('live-rounds');
// Round table view.
await a.go(`${A}/${out.after}`);
await a.waitFor(`!!document.querySelector('.seg [data-v=table]')`);
await a.click('.seg [data-v=table]');
await a.waitFor(`!!document.querySelector('svg.felt')`);
out.chips = await a.ev(`document.querySelectorAll('svg.felt .felt-chip').length`);
out.won = await a.ev(`document.querySelectorAll('svg.felt .felt-chip.won').length`);
out.dolly = await a.ev(`!!document.querySelector('svg.felt .felt-dolly')`);
assert.equal(out.chips, 7);
await sleep(600);
await a.shot('round-table-view');
// Bank page: add a public wallet that holds USDT, read it live.
await a.go(`${A}/#/bank`);
await a.waitFor(`!!document.querySelector('.bank-hero')`);
await a.shot('bank-empty');
const saved = await a.ev(`fetch('/api/bank',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({wallets:[{label:'Test wallet (public)',address:'0x28C6c06298d514Db089934071355E5743bf21d60'}],reservePct:20})}).then(r=>r.status)`);
assert.equal(saved, 200);
await a.go(`${A}/#/bank`);
await a.waitFor(`document.querySelector('.kpis .big')?.textContent !== '-'`, 15000);
out.bank = await a.ev(`[...document.querySelectorAll('.kpis .big')].map(e=>e.textContent)`);
out.bankLine = await a.ev(`document.querySelector('.bank-hero b').textContent`);
await a.shot('bank-live');
// Remove the test wallet again.
await a.ev(`fetch('/api/bank',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({wallets:[]})})`);
out.errors = [...a.errors, ...g.errors];
console.log(JSON.stringify(out, null, 1));
assert.deepEqual(out.errors, []);
console.log('PASS features QA');
await a.close(); await g.close();
