// Browser QA for the Real / Demo switch and the internal links.
// Seed: one wallet player with 1 real round (bet 100 TICS, lost) and 1 demo round (bet 2,000, won 7,200),
// plus a guest with 1 demo round (bet 500, lost). See the commit that added this file.
// ADMIN_URL=http://127.0.0.1:8790 CDP_PORT=9355 SETUP_LINK=... QA_OUT=dir node test/browser/view-switch-qa.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { openPage, totp } from './cdp.mjs';

const BASE = process.env.ADMIN_URL || 'http://127.0.0.1:8790';
const OUT = process.env.QA_OUT || '/tmp/admin-view-qa';
mkdirSync(OUT, { recursive: true });
const SECRET_FILE = `${OUT}/qa-totp-secret.txt`;
const W1 = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(cond ? 'PASS' : 'FAIL', name, detail); };

const p = await openPage(1440, 900);
await p.go(`${BASE}/`);
if (process.env.SETUP_LINK && !existsSync(SECRET_FILE)) {
  await p.go(process.env.SETUP_LINK);
  await p.waitFor(`!!document.querySelector('input[type=password]')`);
  await p.type('input[autocomplete=new-password]', 'Correct horse 42 battery');
  await p.ev(`document.querySelectorAll('input[autocomplete=new-password]')[1].value='Correct horse 42 battery'`);
  await p.click('form button[type=submit]');
  await p.waitFor(`!!document.querySelector('.qr svg')`);
  const secret = (await p.ev(`document.querySelector('.qr ~ details .mono').textContent`)).replace(/\s/g, '');
  writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  await p.type('input.code', totp(secret));
  await p.click('form button[type=submit]');
  await p.waitFor(`location.hash.startsWith('#/overview') && !!document.querySelector('.kpis')`, 12000);
}
readFileSync(SECRET_FILE, 'utf8');

const settle = async () => { await p.waitFor(`!document.querySelector('.loading') && !!document.querySelector('.page')`, 12000); await sleep(900); };
const visit = async (hash) => { await p.go(`${BASE}/#/${hash}`); await settle(); };
const text = () => p.ev('document.querySelector("main").innerText');
const nav = () => p.ev(`[...document.querySelectorAll('nav.side a')].map(a => a.textContent.trim())`);
const setViewUI = async v => { await p.ev(`[...document.querySelectorAll('.view-switch .seg button')].find(b => b.dataset.v === '${v}').click()`); await settle(); };

// Start in Real (the default).
await p.ev(`localStorage.removeItem('betics-admin-view')`);
await visit('overview');
let t = await text();
ok('real overview: only the real round counts', /made\s+100\.00 TICS/.test(t) && /1 player/.test(t), t.slice(0, 160).replace(/\n/g, ' | '));
ok('real overview: Real TICS label', /Real TICS/.test(t));
ok('real nav has Treasury and Payments', (await nav()).includes('Treasury') && (await nav()).includes('Payments'));
ok('no demo banner in Real', !(await p.ev(`!!document.querySelector('.demo-banner')`)));
await p.shot('real-overview');
// KPI card links
ok('House profit card links to Money', (await p.ev(`[...document.querySelectorAll('a.card.kpi')].map(a=>a.getAttribute('href'))`)).join(',') === '#/money,#/money,#/games,#/players');

await visit('players');
t = await text();
ok('real players: wallet players only', /^1 player/m.test(t) && !/guest/.test(t), t.slice(0, 80));
await visit('rounds');
ok('real rounds: 1 round', (await p.ev(`document.querySelectorAll('main table tbody tr').length`)) === 1);
// Player link inside the rounds table goes to the player, not the round.
await p.ev(`document.querySelector('main table tbody tr a[href^="#/players/"]').click()`); await settle();
ok('rounds table player link opens the player', (await p.ev('location.hash')) === `#/players/${W1}`);
t = await text();
ok('real player profile: real balance, deposit and 1 real round', /Real TICS balance/.test(t) && /Deposited/.test(t) && /6,000\.00 TICS/.test(t) && !/Demo balance/.test(t), '');
ok('real player profile: no demo adjust button', !/Adjust demo balance/.test(t));
await p.shot('real-player');
await p.ev(`document.querySelector('main a[href^="#/games/"]').click()`); await settle();
ok('player profile game link opens the game', (await p.ev('location.hash')) === '#/games/roulette');
ok('game page says Real TICS results', /Real TICS results/.test(await text()));

// Switch to Demo with the top bar control.
await visit('overview');
await setViewUI('demo');
t = await text();
ok('demo overview: only demo rounds count', /lost\s+4,700\.00 TICS/.test(t) && /2 players/.test(t), t.slice(0, 160).replace(/\n/g, ' | '));
ok('demo banner shown', await p.ev(`!!document.querySelector('.demo-banner')`));
const dn = await nav();
ok('demo nav hides real-only pages', !dn.includes('Treasury') && !dn.includes('Payments') && !dn.includes('Fees') && !dn.includes('Bank'), dn.join(','));
ok('float card hidden in Demo', !/Casino wallet float/.test(t));
await p.shot('demo-overview');
await visit('players');
t = await text();
ok('demo players: guests included', /^2 players/m.test(t) && /guest/.test(t), t.slice(0, 80));
await visit(`players/${W1}`);
t = await text();
ok('demo player profile: demo balance and demo round only', /Demo balance/.test(t) && !/Real TICS balance/.test(t) && /Demo rounds[\s\S]{0,12}\n1\n/.test(t) && !/100\.00 TICS\n/.test(t), JSON.stringify(t.match(/Demo rounds[\s\S]{0,12}/)?.[0]));
await p.shot('demo-player');
await visit('treasury');
ok('real-only page in Demo explains and offers the switch', /This page is about real TICS/.test(await text()));
// The choice is remembered across reloads.
await p.go(`${BASE}/#/money`); await settle();
ok('Demo is remembered after reload', (await p.ev(`document.querySelector('.view-switch .seg button.active').dataset.v`)) === 'demo' && /Demo money/.test(await text()));
await p.ev(`[...document.querySelectorAll('.demo-banner a')][0].click()`); await settle();
ok('banner link switches back to Real', (await p.ev(`document.querySelector('.view-switch .seg button.active').dataset.v`)) === 'real' && !(await p.ev(`!!document.querySelector('.demo-banner')`)));

// Phone width: switch fits, no overflow.
const m = await openPage(390, 844, true);
await m.go(`${BASE}/#/overview`); await m.waitFor(`!document.querySelector('.loading') && !!document.querySelector('.page')`, 12000); await sleep(900);
const fit = await m.ev(`(()=>{const b=document.querySelector('.view-switch').getBoundingClientRect();return {right:b.right, vw: document.documentElement.clientWidth, docW: document.documentElement.scrollWidth}})()`);
ok('phone: switch visible and page not wider than the screen', fit.right <= fit.vw && fit.docW <= fit.vw + 1, JSON.stringify(fit));
await m.shot('phone-overview');
ok('no browser errors', !p.errors.length && !m.errors.length, [...p.errors, ...m.errors].join(' | ').slice(0, 300));
const failed = results.filter(r => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
