import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Connection, Keypair } from "@solana/web3.js";
import { JsonRpcProvider, Wallet as EvmWallet } from "ethers";
import { getSolanaPrice } from "../chains/solana/price.js";
import { getEvmPrice } from "../chains/evm/price.js";
import { executeBuy as executeSolanaBuy, executeSell as executeSolanaSell } from "../chains/solana/executor.js";
import { executeBuy as executeEvmBuy, executeSell as executeEvmSell } from "../chains/evm/executor.js";
import { getSystemControls, recordHolding } from "../db/db.js";
import type { AppConfig } from "../config/env.js";
import { assertBuyEntryEnabled, evaluateTradePolicy } from "../risk/policy.js";
import { parseUnitsExact } from "../shared/amount.js";
import { beginTrackedTrade } from "../transactions/tracker.js";

export interface LimitOrderInput {
  userId: string;
  chain: "solana" | "evm";
  identifier: string; // mint or token address
  poolRef?: string; // required for solana (poolId); unused for evm
  side: "buy" | "sell";
  direction: "above" | "below"; // fire when price crosses above/below trigger
  triggerPrice: number;
  amount: string; // buy: native currency to spend (SOL/ETH). sell: token quantity, human units.
  decimals?: number; // required for sell orders — token decimals, to compute raw base units
}

export function createOrder(db: Database.Database, order: LimitOrderInput): string {
  if (order.chain === "solana" && !order.poolRef) {
    throw new Error("Solana limit orders require poolRef (poolId) for pricing + execution");
  }
  if (order.side === "sell" && order.decimals === undefined) {
    throw new Error("Sell orders require decimals to convert amount into raw token base units");
  }
  if (!Number.isFinite(order.triggerPrice) || order.triggerPrice <= 0) {
    throw new Error("Trigger price must be a positive finite number.");
  }
  const amountUnits = parseUnitsExact(
    order.amount,
    order.side === "sell" ? order.decimals! : order.chain === "solana" ? 9 : 18
  );
  if (amountUnits <= 0n) throw new Error("Order amount must be greater than zero.");
  if (!Number.isFinite(Number(order.amount))) throw new Error("Order amount is outside the supported range.");
  if (order.side === "sell" && (!Number.isInteger(order.decimals) || order.decimals! < 0 || order.decimals! > 255)) {
    throw new Error("Sell order decimals must be an integer from 0 to 255.");
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO limit_orders
     (id, user_id, chain, identifier, pool_ref, side, direction, trigger_price, amount, amount_exact, decimals, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(
    id,
    order.userId,
    order.chain,
    order.identifier,
    order.poolRef ?? null,
    order.side,
    order.direction,
    order.triggerPrice,
    Number(order.amount),
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

function toBaseUnits(amount: string, decimals: number): bigint {
  return parseUnitsExact(amount, decimals);
}

export interface EngineDeps {
  db: Database.Database;
  solConnection: Connection;
  loadSolWallet: (userId: string) => Keypair | null;
  evmProvider: JsonRpcProvider;
  loadEvmWallet: (userId: string) => EvmWallet | null;
  evmFactoryAddress: string;
  config: AppConfig;
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
  const { db, solConnection, loadSolWallet, evmProvider, loadEvmWallet, evmFactoryAddress, config } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000;
  const auditedBlockedOrders = new Set<string>();

  const interval = setInterval(async () => {
    const orders = getOpenOrders(db);
    if (orders.length === 0) return;

    for (const order of orders) {
      let lifecycle: ReturnType<typeof beginTrackedTrade> | undefined;
      try {
        const amount = order.amount_exact ?? String(order.amount);
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

        if (order.side === "buy" && auditedBlockedOrders.has(order.id)) continue;
        if (order.side === "buy" && getSystemControls(db).kill_switch_enabled) continue;

        const price =
          order.chain === "solana"
            ? await getSolanaPrice(solConnection, solWallet!, order.pool_ref)
            : await getEvmPrice(evmProvider, evmFactoryAddress, order.identifier);

        if (!crossed(order.direction, price, order.trigger_price)) continue;

        console.log(
          `[limit-order] triggered: ${order.chain} ${order.side} ${order.identifier} @ ${price} (trigger ${order.trigger_price}) for user ${order.user_id}`
        );

        const decision = evaluateTradePolicy(db, config, {
          userId: order.user_id,
          chain: order.chain,
          side: order.side,
          amount,
          source: "limit_order",
        });
        if (!decision.allowed) {
          auditedBlockedOrders.add(order.id);
          continue;
        }
        lifecycle = beginTrackedTrade(db, {
          userId: order.user_id,
          chain: order.chain,
          side: order.side,
          source: "limit_order",
          asset: order.identifier,
          amount,
        });

        if (order.chain === "solana") {
          if (order.side === "buy") {
            await executeSolanaBuy({
              connection: solConnection,
              wallet: solWallet!,
              poolId: order.pool_ref,
              amountInLamports: parseUnitsExact(amount, 9),
              slippageBps: decision.maxSlippageBps,
              assertCanSubmit: () => assertBuyEntryEnabled(db, order.user_id, "solana", "limit_order"),
              onLifecycleEvent: lifecycle.observe,
            });
          } else {
            await executeSolanaSell({
              connection: solConnection,
              wallet: solWallet!,
              poolId: order.pool_ref,
              amountInTokenBaseUnits: toBaseUnits(amount, order.decimals),
              slippageBps: decision.maxSlippageBps,
              onLifecycleEvent: lifecycle.observe,
            });
          }
        } else {
          if (order.side === "buy") {
            await executeEvmBuy({
              provider: evmProvider,
              wallet: evmWallet!,
              tokenAddress: order.identifier,
              amountInEth: amount,
              slippageBps: decision.maxSlippageBps,
              assertCanSubmit: () => assertBuyEntryEnabled(db, order.user_id, "evm", "limit_order"),
              onLifecycleEvent: lifecycle.observe,
            });
            recordHolding(db, "evm", order.user_id, order.identifier);
          } else {
            await executeEvmSell({
              provider: evmProvider,
              wallet: evmWallet!,
              tokenAddress: order.identifier,
              amountInTokenBaseUnits: toBaseUnits(amount, order.decimals),
              slippageBps: decision.maxSlippageBps,
              onLifecycleEvent: lifecycle.observe,
            });
          }
        }

        markFilled(db, order.id);
      } catch (err) {
        lifecycle?.failIfNotSubmitted(err);
        if (lifecycle?.wasSubmitted) markFilled(db, order.id);
        console.error(`[limit-order] error processing order ${order.id}:`, err);
      }
    }
  }, pollIntervalMs);

  return () => clearInterval(interval);
}
