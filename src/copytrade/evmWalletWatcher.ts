import { Provider, Interface } from "ethers";

const ROUTER_ADDRESSES = new Set([
  "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2
]);

const ROUTER_IFACE = new Interface([
  "function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
]);

export interface CopyTradeEvent {
  txHash: string;
  side: "buy" | "sell";
  tokenAddress: string;
  ethAmount: string; // human-readable ETH value involved
}

type CopyTradeHandler = (event: CopyTradeEvent) => void;

/**
 * Watches a target wallet by scanning confirmed blocks for router calls
 * `from` that address. This trades latency for reliability — the copy trade
 * lands after the target's tx is already mined, not before. For a race-speed
 * version, subscribe to `provider.on("pending", ...)` instead and filter by
 * `tx.from`, but that requires a provider whose websocket actually exposes
 * pending tx hashes (Alchemy/Infura do; many public RPCs don't), and mempool
 * volume on a busy chain makes it expensive to run against a shared endpoint.
 */
export function startWalletWatcher(
  provider: Provider,
  targetWallet: string,
  onTrade: CopyTradeHandler
) {
  const target = targetWallet.toLowerCase();

  const listener = async (blockNumber: number) => {
    const block = await provider.getBlock(blockNumber, true);
    if (!block) return;

    for (const txResponse of block.prefetchedTransactions ?? []) {
      if (txResponse.from.toLowerCase() !== target) continue;
      if (!txResponse.to || !ROUTER_ADDRESSES.has(txResponse.to)) continue;

      try {
        const decoded = ROUTER_IFACE.parseTransaction({
          data: txResponse.data,
          value: txResponse.value,
        });
        if (!decoded) continue;

        const path: string[] = decoded.args.path;
        const isBuy = decoded.name.startsWith("swapExactETHFor");
        const tokenAddress = isBuy ? path[path.length - 1] : path[0];
        const ethAmount = isBuy
          ? txResponse.value.toString()
          : decoded.args.amountOutMin?.toString() ?? "0";

        onTrade({
          txHash: txResponse.hash,
          side: isBuy ? "buy" : "sell",
          tokenAddress,
          ethAmount,
        });
      } catch {
        // not a swap call shape we recognize — ignore
      }
    }
  };

  provider.on("block", listener);
  return () => provider.off("block", listener);
}
