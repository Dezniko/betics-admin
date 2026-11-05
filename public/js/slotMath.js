// Gods of Power slot: the published reel strips, lines and symbol names, plus the pure helpers the
// admin uses to show a stored round (stops -> 5x3 grid, winning cells, one-line summary).
//
// MIRRORS the game repo's backend/src/games/slotsMath.js (SYMBOLS, LINES, STRIPS, rows 3, stops 32) and
// its gridFor(). It MUST be kept in sync by hand: test/slots.test.mjs compares this file with the game
// repo's copy when that repo is checked out next to this one. No DOM here, so node can test it.

export const SLOT_GAME_ID = 'godsofpower';
export const ROWS = 3, REELS = 5, STOPS = 32, LINE_COUNT = 20;

export const SYMBOLS = Object.freeze([
  { code: 'W', name: 'Gods of Power', role: 'wild' },
  { code: 'S', name: 'Vault door', role: 'scatter' },
  { code: 'D', name: 'Qubetics' },
  { code: 'B', name: 'Gold bar' },
  { code: 'R', name: 'Ruby' },
  { code: 'C', name: 'Treasure chest' },
  { code: 'A', name: 'Bitcoin' },
  { code: 'K', name: 'Ethereum' },
  { code: 'Q', name: 'Solana' },
  { code: 'J', name: 'Tether' },
]);

export const LINES = Object.freeze([
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 1, 1, 1, 0],
  [2, 1, 1, 1, 2], [1, 0, 1, 2, 1], [1, 2, 1, 0, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
  [1, 1, 0, 1, 1], [1, 1, 2, 1, 1], [0, 0, 2, 0, 0], [2, 2, 0, 2, 2], [0, 2, 2, 2, 0],
].map(l => Object.freeze(l)));

export const STRIPS = Object.freeze([
  Object.freeze(['A', 'K', 'K', 'C', 'R', 'B', 'Q', 'J', 'D', 'A', 'C', 'A', 'R', 'J', 'K', 'K', 'S', 'B', 'Q', 'C', 'R', 'J', 'C', 'A', 'D', 'A', 'K', 'B', 'Q', 'R', 'J', 'C']),
  Object.freeze(['K', 'Q', 'J', 'J', 'C', 'W', 'B', 'R', 'D', 'A', 'K', 'Q', 'C', 'A', 'K', 'Q', 'S', 'W', 'B', 'R', 'C', 'A', 'K', 'Q', 'D', 'J', 'J', 'W', 'B', 'R', 'C', 'A']),
  Object.freeze(['J', 'K', 'K', 'K', 'C', 'W', 'R', 'A', 'D', 'B', 'Q', 'J', 'C', 'A', 'Q', 'J', 'S', 'W', 'R', 'K', 'C', 'A', 'Q', 'J', 'D', 'B', 'K', 'W', 'R', 'C', 'A', 'Q']),
  Object.freeze(['J', 'K', 'K', 'K', 'C', 'W', 'R', 'A', 'D', 'B', 'Q', 'J', 'C', 'A', 'Q', 'J', 'S', 'W', 'R', 'K', 'C', 'A', 'Q', 'J', 'D', 'B', 'K', 'W', 'R', 'C', 'A', 'Q']),
  Object.freeze(['J', 'K', 'K', 'K', 'C', 'W', 'R', 'A', 'D', 'B', 'Q', 'J', 'C', 'A', 'Q', 'J', 'S', 'W', 'R', 'K', 'C', 'A', 'Q', 'J', 'D', 'B', 'K', 'W', 'R', 'C', 'A', 'Q']),
]);

export const symbolName = code => SYMBOLS.find(s => s.code === code)?.name || code;

// grid[row][reel]: the symbol at each position when reel `reel` stopped at stops[reel]. Same as the game's gridFor.
// Bad input (not 5 whole numbers) gives null, so a damaged row never throws in the page.
export function gridFor(stops) {
  if (!Array.isArray(stops) || stops.length !== REELS || !stops.every(s => Number.isInteger(s) && s >= 0)) return null;
  const rows = [];
  for (let r = 0; r < ROWS; r++) rows.push(stops.map((s, reel) => STRIPS[reel][(s + r) % STOPS]));
  return rows;
}

// Is this stored outcome a Gods of Power round? (By the outcome itself, so an old row with no game field still renders.)
export const isSlotOutcome = o => !!o && (o.game === SLOT_GAME_ID || Array.isArray(o.spins));

// Cells lit by the line wins of one spin: a Set of 'row,reel' strings. Scatters are lit wherever they sit.
export function winningCells(spin) {
  const cells = new Set();
  for (const w of spin?.lineWins || []) {
    const line = LINES[w.line];
    if (!line) continue;
    for (let reel = 0; reel < Math.min(w.count || 0, REELS); reel++) cells.add(`${line[reel]},${reel}`);
  }
  if ((spin?.scatterCount || 0) >= 3) {
    const grid = gridFor(spin.stops);
    if (grid) grid.forEach((row, r) => row.forEach((s, reel) => { if (s === 'S') cells.add(`${r},${reel}`); }));
  }
  return cells;
}

// 'stake, payout, N spins (M free), capped' as separate parts, for the rounds tables and the live feed.
// Money is formatted by the caller (units of 0.01 TICS). Never throws on an odd outcome.
export function slotSummary(outcome, { stakeCents = null, payoutCents = null } = {}) {
  const spins = Array.isArray(outcome?.spins) ? outcome.spins : [];
  const free = spins.filter(s => s?.free).length;
  const played = Number.isInteger(outcome?.freeSpinsPlayed) ? outcome.freeSpinsPlayed : free;
  const awarded = Number.isInteger(outcome?.freeSpinsAwarded) ? outcome.freeSpinsAwarded : free;
  return { spins: spins.length, free: played, awarded, capped: !!outcome?.capped, stakeCents, payoutCents,
    multiple: stakeCents ? Math.round((payoutCents || 0) / stakeCents * 10) / 10 : null };
}
export function slotSummaryText(outcome, fmt = c => String(c), money = {}) {
  const s = slotSummary(outcome, money);
  const parts = [];
  if (s.stakeCents != null) parts.push(`${fmt(s.stakeCents)} bet`);
  if (s.payoutCents != null) parts.push(`${fmt(s.payoutCents)} paid`);
  parts.push(`${s.spins} spin${s.spins === 1 ? '' : 's'}${s.free ? ` (${s.free} free)` : ''}`);
  if (s.capped) parts.push('capped');
  return parts.join(', ');
}
