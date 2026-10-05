# Running Maestro on Replit

Keep the existing TypeScript Telegram bot, Express admin API, React/Vite admin
frontend, and SQLite storage. Do not migrate this imported project.

## Dependencies and builds

Install dependencies at the repository root, in `admin-server/`, and in
`admin-web/` using their existing npm package files.

- Bot build: `npm run build`
- Admin frontend build: `npm --prefix admin-web run build`
- Initialize the shared SQLite schema without starting trading:
  `node --import tsx --input-type=module -e 'import { openDb } from "./src/db/db.ts"; openDb().close();'`

## Development services

- Admin web: `npm --prefix admin-web run dev`, on `0.0.0.0:5000`.
  Vite forwards `/api` to the admin API on port 4000. Leave `VITE_API_URL`
  unset so browser requests use the same origin.
- Admin API: `cd admin-server && npm start`, on port 4000.
  Requires `ADMIN_PASSWORD` and `ADMIN_JWT_SECRET` in Replit Secrets.
- Telegram bot: `npm run dev` from the repository root.
  Requires `TELEGRAM_BOT_TOKEN`, numeric `TELEGRAM_OWNER_ID`, and
  `VAULT_MASTER_KEY` (64 hexadecimal characters representing 32 random bytes).
  Use the secure Secrets tool for tokens and keys; never commit them.

Both bot and admin API share `data/bot.db`. The schema initialization command
creates the directory and tables without importing wallets or contacting chains.

## Blockchain configuration and safety

Configure `SOLANA_RPC_HTTP`, `SOLANA_RPC_WSS`, `EVM_RPC_HTTP`, `EVM_RPC_WSS`,
`SOLANA_JITO_BLOCK_ENGINE`, `EVM_FLASHBOTS_RPC`, and `UNISWAP_V2_FACTORY`
as specified in `.env.example`. RPC URLs containing provider credentials belong
in Secrets. Public endpoints in the example are not suitable for reliable
low-latency trading.

The bot operates on live mainnet. Do not submit trades to verify setup.
Do not replace authentication with a bypass or invent credentials.
Preserve and back up the vault master key: changing it makes previously stored
wallets unreadable. The SQLite database and encrypted `vault.json` are local
files; publishing and production persistence need a separate review.
