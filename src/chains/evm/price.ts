import { Contract, JsonRpcProvider, formatUnits } from "ethers";

const UNISWAP_V2_FACTORY_ABI = ["function getPair(address, address) view returns (address)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)",
  "function token0() view returns (address)",
];
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/**
 * Returns the current price of `tokenAddress` denominated in ETH, read
 * directly from pool reserves rather than a router quote — cheaper (one
 * call instead of a simulated swap) and reserves are exactly what a limit
 * order should be watching, unaffected by the size of a hypothetical trade.
 *
 * Assumes 18 decimals on the token side; tokens with a different decimals
 * value will need that passed in and applied instead of the hardcoded 18.
 */
export async function getEvmPrice(
  provider: JsonRpcProvider,
  factoryAddress: string,
  tokenAddress: string
): Promise<number> {
  const factory = new Contract(factoryAddress, UNISWAP_V2_FACTORY_ABI, provider);
  const pairAddress: string = await factory.getPair(tokenAddress, WETH);
  if (pairAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error(`No pair found for ${tokenAddress}/WETH`);
  }

  const pair = new Contract(pairAddress, PAIR_ABI, provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0: string = await pair.token0();

  const [tokenReserve, wethReserve] =
    token0.toLowerCase() === tokenAddress.toLowerCase() ? [reserve0, reserve1] : [reserve1, reserve0];

  const tokenAmount = Number(formatUnits(tokenReserve, 18));
  const wethAmount = Number(formatUnits(wethReserve, 18));
  return wethAmount / tokenAmount;
}
