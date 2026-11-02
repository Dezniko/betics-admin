// The bank: the casino's own wallet(s) on chain, read live, compared with
// what the casino owes players. Tells you whether to top up or how much you
// can safely take out.
import { fail, text, isInt, sqlTime, cached, moneyIs } from '../util.js';
import { requirePerm, stepUp } from '../auth.js';
import { audit } from '../audit.js';
import { floatSnapshot } from './money.js';

const DEFAULT_RPC = 'https://ethereum-rpc.publicnode.com';
const TRONGRID = 'https://api.trongrid.io';
const USDT = { ethereum: { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 }, tron: { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 } };
// The token to read on a wallet's chain: the house currency if it lives there, else USDT on that chain.
function tokenFor(chain, currency) {
  if ((currency.network || 'ethereum') === chain) return { contract: currency.contract, decimals: currency.decimals };
  return currency.symbol === 'USDT' ? USDT[chain] : null;
}
async function tronBalances(env, address, token, fetchImpl) {
  const res = await fetchImpl(`${env.TRONGRID_URL || TRONGRID}/v1/accounts/${address}`, { headers: env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {} });
  if (!res.ok) throw new Error(`TronGrid ${res.status}`);
  const body = await res.json();
  const acct = (body.data || [])[0] || {};
  const entry = (acct.trc20 || []).find((t) => token && t[token.contract] != null);
  const raw = entry ? BigInt(entry[token.contract]) : 0n;
  return { tokenCents: token ? rawToCents('0x' + raw.toString(16), token.decimals) : 0, fee: Number(acct.balance || 0) / 1e6 };
}
const read = async (db, key) => { const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first(); return r ? JSON.parse(r.value) : null; };
const put = (db, key, value) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(key, JSON.stringify(value));
export const DEFAULT_TREASURY = { wallets: [], reservePct: 20 };

async function rpc(env, method, params, fetchImpl = fetch) {
  const res = await fetchImpl(env.ETH_RPC_URL || DEFAULT_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'RPC error');
  return body.result;
}

// Raw on-chain integer -> whole cents of the token (rounded down).
export function rawToCents(hex, decimals) {
  const raw = BigInt(hex === '0x' ? 0 : hex);
  const cents = decimals >= 2 ? raw / 10n ** BigInt(decimals - 2) : raw * 10n ** BigInt(2 - decimals);
  return Number(cents);
}

let cache = { at: 0, key: '', value: null };
export async function walletBalances(env, wallets, currency, { fetchImpl = fetch, now = Date.now() } = {}) {
  const key = JSON.stringify([wallets, currency.contract]);
  if (cache.key === key && now - cache.at < 10000) return cache.value;
  const results = await Promise.all(wallets.map(async (w) => {
    try {
      const chain = w.chain || 'ethereum', token = tokenFor(chain, currency);
      if (chain === 'tron') {
        const t = await tronBalances(env, w.address, token, fetchImpl);
        return { ...w, chain, tokenCents: t.tokenCents, fee: t.fee, feeSymbol: 'TRX', feeLow: t.fee < 30, ok: true };
      }
      const data = '0x70a08231' + w.address.slice(2).toLowerCase().padStart(64, '0');
      const [tokenRaw, eth] = await Promise.all([
        token ? rpc(env, 'eth_call', [{ to: token.contract, data }, 'latest'], fetchImpl) : '0x0',
        rpc(env, 'eth_getBalance', [w.address, 'latest'], fetchImpl),
      ]);
      const ethValue = Number(BigInt(eth) / 10n ** 12n) / 1e6;
      return { ...w, chain, tokenCents: token ? rawToCents(tokenRaw, token.decimals) : 0, fee: ethValue, feeSymbol: 'ETH', feeLow: ethValue < 0.01, ok: true };
    } catch (e) { return { ...w, ok: false, error: 'Could not read this wallet right now.' }; }
  }));
  cache = { at: now, key, value: results };
  return results;
}

export async function bank(db, env, opts = {}) {
  const mode = await read(db, 'mode');
  const now = Date.now(), todayStart = `${sqlTime(new Date(now)).slice(0, 10)} 00:00:00`, from30 = sqlTime(new Date(now - 30 * 864e5));
  const real = mode === 'real' ? 1 : 0;
  // Aggregates: bound time strings (index-friendly), partial indexes, and a 60 s cache (30-day flows: 10 minutes).
  const [treasury, currency, owedPlay, owedReal, today, flows] = await Promise.all([
    read(db, 'treasury'), read(db, 'house_currency'),
    cached(db, 'bank:owedPlay', 60e3, () => db.prepare("SELECT COALESCE(SUM(balance_cents),0) AS n, COUNT(*) AS players FROM players WHERE balance_cents > 0").first()),
    // Owed: every real-money balance, plus withdrawals requested or approved but not sent yet, plus 'failed'
    // (a reject whose refund was not confirmed: counted until someone reviews it).
    cached(db, 'bank:owedReal', 60e3, () => db.prepare(`SELECT (SELECT COALESCE(SUM(real_balance_cents),0) FROM players WHERE real_balance_cents > 0) + (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals WHERE status IN ('requested','approved','failed')) AS n,
      (SELECT COALESCE(SUM(amount_cents),0) FROM withdrawals WHERE status IN ('requested','approved','failed')) AS pending`).first()),
    cached(db, `bank:today:${real}:${todayStart}`, 60e3, () => db.prepare(`SELECT COALESCE(SUM(stake_cents - payout_cents),0) AS n FROM rounds WHERE created_at >= ? AND ${moneyIs(real)}`).bind(todayStart).first()),
    cached(db, 'bank:flows', 600e3, () => db.prepare(`SELECT type, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM ledger WHERE type IN ('deposit','withdrawal') AND created_at >= ? GROUP BY type`).bind(from30).all()),
  ]);
  const t = { ...DEFAULT_TREASURY, ...(treasury || {}) };
  const wallets = t.wallets.length ? await walletBalances(env, t.wallets, currency, opts) : [];
  const heldCents = wallets.reduce((s, w) => s + (w.ok ? w.tokenCents : 0), 0);
  const owedCents = owedReal.n;
  const reserveCents = Math.ceil(owedCents * t.reservePct / 100);
  const neededCents = owedCents + reserveCents;
  const state = !wallets.length ? 'no_wallet' : wallets.some(w => !w.ok) ? 'unreadable' : heldCents < owedCents ? 'short' : heldCents < neededCents ? 'low' : 'healthy';
  return {
    currency, mode, reservePct: t.reservePct, wallets, heldCents, owedCents, reserveCents, neededCents,
    spareCents: Math.max(0, heldCents - neededCents), topUpCents: Math.max(0, neededCents - heldCents), state,
    play: { owedCents: owedPlay.n, players: owedPlay.players }, todayProfitCents: today.n,
    pendingWithdrawalsCents: owedReal.pending,
    flows: Object.fromEntries(flows.results.map(f => [f.type, { count: f.n, totalCents: f.total }])),
    ticsFloat: await floatSnapshot(db),
    checkedAt: new Date().toISOString(),
  };
}

// The bank wallets and safety buffer decide the 'top up / safe to take out' figures: password and a fresh code.
export async function updateTreasury(db, admin, input, env = {}) {
  requirePerm(admin, 'settings:edit');
  const { code, password, ...body } = input;
  const before = { ...DEFAULT_TREASURY, ...((await read(db, 'treasury')) || {}) };
  const next = { ...before };
  if ('wallets' in body) {
    if (!Array.isArray(body.wallets) || body.wallets.length > 10) fail(400, 'Add up to 10 wallets.');
    next.wallets = body.wallets.map(w => {
      const address = typeof w?.address === 'string' ? w.address.trim() : '';
      const chain = ['ethereum', 'tron'].includes(w?.chain) ? w.chain : address.startsWith('0x') ? 'ethereum' : 'tron';
      if (chain === 'tron' && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) fail(400, 'A Tron wallet address starts with T and has 34 characters.');
      if (chain === 'ethereum' && !/^0x[a-fA-F0-9]{40}$/.test(address)) fail(400, 'An Ethereum wallet address is 0x followed by 40 characters.');
      if (!text(w.label, 1, 40)) fail(400, 'Give each wallet a short name, like Hot wallet.');
      return { label: w.label.trim(), address, chain };
    });
  }
  if ('reservePct' in body) { if (!isInt(body.reservePct, 0, 500)) fail(400, 'The safety buffer must be 0 to 500 percent.'); next.reservePct = body.reservePct; }
  if (JSON.stringify(next) === JSON.stringify(before)) return next;
  await stepUp(db, env, admin, { code, password });
  await db.batch([put(db, 'treasury', next), audit(db, admin, 'settings.treasury', { target: 'settings:treasury', before, after: next })]);
  cache = { at: 0, key: '', value: null };
  return next;
}
