// Browser QA for the Gods of Power screens: Games page, a slot round, Rounds filtered by game, Analytics By game.
// Seed: see the slots branch QA notes (one wallet player with roulette + slot rounds, a guest with demo rounds).
// ADMIN_URL=http://127.0.0.1:8790 SETUP_LINK=... QA_OUT=dir node test/browser/slots-qa.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { openPage, totp } from './cdp.mjs';

const BASE = process.env.ADMIN_URL || 'http://127.0.0.1:8790';
const OUT = process.env.QA_OUT || '/tmp/admin-slots-qa';
mkdirSync(OUT, { recursive: true });
const SECRET_FILE = `${OUT}/qa-totp-secret.txt`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(cond ? 'PASS' : 'FAIL', name, detail); };

const p = await openPage(1280, 800);
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
const SECRET = readFileSync(SECRET_FILE, 'utf8').trim();
// A later run (or a lost session) starts on the sign-in form: sign in with the saved secret.
await p.go(`${BASE}/`); await sleep(1200);
if (await p.ev(`!!document.querySelector('input[type=email], input[name=email]')`)) {
  await p.type('input[type=email], input[name=email]', 'qa@example.com');
  await p.type('input[type=password]', 'Correct horse 42 battery');
  await p.click('form button[type=submit]');
  await p.waitFor(`document.querySelector('form button[type=submit]')?.textContent === 'Check code and sign in'`, 8000);
  await p.type('input.code', totp(SECRET));
  await p.click('form button[type=submit]');
  await p.waitFor(`!!document.querySelector('.kpis')`, 12000);
}

const settle = async () => { await p.waitFor(`!document.querySelector('.loading') && !!document.querySelector('.page')`, 12000); await sleep(900); };
const visit = async (hash) => { await p.go(`${BASE}/#/${hash}`); await settle(); };
const text = () => p.ev('document.querySelector("main").innerText');
const size = async (w, h, mobile = false) => { await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile }); await sleep(300); };
const shotBoth = async (name, hash) => {
  await size(1280, 800); await visit(hash); await p.shot(`${name}-1280`);
  await size(390, 844, true); await visit('overview'); await visit(hash); await p.shot(`${name}-390`);
  await size(1280, 800);
};

await p.ev(`localStorage.setItem('betics-admin-view', 'real')`);
// Games page: both games.
await visit('games');
let t = await text();
ok('games page lists Roulette and Gods of Power', /Roulette/.test(t) && /Gods of Power/.test(t) && /Slot/.test(t), t.slice(0, 200).replace(/\n/g, ' | '));
await p.shot('games-1280');
await size(390, 844, true); await visit('overview'); await visit('games'); await p.shot('games-390'); await size(1280, 800);

// Gods of Power settings page: bet level selects.
await visit('games/godsofpower');
t = await text();
ok('slot game page shows bet levels note and selects', /2,000 times the bet/.test(t) && (await p.ev(`document.querySelectorAll('form.stack select').length`)) === 2, '');
ok('slot game page has the gods92 maths option in use', /Gods of Power 92/.test(t) && /In use/.test(t));
await p.shot('game-godsofpower-1280');
await size(390, 844, true); await visit('overview'); await visit('games/godsofpower'); await p.shot('game-godsofpower-390'); await size(1280, 800);

// Rounds page filtered by game.
await visit('rounds');
ok('rounds page has a game filter', await p.ev(`!!document.querySelector('[data-testid=game-filter]')`));
await p.ev(`(()=>{const s=document.querySelector('[data-testid=game-filter]');s.value='godsofpower';s.dispatchEvent(new Event('change'));return true})()`);
await sleep(1200);
const games = await p.ev(`[...document.querySelectorAll('main table tbody tr td:nth-child(2)')].map(td=>td.textContent.trim())`);
ok('rounds filtered to Gods of Power only', games.length === 3 && games.every(g => g === 'Gods of Power'), JSON.stringify(games));
t = await text();
ok('slot result cells show spins and capped', /3 spins \(2 free\)/.test(t) && /capped/.test(t), '');
await p.shot('rounds-godsofpower-1280');
await size(390, 844, true); await visit('overview'); await visit('rounds');
await p.ev(`(()=>{const s=document.querySelector('[data-testid=game-filter]');s.value='godsofpower';s.dispatchEvent(new Event('change'));return true})()`);
await sleep(1200); await p.shot('rounds-godsofpower-390'); await size(1280, 800);
await visit('rounds');
await p.ev(`(()=>{const s=document.querySelector('[data-testid=game-filter]');s.value='roulette';s.dispatchEvent(new Event('change'));return true})()`);
await sleep(1200);
const rg = await p.ev(`[...document.querySelectorAll('main table tbody tr td:nth-child(2)')].map(td=>td.textContent.trim())`);
ok('rounds filtered to Roulette only', rg.length === 1 && rg[0] === 'Roulette', JSON.stringify(rg));

// Slot round detail (free spins, capped) and a roulette round (felt unchanged).
await shotBoth('round-godsofpower', 'rounds/w%3A2');
t = await text();
ok('slot round page: reels, free spins, line wins', /Base spin/.test(t) && /Free spin 1/.test(t) && /Gold bar/.test(t) && /Line 2: 4/.test(t) && /2 played/.test(t), t.slice(0, 300).replace(/\n/g, ' | '));
ok('slot round page: 15 cells per spin', (await p.ev(`document.querySelectorAll('.slot-grid .sym').length`)) === 45);
ok('slot round page: lit cells', (await p.ev(`document.querySelectorAll('.slot-grid .sym.lit').length`)) > 0);
await size(390, 844, true); await visit('overview'); await visit('rounds/w%3A2');
await p.ev(`document.querySelector('.spin')?.scrollIntoView()`); await sleep(400); await p.shot('round-godsofpower-reels-390'); await size(1280, 800);
await visit('rounds/w%3A4');
t = await text();
ok('capped slot round says Reached', /Reached/.test(t) && /2000x/.test(t), '');
await p.shot('round-godsofpower-capped-1280');
await visit('rounds/w%3A1');
ok('roulette round still shows bets and felt', /Bets/.test(await text()) && await p.ev(`!!document.querySelector('.card .seg')`));
await p.shot('round-roulette-1280');

// Player page and live feed.
await visit('players/' + '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
t = await text();
ok('player page names Gods of Power in games and rounds', (t.match(/Gods of Power/g) || []).length >= 3, '');
await visit('overview');
t = await text();
ok('live feed names the game', /Gods of Power/.test(t) && /Roulette/.test(t), '');

// Money page filter + Analytics By game.
await visit('money');
ok('money page has a game filter', await p.ev(`!!document.querySelector('[data-testid=game-filter]')`));
await p.ev(`(()=>{const s=document.querySelector('[data-testid=game-filter]');s.value='godsofpower';s.dispatchEvent(new Event('change'));return true})()`);
await sleep(1200);
t = await text();
ok('money page filtered to Gods of Power', /Showing Gods of Power only/.test(t), '');
await p.shot('money-godsofpower-1280');
await shotBoth('analytics-bygame', 'analytics');
t = await text();
ok('analytics By game table lists both games', /By game/.test(t) && /Gods of Power/.test(t) && /Roulette/.test(t), '');
await p.ev(`document.querySelector('main .grid3 .card:first-child')?.scrollIntoView()`); await sleep(300);
await p.shot('analytics-bygame-table-1280');

// Alerts limits form has the slot field.
await visit('alerts');
ok('alert limits form has the slot multiple', /times the bet/.test(await text()));

ok('no page errors', p.errors.length === 0, p.errors.join(' || ').slice(0, 500));
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
await p.close();
const fails = results.filter(r => !r.pass).length;
console.log(`${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
