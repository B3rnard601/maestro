import Database from "better-sqlite3";
import { Connection } from "@solana/web3.js";
import { JsonRpcProvider } from "ethers";
import {
  listReconciliationTrades,
  listStalePreparedTrades,
  updateTradeLifecycle,
} from "../db/db.js";

const UNKNOWN_AFTER_MS = 15 * 60_000;
const PREPARED_STALE_AFTER_MS = 2 * 60_000;

export function startTradeReconciler(
  db: Database.Database,
  solConnection: Connection,
  evmProvider: JsonRpcProvider,
  pollIntervalMs = 10_000
): () => void {
  let running = false;
  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      for (const trade of listStalePreparedTrades(db, Date.now() - PREPARED_STALE_AFTER_MS)) {
        updateTradeLifecycle(db, trade.id, "failed", "Process stopped before a transaction was submitted.");
      }

      const trades = listReconciliationTrades(db);
      for (const trade of trades) {
        try {
          if (trade.chain === "evm") {
            const transactionRef = trade.transaction_ref ?? trade.approval_transaction_ref;
            if (!transactionRef) continue;
            const receipt = await evmProvider.getTransactionReceipt(transactionRef);
            if (receipt) {
              if (receipt.status === 0) {
                updateTradeLifecycle(db, trade.id, "failed", "EVM transaction reverted.");
              } else if (trade.transaction_ref) {
                updateTradeLifecycle(db, trade.id, "confirmed");
              }
            }
          } else if (trade.transaction_ref) {
            const result = await solConnection.getSignatureStatuses(
              [trade.transaction_ref],
              { searchTransactionHistory: true }
            );
            const status = result.value[0];
            if (status?.err) {
              updateTradeLifecycle(db, trade.id, "failed", "Solana transaction failed on chain.");
            } else if (status?.confirmationStatus === "finalized") {
              updateTradeLifecycle(db, trade.id, "confirmed");
            }
          }

          if (
            Date.now() - trade.created_at > UNKNOWN_AFTER_MS &&
            trade.status === "submitted"
          ) {
            updateTradeLifecycle(db, trade.id, "unknown", "No final chain status was found within 15 minutes.");
          }
        } catch (err) {
          console.error(`[transactions] reconciliation failed for ${trade.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[transactions] reconciliation batch failed:", err);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void reconcile(), pollIntervalMs);
  void reconcile();
  return () => clearInterval(interval);
}
