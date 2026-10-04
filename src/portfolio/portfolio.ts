import { Connection, PublicKey } from "@solana/web3.js";
import { Contract, Provider, formatEther, formatUnits } from "ethers";

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface SolanaPortfolio {
  solBalance: number;
  tokens: { mint: string; uiAmount: number }[];
}

/**
 * SPL token accounts are enumerable directly from the chain, so this needs
 * no external index or tracked-token list — it just asks for everything the
 * wallet holds under the token program and filters out empty accounts.
 */
export async function getSolanaPortfolio(
  connection: Connection,
  pubkey: PublicKey
): Promise<SolanaPortfolio> {
  const [lamports, tokenAccounts] = await Promise.all([
    connection.getBalance(pubkey),
    connection.getParsedTokenAccountsByOwner(pubkey, { programId: new PublicKey(SPL_TOKEN_PROGRAM_ID) }),
  ]);

  const tokens = tokenAccounts.value
    .map((acc) => {
      const info = acc.account.data.parsed.info;
      return { mint: info.mint as string, uiAmount: info.tokenAmount.uiAmount as number };
    })
    .filter((t) => t.uiAmount > 0);

  return { solBalance: lamports / 1e9, tokens };
}

const ERC20_VIEW_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export interface EvmPortfolio {
  ethBalance: string;
  tokens: { address: string; balance: string; symbol: string }[];
}

/**
 * ETH balance is a direct call. ERC20 holdings have no on-chain enumeration
 * the way SPL does — without a paid indexer (Alchemy's getTokenBalances,
 * etc.) the only free option is checking balanceOf() against tokens you
 * already know about, so `knownTokens` comes from db.ts's holdings table
 * (populated on every successful buy). A token this wallet holds but was
 * never bought through this bot won't show up here.
 */
export async function getEvmPortfolio(
  provider: Provider,
  address: string,
  knownTokens: string[]
): Promise<EvmPortfolio> {
  const ethBalanceRaw = await provider.getBalance(address);

  const tokens = await Promise.all(
    knownTokens.map(async (tokenAddress) => {
      try {
        const token = new Contract(tokenAddress, ERC20_VIEW_ABI, provider);
        const [balRaw, decimals, symbol] = await Promise.all([
          token.balanceOf(address),
          token.decimals().catch(() => 18),
          token.symbol().catch(() => tokenAddress.slice(0, 8)),
        ]);
        if (balRaw === 0n) return null;
        return { address: tokenAddress, balance: formatUnits(balRaw, decimals), symbol };
      } catch {
        return null; // bad contract call shouldn't break the whole portfolio view
      }
    })
  );

  return {
    ethBalance: formatEther(ethBalanceRaw),
    tokens: tokens.filter((t): t is NonNullable<typeof t> => t !== null),
  };
}
