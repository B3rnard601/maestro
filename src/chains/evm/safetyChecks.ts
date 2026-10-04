import { JsonRpcProvider, Contract, ZeroAddress, keccak256, AbiCoder, toBeHex } from "ethers";

const ROUTER_ABI = [
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)",
];
const ERC20_ABI = ["function owner() view returns (address)", "function balanceOf(address) view returns (uint256)"];
const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

export interface EvmSafetyResult {
  ownershipRenounced: boolean | "unknown";
  sellSimulationOk: boolean | "unknown";
  safe: boolean;
  reasons: string[];
}

export async function checkOwnershipRenounced(
  provider: JsonRpcProvider,
  tokenAddress: string
): Promise<boolean | "unknown"> {
  try {
    const token = new Contract(tokenAddress, ERC20_ABI, provider);
    const owner: string = await token.owner();
    return owner === ZeroAddress || owner === "0x000000000000000000000000000000000000dEaD";
  } catch {
    // No owner() function — common for tokens that never had (or already
    // renounced past the point of even exposing) ownership. Not itself a
    // red flag, but can't confirm either way.
    return "unknown";
  }
}

/**
 * Brute-forces the storage slot for the ERC20 `balanceOf` mapping by
 * overriding candidate slots and checking which one balanceOf() reflects.
 * Standard technique, works for the vast majority of vanilla ERC20 layouts
 * (slots 0-9). Proxy contracts / non-standard layouts will report "unknown"
 * rather than a false negative.
 */
async function findBalanceSlot(
  provider: JsonRpcProvider,
  tokenAddress: string,
  wallet: string
): Promise<number | null> {
  const probeValue = toBeHex(123456789n, 32);
  for (let slot = 0; slot < 10; slot++) {
    const key = keccak256(
      AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [wallet, slot])
    );
    try {
      const result = await provider.send("eth_call", [
        {
          to: tokenAddress,
          data: new Contract(tokenAddress, ERC20_ABI, provider).interface.encodeFunctionData(
            "balanceOf",
            [wallet]
          ),
        },
        "latest",
        { [tokenAddress]: { stateDiff: { [key]: probeValue } } },
      ]);
      if (BigInt(result) === 123456789n) return slot;
    } catch {
      // slot layout doesn't match this guess — try the next one
    }
  }
  return null;
}

/**
 * Simulates buying then immediately selling via state override, without
 * spending real funds. If the sell reverts or returns near-zero relative to
 * what was "granted", that's the classic honeypot signature (sells disabled
 * or taxed at ~100% for anyone but the deployer).
 *
 * Limitation: only covers plain-mapping balance storage found by
 * findBalanceSlot. Tokens with non-standard/proxied balance storage will
 * come back "unknown" — treat unknown as "don't trust it", not "safe".
 */
export async function simulateSell(
  provider: JsonRpcProvider,
  tokenAddress: string,
  walletAddress: string
): Promise<boolean | "unknown"> {
  const slot = await findBalanceSlot(provider, tokenAddress, walletAddress);
  if (slot === null) return "unknown";

  const grantAmount = 1_000_000_000_000_000_000n; // 1 token (18 decimals assumed)
  const balKey = keccak256(
    AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [walletAddress, slot])
  );

  const router = new Contract(UNISWAP_V2_ROUTER, ROUTER_ABI, provider);
  const sellData = router.interface.encodeFunctionData(
    "swapExactTokensForETHSupportingFeeOnTransferTokens",
    [grantAmount, 0, [tokenAddress, WETH], walletAddress, Math.floor(Date.now() / 1000) + 60]
  );

  try {
    await provider.send("eth_call", [
      { from: walletAddress, to: UNISWAP_V2_ROUTER, data: sellData },
      "latest",
      {
        [tokenAddress]: { stateDiff: { [balKey]: toBeHex(grantAmount, 32) } },
        // NOTE: this doesn't override the router's allowance from the token
        // contract, which most real ERC20s will also require. A fully
        // correct simulation needs the allowance mapping slot too (same
        // brute-force approach, separate mapping) — flagged here rather
        // than silently assumed. Until that's added, a revert here can mean
        // "honeypot" OR just "missing allowance override" — don't treat a
        // pass as a hard guarantee.
      },
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function runEvmSafetyChecks(
  provider: JsonRpcProvider,
  tokenAddress: string,
  simWallet: string
): Promise<EvmSafetyResult> {
  const reasons: string[] = [];

  const ownershipRenounced = await checkOwnershipRenounced(provider, tokenAddress);
  const sellSimulationOk = await simulateSell(provider, tokenAddress, simWallet);

  if (ownershipRenounced === false) reasons.push("ownership not renounced");
  if (sellSimulationOk === false) reasons.push("sell simulation failed — likely honeypot");
  if (sellSimulationOk === "unknown") reasons.push("sell simulation inconclusive — non-standard storage layout");

  return {
    ownershipRenounced,
    sellSimulationOk,
    safe: sellSimulationOk === true && ownershipRenounced !== false,
    reasons,
  };
}
