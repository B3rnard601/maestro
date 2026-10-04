import { Connection, Keypair } from "@solana/web3.js";
import { getRaydium } from "./raydiumClient.js";

const WSOL_MINT = "So11111111111111111111111111111111111111";

/**
 * Returns the current price of the pool's non-SOL side, denominated in SOL.
 * poolInfo.price from the SDK is already base/quote — this just orients it
 * consistently so callers don't have to care which mint is A vs B.
 */
export async function getSolanaPrice(
  connection: Connection,
  owner: Keypair,
  poolId: string
): Promise<number> {
  const raydium = await getRaydium(connection, owner);
  const { poolInfo } = await raydium.liquidity.getPoolInfoFromRpc({ poolId });

  const price = Number(poolInfo.price);
  // poolInfo.price is quoted as mintB per mintA by convention in the SDK —
  // if mintA is the SOL side, invert so the result is always "token price in SOL".
  return poolInfo.mintA.address === WSOL_MINT ? 1 / price : price;
}
