// Bank: what the casino holds in its own wallets, live, against what it owes players.
import { h, api, money, num, info, card, pageHead, loading, errorBox, toast, confirmDialog, field, curSymbol, ago, floatCard, stepUpFields } from '../lib.js';

const T = {
  held: '<b>In the casino wallets</b>The house currency (TICS) held right now in the wallets listed below, read live from the blockchain.',
  owed: '<b>Owed to players</b>The real-money balances players could withdraw right now. Demo balances are not included.',
  buffer: '<b>Safety buffer</b>Extra you keep on top of what players are owed, for big wins and withdrawals in a rush. Set as a percentage of what is owed.',
  spare: '<b>Spare</b>What you could take out of the bank and still cover every player plus the safety buffer.',
  gas: '<b>Coins for fees</b>Sending tokens costs a network fee: ETH on Ethereum, TRX on Tron. A wallet without it cannot send withdrawals.',
};
const STATE = {
  healthy: ['ok', 'The bank covers every player plus your safety buffer.'],
  low: ['warn', 'The bank covers players, but is below your safety buffer.'],
  short: ['bad', 'The bank cannot cover what players are owed. Top up now.'],
  no_wallet: ['idle', 'Add the casino wallet address below to see the bank live.'],
  unreadable: ['warn', 'One of the wallets could not be read just now. Retrying.'],
};

export function bankView(ctx) {
  const root = h('div', { class: 'page' });
  const body = h('div', {}, loading());
  const stamp = h('span', { class: 'muted small' });
  const refresh = h('button', { class: 'btn', onclick: () => load(true) }, '↻ Refresh');
  root.append(pageHead('Bank', 'The casino\'s own wallets, read live from the blockchain, against what it owes players. Shows when to top up and how much you can safely take out.',
    h('span', { class: 'live-dot' }), stamp, refresh), body);
  let lastAt = 0, data = null, editing = false;
  async function load(manual) {
    if (manual) refresh.disabled = true;
    try { data = await api('/bank'); lastAt = Date.now(); if (!editing) render(data); }
    catch (e) { if (!data) body.replaceChildren(errorBox(e, () => load(true))); }
    finally { refresh.disabled = false; tick(); }
  }
  const tick = () => { stamp.textContent = lastAt ? `Updated ${Math.round((Date.now() - lastAt) / 1000)}s ago` : ''; };
  const timer = setInterval(() => { tick(); if (document.visibilityState === 'visible' && Date.now() - lastAt > 10000) load(); }, 1000);
  ctx.onLeave(() => clearInterval(timer));

  function render(b) {
    const sym = b.currency?.symbol || curSymbol();
    const [tone, line] = STATE[b.state];
    const action = b.state === 'healthy' ? `You can take out up to ${money(b.spareCents)}.` : ['low', 'short'].includes(b.state) ? `Top up ${money(b.topUpCents)}.` : '';
    const hero = h('div', { class: `bank-hero ${tone}` }, h('span', { class: 'dot' }), h('div', {}, h('b', {}, line), action ? h('div', {}, action) : null,
      b.owedCents === 0 && b.state !== 'no_wallet' ? h('div', { class: 'muted small' }, 'No real money is owed yet: all player balances are demo money.') : null));
    const kpis = h('div', { class: 'kpis' },
      h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'In the casino wallets', info(T.held)), h('div', { class: 'big gold' }, b.wallets.length ? money(b.heldCents) : '-'), h('div', { class: 'delta' }, `${sym}, live`)),
      h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Owed to players', info(T.owed)), h('div', { class: 'big' }, money(b.owedCents)), h('div', { class: 'delta' }, 'Real money only')),
      h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, 'Safety buffer', info(T.buffer)), h('div', { class: 'big' }, money(b.reserveCents)), h('div', { class: 'delta' }, `${b.reservePct}% of what is owed`)),
      h('div', { class: 'card kpi' }, h('div', { class: 'lab' }, b.topUpCents ? 'Top up needed' : 'Spare', info(T.spare)), h('div', { class: `big ${b.topUpCents ? 'down' : 'up'}` }, money(b.topUpCents || b.spareCents)), h('div', { class: 'delta' }, b.topUpCents ? 'To cover players and buffer' : 'Safe to take out')));
    const walletRows = b.wallets.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Wallet'), h('th', {}, 'Address'), h('th', { class: 'r' }, sym), h('th', {}, 'Network'), h('th', { class: 'r' }, 'Coins for fees', info(T.gas)))),
      h('tbody', {}, b.wallets.map(w => h('tr', {}, h('td', {}, h('b', {}, w.label)),
        h('td', { class: 'mono small' }, h('a', { href: w.chain === 'tron' ? `https://tronscan.org/#/address/${w.address}` : `https://etherscan.io/address/${w.address}`, target: '_blank', rel: 'noopener noreferrer', tip: w.chain === 'tron' ? 'Open on Tronscan' : 'Open on Etherscan' }, `${w.address.slice(0, 8)}...${w.address.slice(-6)}`),
          ' ', h('button', { class: 'btn small', onclick: () => { navigator.clipboard.writeText(w.address); toast('Address copied'); } }, 'Copy')),
        h('td', { class: 'r' }, w.ok ? money(w.tokenCents) : h('span', { class: 'down' }, w.error)),
        h('td', {}, w.chain === 'tron' ? 'Tron (TRC-20)' : 'Ethereum (ERC-20)'),
        h('td', { class: `r ${w.ok && w.feeLow ? 'down' : ''}` }, w.ok ? `${w.fee.toFixed(w.feeSymbol === 'TRX' ? 2 : 4)} ${w.feeSymbol}${w.feeLow ? ' (low)' : ''}` : '-')))))) : h('p', { class: 'muted' }, 'No wallets added yet.');
    const play = card('Demo money held by players', 'Play-money balances in the demo. They are not backed by real money and are never counted as owed.',
      h('div', { class: 'gm' }, h('span', {}, `${num(b.play.players)} players hold`), h('b', {}, money(b.play.owedCents)), h('span', { class: 'muted' }, 'demo')));
    const flows = card('Deposits and withdrawals, last 30 days', 'Money players moved in and out. Fills in once crypto payments are connected.',
      h('div', { class: 'gm' }, h('span', {}, 'Deposits'), h('b', {}, money(b.flows.deposit?.totalCents || 0)), h('span', { class: 'muted' }, `${num(b.flows.deposit?.count || 0)}`)),
      h('div', { class: 'gm' }, h('span', {}, 'Withdrawals'), h('b', {}, money(Math.abs(b.flows.withdrawal?.totalCents || 0))), h('span', { class: 'muted' }, `${num(b.flows.withdrawal?.count || 0)}`)));
    body.replaceChildren(hero, kpis, card('Casino wallets', 'The wallets that hold the casino\'s money. Balances are read from the blockchain every 10 seconds.', walletRows, ctx.can('settings:edit') ? editor(b) : null),
      h('div', { class: 'grid2 even' }, play, flows), b.ticsFloat ? h('div', { class: 'grid2 even' }, floatCard(b.ticsFloat, ctx)) : '');
  }

  function editor(b) {
    const rows = h('div', { class: 'stack' });
    const addRow = (w = { label: '', address: '', chain: 'ethereum' }) => {
      const label = h('input', { class: 'input', value: w.label, placeholder: 'Hot wallet', maxlength: 40 });
      const chain = h('select', { class: 'input' }, h('option', { value: 'tron', selected: w.chain !== 'ethereum' }, 'Tron'), h('option', { value: 'ethereum', selected: w.chain === 'ethereum' }, 'Ethereum'));
      const address = h('input', { class: 'input mono grow', value: w.address, placeholder: 'T... or 0x...' });
      const row = h('div', { class: 'inline-form wallet-row' }, label, chain, address, h('button', { class: 'btn small danger', type: 'button', onclick: () => row.remove() }, 'Remove'));
      [label, address, chain].forEach(i => i.addEventListener('focus', () => { editing = true; }));
      rows.append(row);
    };
    b.wallets.forEach(addRow);
    const buffer = h('input', { class: 'input', type: 'number', min: 0, max: 500, value: b.reservePct });
    return h('details', { class: 'bank-edit' }, h('summary', {}, 'Change wallets or safety buffer'),
      h('form', { class: 'stack', onsubmit: async e => {
        e.preventDefault();
        const wallets = [...rows.querySelectorAll('.wallet-row')].map(r => ({ label: r.children[0].value, chain: r.children[1].value, address: r.children[2].value })).filter(w => w.label || w.address);
        // The wallets and buffer decide the top up / safe to take out figures: your password and a fresh code.
        const step = stepUpFields();
        if (!await confirmDialog({ title: 'Save bank settings?', fields: step.fields, body: `${wallets.length} wallet${wallets.length === 1 ? '' : 's'}, safety buffer ${buffer.value}%. Only add wallets the casino controls.` })) return;
        try { await api('/bank', { method: 'PUT', body: { wallets, reservePct: Number(buffer.value), ...step.read() } }); editing = false; toast('Bank settings saved.'); load(true); }
        catch (err) { toast(err.message, 'bad'); }
      } }, h('p', { class: 'muted small' }, 'Wallets holding the house currency (TICS on Ethereum). Address only: the panel never needs a private key. Automatic payouts and treasury sends are on the Treasury page.'), rows,
        h('button', { class: 'btn small', type: 'button', onclick: () => addRow() }, '+ Add wallet'),
        field('Safety buffer (% of what is owed)', buffer, T.buffer),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary' }, 'Save'), h('button', { class: 'btn', type: 'button', onclick: () => { editing = false; render(data); } }, 'Cancel'))));
  }
  load();
  return root;
}
