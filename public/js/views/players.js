// Rounds and players: search, detail, balance changes and status.
import { h, api, money, num, info, card, pageHead, loading, errorBox, empty, toast, confirmDialog, field, ago, short, flag, countryName, localTime, table, cap, segmented, usd, usdt, addrLink, txLink, shortAddr, isReal, setView, viewQuery, wdPill } from '../lib.js';
import { T } from '../glossary.js';
import { feltView, covered } from './felt.js';
import { resultCell, resultBig, roundKind, slotRoundView, rawOutcomeView, rememberGames, gameName } from './outcome.js';

// Internal links inside table rows (the row itself opens something else, so stop the click there).
const stop = e => e.stopPropagation();
const playerLink = (id, label) => h('a', { class: 'mono tlink', href: `#/players/${encodeURIComponent(id)}`, onclick: stop, tip: 'Open this player' }, label);
const gameLink = id => h('a', { class: 'tlink', href: `#/games/${encodeURIComponent(id)}`, onclick: stop, tip: 'Open this game' }, gameName(id));
const roundLink = (id, label = 'Round') => h('a', { class: 'tlink', href: `#/rounds/${encodeURIComponent(id)}`, onclick: stop }, label);
const modePill = real => h('span', { class: `mode ${real ? 'real' : 'demo'}` }, real ? 'Real TICS' : 'Demo money');
const houseCell = r => { const v = r.stake_cents - r.payout_cents; return h('span', { class: v >= 0 ? 'up' : 'down' }, money(v, { sign: true })); };

// A warning flag; the shared-network one opens the list of the other accounts on that network.
function flagRow(f) {
  if (!f.players?.length) return h('div', { class: 'flag-row' }, h('span', { class: 'dot' }), h('span', { class: 'flag-text' }, f.text));
  const list = h('div', { class: 'flag-players', hidden: true }, table([
    { label: 'Player', render: x => playerLink(x.id, x.walletAddress ? shortAddr(x.walletAddress) : short(x.id)) },
    { label: 'Type', render: x => x.walletAddress ? 'Wallet' : 'Guest' },
    { label: 'Status', render: x => cap(x.status || 'active') },
    { label: 'Where', render: x => [x.city, countryName(x.country)].filter(Boolean).join(', ') || '-' },
    { label: 'Device', render: x => [x.device, x.os, x.browser].filter(Boolean).join(' · ') || '-' },
    { label: 'Rounds', align: 'right', render: x => num(x.rounds || 0) },
    { label: 'Last seen', align: 'right', render: x => ago(x.lastSeenAt) },
  ], f.players, { onRow: x => location.hash = `#/players/${encodeURIComponent(x.id)}` }));
  const btn = h('button', { class: 'btn small flag-toggle', type: 'button', 'aria-expanded': 'false', 'data-testid': 'same-network-toggle' }, `Show ${f.players.length} player${f.players.length > 1 ? 's' : ''}`);
  btn.onclick = () => {
    const open = list.hidden;
    list.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Hide players' : `Show ${f.players.length} player${f.players.length > 1 ? 's' : ''}`;
  };
  return h('div', { class: 'flag-block' }, h('div', { class: 'flag-row' }, h('span', { class: 'dot' }), h('span', { class: 'flag-text' }, f.text), btn), list);
}

let roundsGame = '';
export function roundsView() {
  const root = h('div', { class: 'page' }, pageHead('Rounds', `Every ${isReal() ? 'real TICS' : 'demo'} round played, newest first. Filter by game, big wins or one player, and open a round to see how it went and its fairness proof.`));
  const player = h('input', { class: 'input', placeholder: 'Player id' });
  // Game filter: All, then every game on the platform (the list comes back with the rounds).
  const game = h('select', { class: 'input', 'aria-label': 'Game', 'data-testid': 'game-filter' }, h('option', { value: '' }, 'All games'));
  const fillGames = list => { if (!list?.length || game.options.length > 1) return; for (const g of list) game.append(h('option', { value: g.id, selected: g.id === roundsGame }, g.name)); };
  game.onchange = () => { roundsGame = game.value; run(); };
  const minWin = h('input', { class: 'input', type: 'number', min: 0, placeholder: 'Player won at least (TICS)' });
  const outcome = h('select', { class: 'input' }, h('option', { value: '' }, 'Any result'), h('option', { value: 'player_won' }, 'Player won'), h('option', { value: 'house_won' }, 'House won'));
  const body = h('div', {}, loading());
  const run = async () => {
    const p = new URLSearchParams();
    if (player.value.trim()) p.set('player', player.value.trim());
    if (outcome.value) p.set('outcome', outcome.value);
    if (minWin.value) p.set('minWin', String(Math.round(Number(minWin.value) * 100)));
    if (roundsGame) p.set('game', roundsGame);
    p.set('limit', '100');
    try {
      const d = await api(`/rounds?${p}`);
      rememberGames(d.games); fillGames(d.games);
      body.replaceChildren(table([
        { label: 'When', render: r => h('span', { tip: localTime(r.created_at) }, ago(r.created_at)) },
        { label: 'Game', render: r => gameLink(r.game_id) },
        { label: 'Player', render: r => h('span', {}, `${flag(r.country)} `, playerLink(r.player_id, r.player_id.startsWith('0x') ? shortAddr(r.player_id) : short(r.player_id))) },
        { label: 'Result', render: resultCell, tip: '<b>Result</b>Roulette: the winning number. Gods of Power: how many spins the round had (free spins in brackets), the payout as a multiple of the bet, and whether the 2,000x win cap was reached.' },
        { label: 'Bet', align: 'right', render: r => money(r.stake_cents) },
        { label: 'Paid', align: 'right', render: r => money(r.payout_cents), tip: T.paid },
        { label: 'House', align: 'right', render: houseCell, tip: 'What the casino made (green) or lost (red) on this round.' },
      ], d.rounds, { onRow: r => location.hash = `#/rounds/${encodeURIComponent(r.id)}`, emptyText: 'No rounds match these filters.' }));
    } catch (e) { body.replaceChildren(errorBox(e, run)); }
  };
  root.append(h('form', { class: 'filters', onsubmit: e => { e.preventDefault(); run(); } }, game, player, outcome, minWin, h('button', { class: 'btn primary' }, 'Search')), body);
  run();
  return root;
}

function betsCard(r) {
  const won = b => covered(b).includes(r.outcome.pocket);
  const list = () => table([
    { label: 'Bet', render: b => b.value == null ? cap(b.type) : `${cap(b.type)} ${Array.isArray(b.value) ? b.value.join(', ') : b.value}` },
    { label: 'Amount', align: 'right', render: b => money(b.amountCents) },
    { label: 'Result', render: b => won(b) ? h('span', { class: 'pill on' }, 'Won') : h('span', { class: 'pill off' }, 'Lost') }], r.bets);
  const body = h('div', {}, list());
  const mode = localStorage.getItem('noir-admin-betview') || 'list';
  const show = v => { localStorage.setItem('noir-admin-betview', v); body.replaceChildren(v === 'table' ? feltView(r.bets, r.outcome.pocket) : list()); };
  if (mode === 'table') show('table');
  return h('section', { class: 'card' }, h('h3', {}, 'Bets', info('<b>Bets</b>Every chip in this round. Table view shows them on the felt: the gold marker is the winning number, glowing chips won, faded chips lost.'),
    h('span', { class: 'r' }, segmented([['list', 'List'], ['table', 'Table view']], mode, show))), body);
}

export function roundView(ctx, id) {
  const root = h('div', { class: 'page' }, loading());
  (async () => {
    try {
      const { round: r, ledger, games } = await api(`/rounds/${encodeURIComponent(id)}`);
      rememberGames(games);
      const kind = roundKind(r);
      // Roulette: the bets on the felt. Gods of Power: the reels of every spin. Anything else: the stored outcome.
      const play = kind === 'roulette' && Array.isArray(r.bets) ? betsCard(r) : kind === 'slot' ? slotRoundView(r) : rawOutcomeView(r);
      const f = r.fairness || {};
      root.replaceChildren(h('a', { class: 'back', href: '#/rounds' }, '← All rounds'),
        h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, `Round ${short(r.id.split(':')[1] || r.id)} `, modePill(r.real_money)),
          h('p', { class: 'sub' }, h('a', { href: `#/games/${encodeURIComponent(r.game_id)}` }, gameName(r.game_id)), ` · ${localTime(r.created_at)} · maths setting ${r.math_id}, settings version ${r.config_version}`))),
        h('div', { class: 'kpis' },
          h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Result'), h('div', { class: 'big' }, resultBig(r))),
          h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Bet'), h('div', { class: 'big' }, money(r.stake_cents))),
          h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Paid', info(T.paid)), h('div', { class: 'big' }, money(r.payout_cents))),
          h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'House'), h('div', { class: `big ${r.stake_cents - r.payout_cents >= 0 ? 'up' : 'down'}` }, money(r.stake_cents - r.payout_cents, { sign: true })))),
        play,
        h('div', {},
          card('Fairness proof', T.fairness, h('dl', { class: 'proof' },
            h('dt', {}, 'Lock (shown before the bet)'), h('dd', { class: 'mono' }, f.serverSeedHash ?? '-'),
            h('dt', {}, 'Secret key (revealed after)'), h('dd', { class: 'mono' }, f.serverSeed ?? '-'),
            h('dt', {}, 'Player lucky word + browser randomness'), h('dd', { class: 'mono' }, f.clientSeed ?? '-'),
            h('dt', {}, 'Counter'), h('dd', { class: 'mono' }, f.nonce ?? '-')))),
        card('Money movements', T.ledger, table([
          { label: 'Type', render: l => l.type.replace(/_/g, ' ') }, { label: 'Amount', align: 'right', render: l => money(l.amount_cents, { sign: true }) },
          { label: 'Balance after', align: 'right', render: l => money(l.balance_after_cents) }], ledger)),
        h('p', {}, h('a', { href: `#/players/${r.player_id}` }, 'Open this player →')));
    } catch (e) { root.replaceChildren(errorBox(e)); }
  })();
  return root;
}

const NETWORK = { 'eth-mainnet': 'Ethereum', 'base-mainnet': 'Base', 'bnb-mainnet': 'BNB Chain' };
const who = p => p.walletAddress ? shortAddr(p.walletAddress) : short(p.id);
const sel = (label, opts) => h('select', { class: 'input', 'aria-label': label }, opts.map(([v, t]) => h('option', { value: v }, t)));
let lastFilters = null;

export function playersView(ctx) {
  const real = isReal();
  const root = h('div', { class: 'page' }, pageHead('Players', real
    ? 'Players who connected a wallet, with their real TICS. Search by wallet address (all of it or a part) or email, filter by marketing data, and export the list.'
    : 'Everyone who played with demo money, including guests without a wallet. Search by wallet address, player id or email.'));
  const search = h('input', { class: 'input grow', placeholder: 'Wallet address, part of one, player id or email', type: 'search' });
  const status = sel('Status', [['', 'Any status'], ['active', 'Active'], ['frozen', 'Paused'], ['banned', 'Banned']]);
  const sort = h('select', { class: 'input', 'aria-label': 'Sort', tip: '<b>Sort</b>Most profitable = the players the casino has made the most from. Furthest up = players who have won the most against the casino.' },
    (real ? [['last_seen', 'Recently active'], ['connected', 'Recently connected'], ['joined', 'Newest'], ['holdings', 'Largest holdings'], ['real', 'Highest real TICS balance'], ['house_profit', 'Most profitable for the house'],
      ['player_up', 'Furthest up against the house'], ['bet', 'Most TICS bet']]
      : [['last_seen', 'Recently active'], ['joined', 'Newest'], ['balance', 'Highest demo balance'], ['house_profit', 'Most profitable for the house'], ['player_up', 'Furthest up against the house'], ['bet', 'Most demo money bet']])
      .map(([v, t]) => h('option', { value: v }, t)));
  const hasEmail = sel('Email', [['', 'Email: any'], ['yes', 'Has email'], ['no', 'No email']]);
  const consent = sel('Consent', [['', 'Consent: any'], ['yes', 'Agreed to emails'], ['no', 'Did not agree']]);
  const deposited = sel('Deposited', [['', 'Deposited: any'], ['yes', 'Has deposited'], ['no', 'Never deposited']]);
  const country = h('input', { class: 'input short-in', maxlength: 2, placeholder: 'Country (DE)', 'aria-label': 'Country code' });
  const hMin = h('input', { class: 'input short-in', type: 'number', min: 0, placeholder: 'Holdings from $', 'aria-label': 'Holdings at least (USD)' });
  const hMax = h('input', { class: 'input short-in', type: 'number', min: 0, placeholder: 'Holdings to $', 'aria-label': 'Holdings at most (USD)' });
  const days = h('input', { class: 'input short-in', type: 'number', min: 1, placeholder: 'Connected in last N days', 'aria-label': 'Last connected within days' });
  const body = h('div', {}, loading());
  const params = () => {
    const p = new URLSearchParams({ q: search.value.trim(), status: status.value, sort: sort.value, hasEmail: hasEmail.value, consent: consent.value, deposited: deposited.value,
      country: country.value.trim(), holdingsMin: hMin.value, holdingsMax: hMax.value, connectedDays: days.value });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    return p;
  };
  const exportBtn = ctx.can('money:export') ? h('a', { class: 'btn', href: '#', onclick: e => { e.currentTarget.href = `/api/players.csv?${params()}&${viewQuery()}`; }, download: `qu-betics-players-${real ? 'real' : 'demo'}.csv`,
    tip: '<b>Export CSV</b>The players matching these filters: address, email, consent, country, city, connection dates, holdings, top assets, deposited, withdrawn, rounds and net result.' }, 'Export CSV') : null;
  const run = async () => {
    const p = params(); p.set('limit', '100');
    try {
      const d = await api(`/players?${p}`);
      const status = { label: 'Status', render: p => h('span', { class: `pill ${p.status === 'active' ? 'on' : p.status === 'frozen' ? 'warn' : 'off'}` }, p.status === 'frozen' ? 'Paused' : cap(p.status)), tip: T.status };
      const house = { label: 'House profit', align: 'right', render: p => h('span', { class: p.houseProfitCents >= 0 ? 'up' : 'down' }, money(p.houseProfitCents, { sign: true, short: true })), tip: T.houseFromPlayer };
      const cols = real ? [
        { label: 'Player', render: p => h('span', { class: 'mono', tipText: p.walletAddress || p.id }, who(p)) }, status,
        { label: 'Email', render: p => p.email ? h('span', { class: 'small' }, p.email, ' ', h('span', { class: `pill ${p.emailConsent ? 'on' : 'off'}`, tip: p.emailConsent ? 'Agreed to marketing emails' : 'Did not agree to marketing emails' }, p.emailConsent ? 'consent' : 'no consent')) : h('span', { class: 'muted' }, '-') },
        { label: 'Where', render: p => `${flag(p.country)} ${countryName(p.country)}` },
        { label: 'First connected', render: p => p.firstConnectedAt ? h('span', { tip: localTime(p.firstConnectedAt) }, ago(p.firstConnectedAt)) : '-' },
        { label: 'Last connected', render: p => p.lastConnectedAt ? h('span', { tip: localTime(p.lastConnectedAt) }, ago(p.lastConnectedAt)) : '-' },
        { label: 'Holdings', align: 'right', render: p => p.holdingsUsd == null ? '-' : usd(p.holdingsUsd), tip: '<b>Holdings</b>What the wallet holds on Ethereum, Base and BNB Chain, in US dollars.' },
        { label: 'Real TICS', align: 'right', render: p => money(p.realTicsCents), tip: '<b>Real TICS</b>Deposited TICS the player can bet or withdraw.' },
        { label: 'Rounds', align: 'right', render: p => num(p.rounds) }, house,
      ] : [
        { label: 'Player', render: p => h('span', { class: 'mono', tipText: p.walletAddress || p.id }, who(p), p.walletAddress ? null : h('span', { class: 'muted small' }, ' guest')) }, status,
        { label: 'Where', render: p => `${flag(p.country)} ${countryName(p.country)}` },
        { label: 'Demo balance', align: 'right', render: p => money(p.balanceCents, { short: true }), tip: T.balance },
        { label: 'Rounds', align: 'right', render: p => num(p.rounds) }, house,
        { label: 'Last seen', render: p => ago(p.lastSeenAt) },
      ];
      body.replaceChildren(h('p', { class: 'muted' }, `${num(d.total)} player${d.total === 1 ? '' : 's'}${d.total > d.players.length ? `, showing the first ${d.players.length}` : ''}`), table(cols,
        d.players, { onRow: p => location.hash = `#/players/${p.id}`, emptyText: 'No players match. Try a shorter search or fewer filters.' }));
    } catch (e) { body.replaceChildren(errorBox(e, run)); }
  };
  if (lastFilters) { search.value = lastFilters.q || ''; }
  root.append(h('form', { class: 'filters', onsubmit: e => { e.preventDefault(); lastFilters = { q: search.value }; run(); } }, search, status, sort, h('button', { class: 'btn primary' }, 'Search')),
    h('details', { class: 'more-filters' }, h('summary', {}, 'More filters'), h('div', { class: 'filters' }, ...(real ? [hasEmail, consent, deposited, country, hMin, hMax, days] : [hasEmail, country]),
      h('button', { class: 'btn', type: 'button', onclick: run }, 'Apply'))),
    exportBtn ? h('div', { class: 'actions export-row' }, exportBtn) : '', body);
  [status, sort, hasEmail, consent, deposited].forEach(el => { el.onchange = run; });
  run();
  return root;
}

function holdingsCard(d) {
  let showHidden = false;
  const hiddenCount = d.holdings.filter(x => x.hidden).length;
  const body = h('div');
  const toggle = hiddenCount ? h('label', { class: 'check r' }, h('input', { type: 'checkbox', onchange: e => { showHidden = e.target.checked; draw(); } }), ` Show hidden (${hiddenCount})`) : null;
  const draw = () => {
    const rows = d.holdings.filter(x => showHidden || !x.hidden);
    body.replaceChildren(rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Network'), h('th', {}, 'Asset'), h('th', { class: 'r' }, 'Amount'), h('th', { class: 'r' }, 'USD value'))),
      h('tbody', {}, rows.map(x => h('tr', { class: x.hidden ? 'muted' : '' }, h('td', {}, NETWORK[x.network] || x.network),
        h('td', {}, h('b', {}, x.symbol || '?'), ' ', h('span', { class: 'muted small' }, x.name || ''), x.hidden ? h('span', { class: 'pill off', tip: 'No price or under $0.01: likely spam, not counted in the total.' }, ' hidden') : null),
        h('td', { class: 'r mono small' }, Number(x.amount).toLocaleString('en-US', { maximumFractionDigits: 6 })), h('td', { class: 'r' }, x.usd_value == null ? '-' : usd(x.usd_value)))),
        h('tr', { class: 'holdings-total' }, h('td', {}, 'Total'), h('td', {}, ''), h('td', {}, ''), h('td', { class: 'r' }, usd(d.holdingsTotalUsd)))))) : empty('No holdings', 'Holdings appear after the player connects a wallet.'));
  };
  draw();
  return h('section', { class: 'card' }, h('h3', {}, 'Wallet holdings', info('<b>Holdings</b>Tokens in this wallet on Ethereum, Base and BNB Chain with US dollar values. Assets without a price or under $0.01 are hidden as likely spam.'), toggle), body,
    d.player.holdingsUpdatedAt ? h('p', { class: 'muted small' }, `Updated ${ago(d.player.holdingsUpdatedAt)}`) : null);
}

export function playerView(ctx, id) {
  const root = h('div', { class: 'page' }, loading());
  async function load() {
    try { render(await api(`/players/${id}`)); } catch (e) { root.replaceChildren(errorBox(e, load)); }
  }
  function render(d) {
    rememberGames(d.gameList);
    const p = d.player;
    const actions = h('div', { class: 'actions' });
    const setStatus = async (status, title, text, danger) => {
      const reason = h('input', { class: 'input', maxlength: 300, placeholder: 'Why? (required)' });
      if (!await confirmDialog({ title, body: text, danger, fields: field('Reason', reason), confirmLabel: 'Yes, do it' })) return;
      try { await api(`/players/${id}/status`, { method: 'POST', body: { status, reason: reason.value } }); toast('Status changed.'); load(); } catch (e) { toast(e.message, 'bad'); }
    };
    if (ctx.can('player:status') && p.status === 'active') actions.append(h('button', { class: 'btn', onclick: () => setStatus('frozen', 'Pause this player?', 'They can still sign in and see their balance, but cannot place bets until you unpause them.') }, 'Pause'));
    if (ctx.can('player:status') && p.status === 'frozen') actions.append(h('button', { class: 'btn', onclick: () => setStatus('active', 'Unpause this player?', 'They can bet again straight away.') }, 'Unpause'));
    if (ctx.can('player:ban') && p.status !== 'banned') actions.append(h('button', { class: 'btn danger', onclick: () => setStatus('banned', 'Ban this player?', 'They will not be able to bet and will not receive messages. Only an owner can lift a ban.', true) }, 'Ban'));
    if (ctx.can('player:ban') && p.status === 'banned') actions.append(h('button', { class: 'btn', onclick: () => setStatus('active', 'Lift the ban?', 'They can play again straight away.') }, 'Lift ban'));
    const real = d.realMoney;
    const kpi = (label, tip, big, sub, cls = '', href = null) => h(href ? 'a' : 'div', { class: 'card kpi', ...(href ? { href } : {}) },
      h('div', { class: 'lab' }, label, tip ? info(tip) : null), h('div', { class: `big ${cls}` }, big), sub ? h('div', { class: 'delta' }, sub) : null);
    const games = card('Games played', `How this player did on each game with ${real ? 'real TICS' : 'demo money'}. Click a game to open it.`, table([
      { label: 'Game', render: g => gameLink(g.gameId) }, { label: 'Rounds', align: 'right', render: g => num(g.rounds) },
      { label: 'Bet', align: 'right', render: g => money(g.betCents) }, { label: 'House', align: 'right', render: g => h('span', { class: g.betCents - g.paidCents >= 0 ? 'up' : 'down' }, money(g.betCents - g.paidCents, { sign: true })) }],
      d.games, { onRow: g => location.hash = `#/games/${encodeURIComponent(g.gameId)}`, emptyText: 'No rounds yet.' }));
    const rounds = card('Recent rounds', `Their newest ${real ? 'real TICS' : 'demo'} rounds. Click one for how it went and its fairness proof.`, table([
      { label: 'When', render: r => ago(r.created_at) }, { label: 'Game', render: r => gameLink(r.game_id) }, { label: 'Result', render: resultCell },
      { label: 'Bet', align: 'right', render: r => money(r.stake_cents) }, { label: 'Paid', align: 'right', render: r => money(r.payout_cents) }, { label: 'House', align: 'right', render: houseCell }],
      d.rounds, { onRow: r => location.hash = `#/rounds/${encodeURIComponent(r.id)}`, emptyText: 'No rounds yet.' }));
    const ledger = card('Money movements', `${T.ledger} Only ${real ? 'real TICS' : 'demo money'} movements are listed.`, table([
      { label: 'When', render: l => ago(l.created_at) }, { label: 'Type', render: l => l.type.replace(/_/g, ' ') },
      { label: 'Amount', align: 'right', render: l => h('span', { class: l.amount_cents >= 0 ? 'up' : 'down' }, money(l.amount_cents, { sign: true })) },
      { label: 'Balance after', align: 'right', render: l => money(l.balance_after_cents) },
      { label: 'Round', render: l => l.round_id ? roundLink(l.round_id, 'Open') : '' },
      { label: 'Note', render: l => l.meta?.reason ? `${l.meta.reason}${l.meta.admin ? ` (${l.meta.admin})` : ''}` : '' }], d.ledger, { emptyText: 'No money movements yet.' }));
    const identities = card('Ways they sign in', 'Each way this player can reach their account: browser cookie, wallet address and email.', table([
      { label: 'Kind', render: i => cap(i.kind) }, { label: 'Value', render: i => h('span', { class: 'mono' }, i.value) }, { label: 'Added', render: i => localTime(i.created_at) }], d.identities));
    const head = h('div', { class: 'page-head' }, h('div', { class: 'min0' }, h('h1', { class: 'mono' }, p.walletAddress ? shortAddr(p.walletAddress) : short(p.id), ' ', h('span', { class: `pill ${p.status === 'active' ? 'on' : p.status === 'frozen' ? 'warn' : 'off'}`, tip: T.status }, p.status === 'frozen' ? 'Paused' : cap(p.status)), ' ', modePill(real)),
        h('p', { class: 'sub' }, `${flag(p.country)} ${countryName(p.country)}${p.city ? ', ' + p.city : ''} · ${cap(p.device || '-')}, ${p.os || '-'}, ${p.browser || '-'} · joined ${localTime(p.joinedAt)} · last seen ${ago(p.lastSeenAt)}`),
        p.statusReason && p.status !== 'active' ? h('p', { class: 'muted' }, `Reason: ${p.statusReason}`) : null), actions);
    const flags = d.flags.length ? h('div', { class: 'flags' }, d.flags.map(flagRow)) : '';
    const other = h('p', { class: 'muted small' }, real ? 'Demo play for this player is in the Demo view. ' : 'Real TICS for this player is in the Real view. ',
      h('a', { href: '#', onclick: e => { e.preventDefault(); setView(real ? 'demo' : 'real'); window.dispatchEvent(new HashChangeEvent('hashchange')); } }, real ? 'Switch to Demo' : 'Switch to Real TICS'));
    const back = h('a', { class: 'back', href: '#/players' }, '← All players');
    if (!real) {
      root.replaceChildren(back, head, flags, h('div', { class: 'kpis' },
        kpi('Demo balance', T.balance, money(p.balanceCents, { short: true }), money(p.balanceCents)),
        kpi('Demo money bet', T.bet, money(p.totalBetCents, { short: true })),
        kpi('House profit from them', T.houseFromPlayer, money(p.houseProfitCents, { sign: true, short: true }), null, p.houseProfitCents >= 0 ? 'up' : 'down'),
        kpi('Demo rounds', T.rounds, num(p.rounds))), other,
        h('div', { class: 'grid2 even' }, identities, games), rounds, ledger);
      return;
    }
    if (!p.walletAddress) {
      root.replaceChildren(back, head, flags, h('section', { class: 'card empty-page' }, h('h3', {}, 'No wallet connected'),
        h('p', { class: 'muted' }, 'This player has only played as a guest with demo money, so there is no real TICS to show.'), other));
      return;
    }
    root.replaceChildren(back, head, flags,
      h('div', { class: 'kpis six' },
        kpi('Real TICS balance', '<b>Real TICS</b>Deposited TICS this player can bet or withdraw.', money(p.realTicsCents, { short: true }), money(p.realTicsCents), 'gold'),
        kpi('Deposited', '<b>Deposited</b>All TICS this wallet sent to the casino and was credited.', money(d.depositedUnits, { short: true }), `${d.chainDeposits.length} deposit${d.chainDeposits.length === 1 ? '' : 's'}`, '', '#/payments'),
        kpi('Withdrawn', '<b>Withdrawn</b>TICS paid out to this wallet, before the network fee was taken off.', money(d.withdrawnUnits, { short: true }), d.pendingWithdrawalUnits ? `${money(d.pendingWithdrawalUnits)} on the way` : 'Nothing on the way', '', '#/payments'),
        kpi('Holdings', '<b>Holdings</b>What the wallet holds on Ethereum, Base and BNB Chain, in US dollars. Hidden spam tokens are not counted.', p.holdingsUsd == null ? '-' : usd(p.holdingsUsd), p.holdingsUpdatedAt ? `Updated ${ago(p.holdingsUpdatedAt)}` : 'Not read yet'),
        kpi('TICS bet', T.bet, money(p.totalBetCents, { short: true })),
        kpi('House profit from them', T.houseFromPlayer, money(p.houseProfitCents, { sign: true, short: true }), `${num(p.rounds)} real round${p.rounds === 1 ? '' : 's'}`, p.houseProfitCents >= 0 ? 'up' : 'down')),
      other,
      walletCard(d),
      h('div', { class: 'grid2 even' },
        card('TICS deposits', 'TICS this wallet sent to the casino wallet. All deposits are on the Payments page.', table([
          { label: 'When', render: x => h('span', { tip: localTime(x.created_at) }, ago(x.created_at)) }, { label: 'Amount', align: 'right', render: x => h('b', {}, money(x.amount_units)) },
          { label: 'Status', render: x => cap(x.status.replace('_', ' ')) }, { label: 'Tx', render: x => txLink(x.tx_hash, d.chainId) }], d.chainDeposits, { emptyText: 'No TICS deposits.' }),
          h('p', { class: 'small' }, h('a', { href: '#/payments' }, 'Open Payments →'))),
        card('TICS withdrawals', 'Automatic payouts to this wallet. A waiting one can be cancelled on the Payments page.', table([
          { label: 'When', render: x => h('span', { tip: localTime(x.created_at) }, ago(x.created_at)) }, { label: 'Amount', align: 'right', render: x => h('b', {}, money(x.amount_units)) },
          { label: 'Fee', align: 'right', render: x => money(x.fee_units) }, { label: 'Status', render: x => h('span', {}, wdPill(x.status), x.last_error ? h('div', { class: 'muted small' }, x.last_error) : null) },
          { label: 'Tx', render: x => txLink(x.tx_hash, d.chainId) }], d.chainWithdrawals, { emptyText: 'No TICS withdrawals.' }),
          h('p', { class: 'small' }, h('a', { href: '#/payments' }, 'Open Payments →')))),
      h('div', { class: 'grid2 even' }, games, rounds),
      h('div', { class: 'grid2 even' }, holdingsCard(d),
        card('Connection log', 'The latest 50 times this wallet signed in, with the place and device.', table([
          { label: 'When', render: c => h('span', { tip: localTime(c.created_at) }, ago(c.created_at)) }, { label: 'Where', render: c => `${flag(c.country)} ${c.city || countryName(c.country)}` },
          { label: 'Device', render: c => `${cap(c.device || '-')} · ${c.os || '-'} · ${c.browser || '-'}` }], d.connections, { emptyText: 'No wallet connections yet.' }))),
      d.deposits.length || d.withdrawals.length ? h('div', { class: 'grid2 even' },
        card('USDT deposits', 'Old USDT (NOWPayments) deposits by this player.', table([{ label: 'When', render: x => ago(x.created_at) }, { label: 'Amount', align: 'right', render: x => usdt(x.requested_cents) },
          { label: 'Status', render: x => cap(x.status.replace('_', ' ')) }], d.deposits, { emptyText: 'No deposits.' })),
        card('USDT withdrawals', 'Old USDT withdrawals by this player.', table([{ label: 'When', render: x => ago(x.created_at) }, { label: 'Amount', align: 'right', render: x => usdt(x.amount_cents) },
          { label: 'Status', render: x => cap(x.status) }, { label: 'To', render: x => h('span', { class: 'mono small' }, `${x.address.slice(0, 8)}...`) }], d.withdrawals, { emptyText: 'No withdrawals.' }))) : '',
      ledger, identities);
  }
  load();
  return root;
}

function walletCard(d) {
  const p = d.player;
  const row = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'muted' }, k), h('span', { class: 'min0' }, v));
  if (!p.walletAddress) return card('Wallet', null, h('p', { class: 'muted' }, 'This player has not connected a wallet. They play as a guest with demo money.'));
  return card('Wallet and contact', 'The wallet address is this player\'s account. Email is optional and only used for marketing when they agreed.',
    row('Address', h('span', { class: 'addr-line' }, addrLink(p.walletAddress, d.chainId, { full: true }), h('button', { class: 'btn small', onclick: () => { navigator.clipboard?.writeText(p.walletAddress); toast('Copied'); } }, 'Copy'))),
    row('First connected', p.firstConnectedAt ? `${localTime(p.firstConnectedAt)} (${ago(p.firstConnectedAt)})` : '-'),
    row('Last connected', p.lastConnectedAt ? `${localTime(p.lastConnectedAt)} (${ago(p.lastConnectedAt)})` : '-'),
    row('Country and city', `${flag(p.country)} ${countryName(p.country)}${p.city ? ', ' + p.city : ''}`),
    row('18+ and terms', p.termsAcceptedAt ? `Accepted ${localTime(p.termsAcceptedAt)}` : 'Not accepted yet'),
    row('Email', d.email ? h('span', {}, d.email.address, ' ', h('span', { class: `pill ${d.email.consent ? 'on' : 'off'}` }, d.email.consent ? 'Agreed to emails' : 'No marketing consent')) : h('span', { class: 'muted' }, 'None given')));
}
