import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { Connection } from "@solana/web3.js";
import { JsonRpcProvider } from "ethers";
import { getSolanaPortfolio, getEvmPortfolio } from "./portfolio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const PORT = process.env.ADMIN_PORT || 4000;
const DB_PATH = process.env.BOT_DB_PATH || path.join(__dirname, "..", "data", "bot.db");

if (!ADMIN_PASSWORD || !JWT_SECRET) {
  console.error("ADMIN_PASSWORD and ADMIN_JWT_SECRET must be set (see .env.example). Refusing to start unauthenticated.");
  process.exit(1);
}

const db = new Database(DB_PATH);
const solConn = new Connection(process.env.SOLANA_RPC_HTTP || "https://api.mainnet-beta.solana.com");
const evmProvider = new JsonRpcProvider(process.env.EVM_RPC_HTTP || "https://eth.llamarpc.com");

const app = express();
app.use(cors());
app.use(express.json());

// --- Auth ---
app.post("/api/auth/login", (req, res) => {
  const { password } = req.body ?? {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.use("/api", (req, res, next) => (req.path === "/auth/login" ? next() : requireAuth(req, res, next)));

// --- Users ---
app.get("/api/users", (req, res) => {
  const users = db.prepare(`SELECT * FROM users ORDER BY created_at DESC`).all();
  res.json(users);
});

app.get("/api/users/:id", async (req, res) => {
  const user = db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });

  const orders = db
    .prepare(`SELECT * FROM limit_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`)
    .all(req.params.id);

  const portfolio = { solana: null, evm: null };
  if (user.solana_address) {
    try {
      portfolio.solana = await getSolanaPortfolio(solConn, user.solana_address);
    } catch (err) {
      portfolio.solana = { error: err.message };
    }
  }
  if (user.evm_address) {
    try {
      const known = db
        .prepare(`SELECT identifier FROM holdings WHERE chain = 'evm' AND user_id = ?`)
        .all(req.params.id)
        .map((r) => r.identifier);
      portfolio.evm = await getEvmPortfolio(evmProvider, user.evm_address, known);
    } catch (err) {
      portfolio.evm = { error: err.message };
    }
  }

  res.json({ user, orders, portfolio });
});

app.post("/api/users/:id/approve", (req, res) => {
  db.prepare(`UPDATE users SET status = 'active' WHERE telegram_id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/users/:id/ban", (req, res) => {
  db.prepare(`UPDATE users SET status = 'banned' WHERE telegram_id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/users/:id/unban", (req, res) => {
  db.prepare(`UPDATE users SET status = 'active' WHERE telegram_id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// --- Orders (cross-user, admin view) ---
app.get("/api/orders", (req, res) => {
  const status = req.query.status || "open";
  const orders = db
    .prepare(`SELECT * FROM limit_orders WHERE status = ? ORDER BY created_at DESC LIMIT 200`)
    .all(status);
  res.json(orders);
});

app.delete("/api/orders/:id", (req, res) => {
  db.prepare(`UPDATE limit_orders SET status = 'cancelled' WHERE id = ? AND status = 'open'`).run(req.params.id);
  res.json({ ok: true });
});

// --- Stats ---
app.get("/api/stats", (req, res) => {
  const users = db.prepare(`SELECT status, snipe_enabled, copy_target FROM users`).all();
  const openOrders = db.prepare(`SELECT COUNT(*) AS c FROM limit_orders WHERE status = 'open'`).get().c;
  res.json({
    totalUsers: users.length,
    pendingUsers: users.filter((u) => u.status === "pending").length,
    activeUsers: users.filter((u) => u.status === "active").length,
    bannedUsers: users.filter((u) => u.status === "banned").length,
    activeSnipers: users.filter((u) => u.snipe_enabled).length,
    activeCopyTraders: users.filter((u) => u.copy_target).length,
    openOrders,
  });
});

app.listen(PORT, () => console.log(`admin-server listening on :${PORT}`));
