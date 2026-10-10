import { Connection, ParsedTransactionWithMeta } from "@solana/web3.js";
import { Contract, Interface, Provider, getAddress } from "ethers";
import Database from "better-sqlite3";
import { listConfirmedTradesWithoutFill, recordTradeFill, type TradeLifecycleRow } from "../db/db.js";
import { parseUnitsExact } from "../shared/amount.js";

const ERC20_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Withdrawal(address indexed src, uint256 wad)",
]);
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const TRANSFER_TOPIC = ERC20_INTERFACE.getEvent("Transfer")!.topicHash;
const WITHDRAWAL_TOPIC = ERC20_INTERFACE.getEvent("Withdrawal")!.topicHash;

export async function captureConfirmedTradeFills(
  db: Database.Database,
  solConnection: Connection,
  evmProvider: Provider,
): Promise<void> {
  for (const trade of listConfirmedTradesWithoutFill(db)) {
    try {
      const fill = trade.chain === "solana"
        ? await getSolanaFill(solConnection, trade)
        : await getEvmFill(evmProvider, trade);
      if (!fill) continue;
      recordTradeFill(db, {
        lifecycleId: trade.id,
        userId: trade.user_id,
        chain: trade.chain,
        asset: trade.asset,
        tokenDecimals: fill.tokenDecimals,
        tokenUnits: fill.tokenUnits,
        nativeUnits: fill.nativeUnits,
      });
    } catch (err) {
      console.error(`[premium/pnl] couldn't capture fill for confirmed trade ${trade.id}:`, err);
    }
  }
}

async function getSolanaFill(
  connection: Connection,
  trade: TradeLifecycleRow,
): Promise<{ tokenUnits: string; tokenDecimals: number; nativeUnits: string } | null> {
  if (!trade.wallet_address || !trade.transaction_ref) return null;
  const transaction = await connection.getParsedTransaction(trade.transaction_ref, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  if (!transaction?.meta || transaction.meta.err) return null;
  const tokenBalances = getOwnedTokenDelta(transaction, trade.wallet_address, trade.asset);
  const tokenUnits = trade.side === "buy" ? tokenBalances.delta : -tokenBalances.delta;
  if (tokenUnits <= 0n) return null;

  let nativeUnits: bigint;
  if (trade.side === "buy") {
    nativeUnits = parseUnitsExact(trade.amount, 9);
  } else {
    const accountKeys = getSolanaAccountKeys(transaction);
    const walletIndex = accountKeys.indexOf(trade.wallet_address);
    if (walletIndex < 0) return null;
    const nativeDelta =
      BigInt(transaction.meta.postBalances[walletIndex]) -
      BigInt(transaction.meta.preBalances[walletIndex]);
    const closedAccountRent = getClosedTokenAccountLamports(transaction, trade.wallet_address);
    const newAccountRent = getCreatedTokenAccountLamports(transaction, trade.wallet_address);
    nativeUnits = nativeDelta + BigInt(transaction.meta.fee) - closedAccountRent + newAccountRent;
  }
  if (nativeUnits <= 0n) return null;
  return {
    tokenUnits: tokenUnits.toString(),
    tokenDecimals: tokenBalances.decimals,
    nativeUnits: nativeUnits.toString(),
  };
}

function getOwnedTokenDelta(
  transaction: ParsedTransactionWithMeta,
  walletAddress: string,
  mint: string,
): { delta: bigint; decimals: number } {
  const pre = new Map<string, bigint>();
  const post = new Map<string, bigint>();
  let decimals = 0;
  for (const balance of transaction.meta?.preTokenBalances ?? []) {
    if (balance.owner === walletAddress && balance.mint === mint) {
      pre.set(String(balance.accountIndex), BigInt(balance.uiTokenAmount.amount));
      decimals = balance.uiTokenAmount.decimals;
    }
  }
  for (const balance of transaction.meta?.postTokenBalances ?? []) {
    if (balance.owner === walletAddress && balance.mint === mint) {
      post.set(String(balance.accountIndex), BigInt(balance.uiTokenAmount.amount));
      decimals = balance.uiTokenAmount.decimals;
    }
  }
  const indexes = new Set([...pre.keys(), ...post.keys()]);
  const delta = [...indexes].reduce(
    (sum, index) => sum + (post.get(index) ?? 0n) - (pre.get(index) ?? 0n),
    0n,
  );
  return { delta, decimals };
}

function getSolanaAccountKeys(transaction: ParsedTransactionWithMeta): string[] {
  const staticKeys = transaction.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());
  const loaded = transaction.meta?.loadedAddresses;
  return [
    ...staticKeys,
    ...(loaded?.writable ?? []).map((key) => key.toBase58()),
    ...(loaded?.readonly ?? []).map((key) => key.toBase58()),
  ];
}

function getClosedTokenAccountLamports(transaction: ParsedTransactionWithMeta, owner: string): bigint {
  const pre = new Set(
    (transaction.meta?.preTokenBalances ?? [])
      .filter((balance) => balance.owner === owner)
      .map((balance) => balance.accountIndex),
  );
  const post = new Set(
    (transaction.meta?.postTokenBalances ?? [])
      .filter((balance) => balance.owner === owner)
      .map((balance) => balance.accountIndex),
  );
  let closedRent = 0n;
  for (const accountIndex of pre) {
    if (!post.has(accountIndex)) {
      closedRent += BigInt(transaction.meta!.preBalances[accountIndex]) - BigInt(transaction.meta!.postBalances[accountIndex]);
    }
  }
  return closedRent;
}

function getCreatedTokenAccountLamports(transaction: ParsedTransactionWithMeta, owner: string): bigint {
  const pre = new Set(
    (transaction.meta?.preTokenBalances ?? [])
      .filter((balance) => balance.owner === owner)
      .map((balance) => balance.accountIndex),
  );
  const post = new Set(
    (transaction.meta?.postTokenBalances ?? [])
      .filter((balance) => balance.owner === owner)
      .map((balance) => balance.accountIndex),
  );
  let newAccountRent = 0n;
  for (const accountIndex of post) {
    if (!pre.has(accountIndex)) {
      newAccountRent += BigInt(transaction.meta!.postBalances[accountIndex]) - BigInt(transaction.meta!.preBalances[accountIndex]);
    }
  }
  return newAccountRent;
}

async function getEvmFill(
  provider: Provider,
  trade: TradeLifecycleRow,
): Promise<{ tokenUnits: string; tokenDecimals: number; nativeUnits: string } | null> {
  if (!trade.wallet_address || !trade.transaction_ref) return null;
  const [receipt, transaction] = await Promise.all([
    provider.getTransactionReceipt(trade.transaction_ref),
    provider.getTransaction(trade.transaction_ref),
  ]);
  if (!receipt || receipt.status !== 1 || !transaction) return null;
  const wallet = getAddress(trade.wallet_address);
  const asset = getAddress(trade.asset);
  let tokenDelta = 0n;
  let nativeUnits = 0n;

  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === asset.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC
    ) {
      const event = ERC20_INTERFACE.parseLog(log);
      if (!event) continue;
      if (String(event.args.to).toLowerCase() === wallet.toLowerCase()) {
        tokenDelta += BigInt(event.args.value);
      }
      if (String(event.args.from).toLowerCase() === wallet.toLowerCase()) {
        tokenDelta -= BigInt(event.args.value);
      }
    }
    if (
      trade.side === "sell" &&
      log.address.toLowerCase() === WETH_ADDRESS.toLowerCase() &&
      log.topics[0] === WITHDRAWAL_TOPIC
    ) {
      const event = ERC20_INTERFACE.parseLog(log);
      if (event?.name === "Withdrawal") nativeUnits += BigInt(event.args.wad);
    }
  }

  let tokenUnits: bigint;
  if (trade.side === "buy") {
    tokenUnits = tokenDelta;
    nativeUnits = transaction.value;
  } else {
    tokenUnits = -tokenDelta;
  }
  if (tokenUnits <= 0n || nativeUnits <= 0n) return null;
  const token = new Contract(asset, ERC20_INTERFACE, provider);
  const decimals = Number(await token.decimals());
  return {
    tokenUnits: tokenUnits.toString(),
    tokenDecimals: decimals,
    nativeUnits: nativeUnits.toString(),
  };
}
