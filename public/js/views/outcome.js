// How a round's result is shown, whatever the game: a roulette pocket, a compact slot summary, or
// (for a game this panel does not know yet) the raw outcome. Shared by the rounds tables, the live
// feed and the round page, so a new game never crashes a list.
import { h, money, cap, table, segmented } from '../lib.js';
import { gridFor, isSlotOutcome, winningCells, symbolName, slotSummary, slotSummaryText, LINES } from '../slotMath.js';

// Game names: every rounds response carries the games list (id, name, kind); remember it for labels.
const names = new Map([['roulette', 'Roulette'], ['godsofpower', 'Gods of Power']]);
export const rememberGames = list => { for (const g of list || []) if (g?.id && g?.name) names.set(g.id, g.name); };
export const gameName = id => names.get(id) || cap(id || '-');

const isRoulette = o => !!o && o.pocket != null;
export const pocket = o => h('span', { class: `pocket ${o?.color || ''}` }, o?.pocket ?? '-');
const rawShort = o => { const t = o == null ? '-' : typeof o === 'string' ? o : JSON.stringify(o); return h('span', { class: 'mono small muted', title: t }, t.length > 40 ? t.slice(0, 40) + '…' : t); };

// One table cell: pocket, 'N spins (M free), capped', or raw JSON.
export function resultCell(r) {
  const o = r.outcome;
  if (isRoulette(o)) return pocket(o);
  if (isSlotOutcome(o)) {
    const s = slotSummary(o, { stakeCents: r.stake_cents, payoutCents: r.payout_cents });
    return h('span', { class: 'slot-sum', title: slotSummaryText(o, c => money(c), { stakeCents: r.stake_cents, payoutCents: r.payout_cents }) },
      `${s.spins} spin${s.spins === 1 ? '' : 's'}${s.free ? ` (${s.free} free)` : ''}`,
      s.multiple != null && s.multiple >= 1 ? h('span', { class: 'muted' }, ` · ${s.multiple}x`) : null,
      s.capped ? h('span', { class: 'pill warn' }, 'capped') : null);
  }
  return rawShort(o);
}
// The headline figure on the round page.
export function resultBig(r) {
  const o = r.outcome;
  if (isRoulette(o)) return pocket(o);
  if (isSlotOutcome(o)) { const s = slotSummary(o, { stakeCents: r.stake_cents, payoutCents: r.payout_cents }); return h('span', {}, s.multiple != null ? `${s.multiple}x` : '-', s.capped ? h('span', { class: 'pill warn' }, ' capped') : null); }
  return h('span', { class: 'muted' }, 'See outcome');
}
export const roundKind = r => isRoulette(r.outcome) ? 'roulette' : isSlotOutcome(r.outcome) ? 'slot' : 'other';

// One spin: the 5x3 grid with the winning cells lit, then its line wins.
function spinCard(spin, i, lineBetCents, stakeCents) {
  const grid = gridFor(spin?.stops);
  const lit = winningCells(spin);
  const wins = (spin?.lineWins || []).map(w => ({ ...w, cents: lineBetCents != null ? w.pay * lineBetCents * (spin.multiplier || 1) : null }));
  const scatterCents = spin?.scatterPay && stakeCents != null ? spin.scatterPay * stakeCents * (spin.multiplier || 1) : null;
  const head = h('div', { class: 'spin-head' }, h('b', {}, spin?.free ? `Free spin ${i}` : 'Base spin'),
    spin?.multiplier > 1 ? h('span', { class: 'pill on' }, `x${spin.multiplier}`) : null,
    h('span', { class: 'r' }, spin?.winUnits ? h('b', { class: 'gold' }, money(spin.winUnits)) : h('span', { class: 'muted' }, 'No win')));
  const gridEl = grid ? h('div', { class: 'slot-grid', role: 'img', 'aria-label': `Reels: ${grid.map(row => row.map(symbolName).join(', ')).join(' / ')}` },
    grid.map((row, r) => row.map((code, reel) => h('span', { class: `sym s-${code} ${lit.has(`${r},${reel}`) ? 'lit' : ''}`, title: symbolName(code) }, h('b', {}, code), h('small', {}, symbolName(code))))))
    : h('p', { class: 'muted small' }, `Stops: ${JSON.stringify(spin?.stops)}`);
  const detail = h('div', { class: 'spin-detail' },
    wins.length || scatterCents ? table([
      { label: 'Win', render: w => w.kind === 'scatter' ? `${w.count} vault doors anywhere` : `Line ${w.line + 1}: ${w.count} × ${symbolName(w.symbol)}` },
      { label: 'Pays', align: 'right', render: w => w.kind === 'scatter' ? `${w.pay} × bet` : `${w.pay} × line bet` },
      { label: 'Won', align: 'right', render: w => w.cents == null ? '-' : money(w.cents) }],
      [...wins, ...(spin?.scatterCount >= 3 ? [{ kind: 'scatter', count: spin.scatterCount, pay: spin.scatterPay, cents: scatterCents }] : [])]) : null,
    spin?.freeSpinsAdded ? h('p', { class: 'small' }, `${spin.freeSpinsAdded} free spins awarded by this spin.`) : null,
    h('p', { class: 'muted small mono' }, `stops ${JSON.stringify(spin?.stops)}`));
  return h('div', { class: 'spin' }, head, gridEl, detail);
}

// The slot view of a round: a summary line, then every spin.
export function slotRoundView(r) {
  const o = r.outcome || {};
  const spins = Array.isArray(o.spins) ? o.spins : [];
  // Slot bets are { stake, lines }; an array (a roulette-shaped row) or nothing falls back to every line.
  const lines = (r.bets && !Array.isArray(r.bets) && Number(r.bets.lines) > 0) ? Number(r.bets.lines) : LINES.length;
  const lineBetCents = r.stake_cents && lines ? r.stake_cents / lines : null;
  const s = slotSummary(o, { stakeCents: r.stake_cents, payoutCents: r.payout_cents });
  const sum = h('div', { class: 'slot-summary' },
    h('span', {}, h('small', {}, 'Bet'), h('b', {}, money(r.stake_cents)), h('small', { class: 'muted' }, ` on ${lines} lines, ${lineBetCents == null ? '-' : money(lineBetCents)} a line`)),
    h('span', {}, h('small', {}, 'Paid'), h('b', { class: r.payout_cents > r.stake_cents ? 'gold' : '' }, money(r.payout_cents)), h('small', { class: 'muted' }, s.multiple != null ? ` ${s.multiple}x the bet` : '')),
    h('span', {}, h('small', {}, 'Free spins'), h('b', {}, `${s.free} played`), h('small', { class: 'muted' }, ` of ${s.awarded} awarded`)),
    h('span', {}, h('small', {}, 'Win cap'), s.capped ? h('b', { class: 'down' }, 'Reached') : h('b', {}, 'Not reached'), h('small', { class: 'muted' }, ' 2,000 × bet')));
  const body = h('div', {});
  const list = () => table([
    { label: 'Spin', render: (x) => x.spin.free ? `Free ${x.i}` : 'Base' }, { label: 'Line wins', align: 'right', render: x => String((x.spin.lineWins || []).length) },
    { label: 'Scatters', align: 'right', render: x => String(x.spin.scatterCount || 0) }, { label: 'Multiplier', align: 'right', render: x => `x${x.spin.multiplier || 1}` },
    { label: 'Free spins added', align: 'right', render: x => String(x.spin.freeSpinsAdded || 0) }, { label: 'Won', align: 'right', render: x => x.spin.winUnits ? money(x.spin.winUnits) : '-' }],
    spins.map((spin, k) => ({ spin, i: k })), { emptyText: 'No spins recorded.' });
  const reels = () => h('div', { class: 'spins' }, spins.length ? spins.map((spin, k) => spinCard(spin, k, lineBetCents, r.stake_cents)) : h('p', { class: 'muted' }, 'No spins recorded.'));
  const mode = localStorage.getItem('noir-admin-slotview') || 'reels';
  const show = v => { localStorage.setItem('noir-admin-slotview', v); body.replaceChildren(v === 'list' ? list() : reels()); };
  show(mode);
  return h('section', { class: 'card' }, h('h3', {}, 'Spins', h('span', { class: 'r' }, segmented([['reels', 'Reels'], ['list', 'List']], mode, show))), sum, body);
}

// Unknown game: show what was stored so nothing is hidden.
export const rawOutcomeView = r => h('section', { class: 'card' }, h('h3', {}, 'Outcome'),
  h('p', { class: 'muted small' }, 'This panel has no special view for this game yet, so here is the stored result.'),
  h('pre', { class: 'mono small raw-json' }, JSON.stringify({ outcome: r.outcome, bets: r.bets }, null, 2)));
