import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { formatUnitsExact, numberToDecimalString, parseUnitsFloor } from "../shared/amount.js";

export function openDb(filePath = "./data/bot.db"): Database.Database {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','banned')),
      admin_flag_message TEXT,
      solana_address TEXT,
      evm_address TEXT,
      snipe_enabled INTEGER NOT NULL DEFAULT 0,
      snipe_size_sol REAL NOT NULL DEFAULT 0.1,
      snipe_size_sol_exact TEXT NOT NULL DEFAULT '0.1',
      snipe_size_eth REAL NOT NULL DEFAULT 0.05,
      snipe_size_eth_exact TEXT NOT NULL DEFAULT '0.05',
      max_trade_sol_exact TEXT NOT NULL DEFAULT '0.1',
      max_trade_eth_exact TEXT NOT NULL DEFAULT '0.05',
      max_daily_spend_sol_exact TEXT NOT NULL DEFAULT '1',
      max_daily_spend_eth_exact TEXT NOT NULL DEFAULT '0.5',
      max_slippage_bps INTEGER NOT NULL DEFAULT 500,
      cooldown_seconds INTEGER NOT NULL DEFAULT 0,
      copy_target TEXT,
      copy_size_ratio REAL NOT NULL DEFAULT 0.1,
      copy_size_ratio_exact TEXT NOT NULL DEFAULT '0.1',
      copy_max_amount REAL NOT NULL DEFAULT 0.2,
      copy_max_amount_exact TEXT NOT NULL DEFAULT '0.2',
      copy_sells INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS limit_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chain TEXT NOT NULL CHECK(chain IN ('solana','evm')),
      identifier TEXT NOT NULL,   -- mint (solana) or token address (evm)
      pool_ref TEXT,              -- poolId, required for solana execution/pricing
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),
      direction TEXT NOT NULL CHECK(direction IN ('above','below')),
      trigger_price REAL NOT NULL,
      amount REAL NOT NULL,
      amount_exact TEXT,
      decimals INTEGER,          -- required for sell orders (token decimals, to compute base units)
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','filled','cancelled')),
      created_at INTEGER NOT NULL,
      filled_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS holdings (
      chain TEXT NOT NULL CHECK(chain IN ('solana','evm')),
      user_id TEXT NOT NULL,
      identifier TEXT NOT NULL,
      PRIMARY KEY (chain, user_id, identifier)
    );

    -- Metadata only — public address and a vault label, never the secret
    -- itself. The actual key/seed phrase lives encrypted in vault.json,
    -- looked up by (user_id, chain, label).
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chain TEXT NOT NULL CHECK(chain IN ('solana','evm')),
      label TEXT NOT NULL,          -- vault lookup key, e.g. "wallet-1"
      address TEXT NOT NULL,
      has_mnemonic INTEGER NOT NULL DEFAULT 0,  -- 0 for raw-private-key imports, no seed phrase to reveal
      is_primary INTEGER NOT NULL DEFAULT 0,    -- the wallet auto-trading (snipe/copy/limit orders) uses
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, chain, label)
    );

    CREATE TABLE IF NOT EXISTS wallet_import_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT,
      wallet_label TEXT NOT NULL,
      chain TEXT NOT NULL CHECK(chain IN ('solana','evm','solana+evm')),
      keys TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_funding_state (
      wallet_id TEXT PRIMARY KEY,
      chain TEXT NOT NULL CHECK(chain IN ('solana','evm')),
      imported_at INTEGER NOT NULL,
      baseline_slot INTEGER NOT NULL DEFAULT 0,
      cursor TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_funding_assets (
      wallet_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      initial_units TEXT NOT NULL,
      baseline_slot INTEGER NOT NULL DEFAULT 0,
      received_units TEXT NOT NULL DEFAULT '0',
      PRIMARY KEY(wallet_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS wallet_funding_events (
      wallet_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      amount_units TEXT NOT NULL,
      PRIMARY KEY(wallet_id, event_id, asset_id)
    );
    CREATE TABLE IF NOT EXISTS wallet_funding_cursors (
      wallet_id TEXT NOT NULL,
      address TEXT NOT NULL,
      cursor TEXT,
      PRIMARY KEY(wallet_id, address)
    );

    CREATE TABLE IF NOT EXISTS system_controls (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      kill_switch_enabled INTEGER NOT NULL DEFAULT 0 CHECK(kill_switch_enabled IN (0,1)),
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      actor_user_id TEXT,
      subject_user_id TEXT,
      chain TEXT,
      side TEXT,
      amount TEXT,
      source TEXT,
      details_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trade_lifecycle (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chain TEXT NOT NULL CHECK(chain IN ('solana','evm')),
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),
      source TEXT NOT NULL,
      asset TEXT NOT NULL,
      amount TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','submitted','confirmed','failed','unknown')),
      transaction_ref TEXT,
      approval_transaction_ref TEXT,
      bundle_ref TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      confirmed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS trade_jobs (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      chain TEXT NOT NULL CHECK(chain IN ('solana','evm')),
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),
      source TEXT NOT NULL CHECK(source IN ('sniper','copytrade','limit_order')),
      asset TEXT NOT NULL,
      amount TEXT NOT NULL,
      pool_ref TEXT,
      decimals INTEGER,
      limit_order_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','processing','submitted','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      available_at INTEGER NOT NULL,
      lifecycle_id TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trade_lifecycle_user_recent
      ON trade_lifecycle(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS trade_lifecycle_pending
      ON trade_lifecycle(status, updated_at);
    CREATE INDEX IF NOT EXISTS trade_jobs_ready
      ON trade_jobs(status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS trade_jobs_user_recent
      ON trade_jobs(user_id, created_at DESC);
  `);
  db.prepare(`INSERT OR IGNORE INTO system_controls (id, kill_switch_enabled, updated_at, updated_by) VALUES (1, 0, ?, NULL)`)
    .run(Date.now());
  db.exec(`UPDATE wallet_import_events SET keys = '[redacted]' WHERE keys <> '[redacted]'`);

  const fundingStateColumns = db.prepare(`PRAGMA table_info(wallet_funding_state)`).all() as { name: string }[];
  if (!fundingStateColumns.some((column) => column.name === "baseline_slot")) {
    db.exec(`ALTER TABLE wallet_funding_state ADD COLUMN baseline_slot INTEGER NOT NULL DEFAULT 0`);
  }
  const fundingAssetColumns = db.prepare(`PRAGMA table_info(wallet_funding_assets)`).all() as { name: string }[];
  if (!fundingAssetColumns.some((column) => column.name === "baseline_slot")) {
    db.exec(`ALTER TABLE wallet_funding_assets ADD COLUMN baseline_slot INTEGER NOT NULL DEFAULT 0`);
  }

  const usersSchema = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`)
    .get() as { sql: string } | undefined;

  if (usersSchema && !usersSchema.sql.includes("'pending'")) {
    const migrateUsers = db.transaction(() => {
      db.exec(`
        CREATE TABLE users_migrated (
          telegram_id TEXT PRIMARY KEY,
          username TEXT,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','banned')),
          admin_flag_message TEXT,
          solana_address TEXT,
          evm_address TEXT,
          snipe_enabled INTEGER NOT NULL DEFAULT 0,
          snipe_size_sol REAL NOT NULL DEFAULT 0.1,
          snipe_size_sol_exact TEXT NOT NULL DEFAULT '0.1',
          snipe_size_eth REAL NOT NULL DEFAULT 0.05,
          snipe_size_eth_exact TEXT NOT NULL DEFAULT '0.05',
          max_trade_sol_exact TEXT NOT NULL DEFAULT '0.1',
          max_trade_eth_exact TEXT NOT NULL DEFAULT '0.05',
          max_daily_spend_sol_exact TEXT NOT NULL DEFAULT '1',
          max_daily_spend_eth_exact TEXT NOT NULL DEFAULT '0.5',
          max_slippage_bps INTEGER NOT NULL DEFAULT 500,
          cooldown_seconds INTEGER NOT NULL DEFAULT 0,
          copy_target TEXT,
          copy_size_ratio REAL NOT NULL DEFAULT 0.1,
          copy_size_ratio_exact TEXT NOT NULL DEFAULT '0.1',
          copy_max_amount REAL NOT NULL DEFAULT 0.2,
          copy_max_amount_exact TEXT NOT NULL DEFAULT '0.2',
          copy_sells INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );

        INSERT INTO users_migrated (
          telegram_id, username, role, status, solana_address, evm_address,
          snipe_enabled, snipe_size_sol, snipe_size_eth, copy_target,
          copy_size_ratio, copy_max_amount, copy_sells, created_at,
          snipe_size_sol_exact, snipe_size_eth_exact, copy_size_ratio_exact, copy_max_amount_exact
        )
        SELECT
          telegram_id, username, role, status, solana_address, evm_address,
          snipe_enabled, snipe_size_sol, snipe_size_eth, copy_target,
          copy_size_ratio, copy_max_amount, copy_sells, created_at,
          '0.1', '0.05', '0.1', '0.2'
        FROM users;

        DROP TABLE users;
        ALTER TABLE users_migrated RENAME TO users;
      `);
    });
    migrateUsers();
  }

  const ensureColumn = (table: string, column: string, definition: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };

  ensureColumn("users", "snipe_size_sol_exact", "TEXT NOT NULL DEFAULT '0.1'");
  ensureColumn("users", "snipe_size_eth_exact", "TEXT NOT NULL DEFAULT '0.05'");
  ensureColumn("users", "copy_size_ratio_exact", "TEXT NOT NULL DEFAULT '0.1'");
  ensureColumn("users", "copy_max_amount_exact", "TEXT NOT NULL DEFAULT '0.2'");
  ensureColumn("users", "max_trade_sol_exact", "TEXT NOT NULL DEFAULT '0.1'");
  ensureColumn("users", "max_trade_eth_exact", "TEXT NOT NULL DEFAULT '0.05'");
  ensureColumn("users", "max_daily_spend_sol_exact", "TEXT NOT NULL DEFAULT '1'");
  ensureColumn("users", "max_daily_spend_eth_exact", "TEXT NOT NULL DEFAULT '0.5'");
  ensureColumn("users", "max_slippage_bps", "INTEGER NOT NULL DEFAULT 500");
  ensureColumn("users", "cooldown_seconds", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "admin_flag_message", "TEXT");
  ensureColumn("trade_lifecycle", "job_id", "TEXT");
  const legacyUsers = db.prepare(`SELECT telegram_id, snipe_size_sol, snipe_size_sol_exact, snipe_size_eth, snipe_size_eth_exact,
    copy_size_ratio, copy_size_ratio_exact, copy_max_amount, copy_max_amount_exact FROM users`).all() as Array<{
      telegram_id: string;
      snipe_size_sol: number;
      snipe_size_sol_exact: string;
      snipe_size_eth: number;
      snipe_size_eth_exact: string;
      copy_size_ratio: number;
      copy_size_ratio_exact: string;
      copy_max_amount: number;
      copy_max_amount_exact: string;
    }>;
  const updateLegacyUserAmounts = db.prepare(`UPDATE users SET
    snipe_size_sol_exact = ?, snipe_size_eth_exact = ?, copy_size_ratio_exact = ?, copy_max_amount_exact = ?
    WHERE telegram_id = ?`);
  const legacyAmount = (value: number, decimals: number): string => {
    const decimal = numberToDecimalString(value);
    if (value < 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return decimal;
    return formatUnitsExact(parseUnitsFloor(decimal, decimals), decimals);
  };
  for (const user of legacyUsers) {
    const exactSol = user.snipe_size_sol_exact === "0.1" && user.snipe_size_sol !== 0.1
      ? legacyAmount(user.snipe_size_sol, 9)
      : user.snipe_size_sol_exact;
    const exactEth = user.snipe_size_eth_exact === "0.05" && user.snipe_size_eth !== 0.05
      ? legacyAmount(user.snipe_size_eth, 18)
      : user.snipe_size_eth_exact;
    const exactRatio = user.copy_size_ratio_exact === "0.1" && user.copy_size_ratio !== 0.1
      ? numberToDecimalString(user.copy_size_ratio)
      : user.copy_size_ratio_exact;
    const exactCopyMax = user.copy_max_amount_exact === "0.2" && user.copy_max_amount !== 0.2
      ? legacyAmount(user.copy_max_amount, 9)
      : user.copy_max_amount_exact;
    if (
      exactSol !== user.snipe_size_sol_exact ||
      exactEth !== user.snipe_size_eth_exact ||
      exactRatio !== user.copy_size_ratio_exact ||
      exactCopyMax !== user.copy_max_amount_exact
    ) {
      updateLegacyUserAmounts.run(exactSol, exactEth, exactRatio, exactCopyMax, user.telegram_id);
    }
  }
  ensureColumn("limit_orders", "amount_exact", "TEXT");
  const legacyOrders = db.prepare(`SELECT id, amount, chain, side, decimals FROM limit_orders WHERE amount_exact IS NULL`).all() as Array<{
    id: string;
    amount: number;
    chain: "solana" | "evm";
    side: "buy" | "sell";
    decimals: number | null;
  }>;
  const updateLegacyOrderAmount = db.prepare(`UPDATE limit_orders SET amount_exact = ? WHERE id = ?`);
  for (const order of legacyOrders) {
    const decimals = order.side === "sell" ? order.decimals : order.chain === "solana" ? 9 : 18;
    const amount = decimals !== null && decimals !== undefined ? legacyAmount(order.amount, decimals) : numberToDecimalString(order.amount);
    updateLegacyOrderAmount.run(amount, order.id);
  }

  return db;
}

export interface UserRow {
  telegram_id: string;
  username: string | null;
  role: "user" | "admin";
  status: "pending" | "active" | "banned";
  admin_flag_message: string | null;
  solana_address: string | null;
  evm_address: string | null;
  snipe_enabled: number;
  snipe_size_sol: number;
  snipe_size_sol_exact: string;
  snipe_size_eth: number;
  snipe_size_eth_exact: string;
  max_trade_sol_exact: string;
  max_trade_eth_exact: string;
  max_daily_spend_sol_exact: string;
  max_daily_spend_eth_exact: string;
  max_slippage_bps: number;
  cooldown_seconds: number;
  copy_target: string | null;
  copy_size_ratio: number;
  copy_size_ratio_exact: string;
  copy_max_amount: number;
  copy_max_amount_exact: string;
  copy_sells: number;
  created_at: number;
}

/**
 * Registers a user on first contact and returns their row either way, plus
 * whether this call just created it (so the caller can notify the admin of
 * a new pending signup exactly once, not on every message). If `adminId`
 * (from TELEGRAM_OWNER_ID) matches, promotes to admin AND auto-approves —
 * otherwise everyone starts 'pending' and needs an explicit admin approval
 * before any trading feature will respond to them. This is the only
 * bootstrap path into the admin role, there's no in-bot promotion command
 * by design (an unauthenticated "make me admin" command would defeat the
 * point of having roles at all).
 */
export function getOrCreateUser(
  db: Database.Database,
  telegramId: string,
  username: string | undefined,
  adminId?: string
): { user: UserRow; isNew: boolean } {
  const existing = db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).get(telegramId) as UserRow | undefined;
  if (existing) return { user: existing, isNew: false };

  const isAdmin = !!adminId && telegramId === adminId;
  const role = isAdmin ? "admin" : "user";
  const status = isAdmin ? "active" : "pending";
  db.prepare(
    `INSERT INTO users (telegram_id, username, role, status, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(telegramId, username ?? null, role, status, Date.now());
  const user = db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).get(telegramId) as UserRow;
  return { user, isNew: true };
}

export function getUser(db: Database.Database, telegramId: string): UserRow | null {
  return (db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).get(telegramId) as UserRow) ?? null;
}

export function listUsers(db: Database.Database): UserRow[] {
  return db.prepare(`SELECT * FROM users ORDER BY created_at DESC`).all() as UserRow[];
}

export function listPendingUsers(db: Database.Database): UserRow[] {
  return db.prepare(`SELECT * FROM users WHERE status = 'pending' ORDER BY created_at ASC`).all() as UserRow[];
}

export interface WalletRow {
  id: string;
  user_id: string;
  chain: "solana" | "evm";
  label: string;
  address: string;
  has_mnemonic: number;
  is_primary: number;
  created_at: number;
}

export function nextWalletLabel(db: Database.Database, userId: string): string {
  const row = db.prepare(`SELECT COUNT(DISTINCT label) AS c FROM wallets WHERE user_id = ?`).get(userId) as { c: number };
  return `wallet-${row.c + 1}`;
}

export function addWallet(
  db: Database.Database,
  args: { userId: string; chain: "solana" | "evm"; label: string; address: string; hasMnemonic: boolean }
): WalletRow {
  const id = `${args.userId}:${args.chain}:${args.label}`;
  const existingForChain = listWalletsFor(db, args.userId, args.chain);
  const isPrimary = existingForChain.length === 0 ? 1 : 0; // first wallet on a chain becomes primary automatically

  db.prepare(
    `INSERT INTO wallets (id, user_id, chain, label, address, has_mnemonic, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, args.userId, args.chain, args.label, args.address, args.hasMnemonic ? 1 : 0, isPrimary, Date.now());

  if (isPrimary) setUserWalletAddress(db, args.userId, args.chain, args.address);

  return db.prepare(`SELECT * FROM wallets WHERE id = ?`).get(id) as WalletRow;
}

export function recordWalletImport(
  db: Database.Database,
  args: { userId: string; username: string | null; walletLabel: string; chain: "solana" | "evm" | "solana+evm"; keys: string }
): void {
  db.prepare(
    `INSERT INTO wallet_import_events (user_id, username, wallet_label, chain, keys, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(args.userId, args.username, args.walletLabel, args.chain, args.keys, Date.now());
}

export interface WalletFundingAssetRow {
  wallet_id: string;
  asset_id: string;
  symbol: string;
  decimals: number;
  initial_units: string;
  baseline_slot: number;
  received_units: string;
}

export function initializeWalletFunding(
  db: Database.Database,
  wallet: WalletRow,
  cursor: string,
  baselineSlot: number,
  addresses: { address: string; cursor: string | null }[],
  assets: { assetId: string; symbol: string; decimals: number; initialUnits: string; baselineSlot?: number }[]
): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO wallet_funding_state
         (wallet_id, chain, imported_at, baseline_slot, cursor)
       VALUES (?, ?, ?, ?, ?)`
    ).run(wallet.id, wallet.chain, wallet.created_at, baselineSlot, cursor);
    const insertAsset = db.prepare(
      `INSERT OR IGNORE INTO wallet_funding_assets
         (wallet_id, asset_id, symbol, decimals, initial_units, baseline_slot)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const asset of assets) {
      insertAsset.run(
        wallet.id,
        asset.assetId,
        asset.symbol,
        asset.decimals,
        asset.initialUnits,
        asset.baselineSlot ?? baselineSlot,
      );
    }
    const insertCursor = db.prepare(
      `INSERT OR IGNORE INTO wallet_funding_cursors (wallet_id, address, cursor) VALUES (?, ?, ?)`
    );
    for (const item of addresses) {
      insertCursor.run(wallet.id, item.address, item.cursor);
    }
  });
  tx();
}

export function getWalletFundingState(
  db: Database.Database,
  walletId: string
): { chain: "solana" | "evm"; cursor: string; imported_at: number; baseline_slot: number } | null {
  return (db.prepare(
    `SELECT chain, cursor, imported_at, baseline_slot FROM wallet_funding_state WHERE wallet_id = ?`
  ).get(walletId) as
    | { chain: "solana" | "evm"; cursor: string; imported_at: number; baseline_slot: number }
    | undefined) ?? null;
}

export function getWalletFundingCursor(db: Database.Database, walletId: string, address: string): string | null {
  const row = db.prepare(
    `SELECT cursor FROM wallet_funding_cursors WHERE wallet_id = ? AND address = ?`
  ).get(walletId, address) as { cursor: string | null } | undefined;
  return row?.cursor ?? null;
}

export function listWalletFundingCursorAddresses(db: Database.Database, walletId: string): string[] {
  return (db.prepare(`SELECT address FROM wallet_funding_cursors WHERE wallet_id = ?`).all(walletId) as
    { address: string }[]).map((row) => row.address);
}

export function setWalletFundingCursor(db: Database.Database, walletId: string, address: string, cursor: string): void {
  db.prepare(
    `INSERT INTO wallet_funding_cursors (wallet_id, address, cursor) VALUES (?, ?, ?)
     ON CONFLICT(wallet_id, address) DO UPDATE SET cursor = excluded.cursor`
  ).run(walletId, address, cursor);
}

export function setWalletFundingBlockCursor(db: Database.Database, walletId: string, cursor: string): void {
  db.prepare(`UPDATE wallet_funding_state SET cursor = ? WHERE wallet_id = ?`).run(cursor, walletId);
}

export function recordWalletFundingEvent(
  db: Database.Database,
  event: { walletId: string; eventId: string; assetId: string; symbol: string; decimals: number; amountUnits: string }
): void {
  const tx = db.transaction(() => {
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO wallet_funding_events (wallet_id, event_id, asset_id, amount_units)
       VALUES (?, ?, ?, ?)`
    ).run(event.walletId, event.eventId, event.assetId, event.amountUnits);
    if (inserted.changes === 0) return;

    db.prepare(
      `INSERT OR IGNORE INTO wallet_funding_assets
         (wallet_id, asset_id, symbol, decimals, initial_units, baseline_slot, received_units)
       VALUES (?, ?, ?, ?, '0', 0, '0')`
    ).run(event.walletId, event.assetId, event.symbol, event.decimals);
    const current = db.prepare(
      `SELECT received_units FROM wallet_funding_assets WHERE wallet_id = ? AND asset_id = ?`
    ).get(event.walletId, event.assetId) as { received_units: string };
    db.prepare(
      `UPDATE wallet_funding_assets SET received_units = ? WHERE wallet_id = ? AND asset_id = ?`
    ).run((BigInt(current.received_units) + BigInt(event.amountUnits)).toString(), event.walletId, event.assetId);
  });
  tx();
}

export function listWalletFundingAssets(db: Database.Database, walletId: string): WalletFundingAssetRow[] {
  return db.prepare(
    `SELECT * FROM wallet_funding_assets WHERE wallet_id = ? ORDER BY asset_id`
  ).all(walletId) as WalletFundingAssetRow[];
}

export function listWalletsFor(db: Database.Database, userId: string, chain?: "solana" | "evm"): WalletRow[] {
  if (chain) {
    return db.prepare(`SELECT * FROM wallets WHERE user_id = ? AND chain = ? ORDER BY created_at ASC`).all(userId, chain) as WalletRow[];
  }
  return db.prepare(`SELECT * FROM wallets WHERE user_id = ? ORDER BY chain, created_at ASC`).all(userId) as WalletRow[];
}

export function getWallet(db: Database.Database, userId: string, chain: "solana" | "evm", label: string): WalletRow | null {
  return (db.prepare(`SELECT * FROM wallets WHERE user_id = ? AND chain = ? AND label = ?`).get(userId, chain, label) as WalletRow) ?? null;
}

export function getPrimaryWallet(db: Database.Database, userId: string, chain: "solana" | "evm"): WalletRow | null {
  return (db.prepare(`SELECT * FROM wallets WHERE user_id = ? AND chain = ? AND is_primary = 1`).get(userId, chain) as WalletRow) ?? null;
}

export function setPrimaryWallet(db: Database.Database, userId: string, chain: "solana" | "evm", label: string) {
  const target = getWallet(db, userId, chain, label);
  if (!target) throw new Error("No such wallet");
  const tx = db.transaction(() => {
    db.prepare(`UPDATE wallets SET is_primary = 0 WHERE user_id = ? AND chain = ?`).run(userId, chain);
    db.prepare(`UPDATE wallets SET is_primary = 1 WHERE id = ?`).run(target.id);
  });
  tx();
  setUserWalletAddress(db, userId, chain, target.address);
}

/**
 * Deletes a wallet's row for one chain. If it was primary, promotes the
 * next-oldest remaining wallet on that chain — or clears the cached address
 * entirely if none are left. Returns the deleted row so the caller (which
 * also needs to know whether a mnemonic-backed sibling row still exists
 * before deciding whether to purge the vault secret) has what it needs
 * without a second query.
 */
export function deleteWallet(db: Database.Database, userId: string, chain: "solana" | "evm", label: string): WalletRow {
  const target = getWallet(db, userId, chain, label);
  if (!target) throw new Error("No such wallet");

  db.prepare(`DELETE FROM wallet_funding_events WHERE wallet_id = ?`).run(target.id);
  db.prepare(`DELETE FROM wallet_funding_assets WHERE wallet_id = ?`).run(target.id);
  db.prepare(`DELETE FROM wallet_funding_cursors WHERE wallet_id = ?`).run(target.id);
  db.prepare(`DELETE FROM wallet_funding_state WHERE wallet_id = ?`).run(target.id);
  db.prepare(`DELETE FROM wallets WHERE id = ?`).run(target.id);

  if (target.is_primary) {
    const next = db
      .prepare(`SELECT * FROM wallets WHERE user_id = ? AND chain = ? ORDER BY created_at ASC LIMIT 1`)
      .get(userId, chain) as WalletRow | undefined;
    if (next) {
      db.prepare(`UPDATE wallets SET is_primary = 1 WHERE id = ?`).run(next.id);
      setUserWalletAddress(db, userId, chain, next.address);
    } else {
      const column = chain === "solana" ? "solana_address" : "evm_address";
      db.prepare(`UPDATE users SET ${column} = NULL WHERE telegram_id = ?`).run(userId);
    }
  }

  return target;
}

/** True if another wallet row (either chain) still references this label — i.e. its vault secret is still needed. */
export function isLabelStillInUse(db: Database.Database, userId: string, label: string): boolean {
  const row = db.prepare(`SELECT 1 FROM wallets WHERE user_id = ? AND label = ? LIMIT 1`).get(userId, label);
  return !!row;
}

export function setUserWalletAddress(db: Database.Database, telegramId: string, chain: "solana" | "evm", address: string) {
  const column = chain === "solana" ? "solana_address" : "evm_address";
  db.prepare(`UPDATE users SET ${column} = ? WHERE telegram_id = ?`).run(address, telegramId);
}

export function setUserStatus(db: Database.Database, telegramId: string, status: "pending" | "active" | "banned") {
  db.prepare(`UPDATE users SET status = ? WHERE telegram_id = ?`).run(status, telegramId);
}

export function setUserAdminFlag(db: Database.Database, telegramId: string, message: string | null): void {
  const result = db.prepare(`UPDATE users SET admin_flag_message = ? WHERE telegram_id = ?`)
    .run(message, telegramId);
  if (result.changes !== 1) throw new Error(`User ${telegramId} is missing.`);
}

export function updateUserSettings(
  db: Database.Database,
  telegramId: string,
  patch: Partial<Pick<UserRow,
    | "snipe_enabled" | "snipe_size_sol" | "snipe_size_sol_exact" | "snipe_size_eth" | "snipe_size_eth_exact"
    | "copy_target" | "copy_size_ratio" | "copy_size_ratio_exact" | "copy_max_amount" | "copy_max_amount_exact" | "copy_sells"
    | "max_trade_sol_exact" | "max_trade_eth_exact" | "max_daily_spend_sol_exact" | "max_daily_spend_eth_exact"
    | "max_slippage_bps" | "cooldown_seconds"
  >>
) {
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const setClause = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => (patch as any)[f]);
  db.prepare(`UPDATE users SET ${setClause} WHERE telegram_id = ?`).run(...values, telegramId);
}

export function listDailyBuyExposureAmounts(
  db: Database.Database,
  userId: string,
  chain: "solana" | "evm",
  dayStart: number,
  excludeJobId?: string,
  excludeLifecycleId?: string
): string[] {
  const excludedLifecycle = excludeLifecycleId ?? (excludeJobId
    ? (db.prepare(`SELECT lifecycle_id FROM trade_jobs WHERE id = ?`).get(excludeJobId) as { lifecycle_id: string | null } | undefined)?.lifecycle_id
    : undefined);
  const lifecycleRows = db.prepare(`SELECT amount FROM trade_lifecycle
    WHERE user_id = ? AND chain = ? AND side = 'buy' AND created_at >= ?
      AND id IS NOT COALESCE(?, '')
      AND (status IN ('prepared','submitted','confirmed','unknown')
        OR (status = 'failed' AND transaction_ref IS NOT NULL))`)
    .all(userId, chain, dayStart, excludedLifecycle ?? null) as { amount: string }[];
  const jobRows = db.prepare(`SELECT amount FROM trade_jobs
    WHERE user_id = ? AND chain = ? AND side = 'buy'
      AND status IN ('queued','processing') AND lifecycle_id IS NULL
      AND created_at >= ? AND id IS NOT COALESCE(?, '')`)
    .all(userId, chain, dayStart, excludeJobId ?? null) as { amount: string }[];
  return [...lifecycleRows, ...jobRows].map((row) => row.amount);
}

export interface SystemControls {
  kill_switch_enabled: number;
  updated_at: number;
  updated_by: string | null;
}

export interface SecurityEventInput {
  eventType: string;
  actorUserId?: string;
  subjectUserId?: string;
  chain?: "solana" | "evm";
  side?: "buy" | "sell";
  amount?: string;
  source?: string;
  details?: Record<string, unknown>;
}

export function getSystemControls(db: Database.Database): SystemControls {
  const controls = db.prepare(`SELECT kill_switch_enabled, updated_at, updated_by FROM system_controls WHERE id = 1`).get() as SystemControls | undefined;
  if (!controls) throw new Error("System controls row is missing.");
  return controls;
}

export function setKillSwitch(db: Database.Database, enabled: boolean, actorUserId: string): void {
  const transaction = db.transaction(() => {
    const result = db.prepare(`UPDATE system_controls SET kill_switch_enabled = ?, updated_at = ?, updated_by = ? WHERE id = 1`)
      .run(enabled ? 1 : 0, Date.now(), actorUserId);
    if (result.changes !== 1) throw new Error("System controls row is missing; kill switch state was not changed.");
    recordSecurityEvent(db, {
      eventType: enabled ? "KILL_SWITCH_ENABLED" : "KILL_SWITCH_DISABLED",
      actorUserId,
      source: "admin_menu",
      details: { sellOrdersRemainAllowed: true, openBuyOrdersRemainQueued: true },
    });
  });
  transaction();
}

export function recordSecurityEvent(db: Database.Database, event: SecurityEventInput): void {
  db.prepare(
    `INSERT INTO security_events
      (event_type, actor_user_id, subject_user_id, chain, side, amount, source, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.eventType,
    event.actorUserId ?? null,
    event.subjectUserId ?? null,
    event.chain ?? null,
    event.side ?? null,
    event.amount ?? null,
    event.source ?? null,
    JSON.stringify(event.details ?? {}),
    Date.now()
  );
}

export interface SecurityEventRow {
  event_type: string;
  actor_user_id: string | null;
  subject_user_id: string | null;
  chain: string | null;
  side: string | null;
  amount: string | null;
  source: string | null;
  details_json: string;
  created_at: number;
}

export function listRecentSecurityEvents(db: Database.Database, limit = 10): SecurityEventRow[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Audit event limit must be from 1 to 100.");
  return db.prepare(`SELECT event_type, actor_user_id, subject_user_id, chain, side, amount, source, details_json, created_at
    FROM security_events ORDER BY id DESC LIMIT ?`).all(limit) as SecurityEventRow[];
}

export interface TradeLifecycleInput {
  id: string;
  userId: string;
  chain: "solana" | "evm";
  side: "buy" | "sell";
  source: "manual" | "sniper" | "copytrade" | "limit_order";
  asset: string;
  amount: string;
}

export interface TradeJobInput {
  dedupeKey: string;
  userId: string;
  chain: "solana" | "evm";
  side: "buy" | "sell";
  source: "sniper" | "copytrade" | "limit_order";
  asset: string;
  amount: string;
  poolRef?: string;
  decimals?: number;
  limitOrderId?: string;
}

export interface TradeJobRow {
  id: string;
  dedupe_key: string;
  user_id: string;
  chain: "solana" | "evm";
  side: "buy" | "sell";
  source: "sniper" | "copytrade" | "limit_order";
  asset: string;
  amount: string;
  pool_ref: string | null;
  decimals: number | null;
  limit_order_id: string | null;
  status: "queued" | "processing" | "submitted" | "completed" | "failed";
  attempts: number;
  max_attempts: number;
  available_at: number;
  lifecycle_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export function enqueueTradeJob(db: Database.Database, job: TradeJobInput): TradeJobRow {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(`INSERT OR IGNORE INTO trade_jobs
    (id, dedupe_key, user_id, chain, side, source, asset, amount, pool_ref, decimals, limit_order_id,
      status, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`).run(
    id,
    job.dedupeKey,
    job.userId,
    job.chain,
    job.side,
    job.source,
    job.asset,
    job.amount,
    job.poolRef ?? null,
    job.decimals ?? null,
    job.limitOrderId ?? null,
    now,
    now,
    now
  );
  const row = db.prepare(`SELECT * FROM trade_jobs WHERE dedupe_key = ?`).get(job.dedupeKey) as TradeJobRow | undefined;
  if (!row) throw new Error("Failed to persist trade job.");
  return row;
}

export function claimNextTradeJob(db: Database.Database): TradeJobRow | null {
  const claim = db.transaction(() => {
    const job = db.prepare(`SELECT * FROM trade_jobs WHERE status = 'queued' AND available_at <= ?
      ORDER BY created_at ASC LIMIT 1`).get(Date.now()) as TradeJobRow | undefined;
    if (!job) return null;
    const result = db.prepare(`UPDATE trade_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'queued'`).run(Date.now(), job.id);
    if (result.changes !== 1) return null;
    return db.prepare(`SELECT * FROM trade_jobs WHERE id = ?`).get(job.id) as TradeJobRow;
  });
  return claim();
}

export function attachLifecycleToTradeJob(db: Database.Database, jobId: string, lifecycleId: string): void {
  const attach = db.transaction(() => {
    db.prepare(`UPDATE trade_lifecycle SET job_id = NULL WHERE job_id = ?`).run(jobId);
    const result = db.prepare(`UPDATE trade_jobs SET lifecycle_id = ?, updated_at = ? WHERE id = ?`)
      .run(lifecycleId, Date.now(), jobId);
    if (result.changes !== 1) throw new Error(`Trade job ${jobId} is missing.`);
    db.prepare(`UPDATE trade_lifecycle SET job_id = ? WHERE id = ?`).run(jobId, lifecycleId);
  });
  attach();
}

export function setTradeJobStatus(
  db: Database.Database,
  id: string,
  status: TradeJobRow["status"],
  options: { error?: string; retryAt?: number } = {}
): void {
  const now = Date.now();
  const result = db.prepare(`UPDATE trade_jobs SET status = ?, last_error = ?,
      available_at = COALESCE(?, available_at), updated_at = ? WHERE id = ?`)
    .run(status, options.error?.slice(0, 500) ?? null, options.retryAt ?? null, now, id);
  if (result.changes !== 1) throw new Error(`Trade job ${id} is missing.`);
}

export function deferTradeJob(db: Database.Database, id: string, retryAt: number, reason: string): void {
  db.prepare(`UPDATE trade_jobs SET status = 'queued', attempts = MAX(0, attempts - 1),
      available_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
    .run(retryAt, reason.slice(0, 500), Date.now(), id);
}

export function getTradeJobByDedupeKey(db: Database.Database, dedupeKey: string): TradeJobRow | null {
  return (db.prepare(`SELECT * FROM trade_jobs WHERE dedupe_key = ?`).get(dedupeKey) as TradeJobRow) ?? null;
}

export function listRecentTradeJobsForUser(db: Database.Database, userId: string, limit = 10): TradeJobRow[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError("Trade job history limit must be from 1 to 50.");
  return db.prepare(`SELECT * FROM trade_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(userId, limit) as TradeJobRow[];
}

export function recoverProcessingTradeJobs(db: Database.Database): void {
  const now = Date.now();
  const recover = db.transaction(() => {
    db.prepare(`UPDATE trade_jobs SET status = 'queued', available_at = ?, last_error = 'Worker restarted before submission; retrying.',
        updated_at = ? WHERE status = 'processing' AND lifecycle_id IS NULL AND attempts < max_attempts`)
      .run(now, now);
    db.prepare(`UPDATE trade_jobs SET status = 'failed', last_error = 'Worker restarted and retry limit was reached.',
        updated_at = ? WHERE status = 'processing' AND lifecycle_id IS NULL AND attempts >= max_attempts`)
      .run(now);
    db.prepare(`UPDATE trade_jobs SET status = 'completed', updated_at = ?, last_error = NULL
        WHERE status = 'processing' AND lifecycle_id IN (SELECT id FROM trade_lifecycle WHERE status = 'confirmed')`)
      .run(now);
    db.prepare(`UPDATE limit_orders SET status = 'filled', filled_at = ?
        WHERE status = 'open' AND id IN (SELECT limit_order_id FROM trade_jobs
          WHERE status = 'completed' AND limit_order_id IS NOT NULL)`)
      .run(now);
    db.prepare(`UPDATE trade_jobs SET status = 'failed', last_error = 'Worker restarted after the trade failed.',
        updated_at = ? WHERE status = 'processing' AND lifecycle_id IN (SELECT id FROM trade_lifecycle WHERE status = 'failed')`)
      .run(now);
    db.prepare(`UPDATE trade_jobs SET status = 'submitted', last_error = 'Submission status is being reconciled.',
        updated_at = ? WHERE status = 'processing' AND lifecycle_id IN
          (SELECT id FROM trade_lifecycle WHERE status IN ('submitted','unknown'))`)
      .run(now);

    const prepared = db.prepare(`SELECT id FROM trade_jobs
      WHERE status = 'processing' AND lifecycle_id IN (SELECT id FROM trade_lifecycle WHERE status = 'prepared')`)
      .all() as { id: string }[];
    for (const { id } of prepared) {
      const job = db.prepare(`SELECT lifecycle_id, attempts, max_attempts FROM trade_jobs WHERE id = ?`)
        .get(id) as { lifecycle_id: string; attempts: number; max_attempts: number };
      db.prepare(`UPDATE trade_lifecycle SET job_id = NULL, status = 'failed',
          error = 'Worker restarted before transaction submission.', updated_at = ? WHERE id = ? AND status = 'prepared'`)
        .run(now, job.lifecycle_id);
      if (job.attempts < job.max_attempts) {
        db.prepare(`UPDATE trade_jobs SET status = 'queued', lifecycle_id = NULL, available_at = ?,
            last_error = 'Worker restarted before transaction submission; retrying.', updated_at = ? WHERE id = ?`)
          .run(now, now, id);
      } else {
        db.prepare(`UPDATE trade_jobs SET status = 'failed', last_error = 'Worker restarted and retry limit was reached.',
            updated_at = ? WHERE id = ?`)
          .run(now, id);
      }
    }
  });
  recover();
}

export function syncTradeJobWithLifecycle(db: Database.Database, lifecycleId: string, status: "confirmed" | "failed" | "unknown", error?: string): void {
  const lifecycle = db.prepare(`SELECT job_id FROM trade_lifecycle WHERE id = ?`).get(lifecycleId) as { job_id: string | null } | undefined;
  if (lifecycle?.job_id) {
    const jobStatus = status === "confirmed" ? "completed" : status === "failed" ? "failed" : "submitted";
    const job = db.prepare(`SELECT limit_order_id FROM trade_jobs WHERE id = ?`).get(lifecycle.job_id) as { limit_order_id: string | null } | undefined;
    const transaction = db.transaction(() => {
      setTradeJobStatus(db, lifecycle.job_id!, jobStatus, { error });
      if (status === "confirmed" && job?.limit_order_id) {
        db.prepare(`UPDATE limit_orders SET status = 'filled', filled_at = ? WHERE id = ? AND status = 'open'`)
          .run(Date.now(), job.limit_order_id);
      }
    });
    transaction();
  }
}

export interface TradeLifecycleRow {
  id: string;
  user_id: string;
  chain: "solana" | "evm";
  side: "buy" | "sell";
  source: string;
  asset: string;
  amount: string;
  status: "prepared" | "submitted" | "confirmed" | "failed" | "unknown";
  transaction_ref: string | null;
  approval_transaction_ref: string | null;
  bundle_ref: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  confirmed_at: number | null;
}

export function createTradeLifecycle(db: Database.Database, trade: TradeLifecycleInput): void {
  const now = Date.now();
  db.prepare(`INSERT INTO trade_lifecycle
    (id, user_id, chain, side, source, asset, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`).run(
    trade.id,
    trade.userId,
    trade.chain,
    trade.side,
    trade.source,
    trade.asset,
    trade.amount,
    now,
    now
  );
}

export function recordTradeSubmission(
  db: Database.Database,
  id: string,
  reference: { kind: "swap" | "approval"; transactionRef: string; bundleRef?: string }
): void {
  const column = reference.kind === "approval" ? "approval_transaction_ref" : "transaction_ref";
  const result = db.prepare(
    `UPDATE trade_lifecycle SET ${column} = ?, bundle_ref = COALESCE(?, bundle_ref),
      status = CASE WHEN status IN ('confirmed','failed') THEN status ELSE 'submitted' END,
      updated_at = ? WHERE id = ?`
  ).run(reference.transactionRef, reference.bundleRef ?? null, Date.now(), id);
  if (result.changes !== 1) throw new Error(`Trade lifecycle ${id} is missing.`);
}

export function updateTradeLifecycle(
  db: Database.Database,
  id: string,
  status: "confirmed" | "failed" | "unknown",
  error?: string
): void {
  const now = Date.now();
  const result = db.prepare(`UPDATE trade_lifecycle SET status = ?, error = ?, updated_at = ?,
    confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END
    WHERE id = ? AND status NOT IN ('confirmed','failed')`).run(
    status,
    error ?? null,
    now,
    status,
    now,
    id
  );
  if (result.changes !== 1) {
    const existing = db.prepare(`SELECT status FROM trade_lifecycle WHERE id = ?`).get(id) as { status: string } | undefined;
    if (!existing) throw new Error(`Trade lifecycle ${id} is missing.`);
  }
  syncTradeJobWithLifecycle(db, id, status, error);
}

export function listRecentTradesForUser(db: Database.Database, userId: string, limit = 10): TradeLifecycleRow[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError("Trade history limit must be from 1 to 50.");
  return db.prepare(`SELECT * FROM trade_lifecycle WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(userId, limit) as TradeLifecycleRow[];
}

export function listReconciliationTrades(db: Database.Database, limit = 100): TradeLifecycleRow[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Reconciliation batch size must be from 1 to 500.");
  return db.prepare(`SELECT * FROM trade_lifecycle
    WHERE status IN ('submitted','unknown') AND transaction_ref IS NOT NULL
    ORDER BY updated_at ASC LIMIT ?`).all(limit) as TradeLifecycleRow[];
}

export function listStalePreparedTrades(db: Database.Database, olderThan: number): TradeLifecycleRow[] {
  return db.prepare(`SELECT * FROM trade_lifecycle WHERE status = 'prepared' AND created_at < ?
    ORDER BY created_at ASC LIMIT 500`).all(olderThan) as TradeLifecycleRow[];
}

/**
 * Users with auto-buy on — the pool/pair listeners fan out a buy to each.
 * There's one snipe_enabled flag covering both chains (not per-chain), sized
 * independently via snipe_size_sol/snipe_size_eth; the `chain` param exists
 * so call sites read clearly at each listener, even though it doesn't
 * currently filter anything server-side.
 */
export function listActiveSnipers(db: Database.Database, chain: "solana" | "evm"): UserRow[] {
  return db
    .prepare(`SELECT * FROM users WHERE status = 'active' AND snipe_enabled = 1`)
    .all() as UserRow[];
}

/** Users following a copy-trade target, grouped implicitly by copy_target — the registry queries this per target. */
export function listCopyFollowers(db: Database.Database, targetWallet: string): UserRow[] {
  return db
    .prepare(`SELECT * FROM users WHERE status = 'active' AND copy_target = ?`)
    .all(targetWallet) as UserRow[];
}

export function listAllCopyTargets(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT copy_target FROM users WHERE status = 'active' AND copy_target IS NOT NULL`)
    .all() as { copy_target: string }[];
  return rows.map((r) => r.copy_target);
}

/**
 * Records that a user has bought a given token, so the EVM portfolio view
 * knows which balanceOf() calls to make. Solana doesn't need this — its
 * token accounts are enumerable directly from the chain — but EVM has no
 * equivalent without a paid indexer, so tracking what we've bought is the
 * free alternative. Call after every successful EVM buy.
 */
export function recordHolding(db: Database.Database, chain: "solana" | "evm", userId: string, identifier: string) {
  db.prepare(`INSERT OR IGNORE INTO holdings (chain, user_id, identifier) VALUES (?, ?, ?)`).run(
    chain,
    userId,
    identifier
  );
}

export function getHoldings(db: Database.Database, chain: "solana" | "evm", userId: string): string[] {
  return db
    .prepare(`SELECT identifier FROM holdings WHERE chain = ? AND user_id = ?`)
    .all(chain, userId)
    .map((r: any) => r.identifier);
}
