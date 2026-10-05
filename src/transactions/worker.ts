import Database from "better-sqlite3";
import { Connection, Keypair } from "@solana/web3.js";
import { JsonRpcProvider, Wallet as EvmWallet } from "ethers";
import {
  attachLifecycleToTradeJob,
  claimNextTradeJob,
  deferTradeJob,
  enqueueTradeJob,
  getSystemControls,
  recoverProcessingTradeJobs,
  recordHolding,
  setTradeJobStatus,
  type TradeJobInput,
} from "../db/db.js";
import type { AppConfig } from "../config/env.js";
import { executeBuy as executeSolanaBuy, executeSell as executeSolanaSell } from "../chains/solana/executor.js";
import { executeBuy as executeEvmBuy, executeSell as executeEvmSell } from "../chains/evm/executor.js";
import { assertBuyEntryEnabled, evaluateTradePolicy } from "../risk/policy.js";
import { parseUnitsExact } from "../shared/amount.js";
import { beginTrackedTrade } from "./tracker.js";

const MAX_ATTEMPTS = 5;
const PAUSE_RECHECK_MS = 15_000;

export type AutomatedTradeInput = TradeJobInput;

export interface TradeWorkerDeps {
  db: Database.Database;
  config: AppConfig;
  solConnection: Connection;
  evmProvider: JsonRpcProvider;
  loadSolWallet: (userId: string) => Keypair | null;
  loadEvmWallet: (userId: string) => EvmWallet | null;
  pollIntervalMs?: number;
}

export function enqueueAutomatedTrade(db: Database.Database, trade: AutomatedTradeInput) {
  return enqueueTradeJob(db, trade);
}

export function startTradeWorker(deps: TradeWorkerDeps): () => void {
  const { db, config, solConnection, evmProvider, loadSolWallet, loadEvmWallet } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  recoverProcessingTradeJobs(db);
  let running = false;
  let stopped = false;

  const processOne = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const job = claimNextTradeJob(db);
      if (!job) return;
      if (job.limit_order_id) {
        const order = db.prepare(`SELECT status FROM limit_orders WHERE id = ?`).get(job.limit_order_id) as { status: string } | undefined;
        if (!order || order.status !== "open") {
          setTradeJobStatus(db, job.id, "failed", { error: "Limit order was cancelled before execution." });
          return;
        }
      }

      const decision = evaluateTradePolicy(db, config, {
        userId: job.user_id,
        chain: job.chain,
        side: job.side,
        amount: job.amount,
        source: job.source,
        jobId: job.id,
      });
      if (!decision.allowed) {
        if (decision.reasons.length === 1 && decision.reasons[0] === "KILL_SWITCH_ENABLED") {
          deferTradeJob(db, job.id, Date.now() + PAUSE_RECHECK_MS, "Buy entries paused by the admin kill switch.");
        } else if (decision.reasons.length === 1 && decision.reasons[0].startsWith("COOLDOWN_ACTIVE:")) {
          const remainingSeconds = Number(decision.reasons[0].slice("COOLDOWN_ACTIVE:".length).replace(/s$/, ""));
          deferTradeJob(db, job.id, Date.now() + Math.max(1, remainingSeconds) * 1000, "User buy cooldown is active.");
        } else {
          setTradeJobStatus(db, job.id, "failed", { error: `Risk policy blocked execution: ${decision.reasons.join(", ")}` });
        }
        return;
      }

      const solWallet = job.chain === "solana" ? loadSolWallet(job.user_id) : null;
      const evmWallet = job.chain === "evm" ? loadEvmWallet(job.user_id) : null;
      if ((job.chain === "solana" && !solWallet) || (job.chain === "evm" && !evmWallet)) {
        setTradeJobStatus(db, job.id, "failed", { error: "No usable primary wallet is configured for this chain." });
        return;
      }

      const lifecycle = beginTrackedTrade(db, {
        userId: job.user_id,
        chain: job.chain,
        side: job.side,
        source: job.source,
        asset: job.asset,
        amount: job.amount,
      });
      attachLifecycleToTradeJob(db, job.id, lifecycle.id);
      const observe = (event: Parameters<typeof lifecycle.observe>[0]) => {
        lifecycle.observe(event);
        if (event.phase === "submitted") setTradeJobStatus(db, job.id, "submitted");
        if (event.phase === "confirmed" && event.kind === "swap") {
          setTradeJobStatus(db, job.id, "completed");
        }
      };

      try {
        if (job.chain === "solana") {
          if (!job.pool_ref) throw new Error("Solana trade job is missing its pool ID.");
          if (job.side === "buy") {
            await executeSolanaBuy({
              connection: solConnection,
              wallet: solWallet!,
              poolId: job.pool_ref,
              amountInLamports: parseUnitsExact(job.amount, 9),
              slippageBps: decision.maxSlippageBps,
              assertCanSubmit: () => {
                const latest = evaluateTradePolicy(db, config, {
                  userId: job.user_id, chain: job.chain, side: "buy", amount: job.amount,
                  source: job.source, jobId: job.id,
                });
                if (!latest.allowed) throw new Error(`Risk policy changed before submission: ${latest.reasons.join(", ")}.`);
                if (latest.maxSlippageBps < decision.maxSlippageBps) throw new Error("Slippage ceiling changed before submission; retry the trade.");
                assertBuyEntryEnabled(db, job.user_id, "solana", job.source);
              },
              onLifecycleEvent: observe,
            });
          } else {
            if (job.decimals === null || job.decimals === undefined) throw new Error("Solana sell job is missing token decimals.");
            await executeSolanaSell({
              connection: solConnection,
              wallet: solWallet!,
              poolId: job.pool_ref,
              amountInTokenBaseUnits: parseUnitsExact(job.amount, job.decimals),
              slippageBps: decision.maxSlippageBps,
              assertCanSubmit: () => {
                const latest = evaluateTradePolicy(db, config, {
                  userId: job.user_id, chain: job.chain, side: "sell", amount: job.amount, source: job.source,
                });
                if (latest.maxSlippageBps < decision.maxSlippageBps) throw new Error("Slippage ceiling changed before submission; retry the trade.");
              },
              onLifecycleEvent: observe,
            });
          }
        } else if (job.side === "buy") {
          await executeEvmBuy({
            provider: evmProvider,
            wallet: evmWallet!,
            tokenAddress: job.asset,
            amountInEth: job.amount,
            slippageBps: decision.maxSlippageBps,
            assertCanSubmit: () => {
              const latest = evaluateTradePolicy(db, config, {
                userId: job.user_id, chain: job.chain, side: "buy", amount: job.amount,
                source: job.source, jobId: job.id,
              });
              if (!latest.allowed) throw new Error(`Risk policy changed before submission: ${latest.reasons.join(", ")}.`);
              if (latest.maxSlippageBps < decision.maxSlippageBps) throw new Error("Slippage ceiling changed before submission; retry the trade.");
              assertBuyEntryEnabled(db, job.user_id, "evm", job.source);
            },
            onLifecycleEvent: observe,
          });
          recordHolding(db, "evm", job.user_id, job.asset);
        } else {
          if (job.decimals === null || job.decimals === undefined) throw new Error("EVM sell job is missing token decimals.");
          await executeEvmSell({
            provider: evmProvider,
            wallet: evmWallet!,
            tokenAddress: job.asset,
            amountInTokenBaseUnits: parseUnitsExact(job.amount, job.decimals),
            slippageBps: decision.maxSlippageBps,
            assertCanSubmit: () => {
              const latest = evaluateTradePolicy(db, config, {
                userId: job.user_id, chain: job.chain, side: "sell", amount: job.amount, source: job.source,
              });
              if (latest.maxSlippageBps < decision.maxSlippageBps) throw new Error("Slippage ceiling changed before submission; retry the trade.");
            },
            onLifecycleEvent: observe,
          });
        }

        if (lifecycle.wasSubmitted) {
          const current = db.prepare(`SELECT status FROM trade_jobs WHERE id = ?`).get(job.id) as { status: string };
          if (current.status !== "completed") setTradeJobStatus(db, job.id, "submitted");
        } else {
          throw new Error("Executor returned without recording a transaction submission.");
        }
      } catch (err) {
        lifecycle.failIfNotSubmitted(err);
        const message = err instanceof Error ? err.message : String(err);
        if (lifecycle.wasSubmitted) {
          setTradeJobStatus(db, job.id, "submitted", { error: `Submission status pending reconciliation: ${message}` });
        } else if (job.attempts < job.max_attempts) {
          const delayMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1));
          setTradeJobStatus(db, job.id, "queued", { error: message, retryAt: Date.now() + delayMs });
        } else {
          setTradeJobStatus(db, job.id, "failed", { error: message });
        }
        console.error(`[trade-worker] job ${job.id} attempt ${job.attempts}/${job.max_attempts} failed:`, err);
      }
    } catch (err) {
      console.error("[trade-worker] queue processing failed:", err);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void processOne(), pollIntervalMs);
  void processOne();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
