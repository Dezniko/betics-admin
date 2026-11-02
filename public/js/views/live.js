// A rounds feed that refreshes itself every 5 seconds (can be paused) and
// has a Refresh button, without reloading the rest of the page.
import { h, api, money, info, ago, short, flag, cap, empty } from '../lib.js';

export function liveRounds(ctx, { title = 'Live rounds', tip, game = null, limit = 15 } = {}) {
  const list = h('div', { class: 'feed' });
  const stamp = h('span', { class: 'muted small' }, '');
  const refreshBtn = h('button', { class: 'btn small', 'aria-label': 'Refresh rounds', tip: '<b>Refresh</b>Load the newest rounds now. Only this list reloads.', onclick: () => load(true) }, '↻ Refresh');
  let auto = localStorage.getItem('noir-admin-autorefresh') !== 'off';
  const autoBtn = h('button', { class: `btn small ${auto ? 'on' : ''}`, 'aria-pressed': String(auto), tip: '<b>Auto refresh</b>When on, this list checks for new rounds every 5 seconds. Your choice is remembered.',
    onclick: () => { auto = !auto; localStorage.setItem('noir-admin-autorefresh', auto ? 'on' : 'off'); autoBtn.classList.toggle('on', auto); autoBtn.setAttribute('aria-pressed', String(auto)); autoBtn.textContent = auto ? 'Auto 5s: on' : 'Auto 5s: off'; } },
    auto ? 'Auto 5s: on' : 'Auto 5s: off');
  let known = new Set(), first = true, lastAt = 0, busy = false;
  async function load(manual = false) {
    if (busy) return; busy = true;
    if (manual) refreshBtn.disabled = true;
    try {
      const p = new URLSearchParams({ limit: String(limit) }); if (game) p.set('game', game);
      const { rounds } = await api(`/rounds?${p}`);
      if (!rounds.length) { list.replaceChildren(empty('No rounds yet', 'Rounds appear here the moment they settle.')); }
      else list.replaceChildren(h('div', { class: 'row head' }, h('span', {}, 'Player'), h('span', {}, game ? 'Result' : 'Game'), h('span', { class: 'r' }, 'Bet'), h('span', { class: 'r' }, 'Paid'), h('span', { class: 'r' }, 'House')),
        ...rounds.map(r => {
          const house = r.stake_cents - r.payout_cents;
          return h('a', { class: `row ${!first && !known.has(r.id) ? 'fresh' : ''}`, href: `#/rounds/${encodeURIComponent(r.id)}`, tip: 'Open this round to see the bets on the table and the fairness proof.' },
            h('span', { class: 'mono' }, short(r.player_id)),
            h('span', {}, game ? h('span', { class: `pocket ${r.outcome.color}` }, r.outcome.pocket) : cap(r.game_id),
              h('span', { class: 'meta' }, `${ago(r.created_at)} · ${flag(r.country)} ${r.device || ''}`)),
            h('span', { class: 'r' }, money(r.stake_cents)), h('span', { class: 'r' }, r.payout_cents ? money(r.payout_cents) : '-'),
            h('span', { class: `r ${house >= 0 ? 'up' : 'down'}` }, money(house, { sign: true })));
        }));
      known = new Set(rounds.map(r => r.id)); first = false; lastAt = Date.now(); tick();
    } catch (e) { stamp.textContent = 'Could not refresh. Retrying.'; }
    finally { busy = false; refreshBtn.disabled = false; }
  }
  const tick = () => { if (lastAt) stamp.textContent = `Updated ${Math.max(0, Math.round((Date.now() - lastAt) / 1000))}s ago`; };
  const timer = setInterval(() => { tick(); if (auto && document.visibilityState === 'visible' && Date.now() - lastAt >= 5000) load(); }, 1000);
  // A background tab pauses; coming back to it refreshes straight away.
  const onVisible = () => { if (document.visibilityState === 'visible' && auto) load(); };
  document.addEventListener('visibilitychange', onVisible);
  ctx.onLeave(() => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); });
  load();
  return h('section', { class: 'card' }, h('h3', {}, title, tip ? info(tip) : null, h('span', { class: 'r feed-tools' }, h('span', { class: 'live-dot' }), stamp, autoBtn, refreshBtn)), list);
}
