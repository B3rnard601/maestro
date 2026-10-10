import Database from "better-sqlite3";
import { Connection, Keypair } from "@solana/web3.js";
import { JsonRpcProvider } from "ethers";
import { getEvmPrice } from "../chains/evm/price.js";
import { getSolanaPrice } from "../chains/solana/price.js";
import {
  isPremiumActive,
  listPremiumPriceAlerts,
  markPremiumPriceAlertTriggered,
} from "../db/db.js";

export function startPremiumAlertWatcher(args: {
  db: Database.Database;
  solConnection: Connection;
  evmProvider: JsonRpcProvider;
  evmFactory: string;
  loadSolanaWallet: (userId: string) => Keypair | null;
  notify: (userId: string, text: string) => Promise<unknown>;
  pollIntervalMs?: number;
}): () => void {
  const pollIntervalMs = args.pollIntervalMs ?? 20_000;
  let running = false;

  const poll = async () => {
    if (running) return;
    running = true;
    try {
      for (const alert of listPremiumPriceAlerts(args.db)) {
        try {
          if (!isPremiumActive(args.db, alert.user_id)) continue;
          const price = alert.chain === "solana"
            ? await getAlertSolanaPrice(alert.user_id, alert.pool_ref)
            : await getEvmPrice(args.evmProvider, args.evmFactory, alert.identifier);
          const triggered = alert.direction === "above"
            ? price >= alert.target_price
            : price <= alert.target_price;
          if (!triggered) continue;

          markPremiumPriceAlertTriggered(args.db, alert.id);
          await args.notify(
            alert.user_id,
            `🔔 PREMIUM PRICE ALERT\n${alert.chain.toUpperCase()} ${alert.identifier}\nPrice: ${price}\nCondition: ${alert.direction} ${alert.target_price}`,
          );
        } catch (err) {
          console.error(`[premium/alerts] couldn't check alert ${alert.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[premium/alerts] alert scan failed:", err);
    } finally {
      running = false;
    }
  };

  const getAlertSolanaPrice = async (userId: string, poolRef: string | null): Promise<number> => {
    if (!poolRef) throw new Error("Solana price alert has no pool ID.");
    const wallet = args.loadSolanaWallet(userId);
    if (!wallet) throw new Error(`No Solana wallet is available to read the price for user ${userId}.`);
    return getSolanaPrice(args.solConnection, wallet, poolRef);
  };

  const interval = setInterval(() => void poll(), pollIntervalMs);
  void poll();
  return () => clearInterval(interval);
}
