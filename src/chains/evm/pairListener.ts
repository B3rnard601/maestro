import { Contract, WebSocketProvider } from "ethers";
import { UNISWAP_V2_FACTORY_ABI } from "./provider.js";

export type NewPairEvent = {
  token0: string;
  token1: string;
  pair: string;
  blockNumber: number;
  txHash: string;
};

type NewPairHandler = (event: NewPairEvent) => void;

/**
 * Listens for PairCreated on the Uniswap V2 factory. For V3 or other DEXes
 * (Sushiswap, Pancakeswap, etc.) point this at their factory address and ABI —
 * same event shape for V2 forks.
 *
 * Like the Solana listener: a public WSS endpoint will lose races. Use a
 * private/low-latency RPC (or your own node) once this goes live.
 */
export function startPairListener(
  provider: WebSocketProvider,
  factoryAddress: string,
  onNewPair: NewPairHandler
) {
  const factory = new Contract(factoryAddress, UNISWAP_V2_FACTORY_ABI, provider);

  factory.on("PairCreated", (token0, token1, pair, _reserved, event) => {
    onNewPair({
      token0,
      token1,
      pair,
      blockNumber: event.log.blockNumber,
      txHash: event.log.transactionHash,
    });
  });

  return () => {
    factory.removeAllListeners("PairCreated");
  };
}
