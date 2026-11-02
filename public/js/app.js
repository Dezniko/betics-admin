// App shell: sign-in gate, sidebar, hash router.
import { h, api, installTooltips, applyTheme, setCurrency, toast, getView, setView, isReal, segmented } from './lib.js';
import { loginView, setupView } from './views/auth.js';
import { overviewView } from './views/overview.js';
import { gamesView, gameView } from './views/games.js';
import { roundsView, roundView, playersView, playerView } from './views/players.js';
import { moneyView, analyticsView } from './views/money.js';
import { bankView } from './views/bank.js';
import { paymentsView } from './views/payments.js';
import { treasuryView, feesView } from './views/tics.js';
import { messagesView, alertsView, settingsView, auditView } from './views/more.js';

const ICONS = {
  overview: '<path d="M3 12h4l3 8 4-16 3 8h4"/>', games: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  rounds: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/>', players: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2"/>',
  money: '<path d="M12 3v18M16.5 7.5c0-1.9-2-3-4.5-3s-4.5 1.2-4.5 3 1.8 2.6 4.5 3.2 4.5 1.4 4.5 3.3-2 3.3-4.5 3.3-4.5-1.3-4.5-3.3"/>',
  bank: '<path d="M3 10h18L12 4z"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  payments: '<path d="M7 7h13l-3-3M17 17H4l3 3"/>',
  fees: '<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/><path d="M9.5 14.5c0 1.4 1.1 2.5 2.5 2.5"/>',
  treasury: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14.5h2"/><path d="M7 6V4.5h10V6"/>',
  analytics: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', messages: '<path d="M4 5h16v11H8l-4 4z"/>', alerts: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  audit: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h3"/>',
};
const icon = name => h('span', { class: 'nav-icon', html: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });

const NAV = [
  ['overview', 'Overview', 'How the casino is doing right now'], ['games', 'Games', 'Switch games on or off, limits and maths'],
  ['rounds', 'Rounds', 'Every round played'], ['players', 'Players', 'Search, balances, pause or ban'], ['money', 'Money', 'Bet, paid out and profit over time'], ['bank', 'Bank', 'Casino wallets live: top up or take out'], ['payments', 'Payments', 'TICS payouts and deposits, USDT history'], ['treasury', 'Treasury', 'Casino wallet, free float, send to treasury, payout settings'], ['fees', 'Fees', 'The network fee players pay on withdrawals'],
  ['analytics', 'Analytics', 'Countries, devices, busiest hours, who comes back'], ['messages', 'Messages', 'Send messages to players'], ['alerts', 'Alerts', 'Things that need a look'],
];
const SETUP = [['settings', 'Settings', 'Currency, people and roles, theme'], ['audit', 'Audit log', 'Every change made in this panel']];
// Pages about real TICS only (wallets, payouts, fees). Hidden in the Demo view.
const REAL_ONLY = ['bank', 'payments', 'treasury', 'fees'];

const app = document.getElementById('app');
let admin = null, leaveHandlers = [];
const ctx = {
  get admin() { return admin; },
  can: perm => !!admin && (admin.perms.includes('*') || admin.perms.includes(perm)),
  onLeave: fn => leaveHandlers.push(fn),
};

function shell(active, content) {
  const navLink = ([id, label, tip]) => h('a', { href: `#/${id}`, class: active === id ? 'on' : '', 'aria-current': active === id ? 'page' : null, tip: `<b>${label}</b>${tip}` },
    icon(id), h('span', {}, label), id === 'alerts' ? h('b', { class: 'badge', id: 'alert-badge', hidden: true }) : null);
  const nav = h('nav', { class: 'side', 'aria-label': 'Main' },
    h('a', { class: 'logo', href: '#/overview' }, h('i'), 'qu-BETICS Admin'),
    NAV.filter(n => (n[0] !== 'treasury' || ctx.can('treasury:manage')) && (n[0] !== 'fees' || ctx.can('settings:edit')) && (isReal() || !REAL_ONLY.includes(n[0]))).map(navLink), h('div', { class: 'sec' }, 'Setup'), SETUP.map(navLink),
    h('div', { class: 'me' }, h('div', {}, h('b', {}, admin.name), h('small', {}, admin.roleLabel)),
      h('button', { class: 'btn small', onclick: async () => { try { await api('/auth/logout', { method: 'POST' }); } finally { location.replace('/'); } } }, 'Sign out')));
  const menu = h('button', { class: 'menu-btn', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('nav-open') }, h('span'), h('span'), h('span'));
  const themeBox = h('div', { class: 'theme', tip: '<b>Light or dark</b>Auto follows your phone or computer setting. Your choice is remembered on this device.' },
    ...['light', 'dark', 'auto'].map(m => h('button', { 'data-th': m, onclick: () => applyTheme(m) }, m[0].toUpperCase() + m.slice(1))));
  const viewSwitch = h('div', { class: `view-switch ${isReal() ? 'is-real' : 'is-demo'}` }, h('span', { class: 'view-lab' }, 'Showing'),
    segmented([['real', 'Real TICS'], ['demo', 'Demo']], getView(), v => { setView(v); route(); },
      '<b>Real or demo</b>Real TICS shows only real deposits, bets, payouts and players with a wallet. Demo shows only play money. The two are never mixed. Your choice is remembered on this device.'));
  const top = h('header', { class: 'topbar' }, menu, h('span', { class: 'mobile-logo' }, 'qu-BETICS Admin'), viewSwitch, h('div', { class: 'grow' }), themeBox);
  const banner = isReal() ? null : h('div', { class: 'demo-banner', role: 'status' }, h('b', {}, 'Demo view.'), ' Every number here is play money. ',
    h('a', { href: '#', onclick: e => { e.preventDefault(); setView('real'); route(); } }, 'Switch to Real TICS'));
  return h('div', { class: 'app' }, nav, h('div', { class: 'main-col' }, top, banner || '', h('main', { id: 'main', tabindex: -1 }, content)),
    h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') }));
}

async function refreshBadge() {
  try {
    const d = await api('/alerts?status=open');
    const b = document.getElementById('alert-badge');
    const n = d.counts.open || 0;
    if (b) { b.hidden = !n; b.textContent = n; }
  } catch { /* ignore */ }
}

async function route() {
  leaveHandlers.forEach(fn => fn()); leaveHandlers = [];
  document.body.classList.remove('nav-open');
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'setup' && parts[1]) { app.replaceChildren(setupView(parts[1], a => { admin = a; location.hash = '#/overview'; route(); })); return; }
  if (!admin) {
    try { admin = (await api('/me')).admin; } catch { admin = null; }
    if (!admin) { app.replaceChildren(loginView(a => { admin = a; route(); })); return; }
    api('/settings').then(s => setCurrency(s.currency)).catch(() => {});
  }
  const [page, id] = parts;
  const views = {
    overview: () => overviewView(ctx), games: () => id ? gameView(ctx, id) : gamesView(ctx), rounds: () => id ? roundView(ctx, decodeURIComponent(id)) : roundsView(ctx),
    players: () => id ? playerView(ctx, id) : playersView(ctx), money: () => moneyView(ctx), bank: () => bankView(ctx), payments: () => paymentsView(ctx), treasury: () => treasuryView(ctx), fees: () => feesView(ctx), analytics: () => analyticsView(ctx),
    messages: () => messagesView(ctx), alerts: () => alertsView(ctx), settings: () => settingsView(ctx), audit: () => auditView(ctx),
  };
  const key = views[page] ? page : 'overview';
  const realOnly = !isReal() && REAL_ONLY.includes(key);
  const content = realOnly ? h('div', { class: 'page' }, h('section', { class: 'card empty-page' }, h('h3', {}, 'This page is about real TICS'),
    h('p', { class: 'muted' }, 'Casino wallets, payouts, deposits and fees only exist for real money, so there is nothing to show in the Demo view.'),
    h('button', { class: 'btn primary', onclick: () => { setView('real'); route(); } }, 'Switch to Real TICS'))) : views[key]();
  app.replaceChildren(shell(key, content));
  applyTheme();
  document.title = `${[...NAV, ...SETUP].find(n => n[0] === key)[1]} · qu-BETICS Admin`;
  refreshBadge();
}

window.addEventListener('hashchange', route);
window.addEventListener('signed-out', () => { if (admin) { admin = null; toast('You were signed out. Please sign in again.', 'bad'); route(); } });
installTooltips();
applyTheme();
route();
setInterval(() => { if (admin && document.visibilityState === 'visible') refreshBadge(); }, 60000);
