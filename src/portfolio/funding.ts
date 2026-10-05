import { Connection, PublicKey } from "@solana/web3.js";
import { Contract, Interface, Provider, getAddress } from "ethers";
import Database from "better-sqlite3";
import {
  getWalletFundingCursor,
  getWalletFundingState,
  initializeWalletFunding,
  listWalletFundingAssets,
  listWalletFundingCursorAddresses,
  recordWalletFundingEvent,
  setWalletFundingBlockCursor,
  setWalletFundingCursor,
  type WalletRow,
} from "../db/db.js";

const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ERC20_INTERFACE = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const TRANSFER_TOPIC = ERC20_INTERFACE.getEvent("Transfer")!.topicHash;

export interface FundingAsset {
  assetId: string;
  symbol: string;
  decimals: number;
  initialUnits: string;
  receivedUnits: string;
}

export async function initializeSolanaFunding(
  db: Database.Database,
  wallet: WalletRow,
  connection: Connection
): Promise<void> {
  const owner = new PublicKey(wallet.address);
  const [balance, tokenAccounts] = await Promise.all([
    connection.getBalanceAndContext(owner, "confirmed"),
    connection.getParsedTokenAccountsByOwner(owner, { programId: SPL_TOKEN_PROGRAM_ID }, "confirmed"),
  ]);

  const assets: { assetId: string; symbol: string; decimals: number; initialUnits: string; baselineSlot: number }[] = [
    {
      assetId: "native",
      symbol: "SOL",
      decimals: 9,
      initialUnits: String(balance.value),
      baselineSlot: balance.context.slot,
    },
  ];
  for (const account of tokenAccounts.value) {
    const info = account.account.data.parsed.info;
    assets.push({
      assetId: info.mint as string,
      symbol: (info.mint as string).slice(0, 8),
      decimals: info.tokenAmount.decimals as number,
      initialUnits: info.tokenAmount.amount as string,
      baselineSlot: tokenAccounts.context.slot,
    });
  }

  const baselineSlot = Math.min(balance.context.slot, tokenAccounts.context.slot);
  initializeWalletFunding(
    db,
    wallet,
    String(wallet.created_at),
    baselineSlot,
    [wallet.address, ...tokenAccounts.value.map((account) => account.pubkey.toBase58())]
      .map((address) => ({ address, cursor: null })),
    assets
  );
}

export async function initializeEvmFunding(
  db: Database.Database,
  wallet: WalletRow,
  provider: Provider,
  knownTokens: string[]
): Promise<void> {
  const blockNumber = await provider.getBlockNumber();
  const [ethBalance, assets] = await Promise.all([
    provider.getBalance(wallet.address, blockNumber),
    Promise.all([...new Set(knownTokens)].map(async (tokenAddress) => {
      const token = new Contract(tokenAddress, ERC20_INTERFACE, provider);
      const [balance, decimals, symbol] = await Promise.all([
        token.balanceOf(wallet.address, { blockTag: blockNumber }) as Promise<bigint>,
        token.decimals().catch(() => 18) as Promise<number>,
        token.symbol().catch(() => tokenAddress.slice(0, 8)) as Promise<string>,
      ]);
      return {
        assetId: getAddress(tokenAddress),
        symbol,
        decimals: Number(decimals),
        initialUnits: balance.toString(),
        baselineSlot: blockNumber,
      };
    })),
  ]);

  initializeWalletFunding(
    db,
    wallet,
    String(blockNumber),
    0,
    [],
    [{ assetId: "native", symbol: "ETH", decimals: 18, initialUnits: ethBalance.toString() }, ...assets]
  );
}

export async function updateWalletFunding(
  db: Database.Database,
  wallet: WalletRow,
  solConnection: Connection,
  evmProvider: Provider
): Promise<FundingAsset[]> {
  const state = getWalletFundingState(db, wallet.id);
  if (!state) return [];
  if (state.chain === "solana") {
    await updateSolanaFunding(db, wallet, solConnection, state.baseline_slot);
  } else {
    await updateEvmFunding(db, wallet, evmProvider, state.cursor);
  }
  return listWalletFundingAssets(db, wallet.id).map((asset) => ({
    assetId: asset.asset_id,
    symbol: asset.symbol,
    decimals: asset.decimals,
    initialUnits: asset.initial_units,
    receivedUnits: asset.received_units,
  }));
}

async function updateSolanaFunding(
  db: Database.Database,
  wallet: WalletRow,
  connection: Connection,
  baselineSlot: number
): Promise<void> {
  const owner = new PublicKey(wallet.address);
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    owner,
    { programId: SPL_TOKEN_PROGRAM_ID },
    "confirmed"
  );
  const accounts = [...new Set([
    wallet.address,
    ...listWalletFundingCursorAddresses(db, wallet.id),
    ...tokenAccounts.value.map((account) => account.pubkey.toBase58()),
  ])];
  const tokenAccountMint = new Map(tokenAccounts.value.map((account) => [
    account.pubkey.toBase58(),
    account.account.data.parsed.info.mint as string,
  ]));
  const baselineSlots = new Map(
    listWalletFundingAssets(db, wallet.id).map((asset) => [asset.asset_id, asset.baseline_slot])
  );

  for (const address of accounts) {
    const cursor = getWalletFundingCursor(db, wallet.id, address);
    let before: string | undefined;
    let firstSignature: string | undefined;
    let reachedBoundary = false;
    let boundaryCursor = cursor;

    while (!reachedBoundary) {
      const page = await connection.getSignaturesForAddress(new PublicKey(address), {
        ...(before ? { before } : {}),
        ...(cursor ? { until: cursor } : {}),
        limit: 1000,
      }, "confirmed");
      if (page.length === 0) break;
      firstSignature ??= page[0].signature;

      for (const entry of page) {
        if (entry.signature === cursor) {
          reachedBoundary = true;
          break;
        }
        if (cursor === null && entry.slot <= baselineSlot) {
          reachedBoundary = true;
          boundaryCursor = entry.signature;
          break;
        }
        if (entry.err) continue;
        const transaction = await connection.getParsedTransaction(entry.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (!transaction) throw new Error(`Solana transaction ${entry.signature} is unavailable from the RPC`);
        recordSolanaTransfers(
          db,
          wallet,
          transaction,
          entry.signature,
          tokenAccountMint,
          baselineSlots,
        );
      }

      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }

    if (firstSignature) setWalletFundingCursor(db, wallet.id, address, boundaryCursor ?? firstSignature);
  }
}

function recordSolanaTransfers(
  db: Database.Database,
  wallet: WalletRow,
  transaction: NonNullable<Awaited<ReturnType<Connection["getParsedTransaction"]>>>,
  signature: string,
  tokenAccountMint: Map<string, string>,
  baselineSlots: Map<string, number>
): void {
  if (transaction.meta?.err) return;
  const tokenBalanceByAccount = new Map<string, { mint: string; decimals: number }>();
  const staticKeys = transaction.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());
  const loaded = transaction.meta?.loadedAddresses;
  const accountKeys = [
    ...staticKeys,
    ...(loaded?.writable ?? []).map((key) => key.toBase58()),
    ...(loaded?.readonly ?? []).map((key) => key.toBase58()),
  ];
  for (const balance of [
    ...(transaction.meta?.preTokenBalances ?? []),
    ...(transaction.meta?.postTokenBalances ?? []),
  ]) {
    if (balance.owner === wallet.address) {
      tokenBalanceByAccount.set(accountKeys[balance.accountIndex], {
        mint: balance.mint,
        decimals: balance.uiTokenAmount.decimals,
      });
    }
  }

  const instructions = [
    ...transaction.transaction.message.instructions.map((instruction, index) => ({
      instruction,
      index: `top:${index}`,
    })),
    ...(transaction.meta?.innerInstructions ?? []).flatMap((inner) =>
      inner.instructions.map((instruction, index) => ({
        instruction,
        index: `inner:${inner.index}:${index}`,
      }))
    ),
  ];
  const hasOutgoingTransfer = instructions.some(({ instruction }) => {
    if (!("parsed" in instruction) || !instruction.parsed) return false;
    const parsed = instruction.parsed as { type?: string; info?: Record<string, unknown> };
    if (!parsed.info) return false;
    return (
      (instruction.program === "system" &&
        parsed.type === "transfer" &&
        parsed.info.source === wallet.address) ||
      ((instruction.program === "spl-token" || instruction.program === "spl-token-2022") &&
        (parsed.type === "transfer" || parsed.type === "transferChecked") &&
        parsed.info.authority === wallet.address)
    );
  });
  if (hasOutgoingTransfer) return;

  for (const { instruction, index } of instructions) {
    if (!("parsed" in instruction) || !instruction.parsed) continue;
    const parsed = instruction.parsed as { type?: string; info?: Record<string, unknown> };
    const info = parsed.info;
    if (!info) continue;

    if (
      instruction.program === "system" &&
      parsed.type === "transfer" &&
      info.destination === wallet.address &&
      (typeof info.lamports === "number" || typeof info.lamports === "string") &&
      transaction.slot > (baselineSlots.get("native") ?? 0)
    ) {
      recordWalletFundingEvent(db, {
        walletId: wallet.id,
        eventId: `${signature}:${index}`,
        assetId: "native",
        symbol: "SOL",
        decimals: 9,
        amountUnits: String(info.lamports),
      });
      continue;
    }

    const tokenAmount =
      typeof info.amount === "string"
        ? info.amount
        : typeof info.tokenAmount === "object" &&
            info.tokenAmount !== null &&
            "amount" in info.tokenAmount
          ? String((info.tokenAmount as { amount: unknown }).amount)
          : null;
    if (
      (instruction.program !== "spl-token" && instruction.program !== "spl-token-2022") ||
      (parsed.type !== "transfer" && parsed.type !== "transferChecked") ||
      typeof info.destination !== "string" ||
      tokenAmount === null
    ) continue;

    const destination = info.destination;
    const token = tokenBalanceByAccount.get(destination);
    const mint = (info.mint as string | undefined) ?? token?.mint ?? tokenAccountMint.get(destination);
    if (
      !mint ||
      info.authority === wallet.address ||
      transaction.slot <= (baselineSlots.get(mint) ?? 0)
    ) continue;
    const tokenAmountInfo = info.tokenAmount as { decimals?: unknown } | undefined;
    recordWalletFundingEvent(db, {
      walletId: wallet.id,
      eventId: `${signature}:${index}`,
      assetId: mint,
      symbol: mint.slice(0, 8),
      decimals: token?.decimals ?? Number(tokenAmountInfo?.decimals ?? 0),
      amountUnits: tokenAmount,
    });
  }
}

async function updateEvmFunding(
  db: Database.Database,
  wallet: WalletRow,
  provider: Provider,
  cursorText: string
): Promise<void> {
  const cursor = Number(cursorText);
  const latest = await provider.getBlockNumber();
  if (latest <= cursor) return;

  const tokenAssets = listWalletFundingAssets(db, wallet.id).filter((asset) => asset.asset_id !== "native");
  const tokens = tokenAssets.map((asset) => getAddress(asset.asset_id));
  const metadata = new Map(tokenAssets.map((asset) => [getAddress(asset.asset_id).toLowerCase(), asset]));
  const walletAddress = getAddress(wallet.address);
  const batchSize = 20;

  for (let fromBlock = cursor + 1; fromBlock <= latest; fromBlock += batchSize) {
    const toBlock = Math.min(fromBlock + batchSize - 1, latest);
    const blockNumbers = Array.from({ length: toBlock - fromBlock + 1 }, (_, index) => fromBlock + index);
    const [blocks, logs] = await Promise.all([
      Promise.all(blockNumbers.map((blockNumber) => provider.getBlock(blockNumber, true))),
      tokens.length > 0
        ? provider.getLogs({ address: tokens, fromBlock, toBlock, topics: [TRANSFER_TOPIC] })
        : Promise.resolve([]),
    ]);
    const outgoingTransactions = new Set(
      blocks.flatMap((block) =>
        (block?.prefetchedTransactions ?? [])
          .filter((tx) =>
            tx.from.toLowerCase() === walletAddress.toLowerCase() &&
            tx.to?.toLowerCase() !== walletAddress.toLowerCase()
          )
          .map((tx) => tx.hash)
      )
    );

    for (let index = 0; index < blocks.length; index++) {
      const blockNumber = blockNumbers[index];
      const block = blocks[index];
      if (!block) throw new Error(`EVM block ${blockNumber} is unavailable from the RPC`);

      for (const tx of block.prefetchedTransactions ?? []) {
        if (
          tx.to &&
          getAddress(tx.to) === walletAddress &&
          tx.from.toLowerCase() !== walletAddress.toLowerCase() &&
          tx.value > 0n
        ) {
          recordWalletFundingEvent(db, {
            walletId: wallet.id,
            eventId: `${tx.hash}:native`,
            assetId: "native",
            symbol: "ETH",
            decimals: 18,
            amountUnits: tx.value.toString(),
          });
        }
      }

      for (const log of logs.filter((item) => item.blockNumber === blockNumber)) {
        const decoded = ERC20_INTERFACE.parseLog(log);
        if (
          !decoded ||
          String(decoded.args.to).toLowerCase() !== walletAddress.toLowerCase() ||
          String(decoded.args.from).toLowerCase() === walletAddress.toLowerCase() ||
          outgoingTransactions.has(log.transactionHash)
        ) continue;
        const asset = metadata.get(log.address.toLowerCase());
        if (!asset) continue;
        recordWalletFundingEvent(db, {
          walletId: wallet.id,
          eventId: `${log.transactionHash}:${log.index}`,
          assetId: asset.asset_id,
          symbol: asset.symbol,
          decimals: asset.decimals,
          amountUnits: BigInt(decoded.args.value).toString(),
        });
      }

      setWalletFundingBlockCursor(db, wallet.id, String(blockNumber));
    }
  }
}

export function formatFundingAmount(units: string, decimals: number): string {
  const amount = BigInt(units);
  const precision = 4;
  const scaled = decimals > precision
    ? (amount + 10n ** BigInt(decimals - precision) / 2n) /
      10n ** BigInt(decimals - precision)
    : amount * 10n ** BigInt(precision - decimals);
  return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}`;
}
