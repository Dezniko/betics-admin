// Games list and one game's controls.
import { h, api, money, pct, num, info, card, pageHead, loading, errorBox, empty, toast, confirmDialog, field, centsInput, readCents, ago, short, flag, localTime, fillSeries, isReal, stepUpFields } from '../lib.js';
import { T } from '../glossary.js';
import { lineChart } from '../charts.js';
import { liveRounds } from './live.js';

export function gamesView() {
  const root = h('div', { class: 'page' }, pageHead('Games', `Every game on the platform, with ${isReal() ? 'real TICS' : 'demo'} results. Click one to switch it on or off, set its limits or choose its maths setting.`));
  const body = h('div', {}, loading()); root.append(body);
  (async () => {
    try {
      const { games } = await api('/games');
      body.replaceChildren(h('div', { class: 'game-grid' }, games.map(g => h('a', { class: 'card game-tile', href: `#/games/${g.id}` },
        h('div', { class: 'tile-top' }, h('span', { class: 'gicon' }, g.name[0]), h('div', {}, h('b', {}, g.name), h('div', { class: 'muted small' }, g.mathLabel)),
          h('span', { class: `pill ${g.enabled ? 'on' : 'off'}` }, g.enabled ? 'On' : 'Off')),
        h('div', { class: 'tile-stats' },
          h('div', {}, h('small', {}, 'Profit today', info(T.profit)), h('b', { class: g.profitTodayCents >= 0 ? 'gold' : 'down' }, money(g.profitTodayCents))),
          h('div', {}, h('small', {}, 'Rounds today', info(T.rounds)), h('b', {}, num(g.roundsToday))),
          h('div', {}, h('small', {}, 'Payback 30 days', info(T.rtp)), h('b', {}, g.rtp30 == null ? '-' : pct(g.rtp30)), h('small', { class: 'muted' }, `target ${g.rtpTarget}%`)))))),
        h('p', { class: 'muted note' }, 'New games appear here automatically when they are added to the platform.'));
    } catch (e) { body.replaceChildren(errorBox(e)); }
  })();
  return root;
}

export function gameView(ctx, id) {
  const root = h('div', { class: 'page' }, loading());
  const can = ctx.can('game:edit');
  const latest = liveRounds(ctx, { title: 'Latest rounds', tip: 'The newest rounds on this game. Click one to see the bets on the table and the fairness proof.', game: id, limit: 20 });
  async function load() {
    try { render(await api(`/games/${id}`)); } catch (e) { root.replaceChildren(errorBox(e, load)); }
  }
  // Bet limits and the maths option move money: the server asks for your password and a fresh code (switching off or the message does not).
  async function save(patch, { title, body, danger = false, done, money: moneyChange = false }) {
    const step = moneyChange ? stepUpFields() : null;
    if (!await confirmDialog({ title, body, danger, confirmLabel: 'Yes, save it', fields: step ? step.fields : null })) return false;
    try { const r = await api(`/games/${id}`, { method: 'PUT', body: { ...patch, ...(step ? step.read() : {}) } }); toast(r.changed.length ? `${done} Applies from the next round.` : 'Nothing changed.'); load(); return true; }
    catch (e) { toast(e.message, 'bad'); return false; }
  }
  function render(d) {
    const g = d.game;
    const sw = h('button', { class: `switch ${g.enabled ? 'on' : ''}`, role: 'switch', 'aria-checked': String(g.enabled), disabled: !can, tip: T.enabled,
      onclick: () => save({ enabled: !g.enabled }, g.enabled
        ? { title: `Switch ${g.name} off?`, danger: true, body: `Players in the middle of a round finish it. After that nobody can start a new round, and they see: "${g.maintenanceMessage}"`, done: `${g.name} is off.` }
        : { title: `Switch ${g.name} on?`, body: 'Players can start playing straight away with the current limits and maths setting.', done: `${g.name} is on.` }) });
    const msg = h('textarea', { class: 'input', rows: 2, maxlength: 300, disabled: !can }, g.maintenanceMessage);
    const minI = centsInput(g.minStakeCents, { disabled: !can }), maxI = centsInput(g.maxStakeCents, { disabled: !can });
    const winI = centsInput(g.maxWinCents, { disabled: !can }), lossI = centsInput(g.maxHouseLossCents, { disabled: !can });
    const limitsForm = h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault();
      const patch = { maintenanceMessage: msg.value, minStakeCents: readCents(minI), maxStakeCents: readCents(maxI), maxWinCents: readCents(winI), maxHouseLossCents: readCents(lossI) };
      const limitsChanged = patch.minStakeCents !== g.minStakeCents || patch.maxStakeCents !== g.maxStakeCents || patch.maxWinCents !== g.maxWinCents || patch.maxHouseLossCents !== g.maxHouseLossCents;
      await save(patch, { money: limitsChanged, title: 'Save these limits?', body: h('div', {}, h('p', { class: 'muted' }, 'From the next round:'), h('ul', {},
        h('li', {}, `Bets from ${money(patch.minStakeCents)} to ${money(patch.maxStakeCents)} per round`), h('li', {}, `At most ${money(patch.maxWinCents)} paid on one round`),
        h('li', {}, `The casino can lose at most ${money(patch.maxHouseLossCents)} on one round`))), done: 'Limits saved.' });
    } },
      h('div', { class: 'form-grid' }, field('Minimum bet per round', minI, T.minStake), field('Maximum bet per round', maxI, T.maxStake),
        field('Maximum win per round', winI, T.maxWin), field('Table limit (most the casino can lose on one round)', lossI, T.maxLoss)),
      field('Maintenance message', msg, T.maintenance), can ? h('button', { class: 'btn primary', type: 'submit' }, 'Save limits') : h('p', { class: 'muted' }, 'Your role can view these settings but not change them.'));
    const mathCards = h('div', { class: 'math-options' }, d.math.map(m => h('div', { class: `math ${m.id === g.mathId ? 'chosen' : ''}` },
      h('div', { class: 'math-top' }, h('b', {}, m.label), m.id === g.mathId ? h('span', { class: 'pill on' }, 'In use') : null),
      h('div', { class: 'math-rtp' }, h('span', { class: 'big-num' }, m.rtpMin === m.rtpMax ? `${m.rtpTarget}%` : `${m.rtpMin}% to ${m.rtpMax}%`), h('small', { class: 'muted' }, ' payback ', info(T.rtp))),
      h('div', { class: 'muted small' }, `House keeps about ${(100 - m.rtpTarget).toFixed(1)}% of money bet`),
      h('p', { class: 'small' }, m.description),
      can && m.id !== g.mathId ? h('button', { class: 'btn', onclick: () => save({ mathId: m.id }, { money: true, title: `Use "${m.label}"?`, body: `From the next round ${g.name} pays out using this table. Expected payback ${m.rtpMin === m.rtpMax ? m.rtpTarget + '%' : m.rtpMin + '% to ' + m.rtpMax + '% depending on the bet'}. Results stay provably fair; only payouts change. Players see the new payouts on the table.`, done: 'Maths setting changed.' }) }, 'Use this setting') : null)));
    const readout = h('span', { class: 'r' }, 'Hover for values');
    const rtpReadout = h('span', { class: 'r' }, 'Hover for values');
    root.replaceChildren(
      h('a', { class: 'back', href: '#/games' }, '← All games'),
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, g.name, ' ', h('span', { class: `pill ${g.enabled ? 'on' : 'off'}` }, g.enabled ? 'On' : 'Off')),
        h('p', { class: 'sub' }, `${d.realMoney ? 'Real TICS' : 'Demo money'} results · settings version ${g.configVersion}`, info(T.configVersion), ` · last changed ${localTime(g.updatedAt)}`)),
        h('div', { class: 'head-right' }, h('span', { class: 'muted' }, g.enabled ? 'Players can play' : 'Switched off'), sw)),
      h('div', { class: 'kpis' },
        h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'All-time profit', info(T.profit)), h('div', { class: `big ${d.totals.profit >= 0 ? 'gold' : 'down'}` }, money(d.totals.profit))),
        h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'All-time money bet', info(T.bet)), h('div', { class: 'big' }, money(d.totals.bet))),
        h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'All-time payback', info(T.rtp)), h('div', { class: 'big' }, d.totals.rtp == null ? '-' : pct(d.totals.rtp))),
        h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Players', info(T.players)), h('div', { class: 'big' }, num(d.totals.players)))),
      card('Maths setting', T.math, mathCards),
      card('Limits and maintenance message', 'These protect the casino. They apply from the next round, and every round records the settings version it used.', limitsForm),
      h('div', { class: 'grid2 even' },
        card(null, null, h('h3', {}, 'Profit per day, last 30 days', info(T.profitChart), readout), lineChart(fillSeries(d.series, 'day', 30, t => ({ t, profitCents: 0 })).map(s => ({ label: s.t.slice(5), value: s.profitCents })), { format: v => money(v), readout })),
        card(null, null, h('h3', {}, 'Payback per day', info(T.rtp), rtpReadout), lineChart(d.series.filter(s => s.rtp != null).map(s => ({ label: s.t.slice(5), value: s.rtp })), { format: v => pct(v), readout: rtpReadout, color: 'var(--blue)', zero: false }))),
      latest);
  }
  load();
  return root;
}
