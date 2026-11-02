// Draws a round's bets on a small roulette felt (same layout as the game:
// 0 on the left, 3 rows of 12, columns, dozens and even-money boxes).
import { h, money } from '../lib.js';

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const W = 46, H = 46, X0 = 46, ROWS_H = H * 3, DOZ_H = 38, EVEN_H = 38;
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text != null) el.textContent = text; return el; };

const cell = n => { const col = Math.ceil(n / 3) - 1, row = n % 3 === 0 ? 0 : n % 3 === 2 ? 1 : 2; return { x: X0 + col * W + W / 2, y: row * H + H / 2 }; };
const OUTSIDE = {
  dozen1: { x: X0 + W * 2, y: ROWS_H + DOZ_H / 2, covers: n => n >= 1 && n <= 12, label: '1st 12' },
  dozen2: { x: X0 + W * 6, y: ROWS_H + DOZ_H / 2, covers: n => n >= 13 && n <= 24, label: '2nd 12' },
  dozen3: { x: X0 + W * 10, y: ROWS_H + DOZ_H / 2, covers: n => n >= 25 && n <= 36, label: '3rd 12' },
  low: { x: X0 + W, y: ROWS_H + DOZ_H + EVEN_H / 2, covers: n => n >= 1 && n <= 18, label: '1 to 18' },
  even: { x: X0 + W * 3, y: ROWS_H + DOZ_H + EVEN_H / 2, covers: n => n > 0 && n % 2 === 0, label: 'EVEN' },
  red: { x: X0 + W * 5, y: ROWS_H + DOZ_H + EVEN_H / 2, covers: n => RED.has(n), label: 'RED' },
  black: { x: X0 + W * 7, y: ROWS_H + DOZ_H + EVEN_H / 2, covers: n => n > 0 && !RED.has(n), label: 'BLACK' },
  odd: { x: X0 + W * 9, y: ROWS_H + DOZ_H + EVEN_H / 2, covers: n => n % 2 === 1, label: 'ODD' },
  high: { x: X0 + W * 11, y: ROWS_H + DOZ_H + EVEN_H / 2, covers: n => n >= 19 && n <= 36, label: '19 to 36' },
  column3: { x: X0 + W * 12 + W / 2, y: H / 2, covers: n => n > 0 && n % 3 === 0, label: '2 to 1' },
  column2: { x: X0 + W * 12 + W / 2, y: H * 1.5, covers: n => n > 0 && n % 3 === 2, label: '2 to 1' },
  column1: { x: X0 + W * 12 + W / 2, y: H * 2.5, covers: n => n > 0 && n % 3 === 1, label: '2 to 1' },
};

export function covered(bet) {
  if (OUTSIDE[bet.type]) return Array.from({ length: 37 }, (_, n) => n).filter(OUTSIDE[bet.type].covers);
  return bet.type === 'straight' ? [bet.value] : [...bet.value];
}

// Where the chip sits, matching how it is placed on the game's felt.
function anchor(bet) {
  const o = OUTSIDE[bet.type];
  // Outside boxes: chip sits to the right so the box label stays readable.
  if (o) return bet.type.startsWith('column') ? o : { x: o.x + (bet.type.startsWith('dozen') ? W * 1.45 : W * 0.62), y: o.y };
  const nums = covered(bet).sort((a, b) => a - b);
  if (nums.includes(0)) {
    if (nums.length === 1) return { x: X0 / 2, y: ROWS_H / 2 };
    const others = nums.filter(n => n > 0).map(cell);
    return { x: X0, y: others.reduce((t, c) => t + c.y, 0) / others.length };
  }
  const cs = nums.map(cell), x = cs.reduce((t, c) => t + c.x, 0) / cs.length, y = cs.reduce((t, c) => t + c.y, 0) / cs.length;
  if (bet.type === 'street' || bet.type === 'sixline') return { x, y: ROWS_H };
  return { x, y };
}

const shortMoney = c => c >= 100000 ? `$${Math.round(c / 100000)}k` : c >= 1000 ? `$${Math.round(c / 100)}` : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

export function feltView(bets, pocket) {
  const width = X0 + W * 13, height = ROWS_H + DOZ_H + EVEN_H;
  const svg = s('svg', { viewBox: `-2 -2 ${width + 4} ${height + 4}`, width: '100%', class: 'felt', role: 'img', 'aria-label': `Bets on the table. Winning number ${pocket}.` });
  svg.append(s('rect', { x: -2, y: -2, width: width + 4, height: height + 4, rx: 10, class: 'felt-bg' }));
  // Zero
  const zero = s('path', { d: `M${X0},0 L${X0},${ROWS_H} L${X0 * 0.45},${ROWS_H} L0,${ROWS_H / 2} L${X0 * 0.45},0 Z`, class: `felt-num green ${pocket === 0 ? 'win' : ''}` });
  svg.append(zero, s('text', { x: X0 * 0.55, y: ROWS_H / 2 + 5, class: 'felt-label' }, '0'));
  for (let n = 1; n <= 36; n++) {
    const c = cell(n);
    svg.append(s('rect', { x: c.x - W / 2, y: c.y - H / 2, width: W, height: H, class: `felt-num ${RED.has(n) ? 'red' : 'black'} ${pocket === n ? 'win' : ''}` }));
    svg.append(s('text', { x: c.x, y: c.y + 5, class: 'felt-label' }, n));
  }
  for (const [type, o] of Object.entries(OUTSIDE)) {
    const isCol = type.startsWith('column'), isDoz = type.startsWith('dozen');
    const w = isCol ? W : isDoz ? W * 4 : W * 2, hh = isCol ? H : isDoz ? DOZ_H : EVEN_H;
    const winBox = pocket != null && o.covers(pocket);
    svg.append(s('rect', { x: o.x - w / 2, y: o.y - hh / 2, width: w, height: hh, class: `felt-box ${type === 'red' ? 'redbox' : type === 'black' ? 'blackbox' : ''} ${winBox ? 'covered' : ''}` }));
    svg.append(s('text', { x: o.x, y: o.y + 4, class: 'felt-small' }, o.label));
  }
  // Dolly on the winning number.
  if (pocket != null) {
    const c = pocket === 0 ? { x: X0 * 0.55, y: ROWS_H / 2 } : cell(pocket);
    svg.append(s('circle', { cx: c.x, cy: c.y - 15, r: 5, class: 'felt-dolly' }));
  }
  // Chips: winners glow, losers dim.
  bets.forEach((b, i) => {
    const a = anchor(b), won = pocket != null && covered(b).includes(pocket);
    const g = s('g', { class: `felt-chip ${won ? 'won' : 'lost'}`, tabindex: 0 });
    g.append(s('title', {}, `${b.type}${b.value != null ? ' ' + [].concat(b.value).join(', ') : ''}: ${money(b.amountCents)}${won ? ' (won)' : ''}`));
    g.append(s('circle', { cx: a.x, cy: a.y, r: 14 }), s('circle', { cx: a.x, cy: a.y, r: 10, class: 'inner' }), s('text', { x: a.x, y: a.y + 3.5 }, shortMoney(b.amountCents)));
    g.style.animationDelay = `${i * 40}ms`;
    svg.append(g);
  });
  return h('div', { class: 'felt-wrap' }, svg,
    h('div', { class: 'felt-legend' }, h('span', {}, h('i', { class: 'lg won' }), 'Winning bet'), h('span', {}, h('i', { class: 'lg lost' }), 'Losing bet'), h('span', {}, h('i', { class: 'lg dolly' }), `Winning number ${pocket}`)));
}
