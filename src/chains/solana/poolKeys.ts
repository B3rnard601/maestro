import { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { RAYDIUM_AMM_V4 } from "./connection.js";

export interface RaydiumPoolKeys {
  poolId: string;
  lpMint: string;
  coinMint: string;
  pcMint: string;
}

/**
 * Pulls pool/lp/mint addresses straight out of a Raydium `initialize2`
 * instruction's account list — no API round-trip, no indexing delay, which
 * matters here since this runs on the pool-creation tx itself. Account
 * order below matches Raydium AMM V4's published initialize2 layout
 * (amm=4, lpMint=7, coinMint=8, pcMint=9); if Raydium ships a new pool
 * program version this offset table is the first thing to re-check.
 */
export function extractRaydiumPoolKeysFromTx(
  tx: ParsedTransactionWithMeta
): RaydiumPoolKeys | null {
  const ix = tx.transaction.message.instructions.find(
    (i): i is PartiallyDecodedInstruction =>
      "programId" in i && i.programId.toBase58() === RAYDIUM_AMM_V4 && "accounts" in i
  );
  if (!ix || ix.accounts.length < 10) return null;

  return {
    poolId: ix.accounts[4].toBase58(),
    lpMint: ix.accounts[7].toBase58(),
    coinMint: ix.accounts[8].toBase58(),
    pcMint: ix.accounts[9].toBase58(),
  };
}

/**
 * Looks up the Raydium pool for an arbitrary existing mint (paired against
 * SOL) — needed for copy-trade, where we only ever see the mint a watched
 * wallet bought, not the pool-creation tx. Goes through the SDK's pool API
 * rather than log-scanning, since the pool may have been created long
 * before this process started watching.
 *
 * `fetchPoolByMints`'s exact return shape (array vs `{ data: [...] }`, field
 * names for pool id / tvl) is the same kind of SDK-version-sensitive surface
 * flagged in executor.ts — the field fallbacks below (`.id ?? .poolId`) are
 * a hedge, not a guarantee; verify against your installed version.
 */
export async function getPoolIdByMint(
  raydium: Raydium,
  mint: string,
  quoteMint = "So11111111111111111111111111111111111111"
): Promise<string | null> {
  const pools = await raydium.api.fetchPoolByMints({ mint1: mint, mint2: quoteMint });
  const list = Array.isArray(pools) ? pools : pools?.data ?? [];
  if (!list.length) return null;

  // Prefer the highest-liquidity pool if more than one exists for the pair.
  const sorted = [...list].sort((a: any, b: any) => (b.tvl ?? 0) - (a.tvl ?? 0));
  return sorted[0].id ?? sorted[0].poolId ?? null;
}
