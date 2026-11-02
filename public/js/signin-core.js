// The small part of the admin UI that loads before sign-in: element builder, API calls, toasts,
// tooltips and form fields. Everything else is only sent by the server to a signed-in admin.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v; // only ever used with our own static strings / SVG
    else if (k === 'tip') el.dataset.tip = v; // HTML: our own static glossary text only
    else if (k === 'tipText') el.dataset.tip = esc(v); // any data (addresses, ids, errors): always escaped
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export class ApiError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
// Which money the panel shows: 'real' (real TICS) or 'demo' (play money). Set by the
// switch in the top bar, remembered on this device, sent with every API call.
const VIEW_KEY = 'betics-admin-view';
export const getView = () => (localStorage.getItem(VIEW_KEY) === 'demo' ? 'demo' : 'real');
export const setView = v => localStorage.setItem(VIEW_KEY, v === 'demo' ? 'demo' : 'real');
export const isReal = () => getView() === 'real';
export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-View-Mode': getView(), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && data?.code === 'signed_out') { window.dispatchEvent(new CustomEvent('signed-out')); }
  if (!res.ok) throw new ApiError(res.status, data?.error || 'Something went wrong.', data?.code);
  return data;
}

export const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let tipsOn = false;
export function installTooltips() {
  if (tipsOn) return; tipsOn = true;
  const tip = h('div', { class: 'tip', role: 'tooltip' });
  document.body.append(tip);
  let current = null;
  const show = t => {
    current = t; tip.innerHTML = t.dataset.tip; tip.classList.add('on');
    const r = t.getBoundingClientRect(), w = tip.offsetWidth, th = tip.offsetHeight;
    const below = r.bottom + 8 + th < innerHeight;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    tip.style.top = (below ? r.bottom + 8 : r.top - th - 8) + 'px';
  };
  document.addEventListener('mouseover', e => { const t = e.target.closest('[data-tip]'); if (t && t !== current) show(t); else if (!t) { current = null; tip.classList.remove('on'); } });
  document.addEventListener('focusin', e => { const t = e.target.closest('[data-tip]'); if (t) show(t); });
  document.addEventListener('focusout', () => { current = null; tip.classList.remove('on'); });
  // Touch: tap an (i) to toggle.
  document.addEventListener('click', e => { const t = e.target.closest('.i[data-tip]'); if (t) { e.preventDefault(); current === t && tip.classList.contains('on') ? tip.classList.remove('on') : show(t); } });
  addEventListener('scroll', () => tip.classList.remove('on'), true);
}

export const info = text => h('span', { class: 'i', tabindex: 0, 'aria-label': 'What is this?', tip: text }, 'i');

export function toast(message, kind = 'ok') {
  let box = $('.toasts');
  if (!box) { box = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, message);
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}

export function field(label, input, help) {
  return h('label', { class: 'field' }, h('span', {}, label, help ? info(help) : null), input);
}
