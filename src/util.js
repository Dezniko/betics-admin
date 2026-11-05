// Small shared helpers: responses, errors, hashing, encoding.
export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, message, code) => { throw new HttpError(status, message, code); };

// headers: an object, or a list of [name, value] pairs (for more than one Set-Cookie).
export function json(value, status = 200, headers = {}) {
  const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  for (const [k, v] of Array.isArray(headers) ? headers : Object.entries(headers)) if (v != null) h.append(k, v);
  return new Response(JSON.stringify(value), { status, headers: h });
}

const enc = new TextEncoder();
export const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const fromHex = hex => new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));
export const randomHex = (bytes = 32) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));
export const sha256 = async text => toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

export async function hmacHex(key, message) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

// Constant-time string comparison.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function readJson(request, limit = 65536) {
  const text = await request.text();
  if (text.length > limit) fail(413, 'Request is too large.');
  if (!text) return {};
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Expected a JSON object.');
    return body;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    fail(400, 'That was not valid JSON.');
  }
}

// A stored round outcome is JSON written by the game; one row we cannot parse must not take a whole list down.
export const parseOutcome = text => { try { return JSON.parse(text); } catch { return { raw: text }; } };
export const isInt = (v, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
export const text = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;
export const usd = cents => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// House currency: integers of 0.01 TICS.
export const tics = units => `${units < 0 ? '-' : ''}${(Math.abs(units) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TICS`;
// The old USDT (NOWPayments) payments, kept but switched off.
export const usdt = cents => `${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

// Period helpers. SQLite datetime strings are UTC 'YYYY-MM-DD HH:MM:SS'.
export const sqlTime = d => d.toISOString().slice(0, 19).replace('T', ' ');
// Which money the admin is looking at: 1 = real TICS, 0 = demo (play money).
// Set by the Real/Demo switch in the top bar (header X-View-Mode, or ?money=real|play). Real is the default.
export const viewReal = url => (url.searchParams.get('money') === 'play' ? 0 : 1);
// The Real/Demo filter written as a LITERAL (never a bound ?): the partial index
// rounds_real_time (WHERE real_money = 1) is only used when the query says "real_money = 1".
// Demo feeds use rounds_time: "+real_money = 0" (without the +, a literal LIMIT made SQLite
// scan the whole table and sort it for the 15 newest demo rounds).
export const moneyIs = (real, col = 'real_money') => real ? `${col} = 1` : `+${col} = 0`;
// Per-player (or other narrow) queries: the unary + keeps the planner on rounds_player
// instead of walking the partial time index.
export const moneyIsPlayer = (real, col = 'real_money') => `+${col} = ${real ? 1 : 0}`;

// Dashboard figures change slowly but the pages poll every 10 to 15 seconds: keep each
// aggregate for a short while per isolate (and per database, so tests never share it).
const caches = new WeakMap();
export async function cached(db, key, ttlMs, fn, now = Date.now()) {
  let m = caches.get(db);
  if (!m) { m = new Map(); caches.set(db, m); }
  const hit = m.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = await fn();
  if (m.size > 200) m.clear();
  m.set(key, { at: now, value });
  return value;
}
export const dropCache = db => caches.delete(db);

export function periodRange(period, now = new Date()) {
  const end = new Date(now.getTime() + 60e3); // include rounds stamped this very second
  let start;
  if (period === 'today') { start = new Date(now); start.setUTCHours(0, 0, 0, 0); }
  else if (period === '7d') start = new Date(now.getTime() - 7 * 864e5);
  else if (period === '30d') start = new Date(now.getTime() - 30 * 864e5);
  else if (period === '90d') start = new Date(now.getTime() - 90 * 864e5);
  else if (period === 'all') start = new Date('2020-01-01T00:00:00Z');
  else fail(400, 'Unknown period.');
  const length = end - start;
  return { from: sqlTime(start), to: sqlTime(end), prevFrom: sqlTime(new Date(start - length)), prevTo: sqlTime(start), bucket: period === 'today' ? 'hour' : 'day' };
}
