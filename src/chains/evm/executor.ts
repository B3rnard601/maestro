import { Contract, Wallet, JsonRpcProvider, parseEther, isAddress, keccak256 } from "ethers";
import type { TradeLifecycleObserver } from "../../transactions/types.js";

const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const ROUTER_ABI = [
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] memory)",
];
const ERC20_ABI = [
  "function approve(address spender, uint amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

export interface EvmBuyParams {
  provider: JsonRpcProvider;
  wallet: Wallet;
  tokenAddress: string;
  amountInEth: string; // e.g. "0.05"
  slippageBps: number; // e.g. 500 = 5%
  usePrivateRelay?: boolean;
  assertCanSubmit?: () => void;
  approvedMinimumOut?: bigint;
  onLifecycleEvent?: TradeLifecycleObserver;
}

export interface EvmSellParams {
  provider: JsonRpcProvider;
  wallet: Wallet;
  tokenAddress: string;
  amountInTokenBaseUnits: bigint; // raw units, caller applies token decimals
  slippageBps: number; // e.g. 500 = 5%
  usePrivateRelay?: boolean;
  approvedMinimumOut?: bigint;
  confirmedRequiresApproval?: boolean;
  onLifecycleEvent?: TradeLifecycleObserver;
}

export interface EvmTradeQuote {
  expectedAmountOut: bigint;
  minimumAmountOut: bigint;
  outputDecimals: number;
  requiresApproval: boolean;
}

export async function quoteBuy(params: Pick<EvmBuyParams, "provider" | "tokenAddress" | "amountInEth" | "slippageBps">): Promise<EvmTradeQuote> {
  if (!isAddress(params.tokenAddress)) throw new Error("Invalid EVM token address.");
  const router = new Contract(UNISWAP_V2_ROUTER, ROUTER_ABI, params.provider);
  const token = new Contract(params.tokenAddress, ERC20_ABI, params.provider);
  const value = parseEther(params.amountInEth);
  const [amountsOut, outputDecimals] = await Promise.all([
    router.getAmountsOut(value, [WETH, params.tokenAddress]) as Promise<bigint[]>,
    token.decimals() as Promise<bigint>,
  ]);
  const expectedAmountOut = amountsOut[1];
  if (expectedAmountOut === undefined) throw new Error("The router returned an incomplete quote.");
  return {
    expectedAmountOut,
    minimumAmountOut: (expectedAmountOut * BigInt(10_000 - params.slippageBps)) / 10_000n,
    outputDecimals: Number(outputDecimals),
    requiresApproval: false,
  };
}

export async function quoteSell(
  params: Pick<EvmSellParams, "provider" | "wallet" | "tokenAddress" | "amountInTokenBaseUnits" | "slippageBps">
): Promise<EvmTradeQuote> {
  if (!isAddress(params.tokenAddress)) throw new Error("Invalid EVM token address.");
  const router = new Contract(UNISWAP_V2_ROUTER, ROUTER_ABI, params.provider);
  const token = new Contract(params.tokenAddress, ERC20_ABI, params.provider);
  const [amountsOut, allowance] = await Promise.all([
    router.getAmountsOut(params.amountInTokenBaseUnits, [params.tokenAddress, WETH]) as Promise<bigint[]>,
    token.allowance(params.wallet.address, UNISWAP_V2_ROUTER) as Promise<bigint>,
  ]);
  const expectedAmountOut = amountsOut[1];
  if (expectedAmountOut === undefined) throw new Error("The router returned an incomplete quote.");
  return {
    expectedAmountOut,
    minimumAmountOut: (expectedAmountOut * BigInt(10_000 - params.slippageBps)) / 10_000n,
    outputDecimals: 18,
    requiresApproval: allowance < params.amountInTokenBaseUnits,
  };
}

/**
 * Buys `tokenAddress` on Uniswap V2 with ETH. amountOutMin is computed from
 * a live getAmountsOut() quote — on a token with real fee-on-transfer the
 * quote itself can still be optimistic (it doesn't account for transfer
 * tax), so slippageBps should be generous until the safety-check tax
 * simulation is folded into this math too.
 */
export async function executeBuy(params: EvmBuyParams): Promise<string> {
  const { provider, wallet, tokenAddress, amountInEth, slippageBps, usePrivateRelay = true, assertCanSubmit, approvedMinimumOut, onLifecycleEvent } = params;
  const signer = wallet.connect(provider);
  const router = new Contract(UNISWAP_V2_ROUTER, ROUTER_ABI, signer);

  const deadline = Math.floor(Date.now() / 1000) + 60;
  const path = [WETH, tokenAddress];
  const value = parseEther(amountInEth);

  const amountsOut: bigint[] = await router.getAmountsOut(value, path);
  const quotedOut = amountsOut[1];
  const currentMinimumOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (approvedMinimumOut !== undefined && currentMinimumOut < approvedMinimumOut) {
    throw new Error("Price moved below the confirmed minimum output. Request a fresh quote.");
  }
  const amountOutMin = approvedMinimumOut !== undefined && approvedMinimumOut > currentMinimumOut
    ? approvedMinimumOut
    : currentMinimumOut;

  const feeData = await provider.getFeeData();
  const txRequest = await router
    .swapExactETHForTokensSupportingFeeOnTransferTokens.populateTransaction(
      amountOutMin,
      path,
      wallet.address,
      deadline,
      {
        value,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas ?? 0n) * 3n, // outbid public mempool
      }
    );

  assertCanSubmit?.();
  const signedTx = await signer.signTransaction(txRequest);
  const transactionRef = keccak256(signedTx);

  if (usePrivateRelay) {
    assertCanSubmit?.();
    onLifecycleEvent?.({ phase: "submitted", kind: "swap", transactionRef });
    const relayHash = await sendViaPrivateRelay(signedTx);
    if (relayHash.toLowerCase() !== transactionRef.toLowerCase()) {
      throw new Error("Private relay returned a transaction hash that does not match the signed transaction.");
    }
    return relayHash;
  }

  assertCanSubmit?.();
  onLifecycleEvent?.({ phase: "submitted", kind: "swap", transactionRef });
  const sent = await provider.broadcastTransaction(signedTx);
  await sent.wait();
  onLifecycleEvent?.({ phase: "confirmed", kind: "swap", transactionRef: sent.hash });
  return sent.hash;
}

/**
 * Sells `tokenAddress` back to ETH. Unlike a buy, this needs router
 * allowance on the token first — if it isn't already approved, an approve
 * tx goes out via the public mempool (low risk: an approval alone can't be
 * frontrun for value the way a swap can) before the actual sell, which does
 * go through the private relay same as executeBuy.
 */
export async function executeSell(params: EvmSellParams): Promise<string> {
  const {
    provider,
    wallet,
    tokenAddress,
    amountInTokenBaseUnits,
    slippageBps,
    usePrivateRelay = true,
    approvedMinimumOut,
    confirmedRequiresApproval,
    onLifecycleEvent,
  } = params;
  const signer = wallet.connect(provider);
  const token = new Contract(tokenAddress, ERC20_ABI, signer);
  const router = new Contract(UNISWAP_V2_ROUTER, ROUTER_ABI, signer);

  const allowance: bigint = await token.allowance(wallet.address, UNISWAP_V2_ROUTER);
  if (
    confirmedRequiresApproval !== undefined &&
    (allowance < amountInTokenBaseUnits) !== confirmedRequiresApproval
  ) {
    throw new Error("Token approval state changed after the preview. Request a fresh quote.");
  }
  if (allowance < amountInTokenBaseUnits) {
    const approveTx = await token.approve(UNISWAP_V2_ROUTER, amountInTokenBaseUnits);
    onLifecycleEvent?.({ phase: "submitted", kind: "approval", transactionRef: approveTx.hash });
    await approveTx.wait();
    onLifecycleEvent?.({ phase: "confirmed", kind: "approval", transactionRef: approveTx.hash });
  }

  const deadline = Math.floor(Date.now() / 1000) + 60;
  const path = [tokenAddress, WETH];

  const amountsOut: bigint[] = await router.getAmountsOut(amountInTokenBaseUnits, path);
  const quotedOut = amountsOut[1];
  const currentMinimumOut = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  if (approvedMinimumOut !== undefined && currentMinimumOut < approvedMinimumOut) {
    throw new Error("Price moved below the confirmed minimum output. Request a fresh quote.");
  }
  const amountOutMin = approvedMinimumOut !== undefined && approvedMinimumOut > currentMinimumOut
    ? approvedMinimumOut
    : currentMinimumOut;

  const feeData = await provider.getFeeData();
  const txRequest = await router
    .swapExactTokensForETHSupportingFeeOnTransferTokens.populateTransaction(
      amountInTokenBaseUnits,
      amountOutMin,
      path,
      wallet.address,
      deadline,
      {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas ?? 0n) * 3n,
      }
    );

  const signedTx = await signer.signTransaction(txRequest);
  const transactionRef = keccak256(signedTx);

  if (usePrivateRelay) {
    onLifecycleEvent?.({ phase: "submitted", kind: "swap", transactionRef });
    const relayHash = await sendViaPrivateRelay(signedTx);
    if (relayHash.toLowerCase() !== transactionRef.toLowerCase()) {
      throw new Error("Private relay returned a transaction hash that does not match the signed transaction.");
    }
    return relayHash;
  }

  onLifecycleEvent?.({ phase: "submitted", kind: "swap", transactionRef });
  const sent = await provider.broadcastTransaction(signedTx);
  await sent.wait();
  onLifecycleEvent?.({ phase: "confirmed", kind: "swap", transactionRef: sent.hash });
  return sent.hash;
}

async function sendViaPrivateRelay(signedTx: string): Promise<string> {
  const res = await fetch(process.env.EVM_FLASHBOTS_RPC!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendPrivateTransaction",
      params: [{ tx: signedTx }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Private relay rejected: ${json.error.message}`);
  return json.result; // tx hash
}
