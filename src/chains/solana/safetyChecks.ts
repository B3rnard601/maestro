import { Connection, PublicKey } from "@solana/web3.js";

export interface SolanaSafetyResult {
  mintAuthorityRenounced: boolean;
  freezeAuthorityRenounced: boolean;
  lpBurnedOrLocked: boolean;
  topHolderPct: number | null;
  safe: boolean;
  reasons: string[];
}

// Addresses tokens/LP get sent to when "burned" on Solana.
const KNOWN_BURN_ADDRESSES = new Set([
  "1nc1nerator11111111111111111111111111111",
  "11111111111111111111111111111111111111111", // system program (rare, but seen)
]);

/**
 * Checks mint/freeze authority on the token itself. A live mint authority
 * means the dev can print more supply after you buy; a live freeze authority
 * means they can freeze your wallet's tokens outright.
 */
export async function checkMintAuthorities(
  connection: Connection,
  mintAddress: string
): Promise<{ mintAuthorityRenounced: boolean; freezeAuthorityRenounced: boolean }> {
  const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
  const parsed = (info.value?.data as any)?.parsed?.info;
  if (!parsed) {
    throw new Error(`Could not parse mint account ${mintAddress}`);
  }
  return {
    mintAuthorityRenounced: parsed.mintAuthority === null,
    freezeAuthorityRenounced: parsed.freezeAuthority === null,
  };
}

/**
 * Checks whether LP tokens for the pool have been burned. This tells you the
 * dev can't pull liquidity out from under buyers.
 *
 * NOTE: this needs the LP mint address, which comes from the pool keys
 * (same raydium-sdk-v2 resolution flagged as a plug point in executor.ts).
 * Locked-via-locker-program detection (e.g. Streamflow) isn't covered here —
 * this only catches the burn case, not third-party time-locks.
 */
export async function checkLpBurned(
  connection: Connection,
  lpMintAddress: string
): Promise<{ lpBurnedOrLocked: boolean; topHolderPct: number | null }> {
  const largest = await connection.getTokenLargestAccounts(new PublicKey(lpMintAddress));
  const supply = await connection.getTokenSupply(new PublicKey(lpMintAddress));

  if (largest.value.length === 0 || supply.value.uiAmount === 0) {
    return { lpBurnedOrLocked: true, topHolderPct: 0 }; // no supply left = fully burned
  }

  const top = largest.value[0];
  const topPct = supply.value.uiAmount
    ? ((top.uiAmount ?? 0) / supply.value.uiAmount) * 100
    : null;

  // Check if the largest LP holder is itself a known burn address.
  const ownerInfo = await connection.getParsedAccountInfo(top.address);
  const owner = (ownerInfo.value?.data as any)?.parsed?.info?.owner;
  const burned = owner ? KNOWN_BURN_ADDRESSES.has(owner) : false;

  return { lpBurnedOrLocked: burned, topHolderPct: topPct };
}

export async function runSolanaSafetyChecks(
  connection: Connection,
  mintAddress: string,
  lpMintAddress: string
): Promise<SolanaSafetyResult> {
  const reasons: string[] = [];

  const { mintAuthorityRenounced, freezeAuthorityRenounced } = await checkMintAuthorities(
    connection,
    mintAddress
  );
  const { lpBurnedOrLocked, topHolderPct } = await checkLpBurned(connection, lpMintAddress);

  if (!mintAuthorityRenounced) reasons.push("mint authority still active — supply can be inflated");
  if (!freezeAuthorityRenounced) reasons.push("freeze authority still active — wallets can be frozen");
  if (!lpBurnedOrLocked) reasons.push("LP not burned — liquidity can be pulled");

  return {
    mintAuthorityRenounced,
    freezeAuthorityRenounced,
    lpBurnedOrLocked,
    topHolderPct,
    safe: reasons.length === 0,
    reasons,
  };
}
