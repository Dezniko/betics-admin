-- Central platform database (Cloudflare D1). Wallet Durable Objects hold the
-- authoritative live balance; this database holds config, a copy of every
-- round and ledger entry, players, analytics, alerts, messages and admin data.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('house_currency', '{"symbol":"USDT","name":"Tether USD","contract":"0xdAC17F958D2ee523a2206206994597C13D831ec7","decimals":6,"usdRate":1}'),
  ('mode', '"play"'),
  ('limits', '{"dailyHouseLossAlertCents":200000,"bigWinAlertCents":500000,"playerUpAlertCents":300000,"rtpDriftPct":3,"rtpDriftMinRounds":500}');

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  maintenance_message TEXT NOT NULL DEFAULT 'This game is having a short break. Please check back soon.',
  min_stake_cents INTEGER NOT NULL DEFAULT 1,
  max_stake_cents INTEGER NOT NULL DEFAULT 1000000,
  max_win_cents INTEGER NOT NULL DEFAULT 5000000,
  max_house_loss_cents INTEGER NOT NULL DEFAULT 5000000,
  math_id TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO games (id, name, kind, math_id, sort) VALUES ('roulette', 'Roulette', 'table', 'standard', 1);

CREATE TABLE IF NOT EXISTS game_math (
  game_id TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  rtp_min REAL NOT NULL,
  rtp_max REAL NOT NULL,
  rtp_target REAL NOT NULL,
  PRIMARY KEY (game_id, id),
  CHECK (rtp_max < 100)
);
INSERT OR IGNORE INTO game_math VALUES
  ('roulette', 'standard', 'Standard European', 'Single zero wheel, standard payouts: straight up 35 to 1, split 17 to 1, street 11 to 1, corner 8 to 1, six line 5 to 1, dozens and columns 2 to 1, even money 1 to 1.', 97.30, 97.30, 97.30),
  ('roulette', 'straight34', 'Straight up 34 to 1', 'Same as standard, except a single number pays 34 to 1 instead of 35 to 1. Payback 94.6% on single numbers, 97.3% on every other bet.', 94.59, 97.30, 96.00);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'banned')),
  status_reason TEXT,
  display_name TEXT NOT NULL DEFAULT 'player',
  country TEXT,
  city TEXT,
  device TEXT,
  os TEXT,
  browser TEXT,
  language TEXT,
  first_referrer TEXT,
  first_campaign TEXT,
  ip_hash TEXT,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  total_bet_cents INTEGER NOT NULL DEFAULT 0,
  total_paid_cents INTEGER NOT NULL DEFAULT 0,
  rounds INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS players_last_seen ON players (last_seen_at);
CREATE INDEX IF NOT EXISTS players_ip ON players (ip_hash);

CREATE TABLE IF NOT EXISTS player_identities (
  kind TEXT NOT NULL CHECK (kind IN ('guest', 'wallet', 'email', 'telegram')),
  value TEXT NOT NULL,
  player_id TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  consent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, value)
);
CREATE INDEX IF NOT EXISTS identities_player ON player_identities (player_id);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  math_id TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  stake_cents INTEGER NOT NULL,
  payout_cents INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  bets_json TEXT NOT NULL,
  fairness_json TEXT NOT NULL,
  currency TEXT NOT NULL,
  real_money INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  device TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rounds_time ON rounds (created_at);
CREATE INDEX IF NOT EXISTS rounds_player ON rounds (player_id, created_at);
CREATE INDEX IF NOT EXISTS rounds_game ON rounds (game_id, created_at);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  round_id TEXT,
  meta TEXT,
  currency TEXT NOT NULL,
  real_money INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_player ON ledger (player_id, created_at);
CREATE INDEX IF NOT EXISTS ledger_time ON ledger (created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  details TEXT,
  player_id TEXT,
  game_id TEXT,
  round_id TEXT,
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  telegram_sent INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts (status, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  player_id TEXT,
  game_id TEXT,
  country TEXT,
  city TEXT,
  device TEXT,
  os TEXT,
  browser TEXT,
  screen TEXT,
  language TEXT,
  referrer TEXT,
  campaign TEXT,
  value_cents INTEGER,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_time ON events (created_at, type);
CREATE INDEX IF NOT EXISTS events_player ON events (player_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  button_label TEXT,
  button_url TEXT,
  audience_json TEXT NOT NULL,
  channels_json TEXT NOT NULL DEFAULT '["site"]',
  trigger TEXT NOT NULL DEFAULT 'now' CHECK (trigger IN ('now', 'scheduled', 'wallet_connect', 'first_visit', 'first_deposit')),
  send_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'sent', 'stopped')),
  is_template INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'site',
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT,
  clicked_at TEXT,
  dismissed_at TEXT,
  PRIMARY KEY (message_id, player_id, channel)
);
CREATE INDEX IF NOT EXISTS deliveries_player ON message_deliveries (player_id, delivered_at);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'finance', 'support', 'readonly')),
  password_hash TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  setup_token_hash TEXT,
  setup_expires_at TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS login_attempts_key ON admin_login_attempts (key, created_at);

CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS audit_time ON admin_audit (created_at);

-- Append-only guards for money and audit history.
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
CREATE TRIGGER IF NOT EXISTS rounds_no_update BEFORE UPDATE ON rounds BEGIN SELECT RAISE(ABORT, 'rounds are append only'); END;
-- Payments (real money). Deposits arrive through a payment provider
-- (NOWPayments, USDT on Tron); withdrawals are requested by players, approved
-- in the admin panel, sent from the casino wallet and recorded with the
-- transaction hash. Play money and real money are separate balances.

ALTER TABLE players ADD COLUMN real_balance_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'confirming', 'partially_paid', 'finished', 'failed', 'expired', 'refunded')),
  network TEXT NOT NULL,
  pay_currency TEXT NOT NULL,
  pay_address TEXT,
  pay_amount TEXT,
  actually_paid TEXT,
  requested_cents INTEGER NOT NULL CHECK (requested_cents > 0),
  credited_cents INTEGER NOT NULL DEFAULT 0,
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  credited_at TEXT
);
CREATE INDEX IF NOT EXISTS deposits_player ON deposits (player_id, created_at);
CREATE INDEX IF NOT EXISTS deposits_status ON deposits (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS deposits_provider_ref ON deposits (provider, provider_ref);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents INTEGER NOT NULL DEFAULT 0,
  network TEXT NOT NULL,
  currency TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'sent', 'rejected', 'failed')),
  reason TEXT,
  tx_hash TEXT,
  approved_by TEXT,
  sent_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals (status, created_at);
CREATE INDEX IF NOT EXISTS withdrawals_player ON withdrawals (player_id, created_at);

INSERT OR IGNORE INTO settings (key, value) VALUES ('payments', '{"provider":"nowpayments","network":"tron","payCurrency":"usdttrc20","depositsOpen":false,"withdrawalsOpen":false,"minDepositCents":1000,"minWithdrawalCents":2000,"maxWithdrawalCents":1000000,"withdrawalFeeCents":100,"dailyWithdrawalLimitCents":2000000}');

-- USDT on Tron is the house currency (Dez chose TRC-20 for its low fees).
UPDATE settings SET value = '{"symbol":"USDT","name":"Tether USD","network":"tron","contract":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","decimals":6,"usdRate":1}', updated_at = datetime('now')
  WHERE key = 'house_currency' AND value LIKE '%0xdAC17F958D2ee523a2206206994597C13D831ec7%';
INSERT INTO admin_audit (admin_email, action, target, after_json, reason)
  SELECT 'system', 'settings.currency', 'settings:house_currency', value, 'Network set to Tron (TRC-20) as chosen by the owner'
  FROM settings WHERE key = 'house_currency' AND value LIKE '%TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t%';
-- $TICS on Ethereum: wallet players, deposits to the casino wallet, automatic
-- withdrawals and treasury sends. USDT (NOWPayments / Tron) stays as it is.
-- Amounts are integers in units of 0.01 TICS (the *_cents columns keep that
-- meaning for TICS). On-chain amount = units * 10^16 wei (18 decimals).

INSERT INTO settings (key, value) VALUES ('currencies', '{"USDT":{"symbol":"USDT","name":"Tether USD","network":"tron","contract":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","decimals":6,"unitDecimals":2,"enabled":false},"TICS":{"symbol":"TICS","name":"Qubetics","network":"ethereum","chainId":1,"contract":"0x551ecfdba071cb6541f642cb90a073c8c158df05","decimals":18,"unitDecimals":2,"enabled":true}}')
  ON CONFLICT(key) DO NOTHING;
UPDATE settings SET value = '{"symbol":"TICS","name":"Qubetics","network":"ethereum","chainId":1,"contract":"0x551ecfdba071cb6541f642cb90a073c8c158df05","decimals":18,"unitDecimals":2,"usdRate":0}', updated_at = datetime('now')
  WHERE key = 'house_currency';
INSERT INTO settings (key, value) VALUES ('tics_payments', '{"chainId":1,"token":"0x551ecfdba071cb6541f642cb90a073c8c158df05","casinoWallet":null,"treasuryAddress":null,"confirmations":12,"startBlock":null,"realEnabled":false,"depositsOpen":true,"withdrawalsOpen":true,"payoutsPaused":false,"pausedReason":null,"minDepositUnits":100,"minWithdrawalUnits":10000000,"feesEnabled":true,"gasFeeMarginPct":20,"fallbackFeeUnits":50000,"coolingSeconds":120,"largeWithdrawalAlertUnits":5000000,"lowFloatUnits":0,"highFloatUnits":0,"lowEthWei":"5000000000000000","demoStartUnits":10000000}')
  ON CONFLICT(key) DO NOTHING;

-- Roulette limits in TICS units: min 1 TICS, max 50,000 TICS per spin, max win 1,800,000 TICS.
UPDATE games SET min_stake_cents = 100, max_stake_cents = 5000000, max_win_cents = 180000000, max_house_loss_cents = 180000000,
  config_version = config_version + 1, updated_at = datetime('now') WHERE id = 'roulette' AND max_stake_cents = 1000000;

-- Alert amounts in TICS units.
UPDATE settings SET value = '{"dailyHouseLossAlertCents":100000000,"bigWinAlertCents":20000000,"playerUpAlertCents":50000000,"rtpDriftPct":3,"rtpDriftMinRounds":500}', updated_at = datetime('now')
  WHERE key = 'limits' AND value LIKE '%"dailyHouseLossAlertCents":200000,%';

ALTER TABLE players ADD COLUMN wallet_address TEXT;
ALTER TABLE players ADD COLUMN first_connected_at TEXT;
ALTER TABLE players ADD COLUMN last_connected_at TEXT;
ALTER TABLE players ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE players ADD COLUMN real_tics_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN holdings_usd REAL;
ALTER TABLE players ADD COLUMN holdings_updated_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS players_wallet ON players (wallet_address);

-- Sign-In with Ethereum: single-use nonces (stored hashed) and wallet sessions.
CREATE TABLE IF NOT EXISTS wallet_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wallet_sessions (
  token_hash TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  address TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS wallet_sessions_player ON wallet_sessions (player_id);

CREATE TABLE IF NOT EXISTS wallet_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  address TEXT NOT NULL,
  country TEXT, city TEXT, device TEXT, os TEXT, browser TEXT, language TEXT, ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS wallet_connections_player ON wallet_connections (player_id, created_at);

CREATE TABLE IF NOT EXISTS wallet_holdings (
  player_id TEXT NOT NULL,
  network TEXT NOT NULL,
  token TEXT NOT NULL,
  symbol TEXT, name TEXT, decimals INTEGER,
  amount TEXT NOT NULL,
  usd_price REAL,
  usd_value REAL,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, network, token)
);

-- Rate limiting for wallet endpoints (per hashed IP and bucket).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Every $TICS Transfer into the casino wallet that the watcher saw.
CREATE TABLE IF NOT EXISTS chain_deposits (
  id TEXT PRIMARY KEY,                 -- chainId:txHash:logIndex
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  player_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('credited', 'unmatched', 'below_min', 'assigned', 'ignored')),
  note TEXT,
  credited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS chain_deposits_player ON chain_deposits (player_id, created_at);
CREATE INDEX IF NOT EXISTS chain_deposits_from ON chain_deposits (from_address);
CREATE INDEX IF NOT EXISTS chain_deposits_status ON chain_deposits (status, created_at);

CREATE TABLE IF NOT EXISTS chain_withdrawals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'player' CHECK (kind IN ('player', 'treasury')),
  player_id TEXT,
  chain_id INTEGER NOT NULL,
  to_address TEXT NOT NULL,
  amount_units INTEGER NOT NULL CHECK (amount_units > 0),
  fee_units INTEGER NOT NULL DEFAULT 0,
  send_units INTEGER NOT NULL CHECK (send_units > 0),
  status TEXT NOT NULL CHECK (status IN ('queued', 'signing', 'sending', 'sent', 'failed', 'cancelled')),
  release_at TEXT NOT NULL,
  nonce INTEGER,
  tx_hashes TEXT NOT NULL DEFAULT '[]',
  tx_hash TEXT,
  raw_tx TEXT,
  max_fee_wei TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  requested_by TEXT,
  cancelled_by TEXT,
  sent_at TEXT,
  broadcast_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS chain_withdrawals_status ON chain_withdrawals (status, release_at);
CREATE INDEX IF NOT EXISTS chain_withdrawals_player ON chain_withdrawals (player_id, created_at);

-- Watcher state and the cached casino wallet snapshot (balances, owed, float).
CREATE TABLE IF NOT EXISTS chain_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Real-money exposure holds. Before a real spin runs, its biggest possible net win
-- (worst payout minus stake) is reserved here in one atomic, conditional insert:
-- it only succeeds while casino wallet - owed to players - other open holds still
-- covers it. The hold is removed once the settled balance is copied to players,
-- and expires on its own if a spin never finishes. So any number of players
-- spinning at the same moment can never be owed more than the wallet holds.
CREATE TABLE IF NOT EXISTS spin_holds (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units >= 0),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS spin_holds_expiry ON spin_holds (expires_at);
-- Audit fixes (2026-10-30).
-- Read load: the admin balance check reads the newest ledger row per player; with only
-- (player_id, created_at) it walked every row of that player. (player_id, real_money) keeps
-- rows in rowid order per key, so "ORDER BY rowid DESC LIMIT 1" is a single index step.
CREATE INDEX IF NOT EXISTS ledger_player_money ON ledger (player_id, real_money);
-- What players are owed: only players with a real balance matter.
CREATE INDEX IF NOT EXISTS players_real_tics ON players (real_tics_cents) WHERE real_tics_cents > 0;
-- chain_withdrawals: new status 'holding' (the row is claimed before the money is set aside, so a
-- request sent several times at once can only hold once) and row_mac (the payouts Worker
-- authenticates the treasury rows it signs). SQLite cannot change a CHECK, so rebuild the table.
CREATE TABLE chain_withdrawals_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'player' CHECK (kind IN ('player', 'treasury')),
  player_id TEXT,
  chain_id INTEGER NOT NULL,
  to_address TEXT NOT NULL,
  amount_units INTEGER NOT NULL CHECK (amount_units > 0),
  fee_units INTEGER NOT NULL DEFAULT 0,
  send_units INTEGER NOT NULL CHECK (send_units > 0),
  -- blocked: stopped before payment and the money is still held (needs review, still owed);
  -- cancelling: cancelled but the refund to the player is not confirmed yet (still owed).
  status TEXT NOT NULL CHECK (status IN ('holding', 'queued', 'signing', 'sending', 'sent', 'failed', 'cancelled', 'blocked', 'cancelling')),
  release_at TEXT NOT NULL,
  nonce INTEGER,
  tx_hashes TEXT NOT NULL DEFAULT '[]',
  tx_hash TEXT,
  raw_tx TEXT,
  max_fee_wei TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  requested_by TEXT,
  cancelled_by TEXT,
  sent_at TEXT,
  broadcast_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  row_mac TEXT
);
INSERT INTO chain_withdrawals_new (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, nonce, tx_hashes, tx_hash, raw_tx,
  max_fee_wei, attempts, last_error, requested_by, cancelled_by, sent_at, broadcast_at, created_at, updated_at)
  SELECT id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, nonce, tx_hashes, tx_hash, raw_tx,
  max_fee_wei, attempts, last_error, requested_by, cancelled_by, sent_at, broadcast_at, created_at, updated_at FROM chain_withdrawals;
DROP TABLE chain_withdrawals;
ALTER TABLE chain_withdrawals_new RENAME TO chain_withdrawals;
CREATE INDEX IF NOT EXISTS chain_withdrawals_status ON chain_withdrawals (status, release_at);
CREATE INDEX IF NOT EXISTS chain_withdrawals_player ON chain_withdrawals (player_id, created_at);
-- Quick-lane credits per sending wallet: booked with one conditional INSERT so parallel deposit
-- checks can never pass the rolling 24-hour cap together.
CREATE TABLE IF NOT EXISTS quick_lane (
  deposit_id TEXT PRIMARY KEY,
  from_address TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quick_lane_from ON quick_lane (from_address, at_ms);
-- Money leaving the wallet (player and treasury) is summed by kind and status on every spin.
CREATE INDEX IF NOT EXISTS chain_withdrawals_kind_status ON chain_withdrawals (kind, status);
-- Central copy order: each copy of a player's balances carries a rising number, so an older copy
-- that lands late can never overwrite a newer one.
ALTER TABLE players ADD COLUMN flush_seq INTEGER NOT NULL DEFAULT 0;
-- betics-admin audit fixes (2026-10-30). Additive only.
-- An owner whose sign-in was just set up (or who was just raised to owner) cannot send to the
-- treasury or change the treasury address before this time (UTC, 'YYYY-MM-DD HH:MM:SS').
ALTER TABLE admins ADD COLUMN treasury_ok_after TEXT;
-- Bank page: deposits and withdrawals of the last 30 days without walking every bet in the ledger.
CREATE INDEX IF NOT EXISTS ledger_type_time ON ledger (type, created_at);
-- Telegram sender (runs every 2 minutes): only the alerts not sent yet.
CREATE INDEX IF NOT EXISTS alerts_unsent ON alerts (telegram_sent, status, id);
-- Old USDT owed figure: only players with a real USDT balance.
CREATE INDEX IF NOT EXISTS players_real_usdt ON players (real_balance_cents) WHERE real_balance_cents > 0;
-- Owner sign-in from a new device: look up this admin's earlier sign-ins.
CREATE INDEX IF NOT EXISTS audit_admin_action ON admin_audit (admin_id, action);
-- Live rounds feeds (Overview every 15 s, Rounds every 5 s) filter by Real/Demo and take the newest:
-- without this, the Real view walks back through every demo round to find 15 real ones.
-- Partial, so the planner only uses it for queries that say "real_money = 1" literally (never for
-- per-player queries, which must keep using rounds_player).
CREATE INDEX IF NOT EXISTS rounds_real_time ON rounds (created_at) WHERE real_money = 1;
-- Re-audit round 3 (2026-10-30). Additive only: one new column, two new indexes. No table rebuild.

-- Deposits after a chain reorganisation: the same transaction can come back in another block with a
-- different log index, which used to give it a new id (chainId:txHash:logIndex) and a second credit.
-- A transfer is now also identified by what a reorg does not change: its transaction, sender, amount
-- and tx_ordinal = how many identical transfers (same sender and amount) come before it in that
-- transaction (almost always 0). One row per (chain, tx, sender, amount, ordinal).
ALTER TABLE chain_deposits ADD COLUMN tx_ordinal INTEGER;
-- The index is created first (every ordinal is still NULL, and NULLs never clash), so the backfill
-- below finds rows by the index prefix instead of scanning the table once per row.
CREATE UNIQUE INDEX IF NOT EXISTS chain_deposits_transfer ON chain_deposits (chain_id, tx_hash, from_address, amount_wei, tx_ordinal);
-- Backfill: existing ids are unique per (chain, tx, log index), so counting the earlier log indexes of
-- identical transfers in the same transaction gives each existing row a distinct ordinal, and the
-- unique index cannot be violated by existing data.
UPDATE chain_deposits SET tx_ordinal = (
  SELECT COUNT(*) FROM chain_deposits d2
  WHERE d2.chain_id = chain_deposits.chain_id AND d2.tx_hash = chain_deposits.tx_hash AND d2.from_address = chain_deposits.from_address
    AND d2.amount_wei = chain_deposits.amount_wei AND d2.log_index < chain_deposits.log_index
);

-- Table limit: payouts marked 'sent' after the last casino wallet snapshot are still inside that
-- snapshot's token balance, so every spin subtracts them. (status, sent_at) keeps that lookup to the
-- few rows sent since the snapshot; without it the planner walks every row ever sent.
CREATE INDEX IF NOT EXISTS chain_withdrawals_sent_at ON chain_withdrawals (status, sent_at);
-- Re-audit 2026-11-02.
-- R2: deposits credited at a shallow depth are re-checked once Ethereum has finalized their block.
--   finalized_at   when the transfer was seen again in a finalized block (withdrawals may then use it)
--   final_miss_at  first time (ms) the transfer was NOT found after its block was final; a second miss
--                  minutes later means it is gone, and the credit is reversed
--   reversed_at    when that reversal was booked in the player's wallet
-- Every deposit recorded before this migration is days old, so it counts as final already.
ALTER TABLE chain_deposits ADD COLUMN finalized_at TEXT;
ALTER TABLE chain_deposits ADD COLUMN final_miss_at INTEGER;
ALTER TABLE chain_deposits ADD COLUMN reversed_at TEXT;
UPDATE chain_deposits SET finalized_at = datetime('now');
CREATE INDEX IF NOT EXISTS chain_deposits_unfinal ON chain_deposits (block_number) WHERE finalized_at IS NULL;

-- R1: a spin's possible win stays counted until that player's new balance is in the central copy.
-- booked_at (ms) lets the cron ask the player's wallet about bookings that were not released.
ALTER TABLE spin_holds ADD COLUMN booked_at INTEGER;
CREATE INDEX IF NOT EXISTS spin_holds_booked ON spin_holds (booked_at) WHERE booked_at IS NOT NULL;
