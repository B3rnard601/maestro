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
- `VAULT_MASTER_KEY` — generate one, don't reuse across environments:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Run locally

```bash
npm run dev
```

Message your bot on Telegram — you're auto-registered on first contact. If your id matches `TELEGRAM_OWNER_ID` you're promoted to admin and auto-approved; otherwise you land in `pending` and need to approve yourself via the other account, or just make sure `TELEGRAM_OWNER_ID` is your own id before testing. Once active: `/wallets` → New Wallet (or Import), fund the address, then `/snipe_on` or create limit orders. Every other Telegram user who messages the bot goes through the same pending → approved flow before any of that responds for them — see the operational checklist below.

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

1. **Set `TELEGRAM_OWNER_ID` — this is no longer optional.** Every new user now starts in a `pending` state and can't touch any trading feature until an admin approves them (`/admin_approve <telegram_id>`, or the one-tap "✅ Approve" button you get DMed for each new signup). Without `TELEGRAM_OWNER_ID` set, there's no admin at all, so no one — including you — can ever be approved.
2. **Set `ADMIN_PASSWORD` and `ADMIN_JWT_SECRET`** for the admin server — long random values, not something guessable. The admin dashboard can ban users and cancel anyone's orders.
3. Auto-buy defaults to off per user (`snipe_enabled = 0`) — each user opts in with `/snipe_on` deliberately, not on registration.
4. Watch console logs for a while first (`[SOL] safety check for ... safe=...`) to see real pass/fail rates before anyone risks funds.
5. Snipe size is per-user now (`/snipe_size solana|evm <amount>`, defaults 0.1 SOL / 0.05 ETH) — no shared global size anymore.
6. **Wallet import and secret reveal both put a secret into the Telegram chat as text.** Import: the bot deletes your message immediately after processing. Reveal (`/wallets` → My Wallets → a wallet → "Reveal secret"): requires a confirmation tap first, then auto-deletes its own message after 60 seconds. Either way, the secret briefly exists in Telegram's server-side chat log regardless of the auto-delete — that's a property of Telegram, not something client-side deletion can fully undo. Prefer "New Wallet" (generated in-vault, key never transits Telegram) over import when you don't specifically need to bring an existing wallet in, and treat "Reveal secret" as something to use sparingly, not routinely.
7. **Seed phrases are stored encrypted in `vault.json`, never in `bot.db`.** Wallet rows in SQLite hold public addresses and labels; wallet-import audit events retain only user ID, username, wallet label, and chain. No database record contains a signable secret. Keep `VAULT_MASTER_KEY` at least as protected as the database itself; it's what makes the vault file unreadable without it. Successful wallet imports are recorded in the admin dashboard and sent to `TELEGRAM_OWNER_ID`; seed phrases and private keys are never included.
