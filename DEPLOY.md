# Running & Deploying maestro

## Prerequisites

- Node.js 18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- **Low-latency RPC access** — public RPCs will lose every race:
  - Solana: Helius or Triton (Geyser-backed)
  - EVM: Alchemy or Infura (websocket-capable)
- Jito block engine access (Solana bundle submission — no signup needed, just the endpoint)
- Flashbots Protect RPC (EVM private tx submission — no signup needed)

## Setup

```bash
cd maestro
npm install
cp .env.example .env
```

Fill in `.env`:
- `TELEGRAM_BOT_TOKEN` — from BotFather
- `TELEGRAM_OWNER_ID` — your numeric Telegram id, promotes you to admin on first contact (see the comment in `.env.example` for what this does and doesn't gate)
- `SOLANA_RPC_HTTP` / `SOLANA_RPC_WSS` — your Helius/Triton endpoints
- `EVM_RPC_HTTP` / `EVM_RPC_WSS` — your Alchemy/Infura endpoints
- `MAX_TRADE_SOL` / `MAX_TRADE_ETH` — admin hard maximum spend for each buy, defaulting to `0.1` SOL / `0.05` ETH.
- `MAX_DAILY_SPEND_SOL` / `MAX_DAILY_SPEND_ETH` — admin hard maximum buy spend per user and UTC day, defaulting to `1` SOL / `0.5` ETH. Personal limits are configurable in Telegram but cannot exceed these values.
- `MAX_SLIPPAGE_BPS` — admin hard maximum slippage from 1 to 500 basis points (default `500`); users can set a lower ceiling.
- In Telegram, **Trading settings** lets each user lower their per-buy cap and daily budget (a zero daily budget disables buys) and set their slippage ceiling and buy cooldown (0–3600 seconds). These apply to manual buys and automated entries, including queued trades; sells are not blocked by these buy limits. Cooldown-delayed jobs remain queued, while jobs that exceed the daily budget fail rather than being carried into the next day. Auto-buy size and copy-trading sizing/target/sell behavior remain in their respective menus.
- `TRADE_QUOTE_TTL_SECONDS` — expiry for button-driven manual trade previews (10–300 seconds, default `60`). Confirmation is one-use and rechecks the minimum output before signing.
- Trade lifecycle records are stored in the bot SQLite database. EVM receipts and Solana finalized signatures are reconciled in the background; trades without a final status after 15 minutes are marked `unknown` and continue to be checked. Use **Recent trades** in Telegram to inspect tracked executions.
- Automated trades and triggered limit orders are persisted in a SQLite queue and processed serially. Retryable failures use bounded exponential backoff (up to five attempts); once a transaction submission may have happened, the worker does not resubmit it and leaves the lifecycle reconciler to determine the result. Buy jobs wait while the admin kill switch is active.
- `VAULT_MASTER_KEY` — generate one, don't reuse across environments:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Run locally

```bash
npm run dev
```

Message your bot on Telegram — you're auto-registered on first contact. If your id matches `TELEGRAM_OWNER_ID` you're promoted to admin and auto-approved. Other users remain pending and can only import a wallet and view onboarding/help until an admin approves them. An admin can approve only after at least one wallet has been imported. Every trading and account feature stays unavailable until both steps are complete; see the operational checklist below.

## Admin app

Two extra pieces, both under `admin-server/` and `admin-web/`, sharing the bot's SQLite file — no separate database to stand up.

**API server:**

```bash
cd admin-server
npm install
cp .env.example .env   # set ADMIN_PASSWORD, ADMIN_JWT_SECRET; copy your RPC URLs in
npm start
```

Refuses to start without `ADMIN_PASSWORD`/`ADMIN_JWT_SECRET` set — there's no unauthenticated fallback mode by design, since this endpoint can ban users and cancel anyone's orders.

**Web dashboard:**

```bash
cd admin-web
npm install
cp .env.example .env   # VITE_API_URL, defaults to http://localhost:4000
npm run dev             # local dev server
# or, for production:
npm run build            # outputs static files to dist/ — serve with any static host/nginx
```

The dashboard gives you: user list with ban/unban, per-user detail (settings, live portfolio, recent orders), a cross-user open-orders view with admin cancel, and basic counts. It reads the bot's live DB directly — no polling delay beyond a page refresh.

## Production

Build once, then run the compiled output:

```bash
npm run build
npm start
```

This needs to stay running continuously (price polling, event listeners, the bot itself), so run it under a process manager rather than a bare terminal. The admin server should run continuously too if you want the dashboard usable at any time; the admin web build is static and can be served however you like (nginx, Caddy, a CDN).

**Option A — systemd** (`/etc/systemd/system/maestro.service`, and a second unit for `admin-server` following the same shape with a different `WorkingDirectory`/`ExecStart`):

```ini
[Unit]
Description=maestro
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/maestro
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/maestro/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now maestro
journalctl -u maestro -f   # logs
```

**Option B — pm2:**

```bash
npm install -g pm2
pm2 start dist/index.js --name maestro
pm2 start admin-server/server.js --name maestro-admin
pm2 logs
pm2 startup && pm2 save   # survive reboots
```

**Option C — Docker** (files included: `Dockerfile`, `docker-compose.yml` — covers the main bot only; the admin server/web aren't containerized yet, run them with Option A/B alongside):

```bash
docker compose up -d --build
docker compose logs -f
```

## Where to host it

Latency to your RPC and to the Jito block engine/Flashbots relay is the entire game for sniping — a $5 VPS in the wrong region loses every race regardless of how good the code is. Match your region to your RPC provider's nearest datacenter (Helius and most Jito block engine regions cluster around Frankfurt/Amsterdam, NY, and Tokyo). For EVM, colocate near your RPC provider's edge or run against a bare-metal node if you're serious about it.

## Data persistence

`data/vault.json` (wallet secrets) and `data/bot.db` (users, orders, holdings) live under `./data` — back this up and never commit it. Docker Compose already mounts `./data` as a volume so it survives container rebuilds. The admin server reads the same `bot.db` file directly (`BOT_DB_PATH` in its `.env`), so both processes need access to the same disk — that's automatic on one host, but matters if you ever split them across machines.

## Operational checklist before going live

1. **Set `TELEGRAM_OWNER_ID` — this is no longer optional.** Every new non-admin user starts in a `pending` state. They must import a wallet and then be approved by an admin (`/admin_approve <telegram_id>`, or the one-tap "✅ Approve" button sent to the admin after wallet import) before using other commands or features. Without `TELEGRAM_OWNER_ID` set, there's no admin, so no one — including you — can ever be approved.
2. **Set `ADMIN_PASSWORD` and `ADMIN_JWT_SECRET`** for the admin server — long random values, not something guessable. The admin dashboard can ban users and cancel anyone's orders.
3. Auto-buy defaults to off per user (`snipe_enabled = 0`) — each user opts in with `/snipe_on` deliberately, not on registration.
4. Watch console logs for a while first (`[SOL] safety check for ... safe=...`) to see real pass/fail rates before anyone risks funds.
5. Snipe size is per-user now (defaults 0.1 SOL / 0.05 ETH), but no buy may exceed the global `MAX_TRADE_SOL` / `MAX_TRADE_ETH` cap.
6. **Wallet import and secret reveal both put a secret into the Telegram chat as text.** Import: the bot deletes your message immediately after processing. Reveal (`/wallets` → My Wallets → a wallet → "Reveal secret"): requires a confirmation tap first, then auto-deletes its own message after 60 seconds. Either way, the secret briefly exists in Telegram's server-side chat log regardless of the auto-delete — that's a property of Telegram, not something client-side deletion can fully undo. Treat "Reveal secret" as something to use sparingly, not routinely.
7. **Seed phrases are stored encrypted in `vault.json`, never in `bot.db`.** Wallet rows in SQLite hold public addresses and labels; wallet-import audit events retain only user ID, username, wallet label, and chain. On startup, older wallet-import event rows are redacted to remove any previously retained key material. Keep `VAULT_MASTER_KEY` at least as protected as the database itself; it's what makes the vault file unreadable without it. Successful wallet imports are recorded without secrets.
8. The Admin menu's kill switch pauses all new buys (auto-buy, copy-trading, and limit buys); sells and exit orders remain enabled. Open buy limit orders stay queued and may execute after the switch is disabled. Changes and risk-policy decisions are written to the local SQLite audit log, visible from Admin → Recent risk audit.
