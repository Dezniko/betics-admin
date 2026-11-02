// Payments: deposits, the withdrawal approval queue and payment settings.
import { fail, isInt, text } from '../util.js';
import { requirePerm, stepUp } from '../auth.js';
import { audit, writeAudit } from '../audit.js';

export const DEFAULT_PAYMENTS = { provider: 'nowpayments', network: 'tron', payCurrency: 'usdttrc20', depositsOpen: false, withdrawalsOpen: false,
  minDepositCents: 1000, minWithdrawalCents: 2000, maxWithdrawalCents: 1000000, withdrawalFeeCents: 100, dailyWithdrawalLimitCents: 2000000 };
const read = async (db) => { const r = await db.prepare("SELECT value FROM settings WHERE key = 'payments'").first(); return { ...DEFAULT_PAYMENTS, ...(r ? JSON.parse(r.value) : {}) }; };

async function providerStatus(env, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${env.GAME_URL || 'https://betics.io'}/api/payments/status`);
    return res.ok ? await res.json() : { configured: false, error: true };
  } catch { return { configured: false, error: true }; }
}

export async function paymentsOverview(db, env, url) {
  const status = url.searchParams.get('status') || 'open';
  const where = status === 'open' ? "w.status IN ('requested','approved')" : status === 'all' ? '1=1' : 'w.status = ?';
  const args = ['open', 'all'].includes(status) ? [] : [status];
  const [settings, provider, withdrawals, deposits, sums] = await Promise.all([
    read(db), providerStatus(env),
    db.prepare(`SELECT w.*, p.country, p.real_balance_cents, (SELECT COUNT(*) FROM withdrawals x WHERE x.address = w.address AND x.player_id != w.player_id) AS shared_address
      FROM withdrawals w LEFT JOIN players p ON p.id = w.player_id WHERE ${where} ORDER BY w.created_at DESC LIMIT 200`).bind(...args).all(),
    db.prepare('SELECT * FROM deposits ORDER BY created_at DESC LIMIT 100').all(),
    db.prepare(`SELECT (SELECT COALESCE(SUM(credited_cents),0) FROM deposits WHERE credited_at >= datetime('now','-30 days')) AS dep30,
      (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals WHERE status = 'sent' AND updated_at >= datetime('now','-30 days')) AS wd30,
      (SELECT COUNT(*) FROM withdrawals WHERE status = 'requested') AS waiting,
      (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals WHERE status IN ('requested','approved')) AS pending_cents`).first(),
  ]);
  return { settings, provider, withdrawals: withdrawals.results, deposits: deposits.results, totals: sums };
}

async function getWithdrawal(db, id) {
  const w = await db.prepare('SELECT * FROM withdrawals WHERE id = ?').bind(id).first();
  if (!w) fail(404, 'No withdrawal with that id.');
  return w;
}

function walletRelease(env, w, reason) {
  if (!env.WALLETS || !env.INTERNAL_SECRET) fail(500, 'Wallet connection is not configured.');
  return env.WALLETS.get(env.WALLETS.idFromName(w.player_id)).fetch(new Request('https://wallet/internal/withdraw-release', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': env.INTERNAL_SECRET },
    body: JSON.stringify({ ref: `wdr:${w.id}`, amountCents: w.amount_cents, reason }) }));
}

// A reject whose wallet reply was lost: status 'failed' with this note means 'needs review' (money may still be held).
export const REVIEW_PREFIX = 'Needs review (refund not confirmed): ';
// requested -> approved -> sent (with the transaction hash), or -> rejected (money returned to the player).
export async function withdrawalAction(db, env, admin, id, body) {
  requirePerm(admin, 'payments:approve');
  const w = await getWithdrawal(db, id);
  const action = body.action;
  if (action === 'approve') {
    if (w.status !== 'requested') fail(400, 'Only a new request can be approved.');
    const res = await db.prepare("UPDATE withdrawals SET status = 'approved', approved_by = ?, updated_at = datetime('now') WHERE id = ? AND status = 'requested'").bind(admin.email, id).run();
    if ((res.meta?.changes ?? 0) !== 1) fail(409, 'This withdrawal changed meanwhile. Reload and check.');
    await writeAudit(db, admin, 'withdrawal.approve', { target: `withdrawal:${id}`, before: { status: w.status }, after: { status: 'approved', amountCents: w.amount_cents } });
  } else if (action === 'sent') {
    if (!['requested', 'approved'].includes(w.status)) fail(400, 'This withdrawal is already finished.');
    // A Tron transaction id is exactly 64 hex characters (no 0x); an Ethereum hash is 0x + 64.
    const raw = typeof body.txHash === 'string' ? body.txHash.trim() : '';
    if (!/^(0x)?[a-fA-F0-9]{64}$/.test(raw) || /^(0x)?0{64}$/.test(raw)) fail(400, 'Paste the transaction hash (64 characters) from the wallet you sent it with.');
    const tx = raw.replace(/^0x/, '').toLowerCase();
    const res = await db.prepare("UPDATE withdrawals SET status = 'sent', tx_hash = ?, sent_by = ?, approved_by = COALESCE(approved_by, ?), updated_at = datetime('now') WHERE id = ? AND status IN ('requested','approved')")
      .bind(tx, admin.email, admin.email, id).run();
    if ((res.meta?.changes ?? 0) !== 1) fail(409, 'This withdrawal changed meanwhile (someone else finished it). Reload and check.');
    await writeAudit(db, admin, 'withdrawal.sent', { target: `withdrawal:${id}`, before: { status: w.status }, after: { status: 'sent', txHash: tx } });
  } else if (action === 'reject') {
    if (!['requested', 'approved'].includes(w.status)) fail(400, 'This withdrawal is already finished.');
    if (!text(body.reason, 3, 300)) fail(400, 'Write a short reason. The player sees it.');
    const reason = body.reason.trim();
    // Claim the row first (only from an open status), so it cannot also be marked sent while the money goes back.
    const claim = await db.prepare("UPDATE withdrawals SET status = 'rejected', reason = ?, updated_at = datetime('now') WHERE id = ? AND status = ?").bind(reason, id, w.status).run();
    if ((claim.meta?.changes ?? 0) !== 1) fail(409, 'This withdrawal changed meanwhile (someone else handled it). Reload and check.');
    await writeAudit(db, admin, 'withdrawal.reject_intent', { target: `withdrawal:${id}`, before: { status: w.status }, after: { status: 'rejected', refundCents: w.amount_cents }, reason });
    let res = null;
    try { res = await walletRelease(env, w, reason); } catch { res = null; }
    if (res && !res.ok && res.status < 500) {
      // The wallet clearly refused: nothing was returned, so put it back the way it was (the release is idempotent by its ref).
      await db.prepare("UPDATE withdrawals SET status = ?, reason = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'rejected'").bind(w.status, id).run();
      fail(500, 'The wallet did not return the money. Nothing was changed.');
    }
    if (!res || !res.ok) {
      // No answer: the money may or may not be back. Never put it back to 'approved' (it could then be sent AND refunded):
      // park it for review ('failed' + a note; the legacy table has no review status) and count it as still owed.
      await db.prepare("UPDATE withdrawals SET status = 'failed', reason = ?, updated_at = datetime('now') WHERE id = ? AND status = 'rejected'")
        .bind(`${REVIEW_PREFIX}${reason}`.slice(0, 300), id).run();
      await writeAudit(db, admin, 'withdrawal.reject_review', { target: `withdrawal:${id}`, before: { status: 'rejected' }, after: { status: 'failed', review: true }, reason });
      fail(502, 'The wallet did not answer, so we cannot tell whether the money went back. The withdrawal is now marked Needs review: check the player balance before doing anything else with it.', 'needs_review');
    }
    await writeAudit(db, admin, 'withdrawal.reject', { target: `withdrawal:${id}`, before: { status: w.status }, after: { status: 'rejected', refundedCents: w.amount_cents }, reason });
  } else fail(400, 'Unknown action.');
  return { withdrawal: await getWithdrawal(db, id) };
}

// Legacy USDT settings: switches, limits and fees decide what players can move, so any change needs the password and a fresh code.
export async function updatePayments(db, admin, input, env = {}) {
  requirePerm(admin, 'settings:edit');
  const { code, password, ...body } = input || {};
  const before = await read(db), next = { ...before };
  for (const k of ['depositsOpen', 'withdrawalsOpen']) if (k in body) { if (typeof body[k] !== 'boolean') fail(400, `${k} must be true or false.`); next[k] = body[k]; }
  for (const k of ['minDepositCents', 'minWithdrawalCents', 'maxWithdrawalCents', 'withdrawalFeeCents', 'dailyWithdrawalLimitCents']) if (k in body) {
    if (!isInt(body[k], 0, 1e12)) fail(400, 'Amounts must be whole cents, zero or more.'); next[k] = body[k];
  }
  if (next.minWithdrawalCents > next.maxWithdrawalCents) fail(400, 'The smallest withdrawal cannot be above the largest.');
  if (next.withdrawalFeeCents >= next.minWithdrawalCents) fail(400, 'The fee must be less than the smallest withdrawal.');
  if (JSON.stringify(next) === JSON.stringify(before)) return next;
  await stepUp(db, env, admin, { code, password });
  await db.batch([db.prepare(`INSERT INTO settings (key, value) VALUES ('payments', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(JSON.stringify(next)),
    audit(db, admin, 'settings.payments', { target: 'settings:payments', before, after: next })]);
  return next;
}
