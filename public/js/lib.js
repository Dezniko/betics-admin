// Tiny UI toolkit: element builder, API calls, formatting, tooltips, toasts,
// confirm dialogs and theme. No dependencies.
import { h, $, ApiError, getView, setView, isReal, api, esc, installTooltips, info, toast, field } from './signin-core.js';
export { h, $, ApiError, getView, setView, isReal, api, esc, installTooltips, info, toast, field };
export const clear = el => { el.replaceChildren(); return el; };

// For plain links (CSV downloads) that cannot send the header.
export const viewQuery = () => `money=${isReal() ? 'real' : 'play'}`;
export const viewLabel = () => (isReal() ? 'Real TICS' : 'Demo money');

// Money: everything is stored in whole 0.01 units of the house currency (TICS).
let currency = { symbol: 'TICS' };
export const setCurrency = c => { if (c) currency = c; };
const amountBody = (abs, short) => short && abs >= 1e6 ? `${(abs / 1e6).toFixed(2)}M` : short && abs >= 1e4 ? `${(abs / 1e3).toFixed(1)}k`
  : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const withUnit = (cents, unit, { sign = false, short = false } = {}) => {
  if (cents == null) return '-';
  const v = Number(cents) / 100;
  return `${v < 0 ? '-' : sign && v > 0 ? '+' : ''}${amountBody(Math.abs(v), short)} ${unit}`;
};
// House currency: '1,234.50 TICS'.
export const money = (cents, opts) => withUnit(cents, 'TICS', opts);
// The old USDT (NOWPayments, Tron) payments: '1,234.50 USDT'.
export const usdt = (cents, opts) => withUnit(cents, 'USDT', opts);
// Real US dollars (wallet holdings): '$1,234.56'.
export const usd = n => n == null ? '-' : `${n < 0 ? '-' : ''}$${Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Wei (string) -> '0.01234 ETH'.
export function eth(wei, digits = 5) {
  if (wei == null || wei === '') return '-';
  let w; try { w = BigInt(wei); } catch { return '-'; }
  const neg = w < 0n; if (neg) w = -w;
  const whole = w / 10n ** 18n, frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, digits);
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}.${frac} ETH`;
}
// '0.005' ETH -> '5000000000000000' wei, exactly. null when not a number.
export function ethToWei(text) {
  const t = String(text).trim();
  if (!/^\d+(\.\d{0,18})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return (BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18) || '0')).toString();
}
export const weiToEthText = wei => { try { const w = BigInt(wei); const f = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return `${w / 10n ** 18n}${f ? '.' + f : ''}`; } catch { return ''; } };
// Etherscan links for the chain in use (1 mainnet, 11155111 Sepolia).
export const explorer = chainId => Number(chainId) === 11155111 ? 'https://sepolia.etherscan.io' : 'https://etherscan.io';
export const shortAddr = a => a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '-';
export const addrLink = (a, chainId, { full = false } = {}) => !a ? '-' : h('a', { href: `${explorer(chainId)}/address/${a}`, target: '_blank', rel: 'noopener noreferrer', class: 'mono small', tip: `${esc(a)}<br>Open on Etherscan` }, full ? a : shortAddr(a));
export const txLink = (tx, chainId) => !tx ? '' : h('a', { href: `${explorer(chainId)}/tx/${tx}`, target: '_blank', rel: 'noopener noreferrer', class: 'mono small', tip: `${esc(tx)}<br>Open on Etherscan` }, `${tx.slice(0, 10)}...`);
export const curSymbol = () => currency.symbol;
export const num = n => n == null ? '-' : Number(n).toLocaleString('en-US');
export const pct = n => n == null ? '-' : `${Number(n).toFixed(1)}%`;
export const short = id => String(id).slice(0, 8);
export function ago(sqlTime) {
  if (!sqlTime) return '-';
  const t = Date.parse(sqlTime.replace(' ', 'T') + 'Z'), s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${Math.max(1, s)}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
}
export const localTime = sqlTime => sqlTime ? new Date(sqlTime.replace(' ', 'T') + 'Z').toLocaleString() : '-';
export const flag = cc => !cc || cc.length !== 2 || cc === '??' ? '🌐' : String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0)));
const COUNTRY = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
export const countryName = cc => { try { return cc && cc !== '??' && COUNTRY ? COUNTRY.of(cc) : 'Unknown'; } catch { return cc; } };
export const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

// Count-up animation for headline numbers.
export function countTo(el, to, format) {
  const from = Number(el.dataset.v || 0), start = performance.now(), d = 800;
  el.dataset.v = to;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = format(to); return; }
  const step = now => {
    const t = Math.max(0, Math.min(1, (now - start) / d)), e = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (to - from) * e);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Tooltips: any element with data-tip (HTML allowed: our own glossary text only).
// Confirm dialog. `body` explains exactly what will happen. Optional typed confirmation.
export function confirmDialog({ title, body, confirmLabel = 'Yes, do it', danger = false, typed = null, fields = null }) {
  return new Promise(resolve => {
    const input = typed ? h('input', { class: 'input', placeholder: `Type ${typed}`, autocomplete: 'off' }) : null;
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, disabled: !!typed }, confirmLabel);
    if (input) input.addEventListener('input', () => { ok.disabled = input.value.trim() !== typed; });
    const close = v => { overlay.remove(); resolve(v); };
    const overlay = h('div', { class: 'modal-wrap', onclick: e => { if (e.target === overlay) close(false); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('h3', {}, title), typeof body === 'string' ? h('p', { class: 'muted' }, body) : body,
        fields || null,
        input ? h('label', { class: 'field' }, h('span', {}, `To confirm, type ${typed}`), input) : null,
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), ok)));
    ok.addEventListener('click', () => close(true));
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(false); });
    document.body.append(overlay);
    (input || ok).focus();
  });
}

// Theme: light, dark or auto (follows the device). Remembered on this device.
const mq = matchMedia('(prefers-color-scheme: light)');
export function applyTheme(mode = localStorage.getItem('noir-admin-theme') || 'auto') {
  localStorage.setItem('noir-admin-theme', mode);
  document.documentElement.dataset.theme = mode === 'auto' ? (mq.matches ? 'light' : 'dark') : mode;
  document.querySelectorAll('[data-th]').forEach(b => b.classList.toggle('on', b.dataset.th === mode));
}
mq.addEventListener('change', () => { if ((localStorage.getItem('noir-admin-theme') || 'auto') === 'auto') applyTheme('auto'); });

export function segmented(options, value, onChange, tip) {
  const wrap = h('div', { class: 'seg', role: 'tablist', ...(tip ? { tip } : {}) });
  for (const [v, label] of options) wrap.append(h('button', { class: v === value ? 'active' : '', role: 'tab', 'aria-selected': v === value ? 'true' : 'false',
    onclick: () => { wrap.querySelectorAll('button').forEach(b => b.classList.remove('active')); wrap.querySelector(`[data-v="${v}"]`).classList.add('active'); onChange(v); }, 'data-v': v }, label));
  return wrap;
}

export function pageHead(title, explain, ...right) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), h('p', { class: 'sub' }, explain)), h('div', { class: 'head-right' }, ...right));
}
export const card = (title, tipText, ...children) => h('section', { class: 'card' }, title ? h('h3', {}, title, tipText ? info(tipText) : null) : null, ...children);
export const empty = (title, text) => h('div', { class: 'empty' }, h('b', {}, title), h('p', {}, text));
export const loading = () => h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading');
export function errorBox(e, retry) {
  return h('div', { class: 'error-box' }, h('b', {}, 'That did not load.'), h('p', {}, e.message || String(e)), retry ? h('button', { class: 'btn', onclick: retry }, 'Try again') : null);
}

export function table(columns, rows, { onRow, emptyText = 'Nothing here yet.' } = {}) {
  if (!rows.length) return empty('Nothing to show', emptyText);
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, columns.map(c => h('th', { class: c.align === 'right' ? 'r' : '' }, c.label, c.tip ? info(c.tip) : null)))),
    h('tbody', {}, rows.map(r => h('tr', { class: onRow ? 'clickable' : '', onclick: onRow ? () => onRow(r) : null, tabindex: onRow ? 0 : null,
      onkeydown: onRow ? e => { if (e.key === 'Enter') onRow(r); } : null },
      columns.map(c => h('td', { class: c.align === 'right' ? 'r' : '' }, c.render ? c.render(r) : r[c.key])))))));
}

// Password + a fresh authenticator code, asked for changes to people and money settings.
export function stepUpFields(help = 'A new code each time. A code you already used (also the one you signed in with) is refused; wait for the next one.') {
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const code = h('input', { class: 'input code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '6-digit code' });
  return { fields: h('div', { class: 'stack' }, field('Your password', password), field('Code from your authenticator app', code, help)),
    read: () => ({ password: password.value, code: code.value.replace(/\s/g, '') }) };
}
export async function confirmStepUp({ title, body, confirmLabel = 'Confirm', danger = false, extra = null }) {
  const s = stepUpFields();
  if (!await confirmDialog({ title, body, confirmLabel, danger, fields: h('div', { class: 'stack' }, extra, s.fields) })) return null;
  return s.read();
}

export const centsInput = (cents, attrs = {}) => h('input', { class: 'input', type: 'number', min: '0', step: '0.01', value: cents == null ? '' : (cents / 100).toFixed(2), ...attrs });
export const readCents = input => Math.round(Number(input.value) * 100);
// TICS amount inputs (stored as 0.01 TICS units).
export const unitsInput = centsInput;
export const readUnits = readCents;

// Fill empty hours/days so charts show the whole period, not just busy moments.
// series items have t = 'YYYY-MM-DD HH:00' (hour) or 'YYYY-MM-DD' (day).
export function fillSeries(series, bucket, days, make) {
  const have = new Map(series.map(x => [x.t, x]));
  const out = [], now = new Date();
  if (bucket === 'hour') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    for (let h = 0; h <= now.getUTCHours(); h++) { const t = `${start.toISOString().slice(0, 10)} ${String(h).padStart(2, '0')}:00`; out.push(have.get(t) || make(t)); }
  } else {
    for (let d = days - 1; d >= 0; d--) { const t = new Date(now - d * 864e5).toISOString().slice(0, 10); out.push(have.get(t) || make(t)); }
  }
  return out;
}

// Casino wallet snapshot (chain_state 'float'), shared by Overview and Bank.
// Plain words for the unresolved-deposits line, shared by the reserve card and the Treasury page.
export const UNRESOLVED_TIP = '<b>Unresolved deposits</b>Money that reached the casino wallet from senders we could not match to a player yet. It is owed to someone until you assign it or mark it as your own funding.';
export const PROTECTED_TIP = '<b>Protected balance</b>The part of the wallet balance the deposit scan has already classified as the casino\'s own. Tokens that arrived but are not matched to a player yet are customer money and are left out.';
export function floatCard(f, ctx) {
  if (!f) return null;
  const age = f.ageSeconds == null ? '' : f.ageSeconds < 90 ? `${f.ageSeconds}s ago` : f.ageSeconds < 5400 ? `${Math.round(f.ageSeconds / 60)}m ago` : `${Math.round(f.ageSeconds / 3600)}h ago`;
  const row = (k, v, cls = '', tip = null) => h('div', { class: 'gm' }, h('span', {}, k, tip ? info(tip) : null), h('b', { class: cls }, v), h('span', { class: 'muted' }, ''));
  const freeSend = f.freeToSendUnits ?? f.freeUnits;
  return card('Casino wallet float', '<b>Float</b>The TICS in the casino wallet, what is owed to players, and the free part that can go to the treasury. Cached by the game every minute.',
    row('TICS in wallet', money(f.tokenUnits), 'gold'),
    f.protectedUnits != null ? row('Protected balance', f.safeUnknown ? 'Not classified yet' : money(f.protectedUnits), f.safeUnknown ? 'down' : '', PROTECTED_TIP) : null,
    row('Owed to players', money(f.owedUnits)),
    f.unresolvedUnits != null ? row('Unresolved deposits', money(f.unresolvedUnits), f.unresolvedUnits > 0 ? 'down' : '', UNRESOLVED_TIP) : null,
    row('Free to send', freeSend == null ? '-' : money(freeSend), freeSend < 0 ? 'down' : 'up', '<b>Free to send</b>Protected balance minus what is owed (unresolved deposits included) and spins in play. Only this part can go to the treasury.'),
    row('Covers every player balance', f.tokenUnits == null || f.owedUnits == null ? '-' : f.tokenUnits >= f.owedUnits ? 'Yes' : 'No', f.tokenUnits >= f.owedUnits ? 'up' : 'down'),
    f.maxWinUnits != null ? row('Max win per spin now', money(f.maxWinUnits), 'gold') : null,
    f.maxWinUnits != null ? row('Max bet on one number', money(Math.floor(f.maxWinUnits / 36))) : null,
    row('ETH for gas', eth(f.ethWei, 4)),
    h('p', { class: 'muted small' }, `Snapshot ${age}${f.ageSeconds > 600 ? ' (old: check the game cron)' : ''}.`, ctx?.can('treasury:manage') ? h('span', {}, ' ', h('a', { href: '#/treasury' }, 'Open Treasury')) : null));
}

// TICS withdrawal statuses (chain_withdrawals), shared by Payments and the player page.
// 'Failed, money returned' is only ever 'failed'; 'blocked' and 'cancelling' still hold the player's money (counted as owed).
export const WD_STATUS = { holding: ['warn', 'Starting'], queued: ['warn', 'Waiting'], signing: ['warn', 'Signing'], sending: ['warn', 'Sending'], sent: ['on', 'Sent'],
  blocked: ['off', 'Stopped, needs review', 'Stopped before payment. The money is still held for the player (counted as owed). Contact the player and check the alert before doing anything else.'],
  cancelling: ['warn', 'Cancelling', 'Cancel in progress: the refund to the player is not confirmed yet, so the money is still counted as owed.'],
  failed: ['off', 'Failed, money returned'], cancelled: ['off', 'Cancelled, money returned'] };
export const wdPill = s => { const [c, t, tip] = WD_STATUS[s] || ['off', s]; return h('span', { class: `pill ${c}`, ...(tip ? { tipText: tip } : {}) }, t); };
