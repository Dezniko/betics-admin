// Overview: how the casino is doing right now.
import { h, api, money, pct, num, info, card, pageHead, segmented, countTo, ago, flag, countryName, short, loading, errorBox, empty, cap, fillSeries, floatCard, isReal } from '../lib.js';
import { T } from '../glossary.js';
import { lineChart, shareBars } from '../charts.js';
import { liveRounds } from './live.js';

let period = 'today';
const last = {}; // previous headline values, so refreshes count from where they were
export function overviewView(ctx) {
  const root = h('div', { class: 'page' });
  const body = h('div', {}, loading());
  root.append(pageHead('Overview', 'How the casino is doing right now. Hover any (i) to see what a number means.',
    segmented([['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']], period, v => { period = v; for (const k in last) delete last[k]; load(); }, '<b>Period</b>Today runs from midnight UTC.')), body);
  let timer = null;
  const live = liveRounds(ctx, { title: 'Live rounds', tip: T.live });
  async function load() {
    try {
      const d = await api(`/overview?period=${period}`);
      render(d);
    } catch (e) { body.replaceChildren(errorBox(e, load)); }
  }
  function delta(nowV, prevV, invert = false) {
    if (prevV == null || nowV == null || prevV === 0) return h('div', { class: 'delta' }, 'No earlier data to compare');
    const change = (nowV - prevV) / Math.abs(prevV) * 100, good = invert ? change < 0 : change > 0;
    return h('div', { class: `delta ${good ? 'up' : 'down'}` }, `${change > 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(0)}% vs previous period`);
  }
  function kpi(label, tip, value, fmt, extra, cls = '', href = null) {
    const el = h('div', { class: `big ${cls}` }, fmt(last[label] ?? 0));
    el.dataset.v = last[label] ?? 0;
    last[label] = value ?? 0;
    requestAnimationFrame(() => countTo(el, value ?? 0, fmt));
    return h(href ? 'a' : 'div', { class: 'card kpi', ...(href ? { href, tip: '<b>Open</b>Click for the full breakdown.' } : {}) }, h('div', { class: 'lab' }, label, info(tip)), el, extra);
  }
  function render(d) {
    const periodWord = { today: 'Today', '7d': 'In the last 7 days', '30d': 'In the last 30 days' }[period];
    const profit = d.now.profitCents;
    const headline = h('div', { class: 'headline' }, `${periodWord} the casino ${profit >= 0 ? 'made' : 'lost'} `,
      h('b', { class: profit >= 0 ? 'up' : 'down' }, money(Math.abs(profit))), ` from ${num(d.now.players)} player${d.now.players === 1 ? '' : 's'} and ${num(d.now.rounds)} rounds.`,
      h('span', { class: `mode ${d.realMoney ? 'real' : 'demo'}`, tip: T.mode }, d.realMoney ? 'Real TICS' : 'Demo money'));
    const alerts = d.openAlerts ? h('a', { class: 'alert-strip', href: '#/alerts' }, h('span', { class: 'dot' }),
      h('div', {}, h('b', {}, d.alerts[0]?.title || 'Alerts need a look'), d.openAlerts > 1 ? h('span', { class: 'muted' }, ` and ${d.openAlerts - 1} more`) : null),
      h('span', { class: 'btn small' }, 'Review')) : null;
    const kpis = h('div', { class: 'kpis' },
      kpi('House profit', T.profit, profit, v => money(v), delta(profit, d.prev.profitCents), profit >= 0 ? 'gold' : 'down', '#/money'),
      kpi('Money bet', T.bet, d.now.betCents, v => money(v), delta(d.now.betCents, d.prev.betCents), '', '#/money'),
      kpi('Payback', T.rtp, d.now.rtp ?? 0, v => d.now.rtp == null ? '-' : pct(v), h('div', { class: 'delta' }, `Target ${d.games.map(g => `${g.name} ${g.rtpTarget}%`).join(', ')}`), '', '#/games'),
      kpi('Active players', T.players, d.now.players, v => num(Math.round(v)), h('div', { class: 'delta' }, `${num(d.now.newPlayers)} ${d.realMoney ? 'new wallets' : 'new'}`, info(T.newPlayers)), '', '#/players'));
    const readout = h('span', { class: 'r' }, 'Hover the chart for exact values');
    const chart = card(null, null, h('h3', {}, 'Profit over time', info(T.profitChart), readout),
      lineChart(fillSeries(d.series, period === 'today' ? 'hour' : 'day', period === '7d' ? 7 : 30, t => ({ t, profitCents: 0 })).map(s => ({ label: period === 'today' ? s.t.slice(11) : s.t.slice(5), value: s.profitCents })), { format: v => money(v), readout, label: 'House profit over time', height: 330 }));
    const games = card('Games', 'Each game\'s results in this period. Click a game to change its limits, maths setting or switch it off.',
      ...d.games.map(g => h('a', { class: 'gm', href: `#/games/${g.id}` }, h('span', {}, g.name, ' ', h('span', { class: `pill ${g.enabled ? 'on' : 'off'}` }, g.enabled ? 'On' : 'Off')),
        h('span', { class: g.profitCents >= 0 ? 'gold' : 'down' }, money(g.profitCents)), h('span', { class: 'muted', tip: T.rtp }, g.rtp == null ? 'no rounds' : pct(g.rtp)))));
    const more = (href, text) => h('p', { class: 'small' }, h('a', { href }, text));
    const dev = card('Devices', T.devices, d.devices.length ? shareBars(d.devices.map(x => ({ label: cap(x.k), value: x.n })), { format: n => `${n} players` }) : empty('No players yet', 'Device split appears once people play.'), more('#/analytics', 'More in Analytics →'));
    const countries = card('Top countries', T.countries, d.countries.length ? h('div', {}, d.countries.map(c => h('div', { class: 'gm' },
      h('span', {}, `${flag(c.k)} ${countryName(c.k)}`), h('span', {}, `${c.n} players`), h('span', { class: c.profit >= 0 ? 'up' : 'down' }, money(c.profit))))) : empty('No players yet', 'Countries appear once people play.'), more('#/analytics', 'More in Analytics →'));
    const wins = card('Biggest wins', 'The largest wins by players in this period (what they won after taking off their bet).',
      d.bigWins.length ? h('div', {}, d.bigWins.map(w => h('a', { class: 'gm', href: `#/players/${w.player_id}` }, h('span', { class: 'mono' }, short(w.player_id)),
        h('span', { class: 'down' }, `+${money(w.payout_cents - w.stake_cents)}`), h('span', { class: 'muted' }, ago(w.created_at))))) : empty('No player wins yet', 'When players win, the biggest show here.'), more('#/rounds', 'All rounds →'));
    const fl = floatCard(d.ticsFloat, ctx);
    body.replaceChildren(headline, alerts || '', kpis, h('div', { class: 'grid2' }, chart, live), h('div', { class: 'grid4' }, games, wins, dev, countries), fl ? h('div', { class: 'grid2 even' }, fl) : '');
  }
  load();
  timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
  ctx.onLeave(() => clearInterval(timer));
  return root;
}
