// $TICS: the Treasury page (owner) and the TICS payouts / deposits section of Payments.
import { h, api, money, num, info, card, pageHead, loading, errorBox, empty, toast, confirmDialog, field, ago, localTime, table, segmented, unitsInput, readUnits,
  eth, ethToWei, weiToEthText, addrLink, txLink, explorer, shortAddr, esc, stepUpFields, wdPill, WD_STATUS } from '../lib.js';

const T = {
  tokens: '<b>TICS in the casino wallet</b>Read live from Ethereum by the payouts service. This is the money that pays players.',
  gas: '<b>ETH for gas</b>Every payout costs a little ETH as the network fee. Without ETH the casino wallet cannot send anything.',
  owed: '<b>Owed to players</b>Every real TICS balance players hold, plus withdrawals that are waiting or being sent.',
  free: '<b>Free float</b>TICS in the casino wallet minus what is owed to players. Only this part can go to the treasury.',
  treasury: '<b>Treasury</b>Your own safe wallet for the house money. Keep only a working float in the casino wallet, because its key lives on a server.',
  send: '<b>Send to treasury</b>Moves free float from the casino wallet to the treasury address. It needs a new 6-digit code every time.',
  pause: '<b>Automatic payouts</b>While paused, player withdrawals wait in the queue and nothing is sent. Pause before you send from the casino wallet yourself (for example from MetaMask), so the two never clash.',
  fee: '<b>Withdrawal fee</b>When fees are on, the player pays the network fee of their payout: the live gas cost of one TICS transfer, priced in TICS, plus your margin. If gas or price data is old, the fallback fee is used.',
  cooling: '<b>Cooling delay</b>How long a withdrawal waits before it is sent. You can cancel it during this time. 0 sends at once.',
  confirmations: '<b>Confirmations for big deposits</b>How many Ethereum blocks a deposit above the quick limit needs on top before it is credited. 12 is about 2.5 minutes.',
  quickConf: '<b>Confirmations for quick deposits</b>Blocks a deposit up to the quick limit needs before it is credited. 3 is about 40 to 60 seconds.',
  quickMax: '<b>Quick deposits up to</b>Deposits up to this amount use the quick confirmations; bigger ones wait for the full count. 0 turns quick deposits off.',
  startBlock: '<b>Start block</b>The block the deposit watcher starts reading from. Leave it empty unless you know you need it.',
  queue: '<b>TICS payouts</b>Player withdrawals and treasury sends, newest first. A queued withdrawal can still be cancelled; its money goes back to the player.',
  deposits: '<b>TICS deposits</b>Every TICS transfer into the casino wallet. Unmatched means it came from a wallet that is not a player; you can assign it to the right player.',
};
const DEP = { credited: ['on', 'Credited'], unmatched: ['warn', 'Unmatched'], below_min: ['off', 'Below minimum'], assigned: ['on', 'Assigned'], ignored: ['off', 'Ignored'] };
const pill = (map, s) => { const [c, t] = map[s] || ['off', s]; return h('span', { class: `pill ${c}` }, t); };
const kpi = (label, tip, value, sub, cls = '') => h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, label, tip ? info(tip) : null), h('div', { class: `big ${cls}` }, value), sub ? h('div', { class: 'delta' }, sub) : null);
const copyBtn = text => h('button', { class: 'btn small', type: 'button', onclick: () => { navigator.clipboard?.writeText(text); toast('Copied'); } }, 'Copy');
const codeInput = () => h('input', { class: 'input code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '6-digit code', pattern: '[0-9]{6}' });
const sqlAgo = ms => ms ? ago(new Date(ms).toISOString().slice(0, 19).replace('T', ' ')) : '-';
const releaseText = r => {
  const t = Date.parse(r.release_at.replace(' ', 'T') + 'Z') - Date.now();
  if (r.status !== 'queued') return localTime(r.release_at);
  if (t <= 0) return 'Due now';
  const s = Math.round(t / 1000);
  return s < 60 ? `in ${s}s` : s < 3600 ? `in ${Math.floor(s / 60)}m ${s % 60}s` : `in ${Math.round(s / 3600)}h`;
};

const PROBLEM = {
  not_connected: 'The payouts service is not connected here, so live balances and sending are not available. This is expected when running the panel on its own.',
  no_secret: 'The internal secret is not set on this panel, so the payouts service cannot be reached.',
  unreachable: 'The payouts service is unreachable right now. Try again in a minute.',
  refused: 'The payouts service refused the request. Both Workers need the same internal secret.',
  error: 'The payouts service returned an error.',
};

// The live fee a player pays on a withdrawal right now.
function feeQuoteCard(q, settings) {
  const rows = [];
  const badge = q.source === 'off' ? h('span', { class: 'pill off' }, 'Fees are off') : q.source === 'fallback' ? h('span', { class: 'pill warn' }, 'Using fallback') : h('span', { class: 'pill on' }, 'Live');
  rows.push(h('div', { class: 'gm' }, h('span', {}, 'Fee per withdrawal now'), h('b', {}, money(q.feeUnits)), h('span', {}, badge)));
  if (q.source === 'off') rows.push(h('p', { class: 'muted small' }, 'Fees are off: players receive the full amount and the casino pays the gas.'));
  if (q.source === 'fallback') rows.push(h('p', { class: 'muted small' }, [q.gasStale ? `Gas data is ${q.gasAt ? `${sqlAgo(q.gasAt)} old` : 'missing'} (limit 10 minutes).` : null,
    q.priceStale ? `The TICS price is ${q.pricesAt ? `${sqlAgo(q.pricesAt)} old` : 'missing'} (limit 60 minutes).` : null].filter(Boolean).join(' '), ' The fallback fee is used until fresh data arrives.'));
  if (q.gasWei) {
    rows.push(h('div', { class: 'gm' }, h('span', {}, 'Gas price'), h('span', {}, `${(Number(q.baseFeeWei) / 1e9).toFixed(2)} gwei base, ${(Number(q.tipWei) / 1e9).toFixed(2)} tip`), h('span', { class: 'muted' }, sqlAgo(q.gasAt))));
    rows.push(h('div', { class: 'gm' }, h('span', {}, 'TICS price'), h('span', {}, `${Number(q.ticsEth).toPrecision(4)} ETH${q.ticsUsd ? `, $${Number(q.ticsUsd).toPrecision(4)}` : ''}`), h('span', { class: 'muted' }, sqlAgo(q.pricesAt))));
    rows.push(h('div', { class: 'gm' }, h('span', {}, 'Gas of one payout'), h('span', {}, eth(q.gasWei, 6)), h('span', { class: 'muted' }, `+${settings.gasFeeMarginPct}% margin`)));
  }
  rows.push(h('p', { class: 'muted small' }, `Minimum withdrawal ${money(settings.minWithdrawalUnits)}; the player receives it minus the fee.`));
  return card('Fee quote', T.fee, ...rows);
}

export function feesView(ctx) {
  const root = h('div', { class: 'page' });
  if (!ctx.can('settings:edit')) { root.append(pageHead('Fees', 'Only an owner can open this page.')); return root; }
  const body = h('div', {}, loading());
  const refresh = h('button', { class: 'btn', onclick: () => load() }, 'Refresh');
  root.append(pageHead('Fees', 'What players pay when they withdraw TICS: the network (gas) cost of their payout, priced in TICS.', refresh), body);
  async function load() {
    refresh.disabled = true;
    try { render(await api('/tics/fees')); } catch (e) { body.replaceChildren(errorBox(e, load)); } finally { refresh.disabled = false; }
  }
  function render(d) {
    const s = d.settings;
    const on = h('input', { type: 'checkbox', checked: s.feesEnabled !== false });
    const margin = h('input', { class: 'input', type: 'number', min: 0, max: 200, step: '1', value: s.gasFeeMarginPct ?? 20 });
    const fallback = unitsInput(s.fallbackFeeUnits);
    const form = card('Fee settings', 'Every change is in the audit log.', h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault();
      const next = { feesEnabled: on.checked, gasFeeMarginPct: Number(margin.value), fallbackFeeUnits: readUnits(fallback) };
      // Fees on/off, the margin and the fallback fee decide what players are charged: password and a fresh code.
      const step = next.feesEnabled !== (s.feesEnabled !== false) || next.gasFeeMarginPct !== (s.gasFeeMarginPct ?? 20) || next.fallbackFeeUnits !== s.fallbackFeeUnits ? stepUpFields() : null;
      if (!await confirmDialog({ title: 'Save fee settings?', fields: step ? step.fields : null, body: next.feesEnabled ? `Players pay the live gas plus ${next.gasFeeMarginPct}%. Fallback ${money(next.fallbackFeeUnits)}.` : 'Players pay no fee. The casino pays the gas of every payout.' })) return;
      try { render(await api('/tics/fees', { method: 'PUT', body: { ...next, ...(step ? step.read() : {}) } })); toast('Fee settings saved.'); } catch (err) { toast(err.message, 'bad'); }
    } },
      h('label', { class: 'check switch-line' }, on, ' Players pay the network fee on withdrawals', info(T.fee)),
      h('div', { class: 'form-grid' }, field('Gas fee margin (%)', margin, 'Added on top of the live gas cost, 0 to 200.'),
        field('Fallback fee (TICS)', fallback, 'Used when gas data is older than 10 minutes or the TICS price is older than 60 minutes.')),
      h('button', { class: 'btn primary' }, 'Save fee settings')));
    body.replaceChildren(h('div', { class: 'grid2 even' }, feeQuoteCard(d.quote, { ...s }), form),
      h('p', { class: 'muted small' }, `Checked ${new Date(d.checkedAt).toLocaleTimeString()}. The minimum withdrawal is on the Treasury page.`));
  }
  load();
  return root;
}

export function treasuryView(ctx) {
  const root = h('div', { class: 'page' });
  if (!ctx.can('treasury:manage')) { root.append(pageHead('Treasury', 'Only an owner can open this page.')); return root; }
  const body = h('div', {}, loading());
  const refresh = h('button', { class: 'btn', onclick: () => load() }, 'Refresh');
  root.append(pageHead('Treasury', 'The casino wallet on Ethereum, what it owes players, and moving free float to your treasury wallet.', refresh), body);
  let busy = false;
  async function load() {
    refresh.disabled = true;
    try { render(await api('/tics/treasury')); } catch (e) { body.replaceChildren(errorBox(e, load)); } finally { refresh.disabled = false; }
  }
  function render(d) {
    const s = d.settings, st = d.status, f = d.float, chain = s.chainId;
    const live = !!st && st.tokenUnits != null;
    const banners = [];
    if (d.statusProblem) banners.push(h('div', { class: 'bank-hero warn', role: 'status' }, h('span', { class: 'dot' }), h('div', {}, h('b', {}, 'Payouts service unavailable'),
      h('div', {}, PROBLEM[d.statusProblem.problem] || d.statusProblem.error), d.statusProblem.problem === 'error' ? h('div', { class: 'muted small' }, d.statusProblem.error) : null,
      f ? h('div', { class: 'muted small' }, `Showing the last cached snapshot from ${sqlAgo(f.at)}.`) : null)));
    else if (st && st.keyConfigured === false) banners.push(h('div', { class: 'bank-hero warn' }, h('span', { class: 'dot' }), h('div', {}, h('b', {}, 'The casino wallet key is not configured'), h('div', {}, 'Payouts and treasury sends cannot be signed until the key is set up in the payouts service.'))));
    if (!s.casinoWallet) banners.push(h('div', { class: 'bank-hero idle' }, h('span', { class: 'dot' }), h('div', {}, h('b', {}, 'No casino wallet yet'), h('div', {}, 'It is set when the casino wallet key is set up.'))));
    const paused = st ? st.paused : s.payoutsPaused;
    const pausedReason = st ? st.pausedReason : s.pausedReason;
    const pauseBox = h('div', { class: `bank-hero ${paused ? 'bad' : 'ok'}` }, h('span', { class: 'dot' }), h('div', { class: 'grow' },
      h('b', {}, paused ? 'Automatic payouts are paused' : 'Automatic payouts are running', info(T.pause)),
      paused && pausedReason ? h('div', {}, `Reason: ${pausedReason}`) : h('div', { class: 'muted small' }, paused ? '' : 'Pause before you send from the casino wallet yourself.')),
      h('button', { class: `btn ${paused ? 'primary' : 'danger'}`, onclick: () => togglePause(!paused) }, paused ? 'Resume payouts' : 'Pause payouts'));
    const tokenUnits = live ? st.tokenUnits : f?.tokenUnits, ethWei = live ? st.ethWei : f?.ethWei;
    // Owed = real balances + unsent player withdrawals (incl. Starting) + treasury sends in flight; free = wallet - owed - open spin holds.
    const owed = live ? st.owedUnits : d.owedUnitsDb, freeUnits = live ? st.freeUnits : d.freeUnitsDb;
    if (d.adminTreasuryOkAt) banners.push(h('div', { class: 'bank-hero warn' }, h('span', { class: 'dot' }), h('div', {}, h('b', {}, 'Your owner sign in is new'),
      h('div', {}, `For safety, treasury sends and address changes open for you at ${new Date(d.adminTreasuryOkAt).toLocaleString()}.`))));
    if (d.treasurySendableAt) banners.push(h('div', { class: 'bank-hero warn' }, h('span', { class: 'dot' }), h('div', {}, h('b', {}, 'The treasury address was changed recently'),
      h('div', {}, `Sends to the new address open at ${new Date(d.treasurySendableAt).toLocaleString()} (48 hours after the change).`))));
    if (d.openSend) banners.push(h('div', { class: 'bank-hero idle' }, h('span', { class: 'dot' }), h('div', {}, h('b', {}, 'A treasury send is in progress'),
      h('div', {}, `${money(d.openSend.amount_units)} is ${(WD_STATUS[d.openSend.status] || [, d.openSend.status])[1].toLowerCase()}. A new send can start once it is finished.`))));
    const src = live ? 'Live' : f ? `Cached ${sqlAgo(f.at)}` : 'Not available';
    const kpis = h('div', { class: 'kpis' },
      kpi('TICS in casino wallet', T.tokens, tokenUnits == null ? '-' : money(tokenUnits, { short: true }), src, 'gold'),
      kpi('ETH for gas', T.gas, ethWei == null ? '-' : eth(ethWei, 4), src),
      kpi('Owed to players', T.owed, money(owed ?? 0, { short: true }), live ? 'Live' : f ? src : 'From player balances'),
      kpi('Free float', T.free, freeUnits == null ? '-' : money(freeUnits, { short: true }), src, freeUnits < 0 ? 'down' : 'up'));
    const wallets = card('Wallets', T.treasury,
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'Casino wallet'), s.casinoWallet ? h('span', { class: 'addr-line' }, addrLink(s.casinoWallet, chain, { full: true }), copyBtn(s.casinoWallet)) : h('span', { class: 'muted' }, 'Not set')),
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'Treasury'), s.treasuryAddress ? h('span', { class: 'addr-line' }, addrLink(s.treasuryAddress, chain, { full: true }), copyBtn(s.treasuryAddress)) : h('span', { class: 'muted' }, 'Not set')),
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'Network'), h('span', {}, Number(chain) === 11155111 ? 'Sepolia test network' : 'Ethereum')),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => changeAddress(s) }, s.treasuryAddress ? 'Change treasury address' : 'Set treasury address')));
    // Send to treasury.
    const amount = unitsInput(null, { placeholder: '0.00', min: '0.01' });
    const code = codeInput();
    const sendBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Send to treasury');
    const canSend = !!s.treasuryAddress && !d.statusProblem && !d.adminTreasuryOkAt && !d.treasurySendableAt && !d.openSend;
    if (!canSend) { sendBtn.disabled = true; amount.disabled = true; code.disabled = true; }
    const max = h('button', { class: 'btn small', type: 'button', disabled: !canSend || !(freeUnits > 0), onclick: () => { amount.value = (Math.max(0, freeUnits) / 100).toFixed(2); } }, 'Max');
    const sendCard = card('Send to treasury', T.send, h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault();
      if (busy) return;
      const units = readUnits(amount);
      if (!(units > 0)) return toast('Enter an amount.', 'bad');
      if (!/^\d{6}$/.test(code.value.trim())) return toast('Enter the 6-digit code from your authenticator app.', 'bad');
      if (!await confirmDialog({ title: `Send ${money(units)} to the treasury?`, confirmLabel: 'Send now', danger: true,
        body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'From the casino wallet to:'), h('p', { class: 'mono wrap' }, s.treasuryAddress), h('p', { class: 'muted small' }, 'This cannot be undone once it is on chain.')) })) return;
      busy = true; sendBtn.disabled = true;
      try { const r = await api('/tics/treasury/send', { method: 'POST', body: { amountUnits: units, code: code.value.trim() } }); toast(`Treasury send queued: ${money(r.amountUnits)}.`); load(); }
      catch (err) { toast(err.message, 'bad'); code.value = ''; }
      finally { busy = false; sendBtn.disabled = !canSend; }
    } },
      h('div', { class: 'form-grid' }, field('Amount (TICS)', h('div', { class: 'input-row' }, amount, max), `Up to the free float${freeUnits != null ? `: ${money(Math.max(0, freeUnits))}` : ''}.`),
        field('Code from your authenticator app', code, 'A new code for every send. A code you already used (also the one you signed in with) is refused; wait for the next one.')),
      h('div', { class: 'actions' }, sendBtn, !s.treasuryAddress ? h('span', { class: 'muted small' }, 'Set a treasury address first.') : d.statusProblem ? h('span', { class: 'muted small' }, 'Sending needs the payouts service.') : null)));
    const sends = card('Recent treasury sends', null, table([
      { label: 'When', render: x => h('span', { tip: localTime(x.created_at) }, ago(x.created_at)) },
      { label: 'Amount', align: 'right', render: x => h('b', {}, money(x.amount_units)) },
      { label: 'To', render: x => addrLink(x.to_address, chain) },
      { label: 'Status', render: x => h('span', {}, wdPill(x.status), x.last_error ? h('div', { class: 'muted small' }, x.last_error) : null) },
      { label: 'Tx', render: x => txLink(x.tx_hash, chain) },
      { label: 'By', render: x => h('span', { class: 'small' }, x.requested_by || '-') }], d.sends, { emptyText: 'No treasury sends yet.' }));
    body.replaceChildren(...banners, pauseBox, kpis, h('div', { class: 'grid2 even' }, wallets, sendCard), sends, settingsForm(ctx, s, load),
      h('p', { class: 'muted small' }, `Checked ${new Date(d.checkedAt).toLocaleTimeString()}.`));
  }
  async function togglePause(pause) {
    const reason = h('input', { class: 'input', maxlength: 200, placeholder: pause ? 'Why? (required)' : 'Optional note' });
    // Pausing is one click; resuming needs your password and a fresh code.
    const step = pause ? null : stepUpFields();
    if (!await confirmDialog({ title: pause ? 'Pause automatic payouts?' : 'Resume automatic payouts?', danger: pause, confirmLabel: pause ? 'Pause payouts' : 'Resume payouts',
      body: pause ? 'Player withdrawals wait in the queue until you resume. Players can still request them.' : 'Waiting withdrawals that are due are sent straight away.', fields: h('div', { class: 'stack' }, field('Reason', reason), step ? step.fields : null) })) return;
    try { await api('/tics/payouts/pause', { method: 'POST', body: { paused: pause, reason: reason.value, ...(step ? step.read() : {}) } }); toast(pause ? 'Payouts paused.' : 'Payouts resumed.'); load(); }
    catch (e) { toast(e.message, 'bad'); }
  }
  async function changeAddress(s) {
    const address = h('input', { class: 'input mono', placeholder: '0x...', autocomplete: 'off', spellcheck: 'false' });
    const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const code = codeInput();
    if (!await confirmDialog({ title: 'Change the treasury address', confirmLabel: 'Save address', danger: true,
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Every treasury send goes to this address. Paste it from your own wallet and check the first and last characters.'),
        s.treasuryAddress ? h('p', { class: 'muted small' }, `Now: ${s.treasuryAddress}`) : null, h('p', { class: 'muted small' }, 'You get a Telegram alert when it changes.')),
      fields: h('div', { class: 'stack' }, field('New treasury address', address), field('Your password', password), field('Code from your authenticator app', code)) })) return;
    try { const r = await api('/tics/treasury/address', { method: 'PUT', body: { address: address.value.trim(), password: password.value, code: code.value.trim() } });
      toast(r.unchanged ? 'That is already the treasury address.' : `Treasury address saved. Sends to it open at ${new Date(r.sendableAt).toLocaleString()}.`); load(); }
    catch (e) { toast(e.message, 'bad'); }
  }
  load();
  return root;
}

// Same list as SENSITIVE_TICS in src/api/tics.js (the server enforces it; this only decides when to ask).
const SENSITIVE = ['realEnabled', 'withdrawalsOpen', 'depositsOpen', 'confirmations', 'quickConfirmations', 'quickDepositMaxUnits', 'quickDailyMaxUnits',
  'maxSpinExposurePct', 'coolingSeconds', 'startBlock', 'minWithdrawalUnits', 'fallbackFeeUnits', 'gasFeeMarginPct',
  'feesEnabled', 'minDepositUnits', 'lowFloatUnits', 'highFloatUnits', 'largeWithdrawalAlertUnits', 'lowEthWei'];
function settingsForm(ctx, s, reload) {
  const owner = ctx.can('settings:edit');
  const dis = { disabled: !owner };
  const chk = v => h('input', { type: 'checkbox', checked: v, ...dis });
  const int = (v, attrs = {}) => h('input', { class: 'input', type: 'number', step: '1', value: v ?? '', ...dis, ...attrs });
  const real = chk(s.realEnabled), dep = chk(s.depositsOpen), wd = chk(s.withdrawalsOpen);
  const quickConf = int(s.quickConfirmations, { min: 2 }), quickMax = unitsInput(s.quickDepositMaxUnits, { ...dis, max: '1000000' });
  const quickDay = unitsInput(s.quickDailyMaxUnits, { ...dis, max: '1000000', placeholder: 'Empty: same as one quick deposit' });
  const conf = int(s.confirmations, { min: 6 }), cool = int(s.coolingSeconds, { min: 60 }), start = int(s.startBlock, { min: 0, placeholder: 'Empty: automatic' });
  const minDep = unitsInput(s.minDepositUnits, dis), minWd = unitsInput(s.minWithdrawalUnits, { ...dis, max: '100000' });
  const large = unitsInput(s.largeWithdrawalAlertUnits, dis), lowF = unitsInput(s.lowFloatUnits, dis), highF = unitsInput(s.highFloatUnits, dis), demo = unitsInput(s.demoStartUnits, dis);
  const lowEth = h('input', { class: 'input', type: 'text', inputmode: 'decimal', value: weiToEthText(s.lowEthWei), ...dis });
  const exposure = int(s.maxSpinExposurePct ?? 25, { min: 1, max: 50 });
  return card('Payout settings', 'Switches, limits, fees and alert levels for TICS deposits and withdrawals. Every change is in the audit log.', h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault();
    const wei = ethToWei(lowEth.value);
    if (wei == null) return toast('Low ETH alert must be an amount of ETH, like 0.005.', 'bad');
    const next = { realEnabled: real.checked, depositsOpen: dep.checked, withdrawalsOpen: wd.checked, confirmations: Number(conf.value), quickConfirmations: Number(quickConf.value), quickDepositMaxUnits: readUnits(quickMax), quickDailyMaxUnits: quickDay.value === '' ? null : readUnits(quickDay), coolingSeconds: Number(cool.value),
      startBlock: start.value === '' ? null : Number(start.value), minDepositUnits: readUnits(minDep), minWithdrawalUnits: readUnits(minWd),
      largeWithdrawalAlertUnits: readUnits(large), lowFloatUnits: readUnits(lowF),
      highFloatUnits: readUnits(highF), lowEthWei: wei, demoStartUnits: readUnits(demo), maxSpinExposurePct: Number(exposure.value) };
    const opening = next.realEnabled && !s.realEnabled;
    // These decide when money is real, final or exposed, and when you hear about it: changing them needs your password and a fresh code.
    const sensitive = SENSITIVE.filter(k => JSON.stringify(next[k]) !== JSON.stringify(s[k]));
    const step = sensitive.length ? stepUpFields() : null;
    if (!await confirmDialog({ title: 'Save payout settings?', danger: opening, typed: opening ? 'REAL' : null, fields: step ? step.fields : null,
      body: opening ? 'This lets players bet real TICS. Only do it once the casino wallet holds TICS and ETH and the key is set up.' : 'New values apply to the next deposit or withdrawal.' })) return;
    try { const r = await api('/tics/settings', { method: 'PUT', body: { ...next, ...(step ? step.read() : {}) } }); toast(r.changed.length ? `Saved: ${r.changed.length} change${r.changed.length === 1 ? '' : 's'}.` : 'Nothing changed.'); reload(); }
    catch (err) { toast(err.message, 'bad'); }
  } },
    h('div', { class: 'channels' }, h('label', { class: 'check' }, real, ' Real money play on'), h('label', { class: 'check' }, dep, ' Deposits open'), h('label', { class: 'check' }, wd, ' Withdrawals open')),
    h('h4', {}, 'Deposits'),
    h('div', { class: 'form-grid' }, field('Smallest deposit (TICS)', minDep), field('Quick deposits up to (TICS)', quickMax, T.quickMax), field('Quick deposits per wallet per 24 hours (TICS)', quickDay, 'Quick (fewer confirmations) credits from one wallet over the last 24 hours stay under this; the rest waits for full confirmations. At most 1,000,000 TICS.'), field('Confirmations for quick deposits', quickConf, T.quickConf), field('Confirmations for big deposits', conf, T.confirmations), field('Start block', start, T.startBlock), field('Demo start balance (TICS)', demo)),
    h('h4', {}, 'Withdrawals'),
    h('div', { class: 'form-grid' }, field('Minimum withdrawal (player receives this minus the fee)', minWd, 'In TICS, at most 100,000. The network fee is set on the Fees page.'), field('Cooling delay (seconds)', cool, T.cooling)),
    h('h4', {}, 'Table limit'),
    h('div', { class: 'form-grid' }, field('Most one spin can pay (% of free float)', exposure, 'The table refuses chips (Demo and Real) once the biggest possible payout, stake included, is more than this share of the free float: casino wallet minus what players are owed and minus real spins in progress, read live. Real spins also book their exposure before they run, so players spinning at the same moment can never be owed more than the wallet holds.')),
    h('h4', {}, 'Alerts'),
    h('div', { class: 'form-grid' }, field('Large withdrawal (TICS)', large, 'Alert only. It never blocks a withdrawal.'), field('Low float (TICS)', lowF, '0 turns it off.'),
      field('High float (TICS)', highF, 'Alert to move the extra to the treasury. 0 turns it off.'), field('Low ETH for gas (ETH)', lowEth)),
    owner ? h('button', { class: 'btn primary' }, 'Save payout settings') : h('p', { class: 'muted' }, 'Only an owner can change payout settings.')));
}

// ---------- Payments page: TICS section ----------
let wdTab = 'open', depTab = 'all';
export function ticsPaymentsSection(ctx) {
  const wrap = h('div', { class: 'stack' }, loading());
  async function load() {
    try { render(await api(`/tics/payments?status=${wdTab}&deposits=${depTab}`)); } catch (e) { wrap.replaceChildren(errorBox(e, load)); }
  }
  function render(d) {
    const chain = d.settings.chainId, c = d.counts;
    const n = (m, k) => m[k]?.n || 0;
    const head = h('div', { class: 'section-head' }, h('h2', {}, 'TICS on Ethereum'), h('p', { class: 'muted' }, 'Automatic withdrawals and deposits to the casino wallet.'));
    const paused = d.settings.payoutsPaused ? h('div', { class: 'bank-hero bad' }, h('span', { class: 'dot' }), h('div', {}, h('b', {}, 'Automatic payouts are paused'),
      d.settings.pausedReason ? h('div', {}, `Reason: ${d.settings.pausedReason}`) : null, ctx.can('treasury:manage') ? h('a', { href: '#/treasury' }, 'Resume on the Treasury page') : null)) : null;
    const kpis = h('div', { class: 'kpis' },
      kpi('Waiting to send', T.queue, num(n(c.withdrawals, 'holding') + n(c.withdrawals, 'queued') + n(c.withdrawals, 'signing') + n(c.withdrawals, 'sending')),
        `${n(c.withdrawals, 'blocked') ? `${num(n(c.withdrawals, 'blocked'))} need review, ` : ''}${n(c.withdrawals, 'cancelling') ? `${num(n(c.withdrawals, 'cancelling'))} cancelling, ` : ''}${num(n(c.withdrawals, 'failed'))} failed`,
        n(c.withdrawals, 'blocked') ? 'down' : n(c.withdrawals, 'queued') ? 'gold' : ''),
      kpi('Sent, 30 days', null, money(d.totals.wd30, { short: true }), `Fees ${money(d.totals.fees30, { short: true })}`),
      kpi('Deposits, 30 days', null, money(d.totals.dep30, { short: true }), null, 'up'),
      kpi('Unmatched deposits', T.deposits, num(n(c.deposits, 'unmatched')), money(c.deposits.unmatched?.units || 0, { short: true }), n(c.deposits, 'unmatched') ? 'gold' : ''));
    const canCancel = ctx.can('payments:approve');
    const queue = h('section', { class: 'card' }, h('h3', {}, 'TICS payouts', info(T.queue), h('span', { class: 'r' },
      segmented([['open', 'Open'], ['queued', 'Waiting'], ['blocked', 'Needs review'], ['sent', 'Sent'], ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['all', 'All']], wdTab, v => { wdTab = v; load(); }))),
      d.withdrawals.length ? table([
        { label: 'When', render: w => h('span', { tip: localTime(w.created_at) }, ago(w.created_at)) },
        { label: 'To', render: w => h('span', {}, w.kind === 'treasury' ? h('span', { class: 'pill on' }, 'Treasury') : w.player_id ? h('a', { class: 'mono small', href: `#/players/${w.player_id}` }, shortAddr(w.to_address)) : null, ' ', addrLink(w.to_address, chain)) },
        { label: 'Amount', align: 'right', render: w => h('b', {}, money(w.amount_units)) },
        { label: 'Fee', align: 'right', render: w => money(w.fee_units), tip: T.fee },
        { label: 'Sends', align: 'right', render: w => money(w.send_units) },
        { label: 'Release', render: w => h('span', { tip: localTime(w.release_at) }, releaseText(w)) },
        { label: 'Status', render: w => h('span', {}, wdPill(w.status), w.cancelled_by ? h('div', { class: 'muted small' }, `by ${w.cancelled_by}`) : null) },
        { label: 'Tx', render: w => w.tx_hash ? h('span', {}, txLink(w.tx_hash, chain), w.tx_hashes.length > 1 ? h('span', { class: 'muted small', tip: w.tx_hashes.map(x => esc(x.slice(0, 18))).join('<br>') }, ` +${w.tx_hashes.length - 1}`) : null) : '' },
        { label: 'Tries', align: 'right', render: w => num(w.attempts) },
        { label: 'Last error', render: w => w.last_error ? h('span', { class: 'small down err-cell', tipText: w.last_error }, w.last_error) : '' },
        { label: '', render: w => canCancel && w.status === 'queued' ? h('button', { class: 'btn small danger', onclick: () => cancel(w) }, 'Cancel')
          : ctx.can('treasury:manage') && w.status === 'blocked' && w.kind === 'player' ? h('button', { class: 'btn small', onclick: () => releaseBlocked(w) }, 'Return to player') : '' },
      ], d.withdrawals) : empty('Nothing here', wdTab === 'open' ? 'Withdrawals appear here while they wait, send or fail.' : 'No payouts in this list.'));
    const owner = ctx.can('deposit:assign');
    const deposits = h('section', { class: 'card' }, h('h3', {}, 'TICS deposits', info(T.deposits), h('span', { class: 'r' },
      segmented([['all', 'All'], ['unmatched', 'Unmatched'], ['credited', 'Credited'], ['assigned', 'Assigned'], ['below_min', 'Below minimum']], depTab, v => { depTab = v; load(); }))),
      d.deposits.length ? table([
        { label: 'When', render: x => h('span', { tip: localTime(x.created_at) }, ago(x.created_at)) },
        { label: 'From', render: x => addrLink(x.from_address, chain) },
        { label: 'Player', render: x => x.player_id ? h('a', { class: 'mono small', href: `#/players/${x.player_id}` }, shortAddr(x.player_id)) : h('span', { class: 'muted' }, '-') },
        { label: 'Amount', align: 'right', render: x => h('b', {}, money(x.amount_units)) },
        { label: 'Block', align: 'right', render: x => num(x.block_number) },
        { label: 'Status', render: x => h('span', {}, x.reversed_at ? h('span', { class: 'pill off' }, 'Reversed') : x.review_at ? h('span', { class: 'pill warn', tip: 'Not found on Ethereum although its block is final. The player is paused and this money cannot be withdrawn. Check it on Etherscan.' }, 'Under review') : pill(DEP, x.status),
          !x.reversed_at && !x.review_at && x.credited_at && !x.finalized_at ? h('div', { class: 'muted small', tip: 'Played already; it can be withdrawn once Ethereum has made its block final, about 15 minutes after it arrived.' }, 'Not final yet') : null,
          x.note ? h('div', { class: 'muted small' }, x.note) : null) },
        { label: 'Tx', render: x => txLink(x.tx_hash, chain) },
        { label: '', render: x => !owner || x.reversed_at ? '' : x.status === 'unmatched' ? h('button', { class: 'btn small primary', onclick: () => assign(x) }, 'Assign to player')
          : x.status === 'assigned' && !x.credited_at ? h('button', { class: 'btn small', tipText: 'The credit was not confirmed. It can only be tried again for the same player.', onclick: () => assign(x) }, 'Try the credit again') : '' },
      ], d.deposits) : empty('No deposits here', 'TICS sent to the casino wallet appears here once the watcher sees it.'));
    wrap.replaceChildren(head, paused || '', kpis, queue, deposits);
  }
  async function cancel(w) {
    if (!await confirmDialog({ title: 'Cancel this withdrawal?', danger: true, confirmLabel: 'Cancel withdrawal',
      body: `${money(w.amount_units)} goes straight back to the player's balance and nothing is sent.` })) return;
    try { await api(`/tics/withdrawals/${encodeURIComponent(w.id)}/cancel`, { method: 'POST', body: {} }); toast('Withdrawal cancelled. The money is back with the player.'); load(); }
    catch (e) { toast(e.message, 'bad'); }
  }
  async function releaseBlocked(w) {
    const step = stepUpFields();
    if (!await confirmDialog({ title: 'Return this money to the player?', danger: true, confirmLabel: 'Return to player',
      body: `${money(w.amount_units)} goes back to the player's balance and nothing is sent. Refused automatically if this withdrawal was ever signed (then check it on Etherscan first). Reason it stopped: ${w.last_error || 'not recorded'}.`,
      fields: step.fields })) return;
    try { const r = await api(`/tics/withdrawals/${encodeURIComponent(w.id)}/release`, { method: 'POST', body: step.read() }); toast(r.withdrawal?.status === 'cancelled' ? 'Returned to the player.' : 'Return started; it finishes on the next run.'); load(); }
    catch (e) { toast(e.message, 'bad'); }
  }
  // Real TICS move: password and a fresh code. A credit that was not confirmed can only be retried for the same player.
  async function assign(x) {
    const retry = x.status === 'assigned';
    const address = h('input', { class: 'input mono', placeholder: '0x... wallet of an existing player', autocomplete: 'off', spellcheck: 'false',
      ...(retry ? { value: x.player_id || '', readonly: true } : {}) });
    const note = h('input', { class: 'input', maxlength: 200, placeholder: 'How you know it is theirs (required)', ...(retry && x.note ? { value: x.note } : {}) });
    const step = stepUpFields();
    if (!await confirmDialog({ title: retry ? `Try the credit of ${money(x.amount_units)} again?` : `Assign ${money(x.amount_units)} to a player?`, confirmLabel: 'Credit the player', danger: true,
      body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, `Sent from ${x.from_address}. The player's real TICS balance goes up by this amount. It can only be done once.`),
        retry ? h('p', { class: 'muted small' }, 'The last try could not be confirmed, so it may already be credited. Trying again for the same player never pays it twice.') : null),
      fields: h('div', { class: 'stack' }, field('Player wallet address', address), field('Note', note), step.fields) })) return;
    try { const r = await api(`/tics/deposits/${encodeURIComponent(x.id)}/assign`, { method: 'POST', body: { address: address.value.trim(), note: note.value, ...step.read() } }); toast(r.duplicate ? 'It was already credited.' : `Credited ${r.amount}.`); load(); }
    catch (e) { toast(e.message, 'bad'); load(); }
  }
  load();
  return wrap;
}

export { explorer };
