// Messages to players: who, what, when. Delivered on the casino site as a
// popup plus an inbox; email and Telegram channels come later.
import { fail, text, isInt } from '../util.js';
import { requirePerm } from '../auth.js';
import { audit } from '../audit.js';

const TRIGGERS = ['now', 'scheduled', 'first_visit', 'wallet_connect', 'first_deposit'];

// Audience: everyone, a list of players (ids or wallet addresses), or a group by filters.
export function audienceSql(audience) {
  if (!audience || typeof audience !== 'object') fail(400, 'Choose who should get this message.');
  if (audience.type === 'all') return { where: "p.status = 'active'", args: [] };
  if (audience.type === 'players') {
    const list = Array.isArray(audience.ids) ? audience.ids.map(String).map(s => s.trim()).filter(Boolean) : [];
    if (!list.length || list.length > 5000) fail(400, 'Add between 1 and 5,000 player ids or wallet addresses.');
    const marks = list.map(() => '?').join(',');
    return { where: `p.status != 'banned' AND (p.id IN (${marks}) OR p.id IN (SELECT player_id FROM player_identities WHERE kind = 'wallet' AND lower(value) IN (${marks})))`,
      args: [...list, ...list.map(s => s.toLowerCase())] };
  }
  if (audience.type === 'segment') {
    const s = audience.filters || {}, w = ["p.status = 'active'"], a = [];
    if (s.joinedWithinDays) { if (!isInt(s.joinedWithinDays, 1, 3650)) fail(400, 'Joined within must be 1 to 3650 days.'); w.push(`p.joined_at >= datetime('now', ?)`); a.push(`-${s.joinedWithinDays} days`); }
    if (s.inactiveDays) { if (!isInt(s.inactiveDays, 1, 3650)) fail(400, 'Inactive for must be 1 to 3650 days.'); w.push(`p.last_seen_at < datetime('now', ?)`); a.push(`-${s.inactiveDays} days`); }
    if (s.minBetCents) { if (!isInt(s.minBetCents, 1, 1e13)) fail(400, 'Minimum total bet must be a positive amount.'); w.push('p.total_bet_cents >= ?'); a.push(s.minBetCents); }
    if (s.country) { w.push('p.country = ?'); a.push(String(s.country).toUpperCase().slice(0, 2)); }
    if (s.device) { w.push('p.device = ?'); a.push(String(s.device)); }
    if (s.hasWallet) w.push("EXISTS (SELECT 1 FROM player_identities i WHERE i.player_id = p.id AND i.kind = 'wallet')");
    return { where: w.join(' AND '), args: a };
  }
  fail(400, 'Unknown audience type.');
}

export async function audiencePreview(db, body) {
  const { where, args } = audienceSql(body.audience);
  const [count, sample] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM players p WHERE ${where}`).bind(...args).first(),
    db.prepare(`SELECT p.id, p.country, p.device, p.last_seen_at FROM players p WHERE ${where} ORDER BY p.last_seen_at DESC LIMIT 5`).bind(...args).all(),
  ]);
  return { count: count.n, sample: sample.results };
}

// Button links: a page on the casino (/...), or https to betics.io, www.betics.io or our Telegram
// channel. Owners may link anywhere on https (players trust these buttons, so others cannot).
// The link is judged the way a browser reads it: parsed against the casino site, the resolved host
// checked, and the parsed (normalised) href stored, so tricks like "/\t/evil.example" or "/\\evil"
// cannot turn a "page on the casino" into another site.
const LINK_BASE = 'https://www.betics.io';
const LINK_HOSTS = ['betics.io', 'www.betics.io'];
const okTelegram = x => x.hostname === 't.me' && /^\/Betics_casino(\/|$)/i.test(x.pathname);
export function validUrl(u, admin = null) {
  if (u == null || u === '') return null;
  if (typeof u !== 'string' || u.length > 300) fail(400, 'The button link is too long.');
  // Browsers silently drop tabs and new lines and read \ as /: refuse them (and any other space or control character) outright.
  if (/[\s\u0000-\u001f\u007f-\u009f\\]/.test(u)) fail(400, 'The button link cannot contain spaces, tabs, line breaks or backslashes.');
  const relative = u.startsWith('/') && !u.startsWith('//');
  if (!relative && !/^https:\/\//i.test(u)) fail(400, 'The button link must start with https:// or /');
  let x = null;
  try { x = new URL(u, LINK_BASE); } catch { /* fall through */ }
  if (!x || x.protocol !== 'https:' || x.username || x.password) fail(400, 'The button link must start with https:// or /');
  if (relative && x.hostname !== new URL(LINK_BASE).hostname) fail(400, 'That link does not stay on the casino site.');
  // The player site opens its own links in place by path; a path starting with "//" would open another site.
  if (LINK_HOSTS.includes(x.hostname) && x.pathname.startsWith('//')) fail(400, 'That link does not stay on the casino site.');
  if (admin?.role !== 'owner' && !LINK_HOSTS.includes(x.hostname) && !okTelegram(x)) fail(400, 'Button links can only go to betics.io or t.me/Betics_casino. Ask an owner for other links.');
  // A page on the casino is stored as its path (the player site opens it in place); never as "//..." which would leave the site.
  // ("/..//evil.example" normalises to "//evil.example", which a browser opens as another site: refused.)
  if (relative) { const path = x.pathname + x.search + x.hash; if (path.startsWith('//')) fail(400, 'That link does not stay on the casino site.'); return path; }
  return x.href;
}

export async function createMessage(db, admin, body) {
  requirePerm(admin, 'message:send');
  const trigger = body.trigger || 'now';
  if (!TRIGGERS.includes(trigger)) fail(400, 'Unknown send option.');
  if (!['now', 'scheduled'].includes(trigger)) requirePerm(admin, 'message:trigger');
  if (!text(body.title, 2, 80)) fail(400, 'The title needs 2 to 80 characters.');
  if (!text(body.body, 2, 1000)) fail(400, 'The message needs 2 to 1,000 characters.');
  const buttonUrl = validUrl(body.buttonUrl, admin);
  const buttonLabel = buttonUrl ? (text(body.buttonLabel, 1, 30) ? body.buttonLabel.trim() : 'Open') : null;
  const channels = ['site']; // email and telegram arrive later
  let sendAt = null;
  if (trigger === 'scheduled') {
    const t = Date.parse(body.sendAt);
    if (!t || t < Date.now() - 60e3) fail(400, 'Pick a time in the future.');
    sendAt = new Date(t).toISOString().slice(0, 19).replace('T', ' ');
  }
  const { where, args } = audienceSql(body.audience); // validates
  const status = body.isTemplate ? 'draft' : trigger === 'now' ? 'sent' : 'active';
  const row = await db.prepare(`INSERT INTO messages (title, body, button_label, button_url, audience_json, channels_json, trigger, send_at, status, is_template, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(body.title.trim(), body.body.trim(), buttonLabel, buttonUrl, JSON.stringify(body.audience),
    JSON.stringify(channels), trigger, sendAt, status, body.isTemplate ? 1 : 0, admin.email).first();
  let delivered = 0;
  if (status === 'sent') delivered = await deliver(db, row.id, where, args);
  await audit(db, admin, body.isTemplate ? 'message.template' : 'message.create', { target: `message:${row.id}`, after: { title: body.title.trim(), trigger, audience: body.audience, delivered } }).run();
  return { id: row.id, status, delivered };
}

export async function deliver(db, messageId, where, args) {
  const res = await db.prepare(`INSERT OR IGNORE INTO message_deliveries (message_id, player_id, channel) SELECT ?, p.id, 'site' FROM players p WHERE ${where}`).bind(messageId, ...args).run();
  return res.meta?.changes ?? 0;
}

// Called by the cron: scheduled messages whose time has come.
export async function sendScheduled(db) {
  const due = await db.prepare("SELECT * FROM messages WHERE status = 'active' AND trigger = 'scheduled' AND send_at <= datetime('now')").all();
  for (const m of due.results) {
    const { where, args } = audienceSql(JSON.parse(m.audience_json));
    await deliver(db, m.id, where, args);
    await db.prepare("UPDATE messages SET status = 'sent' WHERE id = ?").bind(m.id).run();
  }
  return due.results.length;
}

export async function listMessages(db) {
  const rows = await db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM message_deliveries d WHERE d.message_id = m.id) AS delivered,
    (SELECT COUNT(*) FROM message_deliveries d WHERE d.message_id = m.id AND d.seen_at IS NOT NULL) AS seen,
    (SELECT COUNT(*) FROM message_deliveries d WHERE d.message_id = m.id AND d.clicked_at IS NOT NULL) AS clicked
    FROM messages m ORDER BY m.id DESC LIMIT 200`).all();
  return { messages: rows.results.map(m => ({ ...m, audience: JSON.parse(m.audience_json), channels: JSON.parse(m.channels_json) })) };
}

export async function stopMessage(db, admin, id) {
  requirePerm(admin, 'message:send');
  const m = await db.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first();
  if (!m) fail(404, 'No message with that id.');
  if (m.status !== 'active') fail(400, 'Only scheduled or automatic messages can be stopped.');
  await db.batch([db.prepare("UPDATE messages SET status = 'stopped' WHERE id = ?").bind(id), audit(db, admin, 'message.stop', { target: `message:${id}` })]);
  return { ok: true };
}
