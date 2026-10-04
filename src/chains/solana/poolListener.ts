import { Connection, PublicKey, Logs, Context } from "@solana/web3.js";
import { RAYDIUM_AMM_V4, PUMPFUN_PROGRAM } from "./connection.js";

export type NewPoolEvent = {
  source: "raydium" | "pumpfun";
  signature: string;
  slot: number;
  logs: string[];
};

type NewPoolHandler = (event: NewPoolEvent) => void;

/**
 * Subscribes to program logs and flags transactions that look like new-pool
 * creation (Raydium "initialize2" / pump.fun "create"). This is a detection
 * layer only — parsing the resulting accounts into a tradeable pool address,
 * and the actual buy, happens in executor.ts (next step).
 *
 * NOTE: public RPC log subscriptions are too slow to win real races. Point
 * SOLANA_RPC_WSS at a Geyser-backed provider (Helius/Triton) before this is
 * used for anything live.
 */
export function startPoolListener(connection: Connection, onNewPool: NewPoolHandler) {
  const raydiumSub = connection.onLogs(
    new PublicKey(RAYDIUM_AMM_V4),
    (logs: Logs, ctx: Context) => {
      if (logs.err) return;
      const isInit = logs.logs.some((l) => l.includes("initialize2"));
      if (isInit) {
        onNewPool({
          source: "raydium",
          signature: logs.signature,
          slot: ctx.slot,
          logs: logs.logs,
        });
      }
    },
    "confirmed"
  );

  const pumpfunSub = connection.onLogs(
    new PublicKey(PUMPFUN_PROGRAM),
    (logs: Logs, ctx: Context) => {
      if (logs.err) return;
      const isCreate = logs.logs.some((l) => l.includes("Instruction: Create"));
      if (isCreate) {
        onNewPool({
          source: "pumpfun",
          signature: logs.signature,
          slot: ctx.slot,
          logs: logs.logs,
        });
      }
    },
    "confirmed"
  );

  return () => {
    connection.removeOnLogsListener(raydiumSub);
    connection.removeOnLogsListener(pumpfunSub);
  };
}
