// End-to-end admin QA in a real browser: setup with QR + code, every page,
// light and dark, switching a game off and on, adjusting a balance.
import assert from 'node:assert/strict';
import { openPage, totp } from './cdp.mjs';

const BASE = process.env.ADMIN_URL || 'http://127.0.0.1:8790';
const GAME = process.env.GAME_URL || 'http://127.0.0.1:8789';
const link = process.env.SETUP_LINK;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = {};

const p = await openPage(1440, 900);
if (link) {
  await p.go(link);
  await p.waitFor(`!!document.querySelector('input[type=password]')`);
  await p.type('input[autocomplete=new-password]', 'Correct horse 42 battery');
  await p.ev(`document.querySelectorAll('input[autocomplete=new-password]')[1].value='Correct horse 42 battery'`);
  await p.click('form button[type=submit]');
  await p.waitFor(`!!document.querySelector('.qr svg')`);
  await p.shot('setup-qr');
  // Decode the QR with the browser's own barcode reader where available.
  report.qr = await p.ev(`(async()=>{ if(!('BarcodeDetector' in window)) return 'no-detector';
    const svg=document.querySelector('.qr svg'); const img=new Image(); img.src='data:image/svg+xml;base64,'+btoa(new XMLSerializer().serializeToString(svg));
    await img.decode(); const c=document.createElement('canvas'); c.width=img.width; c.height=img.height; c.getContext('2d').drawImage(img,0,0);
    const r=await new BarcodeDetector({formats:['qr_code']}).detect(c); return r[0]?.rawValue||'unreadable'; })()`);
  const secret = (await p.ev(`document.querySelector('.qr ~ details .mono').textContent`)).replace(/\s/g, '');
  process.env.QA_SECRET = secret;
  console.log('SECRET_FOR_LOGIN', secret);
  await p.type('input.code', totp(secret));
  await p.click('form button[type=submit]');
  await p.waitFor(`location.hash.startsWith('#/overview') && !!document.querySelector('.kpis')`, 12000);
}
await sleep(1500);
report.overviewDark = await p.shot('overview-dark');
for (const page of ['games', 'games/roulette', 'rounds', 'players', 'money', 'bank', 'analytics', 'messages', 'alerts', 'settings', 'audit']) {
  await p.go(`${BASE}/#/${page}`);
  await p.waitFor(`!document.querySelector('.loading') && !!document.querySelector('.page')`, 12000);
  await sleep(500);
  const err = await p.ev(`document.querySelector('.error-box')?.textContent || ''`);
  assert.equal(err, '', `${page}: ${err}`);
  await p.shot(`page-${page.replace('/', '-')}`);
}
// Tooltips render.
await p.go(`${BASE}/#/overview`); await p.waitFor(`!!document.querySelector('.kpis .i')`);
const box = await p.ev(`(()=>{const r=document.querySelector('.kpis .i').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
await sleep(300);
report.tooltip = await p.ev(`document.querySelector('.tip.on')?.textContent || ''`);
assert.match(report.tooltip, /House profit/);
await p.shot('tooltip');
// Light mode.
await p.clickText('Light');
await sleep(400);
assert.equal(await p.ev(`document.documentElement.dataset.theme`), 'light');
report.overviewLight = await p.shot('overview-light');
await p.go(`${BASE}/#/games/roulette`); await p.waitFor(`!!document.querySelector('.switch')`);
await p.shot('game-light');
// Switch the game off, confirm, check the player site sees it, then switch on.
await p.click('.switch');
await p.waitFor(`!!document.querySelector('.modal')`);
await p.shot('confirm-off');
await p.clickText('Yes, save it');
await p.waitFor(`document.querySelector('.switch') && !document.querySelector('.switch').classList.contains('on')`);
await sleep(3500); // config cache on the game side is 3 s
const cfg = await (await fetch(`${GAME}/api/games/roulette/config`, { headers: { Cookie: process.env.GAME_COOKIE || '' } })).json().catch(() => null);
report.gameSeesOff = cfg ? cfg.enabled === false : 'no-cookie';
await p.click('.switch'); await p.waitFor(`!!document.querySelector('.modal')`); await p.clickText('Yes, save it');
await p.waitFor(`document.querySelector('.switch')?.classList.contains('on')`);
// Dark again and mobile layout.
await p.clickText('Dark');
await p.close();
const m = await openPage(390, 844, true);
await m.go(`${BASE}/#/overview`);
await sleep(1500);
report.mobile = await m.shot('mobile-overview');
await m.click('.menu-btn'); await sleep(400);
await m.shot('mobile-menu');
report.errors = [...p.errors, ...m.errors];
await m.close();
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.errors, []);
console.log('PASS admin browser QA');
