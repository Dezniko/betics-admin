// Payments: withdrawal approvals, deposits, and payment settings.
import { ticsPaymentsSection } from './tics.js';
import { h, api, usdt as money, num, info, card, pageHead, loading, errorBox, empty, toast, confirmDialog, field, ago, short, localTime, table, cap, segmented, centsInput, readCents, stepUpFields } from '../lib.js';

const T = {
  queue: '<b>Withdrawals to handle</b>Players asked for these. The money is already taken from their balance and held, so they cannot bet it. Approve, send it from the casino wallet, then paste the transaction hash. Or reject it and the money goes back to them.',
  deposits: '<b>Deposits</b>Payments players made through NOWPayments. A deposit is only credited once NOWPayments confirms it as finished.',
  provider: '<b>Payment provider</b>NOWPayments creates a USDT (Tron) address for each deposit and tells the casino when it is paid.',
  fee: '<b>Network fee</b>Taken from each withdrawal to cover the Tron network cost of sending it.',
  daily: '<b>Daily limit</b>The most one player can withdraw in 24 hours.',
};
// Legacy withdrawals: 'failed' is only written when a reject's wallet reply was lost (refund not confirmed).
const WSTATUS = { failed: ['warn', 'Needs review'] };
const STATUS = { requested: ['warn', 'Waiting'], approved: ['on', 'Approved, send it'], sent: ['on', 'Sent'], rejected: ['off', 'Rejected'], failed: ['off', 'Failed'],
  waiting: ['warn', 'Waiting for payment'], confirming: ['warn', 'Confirming'], partially_paid: ['off', 'Partly paid'], finished: ['on', 'Credited'], expired: ['off', 'Expired'], refunded: ['off', 'Refunded'] };
const pill = s => { const [c, t] = STATUS[s] || ['off', s]; return h('span', { class: `pill ${c}` }, t); };
const tronTx = tx => h('a', { href: `https://tronscan.org/#/transaction/${tx}`, target: '_blank', rel: 'noopener noreferrer', class: 'mono small' }, `${tx.slice(0, 10)}...`);
const tronAddr = a => h('a', { href: `https://tronscan.org/#/address/${a}`, target: '_blank', rel: 'noopener noreferrer', class: 'mono small', tipText: a }, `${a.slice(0, 8)}...${a.slice(-6)}`);

let tab = 'open';
export function paymentsView(ctx) {
  const root = h('div', { class: 'page' });
  const body = h('div', {}, loading());
  root.append(pageHead('Payments', 'TICS payouts and deposits on Ethereum. The older USDT (Tron) payments are further down; they are switched off.'),
    ticsPaymentsSection(ctx),
    h('div', { class: 'section-head' }, h('h2', {}, 'USDT on Tron (switched off)'), h('p', { class: 'muted' }, 'The NOWPayments route, kept for later. Withdrawals here wait for manual approval.'),
      segmented([['open', 'To handle'], ['sent', 'Sent'], ['rejected', 'Rejected'], ['all', 'All']], tab, v => { tab = v; load(); })), body);
  async function load() {
    try { render(await api(`/payments?status=${tab}`)); } catch (e) { body.replaceChildren(errorBox(e, load)); }
  }
  const act = async (w, action) => {
    const amount = `${money(w.amount_cents)} (send ${money(w.amount_cents - w.fee_cents)} after the ${money(w.fee_cents)} fee)`;
    if (action === 'approve') {
      if (!await confirmDialog({ title: 'Approve this withdrawal?', body: `${amount} to ${w.address}. After approving, send it from the casino wallet and record the transaction hash.` })) return;
      await run(w, { action });
    } else if (action === 'sent') {
      const tx = h('input', { class: 'input mono', placeholder: 'Transaction hash (64 characters)' });
      if (!await confirmDialog({ title: 'Record the payment', confirmLabel: 'Mark as sent', body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, `Send exactly ${money(w.amount_cents - w.fee_cents)} on Tron to:`), h('p', { class: 'mono' }, w.address),
        h('button', { class: 'btn small', onclick: () => { navigator.clipboard.writeText(w.address); toast('Address copied'); } }, 'Copy address')), fields: field('Transaction hash from Tronscan or your wallet', tx) })) return;
      await run(w, { action, txHash: tx.value });
    } else {
      const reason = h('input', { class: 'input', maxlength: 300, placeholder: 'The player sees this reason' });
      if (!await confirmDialog({ title: 'Reject this withdrawal?', danger: true, body: `${money(w.amount_cents)} goes straight back to the player's balance.`, fields: field('Reason', reason) })) return;
      await run(w, { action, reason: reason.value });
    }
  };
  const run = async (w, payload) => { try { await api(`/withdrawals/${w.id}`, { method: 'POST', body: payload }); toast('Done.'); load(); } catch (e) { toast(e.message, 'bad'); } };
  function render(d) {
    const canAct = ctx.can('payments:approve');
    const p = d.provider || {};
    const status = h('div', { class: 'kpis' },
      h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Waiting for approval', info(T.queue)), h('div', { class: `big ${d.totals.waiting ? 'gold' : ''}` }, num(d.totals.waiting))),
      h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Held for withdrawals', info('<b>Held</b>Requested or approved, not sent yet. Counted as owed on the Bank page.')), h('div', { class: 'big' }, money(d.totals.pending_cents))),
      h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Deposits, 30 days'), h('div', { class: 'big up' }, money(d.totals.dep30))),
      h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Withdrawals sent, 30 days'), h('div', { class: 'big' }, money(d.totals.wd30))));
    const queue = card('USDT withdrawals', T.queue, d.withdrawals.length ? table([
      { label: 'When', render: w => h('span', { tip: localTime(w.created_at) }, ago(w.created_at)) },
      { label: 'Player', render: w => h('a', { class: 'mono', href: `#/players/${w.player_id}` }, short(w.player_id)) },
      { label: 'Amount', align: 'right', render: w => h('b', {}, money(w.amount_cents)) },
      { label: 'To send', align: 'right', render: w => money(w.amount_cents - w.fee_cents), tip: T.fee },
      { label: 'Address', render: w => h('span', {}, tronAddr(w.address), w.shared_address ? h('span', { class: 'pill warn', tip: 'Another player has withdrawn to this same address. Could be one person with several accounts.' }, ' shared') : null) },
      { label: 'Status', render: w => h('span', {}, WSTATUS[w.status] ? h('span', { class: `pill ${WSTATUS[w.status][0]}`, tipText: 'The wallet did not answer the reject, so it is not known whether the money went back. Check the player balance; it is still counted as owed.' }, WSTATUS[w.status][1]) : pill(w.status), w.tx_hash ? h('span', {}, ' ', tronTx(w.tx_hash)) : null, w.reason ? h('div', { class: 'muted small' }, w.reason) : null) },
      { label: '', render: w => !canAct || !['requested', 'approved'].includes(w.status) ? '' : h('div', { class: 'actions' },
        w.status === 'requested' ? h('button', { class: 'btn small primary', onclick: () => act(w, 'approve') }, 'Approve') : null,
        h('button', { class: 'btn small', onclick: () => act(w, 'sent') }, 'Mark as sent'),
        h('button', { class: 'btn small danger', onclick: () => act(w, 'reject') }, 'Reject')) },
    ], d.withdrawals) : empty(tab === 'open' ? 'Nothing to approve' : 'Nothing here', tab === 'open' ? 'New withdrawal requests appear here and are sent to your Telegram.' : 'No withdrawals in this list.'));
    const deposits = card('USDT deposits', T.deposits, d.deposits.length ? table([
      { label: 'When', render: x => ago(x.created_at) }, { label: 'Player', render: x => h('a', { class: 'mono', href: `#/players/${x.player_id}` }, short(x.player_id)) },
      { label: 'Asked', align: 'right', render: x => money(x.requested_cents) }, { label: 'Credited', align: 'right', render: x => x.credited_cents ? money(x.credited_cents) : '-' },
      { label: 'Paid', render: x => x.actually_paid ? `${x.actually_paid} ${x.pay_currency.toUpperCase()}` : '-' }, { label: 'Status', render: x => pill(x.status) },
      { label: 'Tx', render: x => x.tx_hash ? tronTx(x.tx_hash) : '' }], d.deposits) : empty('No deposits yet', 'Deposits appear here once payments are connected and open.'));
    body.replaceChildren(status, queue, deposits, settingsCard(ctx, d.settings, p, load));
  }
  load();
  return root;
}

function settingsCard(ctx, s, p, reload) {
  const owner = ctx.can('settings:edit');
  const dep = h('input', { type: 'checkbox', checked: s.depositsOpen, disabled: !owner });
  const wd = h('input', { type: 'checkbox', checked: s.withdrawalsOpen, disabled: !owner });
  const minDep = centsInput(s.minDepositCents, { disabled: !owner }), minWd = centsInput(s.minWithdrawalCents, { disabled: !owner }), maxWd = centsInput(s.maxWithdrawalCents, { disabled: !owner });
  const fee = centsInput(s.withdrawalFeeCents, { disabled: !owner }), daily = centsInput(s.dailyWithdrawalLimitCents, { disabled: !owner });
  const providerBox = p.configured
    ? h('div', { class: 'gm' }, h('span', {}, 'NOWPayments', info(T.provider)), h('span', { class: 'pill on' }, 'Connected'), h('span', { class: 'muted' }, 'USDT on Tron'))
    : h('div', { class: 'stack' }, h('div', { class: 'gm' }, h('span', {}, 'NOWPayments', info(T.provider)), h('span', { class: 'pill warn' }, 'Not connected yet'), h('span', {}, '')),
      h('ol', { class: 'muted small setup-steps' },
        h('li', {}, 'Create or sign in to your NOWPayments account and finish its business checks.'),
        h('li', {}, 'In Store Settings, add your casino Tron wallet as the payout wallet for USDT (TRC-20).'),
        h('li', {}, 'In Store Settings > API keys, create an API key.'),
        h('li', {}, 'In Store Settings > IPN, create an IPN secret. The callback address is https://betics.io/api/payments/webhook/nowpayments'),
        h('li', {}, 'Give both to Allen through the secure vault. They are stored as private Worker secrets, never in the code.')));
  return card('USDT payment settings', 'Limits and fees for players, and the switches that open deposits and withdrawals.', h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault();
    const next = { depositsOpen: dep.checked, withdrawalsOpen: wd.checked, minDepositCents: readCents(minDep), minWithdrawalCents: readCents(minWd), maxWithdrawalCents: readCents(maxWd),
      withdrawalFeeCents: readCents(fee), dailyWithdrawalLimitCents: readCents(daily) };
    const opening = (next.depositsOpen && !s.depositsOpen) || (next.withdrawalsOpen && !s.withdrawalsOpen);
    // Switches, limits and fees decide what players can move: any change needs your password and a fresh code.
    const changed = Object.keys(next).some(k => next[k] !== s[k]);
    if (!changed) return toast('Nothing changed.');
    const step = stepUpFields();
    if (!await confirmDialog({ title: 'Save payment settings?', danger: opening, typed: opening ? 'OPEN' : null, fields: step.fields,
      body: opening ? 'This lets players move real money. Only do it once the provider is connected and the casino wallet is funded.' : 'New limits apply to the next request.' })) return;
    try { await api('/payments/settings', { method: 'PUT', body: { ...next, ...step.read() } }); toast('Payment settings saved.'); reload(); } catch (err) { toast(err.message, 'bad'); }
  } }, providerBox,
    h('div', { class: 'channels' }, h('label', { class: 'check' }, dep, ' Deposits open', info('Deposits also need NOWPayments connected; until then players see that deposits are not open yet.')), h('label', { class: 'check' }, wd, ' Withdrawals open')),
    h('div', { class: 'form-grid' }, field('Smallest deposit (USDT)', minDep), field('Smallest withdrawal (USDT)', minWd), field('Largest single withdrawal (USDT)', maxWd),
      field('Network fee per withdrawal (USDT)', fee, T.fee), field('Daily withdrawal limit per player (USDT)', daily, T.daily)),
    owner ? h('button', { class: 'btn primary' }, 'Save USDT payment settings') : h('p', { class: 'muted' }, 'Only an owner can change payment settings.')));
}
