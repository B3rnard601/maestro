import { Connection } from "@solana/web3.js";
import { DEFAULT_RPC_ENDPOINTS } from "../../config/defaults.js";

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
export function getSolanaConnection(
  http: string = DEFAULT_RPC_ENDPOINTS.solanaHttp,
  wss: string = DEFAULT_RPC_ENDPOINTS.solanaWebSocket,
): Connection {
  const connection = new Connection(http, { commitment: "confirmed", wsEndpoint: wss });

  (connection as any)._rpcWebSocket?.on("error", (err: Error) => {
    console.error(
      `[solana] WebSocket connection failed: ${err.message}\n` +
        "The bot will stay online, but Solana event listening may be unavailable until the provider reconnects. Configure SOLANA_RPC_WSS for a more reliable connection."
    );
  });

  return connection;
}

// Known program IDs relevant to new-pool detection.
export const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
