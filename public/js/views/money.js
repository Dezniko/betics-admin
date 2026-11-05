// Money and Analytics screens.
import { h, api, money, pct, num, info, card, pageHead, loading, errorBox, empty, segmented, flag, countryName, cap, table, fillSeries, isReal, viewQuery } from '../lib.js';
import { T } from '../glossary.js';
import { lineChart, barChart, shareBars, donut, heatmap } from '../charts.js';
import { rememberGames, gameName } from './outcome.js';

let mPeriod = '30d', mGroup = 'day', mGame = '';
export function moneyView(ctx) {
  const root = h('div', { class: 'page' });
  const body = h('div', {}, loading());
  // Game filter: the money data already comes per game, so this only picks rows (no extra query).
  const gameSel = h('select', { class: 'input', 'aria-label': 'Game', 'data-testid': 'game-filter' }, h('option', { value: '' }, 'All games'));
  gameSel.onchange = () => { mGame = gameSel.value; load(); };
  const fillGames = list => { if (!list?.length || gameSel.options.length > 1) return; for (const g of list) gameSel.append(h('option', { value: g.id, selected: g.id === mGame }, g.name)); };
  const csv = ctx.can('money:export') ? h('a', { class: 'btn', href: '#', onclick: e => { e.preventDefault(); location.href = `/api/money.csv?period=${mPeriod}&group=${mGroup}&${viewQuery()}`; }, tip: '<b>Download CSV</b>A spreadsheet of these numbers, one row per period and game.' }, 'Download CSV') : null;
  root.append(pageHead('Money', `${isReal() ? 'Real TICS' : 'Demo money'}: what players bet, what they were paid and what the casino kept, by day, week or month.`,
    segmented([['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['all', 'All time']], mPeriod, v => { mPeriod = v; load(); }),
    segmented([['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']], mGroup, v => { mGroup = v; load(); }), gameSel, csv), body);
  async function load() {
    try {
      const d = await api(`/money?period=${mPeriod}&group=${mGroup}`);
      rememberGames(d.games); fillGames(d.games);
      if (mGame) {
        // One game: its rows and totals only (the player count is only known across all games).
        d.rows = d.rows.filter(r => r.gameId === mGame);
        const g = d.byGame.find(x => x.gameId === mGame) || { rounds: 0, betCents: 0, paidCents: 0, profitCents: 0, rtp: null };
        d.total = { ...d.total, rounds: g.rounds, betCents: g.betCents, paidCents: g.paidCents, profitCents: g.profitCents, rtp: g.rtp };
        d.byGame = d.byGame.filter(x => x.gameId === mGame);
      }
      const byT = new Map();
      for (const r of d.rows) { const x = byT.get(r.t) || { t: r.t, bet: 0, paid: 0, profit: 0, rounds: 0 }; x.bet += r.betCents; x.paid += r.paidCents; x.profit += r.profitCents; x.rounds += r.rounds; byT.set(r.t, x); }
      const rows = mGroup === 'day' && mPeriod !== 'all' ? fillSeries([...byT.values()], 'day', mPeriod === '7d' ? 7 : mPeriod === '90d' ? 90 : 30, t => ({ t, bet: 0, paid: 0, profit: 0, rounds: 0 })) : [...byT.values()];
      const readout = h('span', { class: 'r' }, 'Hover a bar');
      body.replaceChildren(
        mGame ? h('p', { class: 'muted' }, `Showing ${gameName(mGame)} only. `, h('a', { href: '#', onclick: e => { e.preventDefault(); mGame = ''; gameSel.value = ''; load(); } }, 'Show all games')) : '',
        h('div', { class: 'kpis' },
          h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'House profit', info(T.profit)), h('div', { class: `big ${d.total.profitCents >= 0 ? 'gold' : 'down'}` }, money(d.total.profitCents))),
          h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Money bet', info(T.bet)), h('div', { class: 'big' }, money(d.total.betCents))),
          h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Paid out', info(T.paid)), h('div', { class: 'big' }, money(d.total.paidCents))),
          h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Payback', info(T.rtp)), h('div', { class: 'big' }, d.total.rtp == null ? '-' : pct(d.total.rtp)))),
        card(null, null, h('h3', {}, 'Profit per period', info('<b>Profit per period</b>Each bar is one day, week or month. Gold bars are profit, red bars are periods the casino lost.'), readout),
          barChart(rows.map(r => ({ label: r.t, value: r.profit })), { format: v => money(v), readout })),
        h('div', { class: 'grid2 even' },
          card('Profit by game', 'Which games made the money in this period.', d.byGame.length ? donut(d.byGame.map(g => ({ label: g.gameName || gameName(g.gameId), value: g.profitCents }))) : empty('No rounds yet', 'Game split appears once people play.'),
            d.byGame.length ? table([{ label: 'Game', render: g => h('a', { href: `#/games/${encodeURIComponent(g.gameId)}` }, g.gameName || gameName(g.gameId)) }, { label: 'Rounds', align: 'right', render: g => num(g.rounds) },
              { label: 'Bet', align: 'right', render: g => money(g.betCents) }, { label: 'Paid', align: 'right', render: g => money(g.paidCents) },
              { label: 'Profit', align: 'right', render: g => h('span', { class: g.profitCents >= 0 ? 'up' : 'down' }, money(g.profitCents, { sign: true })) }], d.byGame) : null),
          card('Costs', 'Costs that come with real money.', h('div', { class: 'stack' },
            h('div', { class: 'gm muted' }, h('span', {}, 'Payment fees'), h('span', {}, 'When payments go live')),
            h('div', { class: 'gm muted' }, h('span', {}, 'Bonuses'), h('span', {}, 'When bonuses exist')),
            h('div', { class: 'gm' }, h('span', {}, 'Net profit (after the above)', info('<b>Net profit (NGR)</b>House profit minus payment fees and bonuses. This is the real money left.')), h('b', { class: 'gold' }, money(d.total.profitCents)))))),
        card('By period', 'The numbers behind the chart.', table([
          { label: 'Period', key: 't' }, { label: 'Rounds', align: 'right', render: r => num(r.rounds) }, { label: 'Bet', align: 'right', render: r => money(r.bet) },
          { label: 'Paid', align: 'right', render: r => money(r.paid) }, { label: 'Profit', align: 'right', render: r => h('span', { class: r.profit >= 0 ? 'up' : 'down' }, money(r.profit, { sign: true })) },
          { label: 'Payback', align: 'right', render: r => r.bet ? pct(r.paid / r.bet * 100) : '-' }], rows.filter(r => r.rounds).reverse(), { emptyText: 'No rounds in this period.' })),
        d.realMoney ? h('section', { class: 'card' }, h('h3', {}, 'Deposits and withdrawals'), h('p', { class: 'muted' }, 'Every TICS deposit and payout, with what is waiting, is on the Payments page. The casino wallet and the free float are on Treasury.'),
          h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/payments' }, 'Open Payments'), h('a', { class: 'btn', href: '#/treasury' }, 'Open Treasury'))) : '');
    } catch (e) { body.replaceChildren(errorBox(e, load)); }
  }
  load();
  return root;
}

let aPeriod = '30d';
export function analyticsView() {
  const root = h('div', { class: 'page' });
  const body = h('div', {}, loading());
  const filters = { country: '', device: '' };
  const device = h('select', { class: 'input' }, h('option', { value: '' }, 'All devices'), h('option', { value: 'mobile' }, 'Phones'), h('option', { value: 'tablet' }, 'Tablets'), h('option', { value: 'desktop' }, 'Computers'));
  device.onchange = () => { filters.device = device.value; load(); };
  root.append(pageHead('Analytics', `Who plays, where from, on what, when, and who comes back. Money figures are ${isReal() ? 'real TICS' : 'demo money'} only and match the Money screen; visits count everyone.`,
    device, segmented([['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']], aPeriod, v => { aPeriod = v; load(); })), body);
  async function load() {
    try {
      const p = new URLSearchParams({ period: aPeriod, ...(filters.device ? { device: filters.device } : {}), ...(filters.country ? { country: filters.country } : {}) });
      const d = await api(`/analytics?${p}`);
      rememberGames(d.games?.map(g => ({ id: g.gameId, name: g.gameName })));
      const readout = h('span', { class: 'r' }, 'Hover a day');
      const days = aPeriod === '7d' ? 7 : aPeriod === '90d' ? 90 : 30;
      d.daily = fillSeries(d.daily, 'day', days, t => ({ t, new_players: 0, returning_players: 0 }));
      const heatOut = h('span', { class: 'r' }, 'Hover a square');
      const funnelMax = Math.max(1, d.funnel[0].n);
      body.replaceChildren(
        filters.country ? h('p', {}, `Showing ${flag(filters.country)} ${countryName(filters.country)} only. `, h('a', { href: '#', onclick: e => { e.preventDefault(); filters.country = ''; load(); } }, 'Show all countries')) : '',
        h('div', { class: 'grid2' },
          card(null, null, h('h3', {}, 'New and returning players per day', info('<b>New and returning</b>Gold: people who visited for the first time that day. Blue: people who came back.'), readout),
            h('div', { class: 'stack' }, lineChart(d.daily.map(x => ({ label: x.t.slice(5), value: x.new_players })), { format: v => `${v} new`, readout, height: 140 }),
              lineChart(d.daily.map(x => ({ label: x.t.slice(5), value: x.returning_players })), { format: v => `${v} returning`, readout, height: 140, color: 'var(--blue)' }))),
          card('Player journey', T.funnel, h('div', { class: 'funnel' }, d.funnel.map((f, i) => h('div', { class: 'funnel-step' },
            h('div', { class: 'funnel-top' }, h('span', {}, f.step, f.soon ? h('span', { class: 'muted small' }, ' (once built)') : ''), h('b', {}, num(f.n)),
              i > 0 && d.funnel[i - 1].n ? h('span', { class: 'muted small' }, `${Math.round(f.n / d.funnel[i - 1].n * 100)}% of previous`) : ''),
            h('div', { class: 'meter' }, h('i', { style: { width: `${f.n / funnelMax * 100}%` } }))))))),
        h('div', { class: 'grid3' },
          card('Countries', `${T.countries} Click a country to filter everything to it.`, d.countries.length ? h('div', {}, d.countries.map(c => h('a', { class: 'gm', href: '#', onclick: e => { e.preventDefault(); filters.country = c.k; load(); } },
            h('span', {}, `${flag(c.k)} ${countryName(c.k)}`), h('span', {}, `${c.n} players`), h('span', { class: c.profit >= 0 ? 'up' : 'down' }, money(c.profit))))) : empty('No visits yet', 'Countries appear once people visit.')),
          card('Devices', T.devices, d.devices.length ? shareBars(d.devices.map(x => ({ label: cap(x.k), value: x.n })), { format: n => `${n}` }) : empty('No visits yet', '')),
          card('Phone and computer systems', '<b>Systems</b>iOS is iPhone and iPad. Android is most other phones. Windows, macOS and Linux are computers.', d.os.length ? shareBars(d.os.map(x => ({ label: x.k, value: x.n })), { format: n => `${n}` }) : empty('No visits yet', ''))),
        h('div', { class: 'grid2' },
          card(null, null, h('h3', {}, 'Busiest hours', info(T.heat), heatOut), heatmap(d.heat.map(c => ({ d: c.d, h: c.h, value: c.bet })), { format: v => `${money(v)} bet`, readout: heatOut })),
          card('Coming back', T.retention, h('div', { class: 'retention' }, d.retention.map(r => h('div', { class: 'ret' }, h('b', {}, r.pct == null ? '-' : `${r.pct}%`),
            h('span', {}, `after ${r.days} day${r.days > 1 ? 's' : ''}`), h('small', { class: 'muted' }, r.cohort ? `${r.back} of ${r.cohort} players` : 'Not enough time has passed yet')))),
            h('div', { class: 'gm' }, h('span', {}, 'Average session', info('<b>Average session</b>How long a visit lasts, from opening the game to leaving it.')), h('b', {}, d.sessions.avgSeconds ? `${Math.round(d.sessions.avgSeconds / 60)} min ${d.sessions.avgSeconds % 60} s` : '-')))),
        h('div', { class: 'grid3' },
          card('By game', '<b>By game</b>Every game on the platform in this period: who played it, how much was bet (turnover) and paid back, and what the casino kept.', table([
            { label: 'Game', render: g => h('a', { href: `#/games/${encodeURIComponent(g.gameId)}` }, g.gameName || gameName(g.gameId)) }, { label: 'Players', align: 'right', render: g => num(g.players) }, { label: 'Rounds', align: 'right', render: g => num(g.rounds) },
            { label: 'Bet', align: 'right', render: g => money(g.betCents) }, { label: 'Paid', align: 'right', render: g => money(g.paidCents) },
            { label: 'Profit', align: 'right', render: g => h('span', { class: g.profitCents >= 0 ? 'up' : 'down' }, money(g.profitCents, { sign: true })) },
            { label: 'Avg bet', align: 'right', render: g => money(g.avgBetCents) }, { label: 'Payback', align: 'right', render: g => g.rtp == null ? '-' : pct(g.rtp) }], d.games, { emptyText: 'No rounds in this period.' })),
          card('Where players come from', '<b>Referrers</b>The website a player came from on their first visit, and how much the casino has made from those players.', table([
            { label: 'Source', render: r => r.k.replace(/^https?:\/\//, '').slice(0, 40) }, { label: 'Players', align: 'right', render: r => num(r.n) },
            { label: 'House profit', align: 'right', render: r => money(r.profit) }], d.referrers, { emptyText: 'No new players in this period.' })),
          card('Player value by country', T.value, table([
            { label: 'Country', render: v => `${flag(v.k)} ${countryName(v.k)}` }, { label: 'Players', align: 'right', render: v => num(v.players) },
            { label: 'Total', align: 'right', render: v => money(v.profit) }, { label: 'Per player', align: 'right', render: v => money(v.per_player) }], d.value))),
        h('div', { class: 'grid3' },
          card('Campaigns', '<b>Campaigns</b>Players who arrived through a link with utm_campaign in it, and what they are worth to the house.', table([
            { label: 'Campaign', key: 'k' }, { label: 'Players', align: 'right', render: r => num(r.n) }, { label: 'House profit', align: 'right', render: r => money(r.profit) }], d.campaigns, { emptyText: 'No campaign links used yet.' })),
          card('Browsers', 'Which browser players use.', d.browsers.length ? shareBars(d.browsers.map(x => ({ label: x.k, value: x.n })), { format: n => `${n}` }) : empty('No visits yet', '')),
          card('Screen sizes', 'The most common screen sizes, useful for design decisions.', d.screens.length ? shareBars(d.screens.map(x => ({ label: x.k, value: x.n })), { format: n => `${n}` }) : empty('No data yet', 'Screen sizes are recorded on the next visits.'))));
    } catch (e) { body.replaceChildren(errorBox(e, load)); }
  }
  load();
  return root;
}
