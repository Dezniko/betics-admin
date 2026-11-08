// $TICS on Ethereum: treasury, payout settings, the automatic payouts queue,
// deposits seen on chain and assigning unmatched deposits.
// Payouts are sent by the separate betics-payouts Worker (service binding
// PAYOUTS); this panel only asks it to act and never sees the wallet key.
import { fail, isInt, text, tics } from '../util.js';
import { requirePerm, confirmSensitive, stepUp, requireTreasuryReady } from '../auth.js';
import { audit, writeAudit, raiseAlert } from '../audit.js';
import { normAddress } from '../eth.js';
import { owedBreakdown, freeFloat, protectedUnits, freeToSend, unresolvedDeposits } from './money.js';

export const DEFAULT_TICS = {
  chainId: 1, token: '0x551ecfdba071cb6541f642cb90a073c8c158df05', casinoWallet: null, treasuryAddress: null, confirmations: 12, startBlock: null,
  quickConfirmations: 3, quickDepositMaxUnits: 100_000_000, quickDailyMaxUnits: null,
  realEnabled: false, depositsOpen: true, withdrawalsOpen: true, payoutsPaused: false, pausedReason: null,
  minDepositUnits: 100, minWithdrawalUnits: 10_000_000, feesEnabled: true, gasFeeMarginPct: 20, fallbackFeeUnits: 50000, coolingSeconds: 120,
  largeWithdrawalAlertUnits: 5_000_000, lowFloatUnits: 0, highFloatUnits: 0, lowEthWei: '5000000000000000', demoStartUnits: 10_000_000,
  maxSpinExposurePct: 25, treasuryAddressSetAt: null,
};
// After the treasury address changes, sends wait this long (the payouts Worker enforces it too).
export const TREASURY_ADDRESS_DELAY_MS = 48 * 3600e3;
// Treasury rows that are not finished yet; only one may be open at a time.
const OPEN_TREASURY = "('holding','queued','signing','sending')";
// Only these keys ever leave the server (the settings row could in theory carry anything).
const VISIBLE = Object.keys(DEFAULT_TICS);
const MAX = Number.MAX_SAFE_INTEGER;
const PAYOUT_GAS = 52000n, // must match ~/betics worker/wallet.js withdrawalFee
  GAS_MAX_AGE_MS = 10 * 60e3, PRICE_MAX_AGE_MS = 60 * 60e3;

export async function ticsSettings(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'tics_payments'").first();
  const all = { ...DEFAULT_TICS, ...(row ? JSON.parse(row.value) : {}) };
  return Object.fromEntries(VISIBLE.map(k => [k, all[k]]));
}
// Merge only the changed keys, so a pause written by the payouts Worker at the same moment is never lost.
const patchTics = (db, changes) => db.prepare(`INSERT INTO settings (key, value) VALUES ('tics_payments', ?)
  ON CONFLICT(key) DO UPDATE SET value = json_patch(value, excluded.value), updated_at = datetime('now')`).bind(JSON.stringify(changes));

export async function chainState(db, key) {
  const row = await db.prepare('SELECT value, updated_at FROM chain_state WHERE key = ?').bind(key).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

// Same rule as the game's withdrawal quote: the live gas of one payout priced in TICS,
// plus the margin. Off: no fee. Old or missing data: the fallback fee.
export function feeQuote(settings, gas, prices, now = Date.now()) {
  if (settings.feesEnabled === false) return { feeUnits: 0, source: 'off' };
  const fallback = Math.max(0, settings.fallbackFeeUnits || 0);
  const gasStale = !gas || !(now - gas.at <= GAS_MAX_AGE_MS);
  const priceStale = !prices || !(now - prices.at <= PRICE_MAX_AGE_MS) || !(prices.ticsEth > 0);
  const ages = { gasAt: gas?.at ?? null, pricesAt: prices?.at ?? null };
  if (gasStale || priceStale) return { feeUnits: fallback, source: 'fallback', gasStale, priceStale, ...ages };
  let gasWei;
  try { gasWei = PAYOUT_GAS * ((BigInt(gas.baseFeeWei) * 5n) / 4n + BigInt(gas.tipWei)); } catch { return { feeUnits: fallback, source: 'fallback', gasStale: true, priceStale, ...ages }; }
  const margin = 1 + Math.max(0, settings.gasFeeMarginPct ?? 20) / 100;
  const units = Math.ceil((Number(gasWei) / 1e18 / prices.ticsEth) * 100 * margin);
  return { feeUnits: units, source: prices.source || 'live', gasWei: gasWei.toString(), ticsEth: prices.ticsEth, ticsUsd: prices.ticsUsd ?? null,
    baseFeeWei: String(gas.baseFeeWei), tipWei: String(gas.tipWei), ...ages };
}

// ---------- the payouts Worker ----------
// extraHeaders: e.g. X-Treasury-Secret, which the payouts Worker requires for POST /treasury.
export async function payouts(env, path, body, extraHeaders = {}) {
  if (!env.PAYOUTS) return { ok: false, problem: 'not_connected', error: 'The payouts service is not connected to this admin panel (no PAYOUTS binding here).' };
  if (!env.INTERNAL_SECRET) return { ok: false, problem: 'no_secret', error: 'The internal secret is not set on this admin panel, so the payouts service cannot be reached.' };
  let res;
  try {
    res = await env.PAYOUTS.fetch(new Request(`https://payouts${path}`, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...extraHeaders, 'X-Internal-Secret': env.INTERNAL_SECRET }, body: body ? JSON.stringify(body) : undefined }));
  } catch {
    return { ok: false, problem: 'unreachable', error: 'The payouts service is unreachable right now.' };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, status: res.status, data };
  if (res.status >= 500 && !data.error) return { ok: false, problem: 'unreachable', status: res.status, error: 'The payouts service is unreachable right now.' };
  if (res.status === 404 && (data.error === 'not found' || !data.error)) return { ok: false, problem: 'refused', status: 404, error: 'The payouts service refused the request. Check that both Workers have the same internal secret.' };
  return { ok: false, problem: 'error', status: res.status, error: data.error || `The payouts service answered ${res.status}.` };
}
const STATUS_KEYS = ['casinoWallet', 'treasuryAddress', 'paused', 'pausedReason', 'chainId', 'queue', 'keyConfigured', 'tokenUnits', 'ethWei', 'owedUnits', 'freeUnits', 'safeUnits', 'safeUnknown', 'spinHoldUnits'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && k in o).map(k => [k, o[k]]));

// When a treasury send becomes possible again after an address change (ms), or null.
export function treasurySendableAt(settings) {
  const at = settings.treasuryAddressSetAt ? Date.parse(settings.treasuryAddressSetAt) : NaN;
  return Number.isFinite(at) ? at + TREASURY_ADDRESS_DELAY_MS : null;
}
const utc = ms => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

// ---------- Treasury page (owner only) ----------
export async function treasury(db, env, admin) {
  requirePerm(admin, 'treasury:manage');
  const [settings, float, gas, prices, sends, owed, me, unresolved] = await Promise.all([
    ticsSettings(db), chainState(db, 'float'), chainState(db, 'gas'), chainState(db, 'prices'),
    db.prepare("SELECT id, to_address, amount_units, status, tx_hash, requested_by, last_error, created_at, sent_at FROM chain_withdrawals WHERE kind = 'treasury' ORDER BY created_at DESC LIMIT 20").all(),
    owedBreakdown(db),
    db.prepare('SELECT treasury_ok_after FROM admins WHERE id = ?').bind(admin.id).first(),
    unresolvedDeposits(db),
  ]);
  const st = await payouts(env, '/status');
  const sendable = treasurySendableAt(settings);
  const mine = me?.treasury_ok_after ? Date.parse(me.treasury_ok_after.replace(' ', 'T') + 'Z') : null;
  // Protected balance and free to send follow the same rule as the treasury precheck (and the payouts signer).
  return { settings, status: st.ok ? pick(st.data, STATUS_KEYS) : null, statusProblem: st.ok ? null : { problem: st.problem, error: st.error },
    float, owedUnitsDb: owed.owedUnits, owed, freeUnitsDb: freeFloat(float?.tokenUnits ?? null, owed),
    protectedUnitsDb: protectedUnits(float), freeToSendUnitsDb: freeToSend(float, owed), safeUnknown: !!float?.safeUnknown,
    unresolved: { n: unresolved?.n || 0, units: unresolved?.units || 0 },
    treasurySendableAt: sendable && sendable > Date.now() ? new Date(sendable).toISOString() : null,
    adminTreasuryOkAt: mine && mine > Date.now() ? new Date(mine).toISOString() : null,
    openSend: sends.results.find(x => ['holding', 'queued', 'signing', 'sending'].includes(x.status)) || null,
    fee: feeQuote(settings, gas, prices), sends: sends.results, checkedAt: new Date().toISOString() };
}

export async function treasurySend(db, env, admin, body, now = Date.now()) {
  requirePerm(admin, 'treasury:manage');
  const units = body.amountUnits;
  if (!isInt(units, 1, MAX)) fail(400, 'Enter an amount above zero.');
  // The payouts Worker only starts a treasury send with its second secret (TREASURY_SECRET, same value on both
  // Workers). Checked first, so nobody spends a code on a send that cannot go out.
  if (!env.TREASURY_SECRET) fail(503, 'Treasury sends are not set up yet.', 'no_treasury_secret');
  const settings = await ticsSettings(db);
  if (!settings.treasuryAddress) fail(400, 'Set a treasury address first.');
  await requireTreasuryReady(db, admin, now);
  const sendable = treasurySendableAt(settings);
  if (sendable && sendable > now) fail(409, `The treasury address was changed recently. For safety, sends to it open at ${utc(sendable)}.`, 'treasury_address_new');
  const open = await db.prepare(`SELECT id, status FROM chain_withdrawals WHERE kind = 'treasury' AND status IN ${OPEN_TREASURY} LIMIT 1`).first();
  if (open) fail(409, 'Another treasury send is still in progress. Wait until it is sent (or failed) before starting a new one.', 'treasury_busy');
  // Free to send = PROTECTED wallet balance (what the deposit scan has classified as the casino's own; security
  // review F1) - owed (balances, unsent withdrawals, treasury in flight, unresolved customer deposits) - open spin
  // holds. Advisory only: the payouts signer computes the same figure from the chain and refuses above it, so this
  // check must never be more permissive than that one.
  const float = await chainState(db, 'float');
  if (float?.tokenUnits == null) fail(409, 'The casino wallet balance is not known yet. Try again in a minute.', 'no_float');
  if (float.safeUnknown) fail(409, 'The casino wallet balance is not classified yet. Try again in a few minutes.', 'float_unclassified');
  const owed = await owedBreakdown(db, now);
  const free = freeToSend(float, owed);
  if (units > free) fail(400, `Only ${tics(Math.max(0, free))} is free to send. The rest is owed to players, not yet classified as the casino's own, or held for spins in play.`, 'not_free');
  await confirmSensitive(db, env, admin, { code: body.code });
  const id = crypto.randomUUID();
  // Written before the payouts Worker is called, so the attempt is on record whatever happens next.
  await writeAudit(db, admin, 'tics.treasury_send_intent', { target: `treasury:${id}`, after: { id, amountUnits: units, to: settings.treasuryAddress, freeUnits: free, protectedUnits: protectedUnits(float), owedUnits: owed.owedUnits, unresolvedUnits: owed.unresolvedUnits } });
  const r = await payouts(env, '/treasury', { id, amountUnits: units, requestedBy: admin.email }, { 'X-Treasury-Secret': env.TREASURY_SECRET });
  if (!r.ok) {
    await writeAudit(db, admin, 'tics.treasury_send_refused', { target: `treasury:${id}`, after: { amountUnits: units, to: settings.treasuryAddress, error: r.error } });
    fail(r.status && r.status < 500 && r.problem === 'error' ? 400 : 502, r.error);
  }
  await db.batch([
    audit(db, admin, 'tics.treasury_send', { target: `treasury:${id}`, after: { id, amountUnits: units, to: settings.treasuryAddress, result: r.data } }),
    raiseAlert(db, { type: 'tics_treasury_send', severity: 'critical', key: `tics_treasury_send:${id}`, title: `Treasury send started: ${tics(units)}`,
      details: `${admin.email} sent ${tics(units)} from the casino wallet to the treasury ${settings.treasuryAddress}. If this was not you, pause payouts and sign in now.` }),
  ]);
  return { id, amountUnits: units, to: settings.treasuryAddress, result: r.data };
}

export async function updateTreasuryAddress(db, env, admin, body, now = Date.now()) {
  requirePerm(admin, 'treasury:manage');
  const address = normAddress(body.address);
  if (!address) fail(400, 'That is not a valid Ethereum address. It is 0x followed by 40 characters; if it has capital letters, they must be exactly as copied.');
  if (address === '0x' + '0'.repeat(40)) fail(400, 'That is the zero address. Funds sent there are lost.');
  const before = await ticsSettings(db);
  if (before.casinoWallet && address === before.casinoWallet) fail(400, 'The treasury must be a different wallet from the casino wallet.');
  if (address === before.token) fail(400, 'That is the TICS token contract, not a wallet.');
  await requireTreasuryReady(db, admin, now);
  await confirmSensitive(db, env, admin, { code: body.code, password: body.password, needPassword: true });
  if (before.treasuryAddress === address) return { treasuryAddress: address, unchanged: true };
  const stamp = new Date(now).toISOString();
  const usable = utc(now + TREASURY_ADDRESS_DELAY_MS);
  await db.batch([
    patchTics(db, { treasuryAddress: address, treasuryAddressSetAt: stamp }),
    audit(db, admin, 'tics.treasury_address', { target: 'settings:tics_payments', before: { treasuryAddress: before.treasuryAddress, treasuryAddressSetAt: before.treasuryAddressSetAt }, after: { treasuryAddress: address, treasuryAddressSetAt: stamp } }),
    db.prepare(`INSERT OR IGNORE INTO alerts (type, severity, title, details, dedupe_key) VALUES ('tics_treasury_changed', 'critical', ?, ?, ?)`)
      .bind('The treasury address was changed', `${admin.email} changed the treasury address from ${before.treasuryAddress || 'none'} to ${address}. Sends to it open at ${usable}. If this was not you, pause payouts and sign in now.`, `tics_treasury_changed:${stamp}:${address}`),
  ]);
  return { treasuryAddress: address, treasuryAddressSetAt: stamp, sendableAt: new Date(now + TREASURY_ADDRESS_DELAY_MS).toISOString() };
}

export async function setPayoutsPaused(db, env, admin, body) {
  requirePerm(admin, 'treasury:manage');
  if (typeof body.paused !== 'boolean') fail(400, 'paused must be true or false.');
  if (body.paused && !text(body.reason, 3, 200)) fail(400, 'Write a short reason (3 to 200 characters).');
  const before = await ticsSettings(db);
  // Pausing is one click (it only stops money moving); resuming needs the password and a fresh code.
  if (!body.paused && before.payoutsPaused) await stepUp(db, env, admin, body);
  const changes = { payoutsPaused: body.paused, pausedReason: body.paused ? body.reason.trim() : null };
  const resuming = !body.paused && before.payoutsPaused;
  await db.batch([patchTics(db, changes),
    audit(db, admin, body.paused ? 'tics.payouts_pause' : 'tics.payouts_resume', { target: 'settings:tics_payments',
      before: { payoutsPaused: before.payoutsPaused, pausedReason: before.pausedReason }, after: changes, reason: body.paused ? body.reason.trim() : (text(body.reason, 1, 200) ? body.reason.trim() : null) }),
    ...(resuming ? [raiseAlert(db, { type: 'tics_payouts_resumed', severity: 'critical', key: `tics_payouts_resumed:${Date.now()}:${admin.id}`, title: 'Automatic payouts were resumed',
      details: `${admin.email} resumed automatic payouts${before.pausedReason ? ` (they were paused: ${before.pausedReason})` : ''}. If this was not you, pause payouts and sign in now.` })] : [])]);
  // Nudge the queue so waiting payouts go out straight away. Not fatal if it is unreachable.
  if (!body.paused) await payouts(env, '/process', {}).catch(() => null);
  return { settings: await ticsSettings(db) };
}

const QUICK_MAX_UNITS = 100_000_000; // 1,000,000 TICS
const MIN_WITHDRAWAL_MAX_UNITS = 10_000_000; // 100,000 TICS: a higher minimum would lock most players' money in
const BOOLS = ['realEnabled', 'depositsOpen', 'withdrawalsOpen', 'feesEnabled'];
const UNITS = { minDepositUnits: [1, MAX], minWithdrawalUnits: [1, MIN_WITHDRAWAL_MAX_UNITS], fallbackFeeUnits: [0, MAX], largeWithdrawalAlertUnits: [0, MAX],
  lowFloatUnits: [0, MAX], highFloatUnits: [0, MAX], demoStartUnits: [0, MAX], quickDepositMaxUnits: [0, QUICK_MAX_UNITS] };
const PROTECTED = { treasuryAddress: 'Change the treasury address with its own form.', casinoWallet: 'The casino wallet is set by the setup script.', token: 'The token cannot be changed here.',
  chainId: 'The chain cannot be changed here.', payoutsPaused: 'Use the pause switch.', pausedReason: 'Use the pause switch.', treasuryAddressSetAt: 'Set when the treasury address changes.' };
// Changing any of these needs the password and a fresh code (they decide when money is real, final or exposed).
// (startBlock moves where deposits are scanned from; the withdrawal minimum, fees and margin decide what players get.)
// Fees on/off, the smallest deposit and the alert levels decide what players pay and when the owners hear
// about money moving, so they need it too. Only the demo start balance (play money) changes without it.
export const SENSITIVE_TICS = ['realEnabled', 'withdrawalsOpen', 'depositsOpen', 'confirmations', 'quickConfirmations', 'quickDepositMaxUnits', 'quickDailyMaxUnits',
  'maxSpinExposurePct', 'coolingSeconds', 'startBlock', 'minWithdrawalUnits', 'fallbackFeeUnits', 'gasFeeMarginPct',
  'feesEnabled', 'minDepositUnits', 'lowFloatUnits', 'highFloatUnits', 'largeWithdrawalAlertUnits', 'lowEthWei'];
const NAMES = { minDepositUnits: 'Smallest deposit', minWithdrawalUnits: 'Minimum withdrawal', fallbackFeeUnits: 'Fallback fee',
  largeWithdrawalAlertUnits: 'Large withdrawal alert', lowFloatUnits: 'Low float alert', highFloatUnits: 'High float alert', demoStartUnits: 'Demo start balance', quickDepositMaxUnits: 'Quick deposits up to' };

export async function updateTicsSettings(db, admin, input, env = {}) {
  requirePerm(admin, 'settings:edit');
  const { code, password, ...body } = input;
  for (const k of Object.keys(body)) {
    if (PROTECTED[k]) fail(400, PROTECTED[k]);
    if (!VISIBLE.includes(k)) fail(400, `Unknown setting: ${k}.`);
  }
  const before = await ticsSettings(db), changes = {};
  for (const k of BOOLS) if (k in body) { if (typeof body[k] !== 'boolean') fail(400, `${k} must be true or false.`); changes[k] = body[k]; }
  for (const [k, [min, max]] of Object.entries(UNITS)) if (k in body) {
    if (!isInt(body[k], min, max)) fail(400, `${NAMES[k]} must be a whole amount of 0.01 TICS${min ? ', above zero' : ', zero or more'}${max === QUICK_MAX_UNITS ? ', at most 1,000,000 TICS' : max === MIN_WITHDRAWAL_MAX_UNITS ? ', at most 100,000 TICS' : ''}.`);
    changes[k] = body[k];
  }
  if ('confirmations' in body) { if (!isInt(body.confirmations, 6, 200)) fail(400, 'Confirmations must be 6 to 200.'); changes.confirmations = body.confirmations; }
  if ('quickConfirmations' in body) { if (!isInt(body.quickConfirmations, 2, 200)) fail(400, 'Confirmations for quick deposits must be 2 to 200.'); changes.quickConfirmations = body.quickConfirmations; }
  if ('maxSpinExposurePct' in body) { if (!isInt(body.maxSpinExposurePct, 1, 50)) fail(400, 'The most one spin can win must be 1 to 50 percent of the free float.'); changes.maxSpinExposurePct = body.maxSpinExposurePct; }
  if ('coolingSeconds' in body) { if (!isInt(body.coolingSeconds, 60, 7 * 86400)) fail(400, 'The cooling delay must be 60 seconds to 7 days.'); changes.coolingSeconds = body.coolingSeconds; }
  if ('gasFeeMarginPct' in body) { if (typeof body.gasFeeMarginPct !== 'number' || !(body.gasFeeMarginPct >= 0 && body.gasFeeMarginPct <= 200)) fail(400, 'The gas fee margin must be 0 to 200 percent.'); changes.gasFeeMarginPct = body.gasFeeMarginPct; }
  if ('lowEthWei' in body) { if (typeof body.lowEthWei !== 'string' || !/^(0|[1-9]\d{0,29})$/.test(body.lowEthWei)) fail(400, 'The low ETH alert must be a whole number of wei.'); changes.lowEthWei = body.lowEthWei; }
  // Rolling 24 h quick-lane cap per sending wallet (game: quickDailyMaxUnits). Empty = same as one quick deposit.
  if ('quickDailyMaxUnits' in body) { if (body.quickDailyMaxUnits !== null && !isInt(body.quickDailyMaxUnits, 0, QUICK_MAX_UNITS)) fail(400, 'Quick deposits per wallet per 24 hours must be 0 to 1,000,000 TICS, or empty.'); changes.quickDailyMaxUnits = body.quickDailyMaxUnits; }
  if ('startBlock' in body) { if (body.startBlock !== null && !isInt(body.startBlock, 0, 1e12)) fail(400, 'The start block must be a block number, or empty.'); changes.startBlock = body.startBlock; }
  const next = { ...before, ...changes };
  if (next.quickConfirmations > next.confirmations) fail(400, 'Quick deposits cannot need more confirmations than big deposits.');
  if (next.highFloatUnits > 0 && next.lowFloatUnits > 0 && next.highFloatUnits <= next.lowFloatUnits) fail(400, 'The high float alert must be above the low float alert.');
  if (('fallbackFeeUnits' in changes || 'minWithdrawalUnits' in changes) && next.fallbackFeeUnits >= next.minWithdrawalUnits) fail(400, 'The fallback fee must be less than the minimum withdrawal.');
  const changed = Object.keys(changes).filter(k => JSON.stringify(changes[k]) !== JSON.stringify(before[k]));
  if (!changed.length) return { settings: before, changed };
  if (changed.some(k => SENSITIVE_TICS.includes(k))) await stepUp(db, env, admin, { code, password });
  // json_patch removes a key set to null; startBlock null then reads as the default (null), which is the same thing.
  await db.batch([patchTics(db, Object.fromEntries(changed.map(k => [k, changes[k]]))),
    audit(db, admin, 'settings.tics_payments', { target: 'settings:tics_payments', before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, changes[k]])) })]);
  return { settings: await ticsSettings(db), changed };
}

// ---------- Fees page ----------
export async function fees(db, admin) {
  requirePerm(admin, 'settings:edit');
  const [settings, gas, prices] = await Promise.all([ticsSettings(db), chainState(db, 'gas'), chainState(db, 'prices')]);
  return { settings: pick(settings, ['feesEnabled', 'gasFeeMarginPct', 'fallbackFeeUnits', 'minWithdrawalUnits']), quote: feeQuote(settings, gas, prices), gas, prices, checkedAt: new Date().toISOString() };
}
export async function updateFees(db, admin, body, env = {}) {
  for (const k of Object.keys(body)) if (!['feesEnabled', 'gasFeeMarginPct', 'fallbackFeeUnits', 'code', 'password'].includes(k)) fail(400, `Unknown fee setting: ${k}.`);
  await updateTicsSettings(db, admin, body, env);
  return fees(db, admin);
}

// ---------- TICS payments: payouts queue and deposits ----------
const WD_STATUSES = ['holding', 'queued', 'signing', 'sending', 'blocked', 'cancelling', 'sent', 'failed', 'cancelled'];
const DEP_STATUSES = ['credited', 'unmatched', 'below_min', 'assigned', 'ignored'];
const clamp = v => Math.max(1, Math.min(200, Number(v) || 100));

export async function ticsPayments(db, url) {
  const q = url.searchParams;
  const wd = q.get('status') || 'open', dep = q.get('deposits') || 'all';
  const wWhere = wd === 'open' ? "w.status IN ('holding','queued','signing','sending','blocked','cancelling','failed')" : wd === 'all' ? '1=1' : WD_STATUSES.includes(wd) ? 'w.status = ?' : fail(400, 'Unknown status.');
  const dWhere = dep === 'all' ? '1=1' : DEP_STATUSES.includes(dep) ? 'd.status = ?' : fail(400, 'Unknown deposit status.');
  const kind = ['player', 'treasury'].includes(q.get('kind')) ? q.get('kind') : null;
  const wArgs = [...(WD_STATUSES.includes(wd) ? [wd] : []), ...(kind ? [kind] : [])];
  const [settings, withdrawals, deposits, wCounts, dCounts, float, sums, gas, prices, unresolved] = await Promise.all([
    ticsSettings(db),
    db.prepare(`SELECT w.id, w.kind, w.player_id, w.chain_id, w.to_address, w.amount_units, w.fee_units, w.send_units, w.status, w.release_at, w.nonce, w.tx_hashes, w.tx_hash,
      w.attempts, w.last_error, w.requested_by, w.cancelled_by, w.sent_at, w.broadcast_at, w.created_at, w.updated_at, p.wallet_address
      FROM chain_withdrawals w LEFT JOIN players p ON p.id = w.player_id WHERE ${wWhere} ${kind ? 'AND w.kind = ?' : ''} ORDER BY w.created_at DESC LIMIT ?`).bind(...wArgs, clamp(q.get('limit'))).all(),
    db.prepare(`SELECT d.* FROM chain_deposits d WHERE ${dWhere} ORDER BY d.created_at DESC LIMIT ?`).bind(...(dep === 'all' ? [] : [dep]), clamp(q.get('limit'))).all(),
    db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_units),0) AS units FROM chain_withdrawals GROUP BY status').all(),
    db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_units),0) AS units FROM chain_deposits GROUP BY status').all(),
    chainState(db, 'float'),
    db.prepare(`SELECT (SELECT COALESCE(SUM(amount_units),0) FROM chain_deposits WHERE status IN ('credited','assigned') AND created_at >= datetime('now','-30 days')) AS dep30,
      (SELECT COALESCE(SUM(send_units),0) FROM chain_withdrawals WHERE kind = 'player' AND status = 'sent' AND created_at >= datetime('now','-30 days')) AS wd30,
      (SELECT COALESCE(SUM(fee_units),0) FROM chain_withdrawals WHERE kind = 'player' AND status = 'sent' AND created_at >= datetime('now','-30 days')) AS fees30`).first(),
    chainState(db, 'gas'), chainState(db, 'prices'), unresolvedDeposits(db),
  ]);
  return {
    unresolved: { n: unresolved?.n || 0, units: unresolved?.units || 0 },
    settings: pick(settings, ['chainId', 'payoutsPaused', 'pausedReason', 'coolingSeconds', 'realEnabled', 'depositsOpen', 'withdrawalsOpen', 'feesEnabled']),
    withdrawals: withdrawals.results.map(w => ({ ...w, tx_hashes: (() => { try { return JSON.parse(w.tx_hashes || '[]'); } catch { return []; } })() })),
    deposits: deposits.results,
    counts: { withdrawals: Object.fromEntries(wCounts.results.map(c => [c.status, { n: c.n, units: c.units }])), deposits: Object.fromEntries(dCounts.results.map(c => [c.status, { n: c.n, units: c.units }])) },
    totals: sums, float, fee: feeQuote(settings, gas, prices),
  };
}

export async function cancelWithdrawal(db, env, admin, id) {
  requirePerm(admin, 'payments:approve');
  const w = await db.prepare('SELECT * FROM chain_withdrawals WHERE id = ?').bind(id).first();
  if (!w) fail(404, 'No withdrawal with that id.');
  if (w.status !== 'queued') fail(409, 'Only a withdrawal that is still waiting (queued) can be cancelled.');
  const r = await payouts(env, '/cancel', { id, by: admin.email });
  if (!r.ok) fail(r.problem === 'error' ? (r.status === 409 ? 409 : r.status === 404 ? 404 : 400) : 502, r.error);
  await writeAudit(db, admin, 'tics.withdrawal_cancel', { target: `chain_withdrawal:${id}`, before: { status: w.status }, after: { status: 'cancelled', amountUnits: w.amount_units, playerId: w.player_id } });
  return { ok: true, withdrawal: await db.prepare('SELECT * FROM chain_withdrawals WHERE id = ?').bind(id).first() };
}

// Owner, with password + code: give the money of a stopped ('blocked') withdrawal back to the player.
// The payouts Worker refuses if the row was ever signed (it may be on chain).
export async function releaseBlockedWithdrawal(db, env, admin, id, body = {}) {
  requirePerm(admin, 'treasury:manage');
  const w = await db.prepare('SELECT * FROM chain_withdrawals WHERE id = ?').bind(id).first();
  if (!w) fail(404, 'No withdrawal with that id.');
  if (w.status !== 'blocked' || w.kind !== 'player') fail(409, 'Only a stopped player withdrawal can be returned.');
  await confirmSensitive(db, env, admin, { code: body.code, password: body.password, needPassword: true });
  await writeAudit(db, admin, 'tics.withdrawal_release_intent', { target: `chain_withdrawal:${id}`, before: { status: w.status, lastError: w.last_error }, after: { amountUnits: w.amount_units, playerId: w.player_id } });
  const r = await payouts(env, '/resolve', { id, by: admin.email });
  if (!r.ok) fail(r.problem === 'error' ? (r.status === 409 ? 409 : r.status === 404 ? 404 : 400) : 502, r.error);
  await db.batch([
    audit(db, admin, 'tics.withdrawal_release', { target: `chain_withdrawal:${id}`, before: { status: 'blocked' }, after: { status: 'cancelled', amountUnits: w.amount_units, playerId: w.player_id, refundPending: !!r.data?.refundPending } }),
    raiseAlert(db, { type: 'tics_withdrawal_returned', severity: 'critical', key: `tics_withdrawal_returned:${id}`, playerId: w.player_id, title: `A stopped withdrawal was returned to the player: ${tics(w.amount_units)}`,
      details: `${admin.email} returned ${tics(w.amount_units)} of a stopped withdrawal to player ${String(w.player_id).slice(0, 10)}. Check on Etherscan that it was never sent. If this was not you, pause payouts and sign in now.` }),
  ]);
  return { ok: true, withdrawal: await db.prepare('SELECT * FROM chain_withdrawals WHERE id = ?').bind(id).first() };
}

function walletStub(env, playerId) {
  if (!env.WALLETS || !env.INTERNAL_SECRET) fail(502, 'The game wallet service is not connected to this admin panel.');
  return env.WALLETS.get(env.WALLETS.idFromName(playerId));
}

// An unmatched deposit (sent from a wallet that is not a player) credited to an existing player.
// Real TICS move, so it needs the password and a fresh code. Idempotent: the wallet ref is the same for
// every try, and the row is claimed (status 'assigned', this player) before the credit. When the wallet's
// answer is lost the credit may have happened: the row then stays assigned to that player, and only that
// player can be tried again (the same ref makes a second credit impossible).
export async function assignDeposit(db, env, admin, id, body) {
  requirePerm(admin, 'deposit:assign');
  const address = normAddress(body.address || '');
  if (!address) fail(400, 'Enter the wallet address of the player (0x followed by 40 characters).');
  if (!text(body.note, 3, 200)) fail(400, 'Write a short note (3 to 200 characters), for example how you know it is theirs.');
  const note = body.note.trim();
  const dep = await db.prepare('SELECT * FROM chain_deposits WHERE id = ?').bind(id).first();
  if (!dep) fail(404, 'No deposit with that id.');
  if (dep.reversed_at) fail(409, 'This deposit disappeared from the chain after its block was final. It cannot be credited.');
  const player = await db.prepare('SELECT id, wallet_address FROM players WHERE wallet_address = ? OR id = ?').bind(address, address).first();
  if (!player) fail(404, 'No player has connected that wallet yet.');
  if (dep.status === 'assigned') {
    if (dep.player_id !== player.id) fail(409, dep.credited_at ? 'This deposit was already assigned to another player.'
      : 'This deposit is waiting for its credit to another player to be confirmed. Try again for that same player.', 'assigned_other');
    if (dep.credited_at) return { ok: true, duplicate: true, deposit: dep };
  } else if (dep.status !== 'unmatched') fail(409, 'Only an unmatched deposit can be assigned.');
  const wallet = walletStub(env, player.id); // not connected: refused here, before a code is used or the row claimed
  await stepUp(db, env, admin, body);
  if (dep.status === 'unmatched') {
    const claim = await db.prepare("UPDATE chain_deposits SET status = 'assigned', player_id = ?, note = ? WHERE id = ? AND status = 'unmatched' AND reversed_at IS NULL").bind(player.id, note, id).run();
    if ((claim.meta?.changes ?? 0) !== 1) fail(409, 'Someone else is assigning this deposit right now. Reload and check.');
  }
  const settings = await ticsSettings(db);
  const ref = `td:${dep.chain_id}-${dep.tx_hash}-${dep.log_index}`;
  let res, data = {};
  try {
    res = await wallet.fetch(new Request('https://wallet/internal/tics-deposit', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': env.INTERNAL_SECRET },
      body: JSON.stringify({ ref, amountCents: dep.amount_units, playerId: player.id, note, demoStartUnits: settings.demoStartUnits }) }));
    data = await res.json().catch(() => ({}));
  } catch { res = null; }
  if (res && !res.ok && res.status < 500) {
    // The wallet clearly refused, so nothing was credited: put the row back so it can be assigned again.
    if (dep.status === 'unmatched') await db.prepare("UPDATE chain_deposits SET status = 'unmatched', player_id = NULL, note = NULL WHERE id = ? AND status = 'assigned' AND credited_at IS NULL").bind(id).run();
    fail(502, `The wallet did not credit the deposit${data.error ? `: ${data.error}` : ''}. Nothing was changed.`);
  }
  if (!res || !res.ok) {
    // No clear answer: the credit may have happened. Keep it assigned to this player (a retry for them is safe,
    // the ref is the same); giving it to someone else could pay it twice.
    await writeAudit(db, admin, 'tics.deposit_assign_unconfirmed', { target: `chain_deposit:${id}`, before: { status: dep.status, playerId: dep.player_id }, after: { status: 'assigned', playerId: player.id, amountUnits: dep.amount_units, ref }, reason: note });
    fail(502, 'We could not confirm the credit. Try again for the same player.', 'credit_unconfirmed');
  }
  await db.batch([
    // The wallet confirmed the credit: the player balance now carries this money, so the row leaves the unresolved
    // (owed) set. Resolution fields record who settled it and when; an earlier stamp (lost reply, then retry) is kept.
    db.prepare(`UPDATE chain_deposits SET credited_at = COALESCE(credited_at, datetime('now')), resolution = 'assigned',
      resolved_at = COALESCE(resolved_at, datetime('now')), resolved_by = COALESCE(resolved_by, ?) WHERE id = ?`).bind(admin.email, id),
    db.prepare("INSERT INTO events (type, player_id, value_cents, meta) VALUES ('deposit', ?, ?, ?)").bind(player.id, dep.amount_units, JSON.stringify({ currency: 'TICS', tx: dep.tx_hash, assignedBy: admin.email })),
    audit(db, admin, 'tics.deposit_assign', { target: `chain_deposit:${id}`, before: { status: dep.status, playerId: dep.player_id }, after: { status: 'assigned', playerId: player.id, amountUnits: dep.amount_units, ref, duplicate: !!data.duplicate }, reason: note }),
  ]);
  return { ok: true, duplicate: !!data.duplicate, realTicsCents: data.realTicsCents ?? null, deposit: await db.prepare('SELECT * FROM chain_deposits WHERE id = ?').bind(id).first(), amount: tics(dep.amount_units) };
}

// Owner, with password + code: an unmatched (or below-minimum) deposit was the house's own top up, for example
// sent from the owner's exchange account. It stops being owed (security review F2) and is recorded as
// status 'ignored' with resolution 'house_funding'. One conditional UPDATE claims the row, so two owners
// cannot both resolve it and a row that was assigned or credited in the meantime is left alone. No address
// rule is created: an exchange hot wallet may also send other customers' money, so every deposit from it still
// arrives as unmatched and is judged on its own.
export async function markHouseFunding(db, env, admin, id, body = {}) {
  requirePerm(admin, 'deposit:house_funding');
  if (!text(body.note, 3, 200)) fail(400, 'Write a short note (3 to 200 characters), for example which exchange or wallet you sent it from.');
  const note = body.note.trim();
  const dep = await db.prepare('SELECT * FROM chain_deposits WHERE id = ?').bind(id).first();
  if (!dep) fail(404, 'No deposit with that id.');
  if (dep.status === 'ignored' && dep.resolution === 'house_funding') return { ok: true, duplicate: true, deposit: dep, amount: tics(dep.amount_units) };
  if (dep.reversed_at) fail(409, 'This deposit disappeared from the chain after its block was final. There is nothing to resolve.');
  if (dep.credited_at || dep.status === 'credited') fail(409, 'This deposit was credited to a player. It is their money, not house funding.');
  if (dep.status === 'assigned') fail(409, 'This deposit is assigned to a player and waiting for its credit. Finish or check that first.');
  if (!['unmatched', 'below_min'].includes(dep.status)) fail(409, 'Only an unmatched or below-minimum deposit can be marked as house funding.');
  await stepUp(db, env, admin, body);
  const r = await db.prepare(`UPDATE chain_deposits SET status = 'ignored', resolution = 'house_funding', resolved_at = datetime('now'), resolved_by = ?, note = ?
    WHERE id = ? AND status IN ('unmatched','below_min') AND reversed_at IS NULL AND credited_at IS NULL`).bind(admin.email, note, id).run();
  if ((r.meta?.changes ?? 0) !== 1) fail(409, 'This deposit changed while you were looking at it (assigned, reversed or already resolved). Reload and check.');
  await db.batch([
    audit(db, admin, 'tics.deposit_house_funding', { target: `chain_deposit:${id}`, before: { status: dep.status, note: dep.note },
      after: { status: 'ignored', resolution: 'house_funding', amountUnits: dep.amount_units, from: dep.from_address, txHash: dep.tx_hash }, reason: note }),
    raiseAlert(db, { type: 'tics_deposit_house_funding', severity: 'info', key: `tics_deposit_house_funding:${id}`, title: `Deposit marked as house funding: ${tics(dep.amount_units)} from ${dep.from_address}`,
      details: `${admin.email} marked the deposit ${dep.tx_hash} (${tics(dep.amount_units)} from ${dep.from_address}) as the casino's own funding: ${note}. It is no longer counted as owed. If a customer sent this money, assign it to them instead.` }),
  ]);
  return { ok: true, duplicate: false, deposit: await db.prepare('SELECT * FROM chain_deposits WHERE id = ?').bind(id).first(), amount: tics(dep.amount_units) };
}
