// Every admin change is written here with before/after values. The table has
// triggers that refuse edits and deletes.
export function audit(db, admin, action, { target = null, before = null, after = null, reason = null } = {}) {
  return db.prepare(`INSERT INTO admin_audit (admin_id, admin_email, action, target, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(admin?.id ?? null, String(admin?.email ?? 'system').slice(0, 200), action, target, before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after), reason);
}
export const writeAudit = (db, ...args) => audit(db, ...args).run();

// An alert for the Alerts page and Telegram. Every alert has a dedupe key, so raising it twice is harmless.
export const raiseAlert = (db, a) => db.prepare(`INSERT OR IGNORE INTO alerts (type, severity, title, details, player_id, game_id, round_id, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(a.type, a.severity || 'warning', a.title, a.details || null, a.playerId || null, a.gameId || null, a.roundId || null, a.key);

// The same insert, but only if guardSql (an EXISTS-able SELECT) finds a row when the statement runs.
// Used inside a batch whose first statement claims a run, so the alerts and the claim land together or not at all.
export const raiseAlertIf = (db, a, guardSql, guardArgs = []) => db.prepare(`INSERT OR IGNORE INTO alerts (type, severity, title, details, player_id, game_id, round_id, dedupe_key)
  SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guardSql})`)
  .bind(a.type, a.severity || 'warning', a.title, a.details || null, a.playerId || null, a.gameId || null, a.roundId || null, a.key, ...guardArgs);
