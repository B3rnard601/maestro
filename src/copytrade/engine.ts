/**
 * Ties a wallet watcher's detected trades to your own executor, sized by a
 * fixed ratio of what the target wallet spent. Deliberately simple — no
 * per-token position tracking or max-exposure caps yet, both worth adding
 * before running this against a wallet you don't fully trust.
 */
import { formatUnitsExact, isPositiveDecimal, parseUnitsExact } from "../shared/amount.js";

export interface CopyTradeConfig {
  targetWallet: string;
  sizeRatio: string; // e.g. "0.1" = copy at 10% of the target's spend
  maxAmountPerTrade: string; // hard cap, in SOL or ETH depending on chain
  copySells: boolean; // mirror exits, not just entries
}

export interface ScaledTrade {
  action: "buy" | "sell";
  identifier: string; // mint (Solana) or token address (EVM)
  amount: string; // capped, scaled size in native currency
  sourceTxRef: string;
}

export function scaleTrade(
  config: CopyTradeConfig,
  targetSpendAmount: string,
  side: "buy" | "sell",
  identifier: string,
  sourceTxRef: string,
  decimals: number
): ScaledTrade | null {
  if (side === "sell" && !config.copySells) return null;

  const ratioScale = 18;
  if (!isPositiveDecimal(config.maxAmountPerTrade, decimals)) {
    console.error("[copytrade] invalid max amount; skipping trade until copy-trade settings are corrected.");
    return null;
  }
  let ratioUnits: bigint;
  let targetUnits: bigint;
  try {
    ratioUnits = parseUnitsExact(config.sizeRatio, ratioScale);
    targetUnits = parseUnitsExact(targetSpendAmount, decimals);
  } catch (err) {
    console.error("[copytrade] invalid decimal input; skipping trade:", err);
    return null;
  }
  if (ratioUnits > 10n ** BigInt(ratioScale)) {
    console.error("[copytrade] configured size ratio exceeds 1; skipping trade until settings are corrected.");
    return null;
  }
  if (targetUnits <= 0n) return null;
  const scaledUnits = (targetUnits * ratioUnits) / (10n ** BigInt(ratioScale));
  const maxUnits = parseUnitsExact(config.maxAmountPerTrade, decimals);
  const amountUnits = scaledUnits < maxUnits ? scaledUnits : maxUnits;
  if (amountUnits <= 0n) return null;

  return { action: side, identifier, amount: formatUnitsExact(amountUnits, decimals), sourceTxRef };
}
