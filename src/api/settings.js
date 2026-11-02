// Settings: house currency, money mode, admin users and the audit log.
import { fail, text, isInt, sqlTime } from '../util.js';
import { requirePerm, ROLES, ROLE_RANK, NEW_OWNER_DELAY_MS, makeSetupToken, stepUp } from '../auth.js';
import { audit, raiseAlert } from '../audit.js';

const read = async (db, key) => { const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first(); return r ? JSON.parse(r.value) : null; };
const put = (db, key, value) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(key, JSON.stringify(value));

export async function getSettings(db, admin) {
  const [currency, mode, limits] = await Promise.all([read(db, 'house_currency'), read(db, 'mode'), read(db, 'limits')]);
  const admins = admin.role === 'owner'
    ? (await db.prepare('SELECT id, email, name, role, active, totp_enabled, last_login_at, created_at, setup_expires_at FROM admins ORDER BY id').all()).results
    : null;
  return { currency, mode, limits, admins, roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])),
    paymentsLive: false };
}

export async function updateCurrency(db, admin, body) {
  requirePerm(admin, 'settings:edit');
  const before = await read(db, 'house_currency');
  if (!text(body.symbol, 2, 12) || !/^[A-Za-z0-9.]+$/.test(body.symbol.trim())) fail(400, 'The token symbol should be 2 to 12 letters or numbers, like USDT.');
  if (!text(body.name, 2, 60)) fail(400, 'Give the token a name, like Tether USD.');
  const network = body.network === 'ethereum' ? 'ethereum' : 'tron';
  if (typeof body.contract !== 'string') fail(400, 'Enter the token contract address.');
  if (network === 'ethereum' && !/^0x[a-fA-F0-9]{40}$/.test(body.contract.trim())) fail(400, 'An Ethereum (ERC-20) contract is 0x followed by 40 characters.');
  if (network === 'tron' && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(body.contract.trim())) fail(400, 'A Tron (TRC-20) contract starts with T and has 34 characters.');
  if (!isInt(body.decimals, 0, 36)) fail(400, 'Decimals must be a whole number from 0 to 36 (USDT uses 6).');
  if (typeof body.usdRate !== 'number' || !(body.usdRate > 0)) fail(400, 'Enter the token price in US dollars.');
  const mode = await read(db, 'mode');
  if (mode === 'real') fail(400, 'Changing the house currency with real balances needs a balance conversion. That arrives with payments.');
  if (body.confirm !== body.symbol.trim().toUpperCase()) fail(400, `Type ${body.symbol.trim().toUpperCase()} to confirm.`);
  const next = { symbol: body.symbol.trim().toUpperCase(), name: body.name.trim(), network, contract: body.contract.trim(), decimals: body.decimals, usdRate: body.usdRate };
  await db.batch([put(db, 'house_currency', next), audit(db, admin, 'settings.currency', { target: 'settings:house_currency', before, after: next })]);
  return next;
}

export async function updateMode(db, admin, body) {
  requirePerm(admin, 'settings:edit');
  if (body.mode === 'real') fail(400, 'Real money mode unlocks once deposits and withdrawals are connected.');
  if (body.mode !== 'play') fail(400, 'Unknown mode.');
  return 'play';
}

// Creating, re-inviting, raising and reactivating admins all need the password and a fresh code.
// Owner invites and owner raises also raise a critical (Telegram) alert.
export async function createAdmin(db, env, admin, body, origin) {
  requirePerm(admin, 'admin:manage');
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) fail(400, 'Enter a valid email address.');
  if (!text(body.name, 1, 60)) fail(400, 'Enter their name.');
  if (!ROLES[body.role]) fail(400, 'Choose a role.');
  if (await db.prepare('SELECT id FROM admins WHERE email = ?').bind(email).first()) fail(400, 'That email already has an account.');
  await stepUp(db, env, admin, body);
  const row = await db.prepare('INSERT INTO admins (email, name, role) VALUES (?, ?, ?) RETURNING id').bind(email, body.name.trim(), body.role).first();
  const token = await makeSetupToken(db, row.id);
  await db.batch([
    audit(db, admin, 'admin.create', { target: `admin:${row.id}`, after: { email, role: body.role } }),
    ...(body.role === 'owner' ? [raiseAlert(db, { type: 'admin_owner_invited', severity: 'critical', key: `admin_owner_invited:${row.id}:${Date.now()}`,
      title: `A new owner was invited: ${email}`, details: `${admin.email} invited ${email} as an owner. If this was not you, remove them in Settings at once.` })] : []),
  ]);
  return { id: row.id, setupLink: `${origin}/#/setup/${token}` };
}

export async function setupLinkFor(db, env, admin, id, origin, body = {}) {
  requirePerm(admin, 'admin:manage');
  const a = await db.prepare('SELECT * FROM admins WHERE id = ?').bind(id).first();
  if (!a) fail(404, 'No admin with that id.');
  await stepUp(db, env, admin, body);
  const token = await makeSetupToken(db, a.id);
  await db.batch([
    db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').bind(a.id),
    audit(db, admin, 'admin.setup_link', { target: `admin:${id}` }),
    ...(a.role === 'owner' ? [raiseAlert(db, { type: 'admin_owner_invited', severity: 'critical', key: `admin_owner_reinvited:${a.id}:${Date.now()}`,
      title: `An owner sign in was reset: ${a.email}`, details: `${admin.email} made a new setup link for owner ${a.email}. If this was not you, remove them in Settings at once.` })] : []),
  ]);
  return { setupLink: `${origin}/#/setup/${token}` };
}

export async function updateAdmin(db, env, admin, id, body) {
  requirePerm(admin, 'admin:manage');
  const a = await db.prepare('SELECT * FROM admins WHERE id = ?').bind(id).first();
  if (!a) fail(404, 'No admin with that id.');
  const role = body.role ?? a.role, active = body.active ?? !!a.active;
  if (!ROLES[role] || typeof active !== 'boolean') fail(400, 'Invalid role or status.');
  // Removing or demoting an active owner takes power away from the person most able to stop an attacker: same step-up and alert as adding one.
  const removingOwner = a.role === 'owner' && !!a.active && (role !== 'owner' || !active);
  if (removingOwner) {
    // Early answer before asking for a code (the UPDATE below is the real, atomic check).
    const owners = await db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND active = 1").first();
    if (owners.n <= 1) fail(400, 'There must always be at least one active owner.', 'last_owner');
  }
  const raising = ROLE_RANK[role] > ROLE_RANK[a.role], reactivating = active && !a.active;
  if (raising || reactivating || removingOwner) await stepUp(db, env, admin, body);
  const newOwner = role === 'owner' && a.role !== 'owner';
  // An owner switched back on waits 48 hours too, like a new one (their sign in may be in other hands now).
  const ownerBack = role === 'owner' && a.role === 'owner' && reactivating;
  const okAfter = newOwner || ownerBack ? sqlTime(new Date(Date.now() + NEW_OWNER_DELAY_MS)) : null;
  // "At least one active owner" is checked in the same statement that changes the row, so two owners
  // removing each other at the same moment cannot both succeed.
  const res = await db.prepare(`UPDATE admins SET role = ?, active = ?, treasury_ok_after = COALESCE(?, treasury_ok_after) WHERE id = ?
    AND (? = 0 OR (SELECT COUNT(*) FROM admins o WHERE o.role = 'owner' AND o.active = 1 AND o.totp_enabled = 1 AND o.id != ?) >= 1)`)
    .bind(role, active ? 1 : 0, okAfter, id, removingOwner ? 1 : 0, id).run();
  if ((res.meta?.changes ?? 0) !== 1) fail(400, 'There must always be at least one active owner.', 'last_owner');
  await db.batch([
    ...(active ? [] : [db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').bind(id)]),
    audit(db, admin, 'admin.update', { target: `admin:${id}`, before: { role: a.role, active: !!a.active }, after: { role, active, ...(okAfter ? { treasuryOkAfter: okAfter } : {}) } }),
    ...(newOwner ? [raiseAlert(db, { type: 'admin_owner_invited', severity: 'critical', key: `admin_owner_raised:${id}:${Date.now()}`,
      title: `${a.email} was made an owner`, details: `${admin.email} raised ${a.email} to owner. Treasury actions open for them at ${okAfter} UTC.` })] : []),
    ...(ownerBack ? [raiseAlert(db, { type: 'admin_owner_invited', severity: 'critical', key: `admin_owner_reactivated:${id}:${Date.now()}`,
      title: `Owner ${a.email} was switched back on`, details: `${admin.email} reactivated owner ${a.email}. Treasury actions open for them at ${okAfter} UTC. If this was not you, remove them in Settings at once.` })] : []),
    ...(removingOwner ? [raiseAlert(db, { type: 'admin_owner_removed', severity: 'critical', key: `admin_owner_removed:${id}:${Date.now()}`,
      title: `${a.email} is no longer an owner`, details: `${admin.email} ${active ? `changed ${a.email} to ${ROLES[role]?.label || role}` : `removed ${a.email}`}. If this was not you, sign in and check Settings at once.` })] : []),
  ]);
  return { ok: true };
}

export async function auditLog(db, admin, url) {
  requirePerm(admin, 'audit:view');
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get('limit'))) || 100));
  const rows = await db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?').bind(limit).all();
  return { entries: rows.results.map(e => ({ ...e, before: e.before_json ? JSON.parse(e.before_json) : null, after: e.after_json ? JSON.parse(e.after_json) : null })) };
}
