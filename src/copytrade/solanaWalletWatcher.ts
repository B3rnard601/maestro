import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";

export interface CopyTradeEvent {
  signature: string;
  side: "buy" | "sell";
  mint: string;
  uiAmountChange: number; // absolute value, sign is carried by `side`
  solChange: number; // native SOL delta for the watched wallet, negative = spent
}

type CopyTradeHandler = (event: CopyTradeEvent) => void;

/**
 * Watches a target wallet and reports what it bought/sold by diffing
 * pre/post token balances on transactions that mention it — this sidesteps
 * needing to decode Raydium instruction args directly (which changes across
 * pool types) and instead reads the same balance-delta data block explorers
 * use, so it works for any DEX/program the wallet trades through.
 */
export function startWalletWatcher(
  connection: Connection,
  targetWallet: string,
  onTrade: CopyTradeHandler
) {
  const pubkey = new PublicKey(targetWallet);

  const sub = connection.onLogs(
    pubkey,
    async (logs) => {
      if (logs.err) return;
      try {
        const tx = await connection.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta) return;
        const events = diffTokenBalances(tx, targetWallet, logs.signature);
        events.forEach(onTrade);
      } catch (err) {
        console.error(`[copytrade/sol] failed to process ${logs.signature}:`, err);
      }
    },
    "confirmed"
  );

  return () => connection.removeOnLogsListener(sub);
}

function diffTokenBalances(
  tx: ParsedTransactionWithMeta,
  targetWallet: string,
  signature: string
): CopyTradeEvent[] {
  const { preTokenBalances = [], postTokenBalances = [], preBalances = [], postBalances = [] } =
    tx.meta!;

  const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const walletIndex = accountKeys.indexOf(targetWallet);
  const solChange =
    walletIndex >= 0 ? (postBalances[walletIndex] - preBalances[walletIndex]) / 1e9 : 0;

  const events: CopyTradeEvent[] = [];
  const preByMint = new Map(
    (preTokenBalances ?? []).filter((b) => b.owner === targetWallet).map((b) => [b.mint, b])
  );
  const postByMint = new Map(
    (postTokenBalances ?? []).filter((b) => b.owner === targetWallet).map((b) => [b.mint, b])
  );

  const mints = new Set([...preByMint.keys(), ...postByMint.keys()]);
  for (const mint of mints) {
    const pre = preByMint.get(mint)?.uiTokenAmount.uiAmount ?? 0;
    const post = postByMint.get(mint)?.uiTokenAmount.uiAmount ?? 0;
    const delta = post - pre;
    if (Math.abs(delta) < 1e-9) continue;

    events.push({
      signature,
      side: delta > 0 ? "buy" : "sell",
      mint,
      uiAmountChange: Math.abs(delta),
      solChange,
    });
  }

  return events;
}
