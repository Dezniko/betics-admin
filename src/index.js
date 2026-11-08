// admin.betics.io: admin API + static admin app. Reads the central
// platform database; balance changes go to the player's wallet object
// through a private binding with the internal secret.
import { HttpError, fail, json, readJson, viewReal } from './util.js';
import { currentAdmin, login, endSession, clearCookie, setupInfo, setupPassword, setupTotp, publicAdmin, requirePerm } from './auth.js';
import { overview, money, moneyCsv } from './api/money.js';
import { listGames, gameDetail, updateGame } from './api/games.js';
import { listRounds, roundDetail, listPlayers, playerDetail, setPlayerStatus, playersCsv } from './api/players.js';
import { treasury, treasurySend, updateTreasuryAddress, setPayoutsPaused, updateTicsSettings, ticsPayments, cancelWithdrawal, releaseBlockedWithdrawal, assignDeposit, markHouseFunding, fees, updateFees } from './api/tics.js';
import { analytics } from './api/analytics.js';
import { listAlerts, resolveAlert, updateLimits, runChecks, sendTelegram, checkBank } from './api/alerts.js';
import { createMessage, listMessages, stopMessage, audiencePreview, sendScheduled } from './api/messages.js';
import { bank, updateTreasury } from './api/bank.js';
import { paymentsOverview, withdrawalAction, updatePayments } from './api/payments.js';
import { getSettings, updateCurrency, updateMode, createAdmin, setupLinkFor, updateAdmin, auditLog } from './api/settings.js';

const SECURITY = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
function secure(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function checkOrigin(request) {
  if (['GET', 'HEAD'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) fail(403, 'Cross-site request refused.');
}

const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, auth });

// Critical alerts raised by a request (new owner, setup done, owner on a new device, treasury address
// changed, treasury send, money returned, payouts resumed, codes locked) go to Telegram at once, not on
// the next cron: handleApi calls this after every request that changes something (also when it failed,
// since a refused request can raise an alert too). Sent before anyone can mark the alert resolved.
const notifyNow = (db, env) => sendTelegram(db, env).catch((e) => console.error('telegram failed', e));

// A path id that is not valid percent-encoding is the caller's mistake (400), not ours (500).
function decodeId(raw) {
  try { return decodeURIComponent(raw); } catch { fail(400, 'That id is not valid.', 'bad_id'); }
}

route('POST', '/api/auth/login', async ({ db, env, request }) => {
  const result = await login(db, env, request, await readJson(request));
  if (result.needCode) return json({ needCode: true });
  return json({ admin: publicAdmin(result.admin) }, 200, result.cookies.map(c => ['Set-Cookie', c]));
}, { auth: false });
route('POST', '/api/auth/logout', async ({ db, request }) => { await endSession(db, request); return json({ ok: true }, 200, { 'Set-Cookie': clearCookie }); }, { auth: false });
route('POST', '/api/auth/setup/info', async ({ db, request }) => json(await setupInfo(db, (await readJson(request)).token)), { auth: false });
route('POST', '/api/auth/setup/password', async ({ db, env, request }) => { const b = await readJson(request); return json(await setupPassword(db, env, b.token, b.password)); }, { auth: false });
route('POST', '/api/auth/setup/code', async ({ db, env, request }) => {
  const b = await readJson(request);
  const result = await setupTotp(db, request, b.token, b.code, Date.now(), env);
  return json({ admin: publicAdmin(result.admin) }, 200, result.cookies.map(c => ['Set-Cookie', c]));
}, { auth: false });
route('GET', '/api/me', async ({ admin }) => json({ admin }));

route('GET', '/api/overview', async ({ db, url }) => json(await overview(db, url)));
route('GET', '/api/money', async ({ db, url }) => json(await money(db, url)));
route('GET', '/api/money.csv', async ({ db, url, admin }) => {
  requirePerm(admin, 'money:export');
  return new Response(moneyCsv(await money(db, url)), { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="casino-money.csv"', 'Cache-Control': 'no-store' } });
});
route('GET', '/api/bank', async ({ db, env }) => json(await bank(db, env)));
route('PUT', '/api/bank', async ({ db, env, admin, request }) => json(await updateTreasury(db, admin, await readJson(request), env)));
route('GET', '/api/payments', async ({ db, env, url }) => json(await paymentsOverview(db, env, url)));
route('POST', '/api/withdrawals/:id', async ({ db, env, admin, params, request }) => json(await withdrawalAction(db, env, admin, params.id, await readJson(request))));
route('PUT', '/api/payments/settings', async ({ db, env, admin, request }) => json(await updatePayments(db, admin, await readJson(request), env)));
route('GET', '/api/tics/treasury', async ({ db, env, admin }) => json(await treasury(db, env, admin)));
route('POST', '/api/tics/treasury/send', async ({ db, env, admin, request }) => json(await treasurySend(db, env, admin, await readJson(request))));
route('PUT', '/api/tics/treasury/address', async ({ db, env, admin, request }) => json(await updateTreasuryAddress(db, env, admin, await readJson(request))));
route('POST', '/api/tics/payouts/pause', async ({ db, env, admin, request }) => json(await setPayoutsPaused(db, env, admin, await readJson(request))));
route('PUT', '/api/tics/settings', async ({ db, env, admin, request }) => json(await updateTicsSettings(db, admin, await readJson(request), env)));
route('GET', '/api/tics/fees', async ({ db, admin }) => json(await fees(db, admin)));
route('PUT', '/api/tics/fees', async ({ db, env, admin, request }) => json(await updateFees(db, admin, await readJson(request), env)));
route('GET', '/api/tics/payments', async ({ db, url }) => json(await ticsPayments(db, url)));
route('POST', '/api/tics/withdrawals/:id/cancel', async ({ db, env, admin, params }) => json(await cancelWithdrawal(db, env, admin, decodeId(params.id))));
route('POST', '/api/tics/withdrawals/:id/release', async ({ db, env, admin, params, request }) => json(await releaseBlockedWithdrawal(db, env, admin, decodeId(params.id), await readJson(request))));
route('POST', '/api/tics/deposits/:id/assign', async ({ db, env, admin, params, request }) => json(await assignDeposit(db, env, admin, decodeId(params.id), await readJson(request))));
route('POST', '/api/tics/deposits/:id/house-funding', async ({ db, env, admin, params, request }) => json(await markHouseFunding(db, env, admin, decodeId(params.id), await readJson(request))));
route('GET', '/api/games', async ({ db, url }) => json({ games: await listGames(db, viewReal(url)) }));
route('GET', '/api/games/:id', async ({ db, params, url }) => json(await gameDetail(db, params.id, viewReal(url))));
route('PUT', '/api/games/:id', async ({ db, env, admin, params, request }) => json(await updateGame(db, admin, params.id, await readJson(request), env)));
route('GET', '/api/rounds', async ({ db, url }) => json(await listRounds(db, url)));
route('GET', '/api/rounds/:id', async ({ db, params }) => json(await roundDetail(db, decodeId(params.id))));
route('GET', '/api/players', async ({ db, url, admin }) => json(await listPlayers(db, url, admin)));
route('GET', '/api/players.csv', async ({ db, url, admin }) => {
  requirePerm(admin, 'money:export');
  const { csv } = await playersCsv(db, url, admin);
  return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="qu-betics-players.csv"', 'Cache-Control': 'no-store' } });
});
route('GET', '/api/players/:id', async ({ db, params, url, admin }) => json(await playerDetail(db, params.id, viewReal(url), admin)));
route('POST', '/api/players/:id/status', async ({ db, admin, params, request }) => json(await setPlayerStatus(db, admin, params.id, await readJson(request))));
route('GET', '/api/analytics', async ({ db, url }) => json(await analytics(db, url)));
route('GET', '/api/alerts', async ({ db, url }) => json(await listAlerts(db, url)));
route('POST', '/api/alerts/:id/resolve', async ({ db, admin, params }) => json(await resolveAlert(db, admin, Number(params.id))));
route('POST', '/api/alerts/check', async ({ db, env, admin }) => { requirePerm(admin, 'alert:resolve'); const n = await runChecks(db, new Date(), { force: true }); await checkBank(db, env); await sendTelegram(db, env); return json({ checked: n }); });
route('PUT', '/api/settings/limits', async ({ db, env, admin, request }) => json(await updateLimits(db, admin, await readJson(request), env)));
route('GET', '/api/messages', async ({ db }) => json(await listMessages(db)));
route('POST', '/api/messages', async ({ db, admin, request }) => json(await createMessage(db, admin, await readJson(request))));
route('POST', '/api/messages/audience', async ({ db, request }) => json(await audiencePreview(db, await readJson(request))));
route('POST', '/api/messages/:id/stop', async ({ db, admin, params }) => json(await stopMessage(db, admin, Number(params.id))));
route('GET', '/api/settings', async ({ db, admin }) => json(await getSettings(db, admin)));
route('PUT', '/api/settings/currency', async ({ db, admin, request }) => json(await updateCurrency(db, admin, await readJson(request))));
route('PUT', '/api/settings/mode', async ({ db, admin, request }) => json({ mode: await updateMode(db, admin, await readJson(request)) }));
route('POST', '/api/admins', async ({ db, env, admin, request, url }) => { return json(await createAdmin(db, env, admin, await readJson(request), url.origin)); });
route('POST', '/api/admins/:id/setup-link', async ({ db, env, admin, params, request, url }) => { return json(await setupLinkFor(db, env, admin, Number(params.id), url.origin, await readJson(request))); });
route('PUT', '/api/admins/:id', async ({ db, env, admin, params, request }) => { return json(await updateAdmin(db, env, admin, Number(params.id), await readJson(request))); });
route('GET', '/api/audit', async ({ db, url, admin }) => json(await auditLog(db, admin, url)));

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const view = request.headers.get('x-view-mode');
  if ((view === 'real' || view === 'demo') && !url.searchParams.has('money')) url.searchParams.set('money', view === 'real' ? 'real' : 'play');
  let changing = false;
  try {
    checkOrigin(request);
    const db = env.DB;
    let found = null, params = {};
    for (const r of routes) {
      if (r.method !== request.method) continue;
      const m = url.pathname.match(r.re);
      if (m) { found = r; params = m.groups || {}; break; }
    }
    // Sign in is checked before 'not found', so a stranger gets the same 401 for every path except the
    // sign-in and setup routes and cannot map which API routes exist.
    const admin = !found || found.auth ? await currentAdmin(db, request) : null;
    if ((!found || found.auth) && !admin) fail(401, 'Please sign in.', 'signed_out');
    if (!found) fail(404, 'Not found.');
    changing = !['GET', 'HEAD'].includes(request.method);
    return await found.handler({ db, env, request, url, admin, params });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, code: error.code || null }, error.status);
    console.error('admin api error', error);
    return json({ error: 'Something went wrong on our side. Try again.' }, 500);
  } finally {
    if (changing) await notifyNow(env.DB, env);
  }
}

// What anyone may load: the sign-in page, its styles and the sign-in / first-time setup scripts.
// Everything else (the control panel's code) is sent only to a signed-in admin; anyone else gets a
// plain 404, so the panel's screens never reach a stranger's browser. Exact matches only: any other
// spelling of a path (encoded, doubled slashes, other case) simply needs a signed-in admin.
export const PUBLIC_FILES = new Set(['/', '/index.html', '/styles.css', '/robots.txt',
  '/js/signin.js', '/js/signin-core.js', '/js/views/auth.js', '/js/qr.js', '/js/theme-boot.js']);
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function serveAsset(request, env) {
  const url = new URL(request.url);
  if (!['GET', 'HEAD'].includes(request.method)) return notFound();
  if (PUBLIC_FILES.has(url.pathname)) return env.ASSETS.fetch(request);
  const admin = await currentAdmin(env.DB, request);
  if (!admin) return notFound();
  const res = await env.ASSETS.fetch(request);
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return secure(await handleApi(request, env));
    return secure(await serveAsset(request, env));
  },
  async scheduled(event, env, ctx) {
    // Every 2 minutes: scheduled messages and Telegram (both cheap, indexed). The alert checks and
    // the bank check run at most every 10 minutes (runChecks returns null when it skipped).
    ctx.waitUntil((async () => {
      await sendScheduled(env.DB);
      const ran = await runChecks(env.DB, new Date(event.scheduledTime || Date.now()));
      if (ran != null) await checkBank(env.DB, env).catch((e) => console.error('bank check failed', e));
      await sendTelegram(env.DB, env);
    })());
  },
};
