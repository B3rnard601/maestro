import Database from "better-sqlite3";
import { listTradeFills } from "../db/db.js";

interface Lot {
  remainingTokens: bigint;
  remainingCost: bigint;
}

export interface RealizedPnl {
  chain: "solana" | "evm";
  nativeSymbol: "SOL" | "ETH";
  nativeDecimals: number;
  realizedUnits: bigint;
  matchedSells: number;
  unmatchedSells: number;
  confirmedFills: number;
}

export function getRealizedPnl(db: Database.Database, userId: string): RealizedPnl[] {
  const fills = listTradeFills(db, userId);
  const result = (["solana", "evm"] as const).map((chain) => {
    const nativeSymbol = chain === "solana" ? "SOL" as const : "ETH" as const;
    const nativeDecimals = chain === "solana" ? 9 : 18;
    const lots = new Map<string, Lot[]>();
    let realizedUnits = 0n;
    let matchedSells = 0;
    let unmatchedSells = 0;
    let confirmedFills = 0;

    for (const fill of fills.filter((row) => row.chain === chain)) {
      confirmedFills++;
      const key = fill.asset.toLowerCase();
      const assetLots = lots.get(key) ?? [];
      if (fill.side === "buy") {
        assetLots.push({
          remainingTokens: BigInt(fill.token_units),
          remainingCost: BigInt(fill.native_units),
        });
        lots.set(key, assetLots);
        continue;
      }

      let tokensToMatch = BigInt(fill.token_units);
      const tokensSold = tokensToMatch;
      let matchedTokens = 0n;
      let costBasis = 0n;
      for (const lot of assetLots) {
        if (tokensToMatch === 0n) break;
        if (lot.remainingTokens === 0n) continue;
        const fromLot = tokensToMatch < lot.remainingTokens ? tokensToMatch : lot.remainingTokens;
        const allocatedCost = fromLot === lot.remainingTokens
          ? lot.remainingCost
          : lot.remainingCost * fromLot / lot.remainingTokens;
        lot.remainingTokens -= fromLot;
        lot.remainingCost -= allocatedCost;
        tokensToMatch -= fromLot;
        matchedTokens += fromLot;
        costBasis += allocatedCost;
      }
      const unmatched = tokensSold - matchedTokens;
      if (unmatched > 0n) unmatchedSells++;
      if (matchedTokens === 0n) continue;
      const proceeds = BigInt(fill.native_units) * matchedTokens / tokensSold;
      realizedUnits += proceeds - costBasis;
      matchedSells++;
    }

    return {
      chain,
      nativeSymbol,
      nativeDecimals,
      realizedUnits,
      matchedSells,
      unmatchedSells,
      confirmedFills,
    };
  });
  return result.filter((entry) => entry.confirmedFills > 0);
}

export function formatNativeAmount(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const fraction = (absolute % scale).toString().padStart(decimals, "0").slice(0, 6);
  return `${negative ? "-" : ""}${absolute / scale}.${fraction}`;
}
