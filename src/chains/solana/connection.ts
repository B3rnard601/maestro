import { Connection } from "@solana/web3.js";

/**
 * Same failure class as chains/evm/provider.ts: a WebSocket connection
 * failure emits an unhandled 'error' event and crashes the whole process if
 * nothing's listening. @solana/web3.js doesn't expose a public API for this
 * — `_rpcWebSocket` is an internal, undocumented property (the underlying
 * rpc-websockets Client, which is a plain EventEmitter), but attaching to it
 * is a long-standing, widely-used workaround in the Solana ecosystem for
 * exactly this crash. If a future @solana/web3.js version renames or
 * removes it, this handler silently stops attaching — worth a smoke test
 * after any @solana/web3.js version bump.
 */
export function getSolanaConnection(): Connection {
  const http = process.env.SOLANA_RPC_HTTP!;
  const wss = process.env.SOLANA_RPC_WSS!;
  const connection = new Connection(http, { commitment: "confirmed", wsEndpoint: wss });

  (connection as any)._rpcWebSocket?.on("error", (err: Error) => {
    console.error(
      `[solana] WebSocket connection failed: ${err.message}\n` +
        "Check SOLANA_RPC_WSS in .env — public endpoints are often unreliable for a persistent connection. Get a free-tier key from Helius or Triton instead."
    );
    process.exit(1);
  });

  return connection;
}

// Known program IDs relevant to new-pool detection.
export const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
