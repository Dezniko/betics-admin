# qu-BETICS Admin

Admin panel for [qu-BETICS](https://github.com/Dezniko/betics), live at **https://admin.betics.io**.

The code is public so anyone can read and check it. It is **not open source**: see [LICENSE](LICENSE) (view only).
Found a problem? See [SECURITY.md](SECURITY.md).

- No runtime dependencies. The Worker is plain ES modules; the UI is vanilla JS with hand-built SVG charts (`public/`).
- Reads the central platform database (Cloudflare D1 `betics-db`), which is owned by the game core repo `Dezniko/betics` (schema in its `migrations/`; a test copy lives in `test/schema.sql`, refresh with `scripts/sync-schema.sh`).
- There is no way to change a player's balance from the admin panel. The only money actions are assigning an unmatched deposit to the player who sent it, cancelling a withdrawal while it waits or returning a stopped one (the money goes back to that player's balance) and treasury sends of the free float. They go to the core Worker (`betics`, class `DemoCasino`) or the payout signer through Cloudflare bindings and secrets.

## Sign in

Email + password (PBKDF2, peppered with `SESSION_PEPPER`) + a mandatory 6-digit authenticator code. Sessions are random tokens stored hashed (12 h idle, 7 day max). Lockout after 5 failed tries per email or 20 per network in 15 minutes. New people get a one-time setup link (48 h) from Settings; the first owner from `scripts/invite-owner.sh email "Name" --remote`.

Roles: owner (everything), finance (view + CSV), support (view, pause players, send messages, resolve alerts), read only.

## Screens

Overview, Games (on/off, maintenance message, bet limits, max win, table limit, maths option), Rounds, Players (pause, ban), Money (+ CSV), Analytics, Messages (now / scheduled / on trigger, popup + inbox on the casino), Alerts (rules + Telegram), Settings (house currency, mode, people), Audit log.

## TICS (Ethereum)

House currency is TICS; every `*_cents` / `*_units` amount is 0.01 TICS and is shown as `1,234.50 TICS`. The old USDT (NOWPayments, Tron) Payments section stays, switched off, with amounts labelled USDT.

- **Treasury** (owner): casino wallet and treasury addresses with Etherscan links (chain 1 or Sepolia 11155111), live TICS / ETH / owed / free float from the `betics-payouts` Worker (`PAYOUTS` service binding, header `X-Internal-Secret`), or the cached `chain_state.float` snapshot with a clear message when that Worker is unreachable. Send to treasury needs a fresh authenticator code on every send; changing the treasury address needs the password plus a code, is audited and raises a critical `tics_treasury_changed` alert (Telegram). Pause / resume automatic payouts. Payout settings (switches, deposit minimum and confirmations, minimum withdrawal, cooling delay, alert levels, demo start, start block), validated and audited.
- **Fees** (owner): players pay the network fee on/off, gas margin, fallback fee, and the live quote from `chain_state` `gas` and `prices` (fallback when gas is older than 10 minutes or prices older than 60).
- **Payments**: TICS payouts queue (status filter, fee, send amount, release time, tx links, tries, last error, Cancel while queued) and TICS deposits; an unmatched deposit can be assigned to an existing player (owner): it calls the game wallet `POST /internal/tics-deposit` with ref `td:<chain>-<tx>-<log>`, so it is credited once. The game wallet only accepts it if the deposits table holds that exact transfer, for that amount and player, not reversed. Deposits whose transfer disappeared after its block was final show as reversed, with a critical `tics_deposit_gone` alert and the player paused.
- **Players**: search by full or partial wallet address (any case), email or id; filters for email, consent, country, holdings USD, deposited, last connected; CSV export (`money:export`). Profiles show wallet, connections, holdings, TICS deposits and withdrawals.
- Address checks use a built-in Keccak-256 (`src/eth.js`): lowercase, uppercase or correctly EIP-55-checksummed addresses only.
- Fresh codes: there is no column on `admins` for it (the game repo owns the schema), so the newest used code step per admin is kept in the `settings` row `admin_totp_steps`, updated atomically. Sign-in and setup codes are recorded too, so a sign-in code cannot also approve a treasury send. 5 wrong tries in 15 minutes pause sensitive actions.
- `settings.casino_key_ct` is never read or returned by any route (tested).

## Cron

Every 2 minutes: scheduled messages, alert checks (big wins, players far up, daily and per-game losses, payback drift, fairness failures, ledger/balance mismatch) and Telegram delivery.

## Why publishing this is safe

Access never depends on the code being secret. No password, key or secret is stored here: the password pepper, the internal and treasury secrets and the Telegram token are Cloudflare Worker secrets, and admin accounts, password hashes and authenticator secrets live only in the database. Strangers are only served the sign-in page (every other file and API request is refused until you are signed in), and signing in needs the password and a fresh authenticator code. `scripts/invite-owner.sh` only works for someone who already has access to the Cloudflare account.

## Develop

```
cp .dev.vars.example .dev.vars   # your own random values, local only
npm test                         # API tests on an in-memory D1 stand-in
wrangler dev --port 8790 --persist-to ../betics/.wrangler/state   # shares the core's local D1
node test/browser/admin-qa.mjs   # real-browser QA (headless Chrome on CDP :9354, CDP_PORT to change)
node test/browser/tics-qa.mjs    # Treasury, Fees, Payments, Players in both themes and at 390px (ADMIN_URL, CDP_PORT, SETUP_LINK, QA_OUT)
node test/browser/slots-qa.mjs   # Gods of Power: Games page, slot round view, Rounds and Money game filters, Analytics By game, at 1280 and 390px
wrangler deploy
```

Secrets: `SESSION_PEPPER`, `INTERNAL_SECRET` (same value as `betics` and `betics-payouts`), `TREASURY_SECRET` (same value as `betics-payouts`; without it treasury sends answer "Treasury sends are not set up yet."), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.


## Licence

View only. You may read, build and test this code to review it. You may not copy, reuse or run it as a service without written permission. Full terms in [LICENSE](LICENSE).
