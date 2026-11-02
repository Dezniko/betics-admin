// Hand-built SVG charts with hover read-outs. Colours come from CSS variables.
import { h } from './lib.js';

const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

// Line/area chart. points: [{label, value}], format(value) for read-out.
export function lineChart(points, { height = 210, format = String, color = 'var(--gold)', readout, zero = true, label = 'Value' } = {}) {
  const W = 640, H = height - 20;
  const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, width: '100%', height, class: 'chart', role: 'img', 'aria-label': label });
  if (!points.length) { const t = s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }); t.textContent = 'No data for this period yet'; svg.append(t); return svg; }
  const vals = points.map(p => p.value), max = Math.max(...vals, zero ? 0 : -Infinity), min = Math.min(...vals, zero ? 0 : Infinity);
  const span = max - min || 1, x = i => points.length === 1 ? W / 2 : 30 + i * (W - 40) / (points.length - 1), y = v => 10 + (max - v) / span * (H - 20);
  const pts = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  const id = 'g' + Math.random().toString(36).slice(2);
  const defs = s('defs'); const grad = s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(s('stop', { offset: 0, 'stop-color': color, 'stop-opacity': '.32' }), s('stop', { offset: 1, 'stop-color': color, 'stop-opacity': '0' }));
  defs.append(grad); svg.append(defs);
  if (min < 0 && max > 0 || zero) { svg.append(s('line', { x1: 30, x2: W - 10, y1: y(0), y2: y(0), class: 'chart-zero' })); const t = s('text', { x: 2, y: y(0) + 3, class: 'chart-axis' }); t.textContent = '0'; svg.append(t); }
  svg.append(s('polygon', { points: `${x(0)},${y(Math.max(min, 0))} ${pts} ${x(points.length - 1)},${y(Math.max(min, 0))}`, fill: `url(#${id})` }));
  svg.append(s('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', class: 'chart-line' }));
  const first = s('text', { x: 30, y: height - 2, class: 'chart-axis' }); first.textContent = points[0].label;
  const last = s('text', { x: W - 10, y: height - 2, 'text-anchor': 'end', class: 'chart-axis' }); last.textContent = points.at(-1).label;
  svg.append(first, last);
  const cursor = s('line', { y1: 6, y2: H, class: 'chart-cursor', visibility: 'hidden' });
  svg.append(cursor);
  points.forEach((p, i) => {
    svg.append(s('circle', { cx: x(i), cy: y(p.value), r: points.length > 40 ? 1.5 : 3, fill: p.value < 0 ? 'var(--red)' : color }));
    const hit = s('rect', { x: x(i) - (W / points.length) / 2, y: 0, width: Math.max(4, W / points.length), height: H, fill: 'transparent' });
    hit.addEventListener('mouseenter', () => { cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i)); cursor.setAttribute('visibility', 'visible'); if (readout) readout.textContent = `${p.label}: ${format(p.value)}`; });
    svg.append(hit);
  });
  svg.addEventListener('mouseleave', () => { cursor.setAttribute('visibility', 'hidden'); if (readout) readout.textContent = 'Hover the chart for exact values'; });
  return svg;
}

// Vertical bars, negative values below the line in red.
export function barChart(points, { height = 190, format = String, readout, label = 'Bars' } = {}) {
  const wrap = h('div', { class: 'bars', role: 'img', 'aria-label': label, style: { height: height + 'px' } });
  if (!points.length) return h('div', { class: 'chart-empty-box' }, 'No data for this period yet');
  const max = Math.max(1, ...points.map(p => Math.abs(p.value)));
  points.forEach((p, i) => {
    const bar = h('div', { class: `bar ${p.value < 0 ? 'neg' : ''}`, style: { height: Math.max(3, Math.abs(p.value) / max * 100) + '%', animationDelay: `${i * 15}ms` } });
    bar.addEventListener('mouseenter', () => { if (readout) readout.textContent = `${p.label}: ${format(p.value)}`; });
    wrap.append(bar);
  });
  return wrap;
}

// Horizontal share bars: [{label, value, sub}]
export function shareBars(items, { format = String, colors = ['var(--blue)', 'var(--green)', 'var(--gold)', 'var(--purple)', 'var(--red)'] } = {}) {
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  return h('div', { class: 'shares' }, items.map((it, i) => h('div', { class: 'share' },
    h('div', { class: 'share-top' }, h('span', {}, it.label), h('b', {}, format(it.value)), h('span', { class: 'muted' }, `${Math.round(it.value / total * 100)}%`)),
    h('div', { class: 'meter' }, h('i', { style: { width: `${it.value / total * 100}%`, background: colors[i % colors.length] } })))));
}

export function donut(items, { size = 120 } = {}) {
  const colors = ['var(--gold)', 'var(--blue)', 'var(--green)', 'var(--purple)', 'var(--red)'];
  const total = items.reduce((a, b) => a + Math.max(0, b.value), 0);
  const svg = s('svg', { width: size, height: size, viewBox: '0 0 42 42', role: 'img', 'aria-label': 'Share by game' });
  svg.append(s('circle', { r: 15.9, cx: 21, cy: 21, fill: 'none', stroke: 'var(--raise)', 'stroke-width': 6 }));
  let offset = 25;
  items.forEach((it, i) => {
    const share = total ? Math.max(0, it.value) / total * 100 : 0;
    if (share > 0) svg.append(s('circle', { r: 15.9, cx: 21, cy: 21, fill: 'none', stroke: colors[i % colors.length], 'stroke-width': 6, 'stroke-dasharray': `${share} ${100 - share}`, 'stroke-dashoffset': offset }));
    offset -= share;
  });
  return h('div', { class: 'donut' }, svg, h('div', { class: 'legend' }, items.map((it, i) => h('div', {}, h('i', { style: { background: colors[i % colors.length] } }), it.label, h('b', {}, total ? `${Math.round(Math.max(0, it.value) / total * 100)}%` : '-')))));
}

// Day x hour heatmap: cells [{d: 0-6 (Sun=0), h: 0-23, value}]
export function heatmap(cells, { format = String, readout } = {}) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], order = [1, 2, 3, 4, 5, 6, 0];
  const max = Math.max(1, ...cells.map(c => c.value));
  const map = new Map(cells.map(c => [`${c.d}:${c.h}`, c.value]));
  const grid = h('div', { class: 'heat' });
  grid.append(h('span', {}), ...Array.from({ length: 24 }, (_, hr) => h('em', {}, hr % 6 === 0 ? String(hr).padStart(2, '0') : '')));
  order.forEach((d, row) => {
    grid.append(h('em', {}, days[row]));
    for (let hr = 0; hr < 24; hr++) {
      const v = map.get(`${d}:${hr}`) || 0;
      const cell = h('span', { class: 'cell', style: { opacity: (0.08 + v / max * 0.92).toFixed(2) } });
      cell.addEventListener('mouseenter', () => { if (readout) readout.textContent = `${days[row]} ${String(hr).padStart(2, '0')}:00 UTC: ${format(v)}`; });
      grid.append(cell);
    }
  });
  return grid;
}
