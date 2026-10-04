import { Connection, Keypair } from "@solana/web3.js";
import { Raydium } from "@raydium-io/raydium-sdk-v2";

let raydiumInstance: Raydium | null = null;

/** Raydium SDK instance is expensive to spin up — reuse it across calls. */
export async function getRaydium(connection: Connection, owner: Keypair): Promise<Raydium> {
  if (!raydiumInstance) {
    raydiumInstance = await Raydium.load({
      connection,
      owner,
      disableFeatureCheck: true,
      blockhashCommitment: "confirmed",
    });
  }
  return raydiumInstance;
}
