// The bets stored with a round come in two shapes: roulette keeps an array of chips
// ([{ type, value, amountCents }]), Gods of Power keeps one object ({ stake, lines }). Every bets
// renderer goes through betsList so an object (or junk from an unknown game) gives an empty list,
// and the page falls back to the raw view instead of crashing on .forEach.
export function betsList(bets) {
  if (Array.isArray(bets)) return bets.filter(b => b && typeof b === 'object');
  if (bets && typeof bets === 'object' && Array.isArray(bets.bets)) return bets.bets.filter(b => b && typeof b === 'object');
  return [];
}
// True when the chips can be drawn on the felt: at least one bet with a type and an amount.
export const hasChips = bets => betsList(bets).some(b => typeof b.type === 'string' && Number.isFinite(Number(b.amountCents)));

// Which pockets a chip covers. outsideCovers(type) returns the predicate for an outside bet (red, dozen1...)
// or nothing. Tolerant of odd rows: a missing value covers nothing rather than throwing.
export function coveredBy(bet, outsideCovers = () => null) {
  const covers = outsideCovers(bet?.type);
  if (covers) return Array.from({ length: 37 }, (_, n) => n).filter(covers);
  if (Array.isArray(bet?.value)) return bet.value.map(Number);
  return bet?.value == null ? [] : [Number(bet.value)];
}
