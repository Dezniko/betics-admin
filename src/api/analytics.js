// Analytics: who plays, from where, on what, when, and who comes back.
import { periodRange, viewReal } from '../util.js';
import { gameList } from './games.js';

export async function analytics(db, url) {
  const q = url.searchParams;
  const r = periodRange(q.get('period') || '30d');
  const f = { country: q.get('country') || null, device: q.get('device') || null, game: q.get('game') || null };
  const ev = (alias = '') => {
    const p = alias ? alias + '.' : '';
    const w = [`${p}created_at >= ?`, `${p}created_at < ?`], a = [r.from, r.to];
    if (f.country) { w.push(`${p}country = ?`); a.push(f.country); }
    if (f.device) { w.push(`${p}device = ?`); a.push(f.device); }
    return { where: w.join(' AND '), args: a };
  };
  const real = viewReal(url);
  const rd = () => { const e = ev(); e.where += ' AND real_money = ?'; e.args.push(real); if (f.game) { e.where += ' AND game_id = ?'; e.args.push(f.game); } return e; };
  const E = ev(), R = rd();
  const dist = (col) => db.prepare(`SELECT COALESCE(${col},'unknown') AS k, COUNT(DISTINCT player_id) AS n FROM events WHERE ${E.where} GROUP BY k ORDER BY n DESC LIMIT 12`).bind(...E.args).all();
  const [daily, countries, devices, oses, browsers, languages, screens, heat, games, funnelVisit, funnelPlay, funnelWallet, funnelDeposit, referrers, campaigns, sessions, value] = await Promise.all([
    db.prepare(`SELECT strftime('%Y-%m-%d', created_at) AS t, COUNT(DISTINCT CASE WHEN type = 'first_visit' THEN player_id END) AS new_players,
      COUNT(DISTINCT CASE WHEN type = 'visit' THEN player_id END) AS returning_players FROM events WHERE ${E.where} GROUP BY t ORDER BY t`).bind(...E.args).all(),
    db.prepare(`SELECT COALESCE(e.country,'??') AS k, COUNT(DISTINCT e.player_id) AS n,
      (SELECT COALESCE(SUM(stake_cents - payout_cents),0) FROM rounds x WHERE x.country = e.country AND x.real_money = ? AND x.created_at >= ? AND x.created_at < ?) AS profit
      FROM events e WHERE ${ev('e').where} GROUP BY k ORDER BY n DESC LIMIT 20`).bind(real, r.from, r.to, ...ev('e').args).all(),
    dist('device'), dist('os'), dist('browser'), dist('language'),
    db.prepare(`SELECT screen AS k, COUNT(DISTINCT player_id) AS n FROM events WHERE ${E.where} AND screen IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 8`).bind(...E.args).all(),
    db.prepare(`SELECT CAST(strftime('%w', created_at) AS INTEGER) AS d, CAST(strftime('%H', created_at) AS INTEGER) AS h, COUNT(*) AS rounds, SUM(stake_cents) AS bet
      FROM rounds WHERE ${R.where} GROUP BY d, h`).bind(...R.args).all(),
    db.prepare(`SELECT game_id, COUNT(*) AS rounds, COUNT(DISTINCT player_id) AS players, SUM(stake_cents) AS bet, SUM(payout_cents) AS paid, AVG(stake_cents) AS avg_bet
      FROM rounds WHERE ${R.where} GROUP BY game_id ORDER BY rounds DESC`).bind(...R.args).all(),
    db.prepare(`SELECT COUNT(DISTINCT player_id) AS n FROM events WHERE ${E.where} AND type IN ('visit','first_visit')`).bind(...E.args).first(),
    db.prepare(`SELECT COUNT(DISTINCT player_id) AS n FROM rounds WHERE ${R.where}`).bind(...R.args).first(),
    db.prepare(`SELECT COUNT(DISTINCT i.player_id) AS n FROM player_identities i WHERE i.kind = 'wallet' AND i.created_at >= ? AND i.created_at < ?`).bind(r.from, r.to).first(),
    db.prepare(`SELECT COUNT(DISTINCT player_id) AS n FROM chain_deposits WHERE status IN ('credited','assigned') AND player_id IS NOT NULL AND created_at >= ? AND created_at < ?`).bind(r.from, r.to).first(),
    db.prepare(`SELECT COALESCE(first_referrer,'Direct or unknown') AS k, COUNT(*) AS n, SUM((SELECT COALESCE(SUM(x.stake_cents - x.payout_cents),0) FROM rounds x WHERE x.player_id = p.id AND x.real_money = ?)) AS profit FROM players p WHERE joined_at >= ? AND joined_at < ? GROUP BY k ORDER BY n DESC LIMIT 10`).bind(real, r.from, r.to).all(),
    db.prepare(`SELECT COALESCE(first_campaign,'No campaign') AS k, COUNT(*) AS n, SUM((SELECT COALESCE(SUM(x.stake_cents - x.payout_cents),0) FROM rounds x WHERE x.player_id = p.id AND x.real_money = ?)) AS profit FROM players p WHERE joined_at >= ? AND joined_at < ? GROUP BY k ORDER BY profit DESC LIMIT 10`).bind(real, r.from, r.to).all(),
    db.prepare(`SELECT COUNT(*) AS n, AVG(CAST(json_extract(meta, '$.seconds') AS REAL)) AS avg FROM events WHERE ${E.where} AND type = 'session_end'`).bind(...E.args).first(),
    db.prepare(`SELECT k, COUNT(*) AS players, SUM(pr) AS profit, AVG(pr) AS per_player FROM (SELECT COALESCE(country,'??') AS k, (SELECT COALESCE(SUM(x.stake_cents - x.payout_cents),0) FROM rounds x WHERE x.player_id = p.id AND x.real_money = ?) AS pr FROM players p WHERE EXISTS (SELECT 1 FROM rounds y WHERE y.player_id = p.id AND y.real_money = ?)) GROUP BY k ORDER BY profit DESC LIMIT 12`).bind(real, real).all(),
  ]);
  // Every game appears in the By game table, with a zero row when nobody played it in the period.
  const allGames = await gameList(db), names = Object.fromEntries(allGames.map(g => [g.id, g.name]));
  const played = Object.fromEntries(games.results.map(g => [g.game_id, g]));
  const byGame = [...allGames.map(g => played[g.id] || { game_id: g.id, rounds: 0, players: 0, bet: 0, paid: 0, avg_bet: 0 }),
    ...games.results.filter(g => !names[g.game_id])];
  const retention = [];
  for (const days of [1, 7, 30]) {
    const row = await db.prepare(`SELECT COUNT(*) AS cohort, SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.player_id = p.id AND e.created_at >= datetime(p.joined_at, '+${days} days')) THEN 1 ELSE 0 END) AS back
      FROM players p WHERE p.joined_at >= ? AND p.joined_at < ? AND p.joined_at <= datetime('now', '-${days} days')`).bind(r.from, r.to).first();
    retention.push({ days, cohort: row.cohort, back: row.back || 0, pct: row.cohort ? Math.round((row.back || 0) / row.cohort * 1000) / 10 : null });
  }
  return {
    period: q.get('period') || '30d', filters: f, realMoney: !!real,
    daily: daily.results, countries: countries.results, devices: devices.results, os: oses.results, browsers: browsers.results,
    languages: languages.results, screens: screens.results, heat: heat.results,
    games: byGame.map(g => ({ gameId: g.game_id, gameName: names[g.game_id] || g.game_id, rounds: g.rounds, players: g.players, betCents: g.bet || 0, paidCents: g.paid || 0,
      profitCents: (g.bet || 0) - (g.paid || 0), avgBetCents: Math.round(g.avg_bet || 0), rtp: g.bet ? Math.round(g.paid / g.bet * 10000) / 100 : null })),
    funnel: [
      { step: 'Visited', n: funnelVisit.n }, { step: 'Played a round', n: funnelPlay.n },
      { step: 'Connected a wallet', n: funnelWallet.n }, { step: 'Deposited', n: funnelDeposit.n },
    ],
    retention, referrers: referrers.results, campaigns: campaigns.results,
    sessions: { count: sessions.n, avgSeconds: sessions.avg ? Math.round(sessions.avg) : null },
    value: value.results.map(v => ({ ...v, per_player: Math.round(v.per_player || 0) })),
  };
}
