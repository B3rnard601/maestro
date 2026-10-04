import { Connection, PublicKey } from "@solana/web3.js";
import { Contract, JsonRpcProvider, formatEther, formatUnits } from "ethers";

// Deliberately duplicated from src/portfolio/portfolio.ts rather than shared
// across packages — admin-server is a standalone service and this keeps it
// that way. If this project grows a real shared-package setup, this is the
// first thing to de-duplicate.

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export async function getSolanaPortfolio(connection, address) {
  const pubkey = new PublicKey(address);
  const [lamports, tokenAccounts] = await Promise.all([
    connection.getBalance(pubkey),
    connection.getParsedTokenAccountsByOwner(pubkey, { programId: new PublicKey(SPL_TOKEN_PROGRAM_ID) }),
  ]);

  const tokens = tokenAccounts.value
    .map((acc) => {
      const info = acc.account.data.parsed.info;
      return { mint: info.mint, uiAmount: info.tokenAmount.uiAmount };
    })
    .filter((t) => t.uiAmount > 0);

  return { solBalance: lamports / 1e9, tokens };
}

const ERC20_VIEW_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export async function getEvmPortfolio(provider, address, knownTokens) {
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
        return null;
      }
    })
  );

  return { ethBalance: formatEther(ethBalanceRaw), tokens: tokens.filter(Boolean) };
}
