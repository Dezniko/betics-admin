// Admin sign-in: email + password (PBKDF2) + a 6-digit code from an
// authenticator app (mandatory). Sessions are random tokens stored hashed.
import { fail, randomHex, sha256, hmacHex, toHex, safeEqual, sqlTime } from './util.js';
import { newTotpSecret, totpStep, otpauthUri } from './totp.js';
import { audit, writeAudit, raiseAlert } from './audit.js';

export const COOKIE = '__Host-admin_session';
// A long-lived signed id for this browser, so 'new device' means a new browser, not a new IP
// (phones change networks all the time). Set at setup and at every sign-in.
export const DEVICE_COOKIE = '__Host-admin_device';
const DEVICE_MAX_AGE = 400 * 86400; // the most browsers keep a cookie
// Wrong authenticator codes per admin in 24 hours (sign-in and confirmations together): past this
// every code is refused until the oldest wrong one is a day old, and the owners get an alert.
export const DAILY_CODE_LIMIT = 20;
const ITERATIONS = 100000; // Workers' PBKDF2 maximum
const IDLE_MS = 12 * 3600e3, MAX_MS = 7 * 864e5, SETUP_MS = 48 * 3600e3;
// A freshly set up owner (or an admin just raised to owner) waits this long before treasury actions.
export const NEW_OWNER_DELAY_MS = 48 * 3600e3;
const enc = new TextEncoder();

export const ROLES = {
  owner: { label: 'Owner', perms: ['*'] },
  finance: { label: 'Finance', perms: ['view', 'money:export', 'payments:approve'] },
  // 'alert:resolve' covers warnings and info only; critical alerts need 'alert:resolve_critical' (owners).
  support: { label: 'Support', perms: ['view', 'player:status', 'message:send', 'alert:resolve'] },
  readonly: { label: 'Read only', perms: ['view'] },
};
// Higher number = more power. Raising someone needs the password and a fresh code.
export const ROLE_RANK = { readonly: 0, support: 1, finance: 2, owner: 3 };
// Personal data (emails, Telegram ids, where and on what a player connected) needs 'pii:view'; only owners have it ('*').
export const can = (admin, perm) => !!admin && (ROLES[admin.role]?.perms.includes('*') || ROLES[admin.role]?.perms.includes(perm));
export function requirePerm(admin, perm) {
  if (!can(admin, perm)) fail(403, 'Your role does not allow this. Ask the owner if you need it.', 'forbidden');
}

async function pbkdf2(password, saltHex, pepper) {
  // The pepper (a Worker secret) is mixed in, so a stolen database alone cannot be brute forced.
  const peppered = await hmacHex(pepper, password);
  const key = await crypto.subtle.importKey('raw', enc.encode(peppered), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(saltHex), iterations: ITERATIONS }, key, 256);
  return toHex(bits);
}
export async function hashPassword(password, pepper) {
  const salt = randomHex(16);
  return `pbkdf2$${ITERATIONS}$${salt}$${await pbkdf2(password, salt, pepper)}`;
}
// Used for unknown emails and accounts without a password, so they take as long as a real check.
const DUMMY_HASH = `pbkdf2$${ITERATIONS}$${'0'.repeat(32)}$${'0'.repeat(64)}`;
export async function verifyPassword(password, stored, pepper) {
  const [, , salt, hash] = (stored || DUMMY_HASH).split('$');
  const ok = safeEqual(await pbkdf2(password, salt, pepper), hash);
  return !!stored && ok;
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 200) return 'That password is too long.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Use letters and at least one number.';
  return null;
}

function readCookie(request, name) {
  const match = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}
function cookieToken(request) {
  const token = readCookie(request, COOKIE);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export async function currentAdmin(db, request, now = Date.now()) {
  const token = cookieToken(request);
  if (!token) return null;
  const hash = await sha256(token);
  const row = await db.prepare(`SELECT s.token_hash, s.created_at AS s_created, s.last_used_at, s.expires_at, a.* FROM admin_sessions s
    JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`).bind(hash).first();
  if (!row || !row.active) return null;
  const used = Date.parse(row.last_used_at + 'Z'), expires = Date.parse(row.expires_at + 'Z');
  if (now - used > IDLE_MS || now > expires) {
    await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }
  if (now - used > 60e3) await db.prepare('UPDATE admin_sessions SET last_used_at = ? WHERE token_hash = ?').bind(sqlTime(new Date(now)), hash).run();
  return publicAdmin(row);
}

export const publicAdmin = a => ({ id: a.id, email: a.email, name: a.name, role: a.role, roleLabel: ROLES[a.role]?.label, perms: ROLES[a.role]?.perms });

// The network a request comes from. IPv6 users get a whole /64 (one home or phone line), so
// rotating through addresses inside it does not give fresh rate limits.
export function networkOf(ip) {
  if (!ip || !ip.includes(':')) return ip || 'unknown';
  let addr = ip.toLowerCase().split('%')[0];
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(addr)) return addr.slice(7); // IPv4 written as IPv6
  const [head, tail = ''] = addr.split('::');
  const a = head ? head.split(':') : [], b = addr.includes('::') && tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return `${groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

// The signed device id from the cookie, or null when it is missing or forged.
async function deviceFromCookie(request, pepper) {
  const v = readCookie(request, DEVICE_COOKIE);
  const m = v && /^([a-f0-9]{32})\.([a-f0-9]{32})$/.exec(v);
  if (!m) return null;
  const sig = (await hmacHex(pepper || '', `admin-device:${m[1]}`)).slice(0, 32);
  return safeEqual(sig, m[2]) ? m[1] : null;
}
const deviceCookie = async (id, pepper) => `${DEVICE_COOKIE}=${id}.${(await hmacHex(pepper || '', `admin-device:${id}`)).slice(0, 32)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DEVICE_MAX_AGE}`;

// Where a request comes from: hashed network, a short browser string and the browser's device id
// (from the signed device cookie; a browser without one gets a new id, sent back as setDevice).
async function clientOf(request, env = {}) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 200);
  const ipHash = await sha256(`admin-ip:${networkOf(ip)}`);
  const known = await deviceFromCookie(request, env.SESSION_PEPPER);
  const id = known || randomHex(16);
  return { ip, ua, ipHash, deviceId: id, hasDevice: !!known, device: (await sha256(`admin-device:${id}`)).slice(0, 24),
    setDevice: await deviceCookie(id, env.SESSION_PEPPER) };
}

export async function createSession(db, admin, request, now = Date.now(), how = 'login', c = null) {
  const token = randomHex(32);
  c ||= await clientOf(request);
  await db.batch([
    db.prepare(`INSERT INTO admin_sessions (token_hash, admin_id, created_at, last_used_at, expires_at, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(await sha256(token), admin.id, sqlTime(new Date(now)), sqlTime(new Date(now)), sqlTime(new Date(now + MAX_MS)), c.ipHash, c.ua),
    db.prepare("UPDATE admins SET last_login_at = datetime('now'), failed_logins = 0 WHERE id = ?").bind(admin.id),
    audit(db, admin, 'auth.session_new', { target: `admin:${admin.id}`, after: { how, ip: c.ipHash.slice(0, 16), device: c.device, ua: c.ua.slice(0, 120) } }),
  ]);
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_MS / 1000}`;
}
export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export async function endSession(db, request) {
  const token = cookieToken(request);
  if (token) await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

// ---------- rate limits ----------
// Each try first claims a slot with ONE conditional insert (count and insert in the same
// statement), so parallel requests cannot all slip under the limit. A try that turns out
// right gives its slots back; a wrong one keeps them for 15 minutes.
const WINDOW_MS = 15 * 60e3;
async function claim(db, key, limit, now, { backoffAfter = null, backoffMs = 0, windowMs = WINDOW_MS } = {}) {
  const cutoff = sqlTime(new Date(now - windowMs)), stamp = sqlTime(new Date(now));
  const count = '(SELECT COUNT(*) FROM admin_login_attempts WHERE key = ? AND created_at > ?)';
  let where = `${count} < ?`; const args = [key, stamp, key, cutoff, limit];
  if (backoffAfter != null) {
    // Past backoffAfter wrong tries, one more try per backoffMs (from any network), never a full lock.
    where += ` AND (${count} < ? OR COALESCE((SELECT MAX(created_at) FROM admin_login_attempts WHERE key = ? AND created_at > ?), '') <= ?)`;
    args.push(key, cutoff, backoffAfter, key, cutoff, sqlTime(new Date(now - backoffMs)));
  }
  const row = await db.prepare(`INSERT INTO admin_login_attempts (key, created_at) SELECT ?, ? WHERE ${where} RETURNING rowid AS id`).bind(...args).first();
  return row ? row.id : null;
}
// Claims every key or none. Returns the claimed row ids, or null when any limit is reached
// (out.refused then names the key that refused).
async function claimAll(db, keys, now, out = {}) {
  const got = [];
  for (const [key, limit, opts] of keys) {
    const id = await claim(db, key, limit, now, opts);
    if (id == null) { await release(db, got); out.refused = key; return null; }
    got.push(id);
  }
  return got;
}

// ---------- wrong authenticator codes per admin per day ----------
// Two pools: codes typed from a network this admin already signed in from (or inside a signed-in
// session) and codes from anywhere else, so someone with only the password cannot use up the owner's own pool.
const codesKey = (id, trusted = false) => `codes:${Number(id)}${trusted ? ':trusted' : ''}`;
const DAY_MS = 864e5;
// One slot per code check, released when the code is right. Refused (and an alert) once the day's cap is used up.
async function claimCodeSlot(db, admin, now, trusted = false) {
  const id = await claim(db, codesKey(admin.id, trusted), DAILY_CODE_LIMIT, now, { windowMs: DAY_MS });
  if (id != null) return id;
  await codeCapAlert(db, admin, now).run();
  fail(429, `Too many wrong authenticator codes for this account today (${DAILY_CODE_LIMIT} in 24 hours). Codes are refused until tomorrow. If these were not you, someone has the password: tell the other owners.`, 'codes_locked');
}
const codeCapAlert = (db, admin, now) => raiseAlert(db, { type: 'admin_codes_locked', severity: 'critical', key: `admin_codes_locked:${admin.id}:${sqlTime(new Date(now)).slice(0, 10)}`,
  title: `${DAILY_CODE_LIMIT} wrong authenticator codes today for ${admin.email}`,
  details: `Someone typed the right password for ${admin.email} but ${DAILY_CODE_LIMIT} wrong codes within 24 hours, so codes for this account are refused for now. If this was not them, reset their sign in in Settings and change the password.` });
// After a wrong code: if that used up the day's cap, alert now (the dedupe key keeps it to one a day).
async function afterWrongCode(db, admin, now, trusted = false) {
  const n = await db.prepare('SELECT COUNT(*) AS n FROM admin_login_attempts WHERE key = ? AND created_at > ?').bind(codesKey(admin.id, trusted), sqlTime(new Date(now - DAY_MS))).first();
  if ((n?.n ?? 0) >= DAILY_CODE_LIMIT) await codeCapAlert(db, admin, now).run();
}
const release = (db, ids) => ids.length ? db.prepare(`DELETE FROM admin_login_attempts WHERE rowid IN (${ids.map(() => '?').join(',')})`).bind(...ids).run() : null;

const BAD_LOGIN = 'That email and password do not match, or the account is not set up yet.';
const loginFailed = (db, admin, email, c, reason) => writeAudit(db, admin ? { id: admin.id, email: admin.email } : { id: null, email: email.slice(0, 120) || 'unknown' },
  'auth.login_failed', { target: admin ? `admin:${admin.id}` : null, after: { reason, ip: c.ipHash.slice(0, 16), device: c.device } });

export async function login(db, env, request, body, now = Date.now()) {
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const c = await clientOf(request, env);
  const admin = email ? await db.prepare('SELECT * FROM admins WHERE email = ?').bind(email).first() : null;
  // A network this admin already signed in from (audit_admin_action: admin_id + action, then this admin's few sign-ins).
  const usualNetwork = admin ? !!await db.prepare(`SELECT 1 AS k FROM admin_audit WHERE admin_id = ? AND action IN ('auth.login', 'auth.setup_complete')
    AND json_extract(after_json, '$.ip') = ? LIMIT 1`).bind(admin.id, c.ipHash.slice(0, 16)).first() : false;
  // Known device = this browser's signed device cookie was seen at an earlier sign-in or setup of this admin.
  // The cookie is signed with the pepper and HttpOnly, so someone with only the password cannot make one.
  const known = !!admin && c.hasDevice && !!await db.prepare(`SELECT 1 AS k FROM admin_audit WHERE admin_id = ? AND action IN ('auth.login', 'auth.setup_complete') AND json_extract(after_json, '$.device') = ? LIMIT 1`)
    .bind(admin.id, c.device).first();
  // Per email + network (strict), per network, and per email from anywhere (loose: slows down instead of locking).
  // The email-wide slow-down is skipped on a network or in a browser where this admin already signed in, so an
  // attacker guessing from elsewhere cannot slow the owner down at home or on their own phone.
  const keys = [[`login:${await sha256(`${email}|${c.ipHash}`)}`, 5], [`ip:${c.ipHash}`, 20],
    ...(usualNetwork || known ? [] : [[`email:${email}`, 1e9, { backoffAfter: 10, backoffMs: 30e3 }]])];
  const refused = {};
  const slots = await claimAll(db, keys, now, refused);
  // Not written to the audit log: a flood of refused tries would only fill it (the tries that got through are there).
  if (!slots) fail(429, refused.refused?.startsWith('email:')
    ? 'This account had many wrong sign in tries from other networks, so sign in is slowed down: one try every 30 seconds. Wait 30 seconds and try again.'
    : 'Too many tries from this network. Wait 15 minutes and try again.', 'locked');
  // Always one full password check, so an unknown email takes as long as a known one.
  const passwordOk = await verifyPassword(String(body.password || ''), admin?.password_hash, env.SESSION_PEPPER);
  if (!passwordOk || !admin || !admin.active || !admin.totp_enabled) {
    await loginFailed(db, admin, email, c, !admin ? 'unknown' : !passwordOk ? 'password' : !admin.active ? 'inactive' : 'setup_needed');
    fail(401, BAD_LOGIN, 'bad_login');
  }
  if (!body.code) { await release(db, slots); return { needCode: true }; }
  // Codes from a known network OR a known browser use the owner's own pool, so an attacker who used up the
  // other pool from elsewhere cannot lock the owner out on a new network (hotel, phone data) for a day.
  const trusted = usualNetwork || known;
  let codeSlot;
  try { codeSlot = await claimCodeSlot(db, admin, now, trusted); } catch (e) { await release(db, slots); throw e; }
  const step = await totpStep(admin.totp_secret, String(body.code));
  if (step == null) { await loginFailed(db, admin, email, c, 'code'); await afterWrongCode(db, admin, now, trusted); fail(401, 'That code is not right. Use the newest code from your authenticator app.', 'bad_code'); }
  // A code works once: the sign-in code cannot also approve a treasury send, and a seen code cannot sign in again.
  if (!await useStep(db, admin.id, step)) { await release(db, [codeSlot]); await loginFailed(db, admin, email, c, 'code_reused'); fail(401, 'That code was already used. Wait for the next code in your authenticator app.', 'code_used'); }
  await release(db, [...slots, codeSlot]);
  const cookie = await createSession(db, admin, request, now, 'login', c);
  await db.batch([
    audit(db, admin, 'auth.login', { target: `admin:${admin.id}`, after: { ip: c.ipHash.slice(0, 16), device: c.device, ua: c.ua.slice(0, 120), newDevice: !known } }),
    ...(admin.role === 'owner' && !known ? [raiseAlert(db, { type: 'admin_new_device', severity: 'critical', key: `admin_new_device:${admin.id}:${c.device}`,
      title: `Owner ${admin.email} signed in from a new device`, details: `Browser: ${c.ua.slice(0, 120) || 'unknown'}. If this was not you, remove the session by resetting the sign in and pause payouts.` })] : []),
  ]);
  return { admin, cookie, cookies: [cookie, c.setDevice], alerted: admin.role === 'owner' && !known };
}

// Each admin's newest used code step, so a code works for one sensitive action only.
// (There is no column for it on the admins table, which the game repo owns; a settings row holds it.)
const STEPS_KEY = 'admin_totp_steps';
export async function useStep(db, adminId, step) {
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, '{}')").bind(STEPS_KEY).run();
  const path = `$."${Number(adminId)}"`;
  const res = await db.prepare(`UPDATE settings SET value = json_set(value, ?, ?), updated_at = datetime('now') WHERE key = ? AND COALESCE(json_extract(value, ?), -1) < ?`)
    .bind(path, step, STEPS_KEY, path, step).run();
  return (res.meta?.changes ?? 0) === 1;
}

// Sensitive actions: a fresh authenticator code every time, and the password when asked.
// 5 wrong tries in 15 minutes pause it (claimed atomically, like sign-in).
export async function confirmSensitive(db, env, admin, { code, password, needPassword = false } = {}, now = Date.now()) {
  const row = await db.prepare('SELECT * FROM admins WHERE id = ?').bind(admin.id).first();
  if (!row || !row.active || !row.totp_enabled) fail(403, 'Your account cannot do this.', 'forbidden');
  const slots = await claimAll(db, [[`confirm:${row.id}`, 5]], now);
  if (!slots) fail(429, 'Too many wrong tries. Wait 15 minutes and try again.', 'locked');
  if (needPassword && !await verifyPassword(String(password || ''), row.password_hash, env.SESSION_PEPPER)) fail(401, 'That password is not right.', 'bad_password');
  let codeSlot;
  try { codeSlot = await claimCodeSlot(db, row, now, true); } catch (e) { await release(db, slots); throw e; }
  const step = await totpStep(row.totp_secret, String(code || ''));
  if (step == null) { await afterWrongCode(db, row, now, true); fail(401, 'That code is not right. Use the newest code from your authenticator app.', 'bad_code'); }
  // A right code that was already used is not a guess: give both slots back.
  if (!await useStep(db, row.id, step)) { await release(db, [...slots, codeSlot]); fail(401, 'That code was already used. Wait for the next code in your authenticator app.', 'code_used'); }
  await release(db, [...slots, codeSlot]);
  return true;
}
// Password + fresh code, the usual step-up for changes to people and money settings.
export const stepUp = (db, env, admin, body) => confirmSensitive(db, env, admin, { code: body?.code, password: body?.password, needPassword: true });

// New owners (and admins just raised to owner) wait 48 hours before treasury actions.
export async function requireTreasuryReady(db, admin, now = Date.now()) {
  const row = await db.prepare('SELECT treasury_ok_after FROM admins WHERE id = ?').bind(admin.id).first();
  const after = row?.treasury_ok_after ? Date.parse(row.treasury_ok_after.replace(' ', 'T') + 'Z') : 0;
  if (after > now) fail(403, `Your owner sign in is new. For safety, treasury sends and treasury address changes open for you at ${new Date(after).toISOString().replace('T', ' ').slice(0, 16)} UTC.`, 'owner_too_new');
}

// One-time setup links (owner creates them; the first owner via scripts/).
export async function makeSetupToken(db, adminId) {
  const token = randomHex(24);
  await db.prepare('UPDATE admins SET setup_token_hash = ?, setup_expires_at = ? WHERE id = ?')
    .bind(await sha256(token), sqlTime(new Date(Date.now() + SETUP_MS)), adminId).run();
  return token;
}
async function adminForSetup(db, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) fail(400, 'This setup link is not valid.', 'bad_setup');
  const admin = await db.prepare('SELECT * FROM admins WHERE setup_token_hash = ?').bind(await sha256(token)).first();
  if (!admin || !admin.active || Date.parse(admin.setup_expires_at + 'Z') < Date.now()) fail(400, 'This setup link has expired or was already used. Ask the owner for a new one.', 'bad_setup');
  return admin;
}
export async function setupInfo(db, token) {
  const a = await adminForSetup(db, token);
  return { email: a.email, name: a.name, role: ROLES[a.role].label, hasPassword: !!a.password_hash && !!a.totp_secret };
}
export async function setupPassword(db, env, token, password) {
  const admin = await adminForSetup(db, token);
  const problem = passwordProblem(password);
  if (problem) fail(400, problem, 'weak_password');
  const secret = newTotpSecret();
  await db.batch([
    db.prepare('UPDATE admins SET password_hash = ?, totp_secret = ?, totp_enabled = 0 WHERE id = ?').bind(await hashPassword(password, env.SESSION_PEPPER), secret, admin.id),
    audit(db, admin, 'auth.setup_password', { target: `admin:${admin.id}` }),
  ]);
  return { secret, uri: otpauthUri(secret, admin.email) };
}
export async function setupTotp(db, request, token, code, now = Date.now(), env = {}) {
  const admin = await adminForSetup(db, token);
  if (!admin.totp_secret || !admin.password_hash) fail(400, 'Choose a password first.', 'bad_setup');
  const slots = await claimAll(db, [[`setup:${admin.id}`, 5]], now);
  if (!slots) fail(429, 'Too many tries. Wait 15 minutes and try again.', 'locked');
  const step = await totpStep(admin.totp_secret, String(code || ''));
  if (step == null) fail(400, 'That code is not right. Check the app shows qu-BETICS Admin and type the newest code.', 'bad_code');
  if (!await useStep(db, admin.id, step)) fail(400, 'That code was already used. Wait for the next code in your authenticator app.', 'code_used');
  await release(db, slots);
  const c = await clientOf(request, env);
  const okAfter = admin.role === 'owner' ? sqlTime(new Date(now + NEW_OWNER_DELAY_MS)) : null;
  await db.batch([
    db.prepare('UPDATE admins SET totp_enabled = 1, setup_token_hash = NULL, setup_expires_at = NULL, treasury_ok_after = COALESCE(?, treasury_ok_after) WHERE id = ?').bind(okAfter, admin.id),
    db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').bind(admin.id),
    audit(db, admin, 'auth.setup_complete', { target: `admin:${admin.id}`, after: { role: admin.role, ip: c.ipHash.slice(0, 16), device: c.device, ua: c.ua.slice(0, 120), treasuryOkAfter: okAfter } }),
    raiseAlert(db, { type: 'admin_setup', severity: 'critical', key: `admin_setup:${admin.id}:${now}`,
      title: `Admin sign in set up: ${admin.email} (${ROLES[admin.role]?.label || admin.role})`,
      details: `A password and authenticator app were just set for ${admin.email}.${okAfter ? ` As an owner they can send to the treasury from ${okAfter} UTC.` : ''} If you did not expect this, remove them in Settings and pause payouts.` }),
  ]);
  const cookie = await createSession(db, admin, request, now, 'setup', c);
  return { admin, cookie, cookies: [cookie, c.setDevice] };
}
