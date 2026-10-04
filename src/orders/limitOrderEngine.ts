import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Connection, Keypair } from "@solana/web3.js";
import { JsonRpcProvider, Wallet as EvmWallet } from "ethers";
import { getSolanaPrice } from "../chains/solana/price.js";
import { getEvmPrice } from "../chains/evm/price.js";
import { executeBuy as executeSolanaBuy, executeSell as executeSolanaSell } from "../chains/solana/executor.js";
import { executeBuy as executeEvmBuy, executeSell as executeEvmSell } from "../chains/evm/executor.js";
import { recordHolding } from "../db/db.js";

export interface LimitOrderInput {
  userId: string;
  chain: "solana" | "evm";
  identifier: string; // mint or token address
  poolRef?: string; // required for solana (poolId); unused for evm
  side: "buy" | "sell";
  direction: "above" | "below"; // fire when price crosses above/below trigger
  triggerPrice: number;
  amount: number; // buy: native currency to spend (SOL/ETH). sell: token quantity, human units.
  decimals?: number; // required for sell orders — token decimals, to compute raw base units
}

export function createOrder(db: Database.Database, order: LimitOrderInput): string {
  if (order.chain === "solana" && !order.poolRef) {
    throw new Error("Solana limit orders require poolRef (poolId) for pricing + execution");
  }
  if (order.side === "sell" && order.decimals === undefined) {
    throw new Error("Sell orders require decimals to convert amount into raw token base units");
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO limit_orders
     (id, user_id, chain, identifier, pool_ref, side, direction, trigger_price, amount, decimals, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(
    id,
    order.userId,
    order.chain,
    order.identifier,
    order.poolRef ?? null,
    order.side,
    order.direction,
    order.triggerPrice,
    order.amount,
    order.decimals ?? null,
    Date.now()
  );
  return id;
}

export function cancelOrder(db: Database.Database, id: string) {
  db.prepare(`UPDATE limit_orders SET status = 'cancelled' WHERE id = ? AND status = 'open'`).run(id);
}

function getOpenOrders(db: Database.Database) {
  return db.prepare(`SELECT * FROM limit_orders WHERE status = 'open'`).all() as any[];
}

function markFilled(db: Database.Database, id: string) {
  db.prepare(`UPDATE limit_orders SET status = 'filled', filled_at = ? WHERE id = ?`).run(Date.now(), id);
}

function crossed(direction: "above" | "below", price: number, trigger: number): boolean {
  return direction === "above" ? price >= trigger : price <= trigger;
}

function toBaseUnits(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}

export interface EngineDeps {
  db: Database.Database;
  solConnection: Connection;
  loadSolWallet: (userId: string) => Keypair | null;
  evmProvider: JsonRpcProvider;
  loadEvmWallet: (userId: string) => EvmWallet | null;
  evmFactoryAddress: string;
  pollIntervalMs?: number;
}

/**
 * Polls open orders on an interval and fires the matching executor —
 * buy or sell, either chain — once price crosses the order's trigger.
 * Wallets are loaded per-order by the order's own user_id, fresh each tick
 * rather than captured at startup, so an order created before its owner has
 * a wallet will start filling as soon as they create one — no restart, and
 * critically, no risk of one user's order executing against another user's
 * wallet now that multiple people's orders share this table.
 */
export function startLimitOrderEngine(deps: EngineDeps) {
  const { db, solConnection, loadSolWallet, evmProvider, loadEvmWallet, evmFactoryAddress } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;

  const interval = setInterval(async () => {
    const orders = getOpenOrders(db);
    if (orders.length === 0) return;

    for (const order of orders) {
      try {
        const solWallet = order.chain === "solana" ? loadSolWallet(order.user_id) : null;
        const evmWallet = order.chain === "evm" ? loadEvmWallet(order.user_id) : null;

        if (order.chain === "solana" && !solWallet) {
          console.warn(`[limit-order] skipping ${order.id} — user ${order.user_id} has no Solana wallet yet`);
          continue;
        }
        if (order.chain === "evm" && !evmWallet) {
          console.warn(`[limit-order] skipping ${order.id} — user ${order.user_id} has no EVM wallet yet`);
          continue;
        }

        const price =
          order.chain === "solana"
            ? await getSolanaPrice(solConnection, solWallet!, order.pool_ref)
            : await getEvmPrice(evmProvider, evmFactoryAddress, order.identifier);

        if (!crossed(order.direction, price, order.trigger_price)) continue;

        console.log(
          `[limit-order] triggered: ${order.chain} ${order.side} ${order.identifier} @ ${price} (trigger ${order.trigger_price}) for user ${order.user_id}`
        );

        if (order.chain === "solana") {
          if (order.side === "buy") {
            await executeSolanaBuy({
              connection: solConnection,
              wallet: solWallet!,
              poolId: order.pool_ref,
              amountInLamports: BigInt(Math.floor(order.amount * 1e9)),
              slippageBps: 500,
            });
          } else {
            await executeSolanaSell({
              connection: solConnection,
              wallet: solWallet!,
              poolId: order.pool_ref,
              amountInTokenBaseUnits: toBaseUnits(order.amount, order.decimals),
              slippageBps: 500,
            });
          }
        } else {
          if (order.side === "buy") {
            await executeEvmBuy({
              provider: evmProvider,
              wallet: evmWallet!,
              tokenAddress: order.identifier,
              amountInEth: String(order.amount),
              slippageBps: 500,
            });
            recordHolding(db, "evm", order.user_id, order.identifier);
          } else {
            await executeEvmSell({
              provider: evmProvider,
              wallet: evmWallet!,
              tokenAddress: order.identifier,
              amountInTokenBaseUnits: toBaseUnits(order.amount, order.decimals),
              slippageBps: 500,
            });
          }
        }

        markFilled(db, order.id);
      } catch (err) {
        console.error(`[limit-order] error processing order ${order.id}:`, err);
      }
    }
  }, pollIntervalMs);

  return () => clearInterval(interval);
}
