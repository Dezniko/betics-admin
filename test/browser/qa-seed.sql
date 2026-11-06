-- Local seed for the browser suites test/browser/tics-qa.mjs and test/browser/slots-qa.mjs (one state for both).
-- Apply after test/schema.sql:  npx wrangler d1 execute betics-db --local --persist-to DIR --file test/browser/qa-seed.sql
-- Everything here is made up: a wallet player (A1) with real rounds (one roulette, three Gods of Power), a guest
-- with demo rounds, a queued payout, deposits, holdings, and the payouts pause + float snapshot the Treasury page shows.

-- Payouts are paused and the game cron left a float snapshot (the local admin has no PAYOUTS binding: "service unavailable").
UPDATE settings SET value = json_set(value, '$.payoutsPaused', json('true'), '$.pausedReason', 'QA: paused for the browser suite', '$.casinoWallet', '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359') WHERE key = 'tics_payments';
INSERT OR REPLACE INTO settings (key, value) VALUES ('casino_key_ct', '"QA-CIPHERTEXT-never-shown"');
INSERT OR REPLACE INTO chain_state (key, value) VALUES ('float', '{"at":1760000000000,"chainId":1,"wallet":"0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359","tokenUnits":50000000,"ethWei":"20000000000000000","owedUnits":1234500,"freeUnits":48765500}');
INSERT OR REPLACE INTO chain_state (key, value) VALUES ('gas', '{"at":1760000000000,"baseFeeWei":"10000000000","tipWei":"1000000000"}');

-- Players: A1 (wallet, email, holdings), A2 (wallet only), g1 (guest, demo only).
INSERT INTO players (id, wallet_address, country, city, device, balance_cents, real_tics_cents, holdings_usd, first_connected_at, last_connected_at, last_seen_at, total_bet_cents, total_paid_cents, rounds)
  VALUES ('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'DE', 'Berlin', 'desktop', 10000000, 1234500, 1520.5, '2026-10-01 10:00:00', datetime('now', '-1 hour'), datetime('now', '-5 minutes'), 1216000, 1210400, 4);
INSERT INTO players (id, wallet_address, country, city, device, balance_cents, real_tics_cents, holdings_usd, first_connected_at, last_connected_at, last_seen_at)
  VALUES ('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359', '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359', 'TR', 'Istanbul', 'mobile', 10000000, 0, 12, '2026-10-05 10:00:00', '2026-10-20 10:00:00', '2026-10-20 10:00:00');
INSERT INTO players (id, country, device, balance_cents, last_seen_at, total_bet_cents, total_paid_cents, rounds)
  VALUES ('g1', 'GB', 'mobile', 9700000, datetime('now', '-2 minutes'), 300000, 0, 2);
INSERT INTO player_identities (kind, value, player_id, consent) VALUES ('email', 'ana.qa@example.com', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 1);
INSERT INTO player_identities (kind, value, player_id) VALUES ('wallet', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
INSERT INTO wallet_connections (player_id, address, country, city, device, os, browser) VALUES ('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'DE', 'Berlin', 'desktop', 'macOS', 'Chrome');
INSERT INTO wallet_holdings (player_id, network, token, symbol, name, decimals, amount, usd_price, usd_value, hidden) VALUES
  ('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'eth-mainnet', 'ETH', 'ETH', 'Ether', 18, '0.3', 3000, 900, 0),
  ('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'eth-mainnet', '0x551ecfdba071cb6541f642cb90a073c8c158df05', 'TICS', 'Qubetics', 18, '12345', 0.0405, 500, 0),
  ('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'base-mainnet', 'USDC', 'USDC', 'USD Coin', 6, '120.5', 1, 120.5, 0),
  ('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'eth-mainnet', '0x00000000000000000000000000000000000000aa', 'FREE-AIRDROP', 'Claim at scam.example', 18, '99999', 1, 99999, 1);

-- Money movements for A1: a credited deposit, a sent payout, a queued payout (Cancel button), an unmatched deposit.
INSERT INTO chain_deposits (id, chain_id, tx_hash, log_index, block_number, from_address, to_address, amount_wei, amount_units, player_id, status, credited_at)
  VALUES ('1:0xabababababababababababababababababababababababababababababababab:0', 1, '0xabababababababababababababababababababababababababababababababab', 0, 21000000, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359', '5000000000000000000000', 500000, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'credited', datetime('now', '-2 days'));
INSERT INTO chain_deposits (id, chain_id, tx_hash, log_index, block_number, from_address, to_address, amount_wei, amount_units, status)
  VALUES ('1:0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd:3', 1, '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', 3, 21000100, '0x1111111111111111111111111111111111111111', '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359', '250000000000000000000', 25000, 'unmatched');
INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, tx_hash, sent_at)
  VALUES ('w-sent-1', 'player', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 1, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 20000000, 50000, 19950000, 'sent', datetime('now', '-1 day'), '0xefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef', datetime('now', '-1 day'));
INSERT INTO chain_withdrawals (id, kind, player_id, chain_id, to_address, amount_units, fee_units, send_units, status, release_at, attempts, last_error)
  VALUES ('11111111-1111-4111-8111-111111111111', 'player', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 1, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 15000000, 50000, 14950000, 'queued', datetime('now', '+2 minutes'), 1, 'temporary rpc error');

-- Rounds. Real: w:1 roulette (chips on the felt), w:2 slot with a base spin + 2 free spins (Gold bar line win on line 2),
-- w:3 a losing slot spin, w:4 a capped slot round. Demo: two guest rounds.
INSERT INTO rounds (id, player_id, game_id, math_id, config_version, stake_cents, payout_cents, outcome, bets_json, fairness_json, currency, real_money, country, device, created_at) VALUES
  ('w:1', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'roulette', 'standard', 1, 6000, 7200, '{"pocket":7,"color":"red"}',
    '[{"type":"straight","value":7,"amountCents":200},{"type":"red","amountCents":2000},{"type":"split","value":[7,8],"amountCents":800},{"type":"dozen1","amountCents":3000}]',
    '{"serverSeed":"1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c","serverSeedHash":"a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff","clientSeed":"lucky","nonce":12}',
    'TICS', 1, 'DE', 'desktop', datetime('now', '-50 minutes')),
  ('w:2', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'godsofpower', 'gods92', 1, 200000, 1000000,
    '{"game":"godsofpower","spins":[{"free":false,"stops":[3,7,11,19,23],"lineWins":[{"line":1,"symbol":"B","count":4,"pay":30}],"scatterCount":3,"scatterPay":5,"multiplier":1,"winUnits":1300000,"freeSpinsAdded":2},{"free":true,"stops":[1,2,3,4,5],"lineWins":[],"scatterCount":0,"scatterPay":0,"multiplier":2,"winUnits":0,"freeSpinsAdded":0},{"free":true,"stops":[9,8,7,6,5],"lineWins":[{"line":0,"symbol":"K","count":3,"pay":4}],"scatterCount":0,"scatterPay":0,"multiplier":2,"winUnits":80000,"freeSpinsAdded":0}],"freeSpinsAwarded":2,"freeSpinsPlayed":2,"capped":false}',
    '{"stake":200000,"lines":20}', '{"serverSeed":"2d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c","serverSeedHash":"b1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff","clientSeed":"lucky","nonce":13}',
    'TICS', 1, 'DE', 'desktop', datetime('now', '-40 minutes')),
  ('w:3', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'godsofpower', 'gods92', 1, 10000, 0,
    '{"game":"godsofpower","spins":[{"free":false,"stops":[0,5,10,15,20],"lineWins":[],"scatterCount":0,"scatterPay":0,"multiplier":1,"winUnits":0,"freeSpinsAdded":0}],"freeSpinsAwarded":0,"freeSpinsPlayed":0,"capped":false}',
    '{"stake":10000,"lines":20}', '{"serverSeed":"3d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c","serverSeedHash":"c1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff","clientSeed":"lucky","nonce":14}',
    'TICS', 1, 'DE', 'desktop', datetime('now', '-30 minutes')),
  ('w:4', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'godsofpower', 'gods92', 1, 1000000, 2000000000,
    '{"game":"godsofpower","spins":[{"free":false,"stops":[16,16,16,16,16],"lineWins":[{"line":0,"symbol":"W","count":5,"pay":2000}],"scatterCount":5,"scatterPay":50,"multiplier":1,"winUnits":2000000000,"freeSpinsAdded":10}],"freeSpinsAwarded":10,"freeSpinsPlayed":0,"capped":true}',
    '{"stake":1000000,"lines":20}', '{"serverSeed":"4d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c","serverSeedHash":"d1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff","clientSeed":"lucky","nonce":15}',
    'TICS', 1, 'DE', 'desktop', datetime('now', '-20 minutes')),
  ('g:1', 'g1', 'roulette', 'standard', 1, 100000, 0, '{"pocket":0,"color":"green"}', '[{"type":"red","amountCents":100000}]', '{}', 'TICS', 0, 'GB', 'mobile', datetime('now', '-15 minutes')),
  ('g:2', 'g1', 'godsofpower', 'gods92', 1, 200000, 0,
    '{"game":"godsofpower","spins":[{"free":false,"stops":[2,4,6,8,10],"lineWins":[],"scatterCount":0,"scatterPay":0,"multiplier":1,"winUnits":0,"freeSpinsAdded":0}],"freeSpinsAwarded":0,"freeSpinsPlayed":0,"capped":false}',
    '{"stake":200000,"lines":20}', '{}', 'TICS', 0, 'GB', 'mobile', datetime('now', '-10 minutes'));
INSERT INTO ledger (id, player_id, type, amount_cents, balance_after_cents, currency, real_money, round_id, created_at) VALUES
  ('l:1', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'bet', -6000, 1227300, 'TICS', 1, 'w:1', datetime('now', '-50 minutes')),
  ('l:2', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'win', 7200, 1234500, 'TICS', 1, 'w:1', datetime('now', '-50 minutes'));
