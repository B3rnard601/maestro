import { WebSocketProvider, JsonRpcProvider } from "ethers";

/**
 * ethers' WebSocketProvider doesn't attach an error handler to its
 * underlying `ws` socket, so a connection failure (bad URL, provider
 * downtime, a Cloudflare 525, etc.) emits an unhandled 'error' event on a
 * plain Node EventEmitter — which crashes the entire process, not just this
 * connection. Attaching a handler here converts that into a clean, logged
 * exit instead. process.exit rather than swallow-and-continue is
 * deliberate: a dead EVM listener means new-pair detection silently stops
 * firing, which is worse than a visible restart under a process manager
 * (see DEPLOY.md — systemd/pm2 are both configured to restart on exit).
 */
export function getEvmWsProvider(): WebSocketProvider {
  const provider = new WebSocketProvider(process.env.EVM_RPC_WSS!);
  provider.websocket.onerror = (err: Error) => {
    console.error(
      `[evm] WebSocket connection failed: ${err.message}\n` +
        "Check EVM_RPC_WSS in .env — public endpoints (llamarpc, etc.) are often unreliable for a persistent connection. Get a free-tier key from Alchemy or Infura instead."
    );
    process.exit(1);
  };
  return provider;
}

export function getEvmHttpProvider(): JsonRpcProvider {
  return new JsonRpcProvider(process.env.EVM_RPC_HTTP!);
}

export const UNISWAP_V2_FACTORY_ABI = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)",
];
