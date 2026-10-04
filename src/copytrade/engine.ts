/**
 * Ties a wallet watcher's detected trades to your own executor, sized by a
 * fixed ratio of what the target wallet spent. Deliberately simple — no
 * per-token position tracking or max-exposure caps yet, both worth adding
 * before running this against a wallet you don't fully trust.
 */

export interface CopyTradeConfig {
  targetWallet: string;
  sizeRatio: number; // e.g. 0.1 = copy at 10% of the target's spend
  maxAmountPerTrade: number; // hard cap, in SOL or ETH depending on chain
  copySells: boolean; // mirror exits, not just entries
}

export interface ScaledTrade {
  action: "buy" | "sell";
  identifier: string; // mint (Solana) or token address (EVM)
  amount: number; // capped, scaled size in native currency
  sourceTxRef: string;
}

export function scaleTrade(
  config: CopyTradeConfig,
  targetSpendAmount: number,
  side: "buy" | "sell",
  identifier: string,
  sourceTxRef: string
): ScaledTrade | null {
  if (side === "sell" && !config.copySells) return null;

  const scaled = targetSpendAmount * config.sizeRatio;
  const amount = Math.min(scaled, config.maxAmountPerTrade);
  if (amount <= 0) return null;

  return { action: side, identifier, amount, sourceTxRef };
}
