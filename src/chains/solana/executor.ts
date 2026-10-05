import {
  Connection,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import { TxVersion, toBN } from "@raydium-io/raydium-sdk-v2";
import { getRaydium } from "./raydiumClient.js";
import bs58 from "bs58";
import type { TradeLifecycleObserver } from "../../transactions/types.js";

const WSOL_MINT = "So11111111111111111111111111111111111111";

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fFyauNCF3xoTd9uCU",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
];

interface BaseParams {
  connection: Connection;
  wallet: Keypair;
  poolId: string;
  slippageBps: number; // e.g. 500 = 5%
  useJitoBundle?: boolean;
  jitoTipLamports?: number;
}

export interface BuyParams extends BaseParams {
  amountInLamports: bigint; // SOL spent, raw lamports
  assertCanSubmit?: () => void;
  approvedMinimumOut?: bigint;
  onLifecycleEvent?: TradeLifecycleObserver;
}

export interface SellParams extends BaseParams {
  amountInTokenBaseUnits: bigint; // token sold, raw base units (caller applies decimals)
  approvedMinimumOut?: bigint;
  onLifecycleEvent?: TradeLifecycleObserver;
}

/**
 * Shared swap builder for both directions via Raydium SDK v2's high-level
 * swap API — this resolves pool keys and constructs the swap instruction
 * internally, which is what the old plug point was waiting on. Returns an
 * array since the SDK can include a setup transaction (e.g. ATA creation)
 * ahead of the actual swap when the wallet doesn't already hold the output
 * token account.
 *
 * The V0 API returns one versioned transaction; keeping it in an array lets
 * the signing and submission path treat swaps uniformly.
 */
async function buildSwapTransactions(
  connection: Connection,
  wallet: Keypair,
  poolId: string,
  inputMint: string,
  amountIn: bigint,
  slippageBps: number,
  approvedMinimumOut?: bigint
): Promise<VersionedTransaction[]> {
  const raydium = await getRaydium(connection, wallet);
  const { poolInfo } = await raydium.liquidity.getPoolInfoFromRpc({ poolId });

  const outputMint = poolInfo.mintA.address === inputMint ? poolInfo.mintB.address : poolInfo.mintA.address;
  const amountInBn = toBN(amountIn.toString());

  const { minAmountOut: currentMinimumOut } = raydium.liquidity.computeAmountOut({
    poolInfo,
    amountIn: amountInBn,
    mintIn: inputMint,
    mintOut: outputMint,
    slippage: slippageBps / 10_000,
  });
  const currentMinimum = BigInt(currentMinimumOut.toString());
  if (approvedMinimumOut !== undefined && currentMinimum < approvedMinimumOut) {
    throw new Error("Price moved below the confirmed minimum output. Request a fresh quote.");
  }
  const minAmountOut = approvedMinimumOut !== undefined && approvedMinimumOut > currentMinimum
    ? toBN(approvedMinimumOut.toString())
    : currentMinimumOut;

  const { transaction } = await raydium.liquidity.swap({
    poolInfo,
    amountIn: amountInBn,
    amountOut: minAmountOut,
    fixedSide: "in",
    inputMint,
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 300_000, microLamports: 200_000 },
  });

  return [transaction];
}

export interface SwapQuote {
  outputMint: string;
  outputDecimals: number;
  expectedAmountOut: bigint;
  minimumAmountOut: bigint;
}

async function getSwapQuote(
  connection: Connection,
  wallet: Keypair,
  poolId: string,
  inputMint: string,
  amountIn: bigint,
  slippageBps: number
): Promise<SwapQuote> {
  const raydium = await getRaydium(connection, wallet);
  const { poolInfo } = await raydium.liquidity.getPoolInfoFromRpc({ poolId });
  const inputIsA = poolInfo.mintA.address === inputMint;
  const inputIsB = poolInfo.mintB.address === inputMint;
  if (!inputIsA && !inputIsB) throw new Error("The input mint is not part of this pool.");
  const output = inputIsA ? poolInfo.mintB : poolInfo.mintA;
  const { amountOut, minAmountOut } = raydium.liquidity.computeAmountOut({
    poolInfo,
    amountIn: toBN(amountIn.toString()),
    mintIn: inputMint,
    mintOut: output.address,
    slippage: slippageBps / 10_000,
  });
  return {
    outputMint: output.address,
    outputDecimals: Number(output.decimals),
    expectedAmountOut: BigInt(amountOut.toString()),
    minimumAmountOut: BigInt(minAmountOut.toString()),
  };
}

export async function quoteBuy(
  params: Omit<BuyParams, "assertCanSubmit" | "useJitoBundle" | "jitoTipLamports" | "approvedMinimumOut">
): Promise<SwapQuote> {
  return getSwapQuote(params.connection, params.wallet, params.poolId, WSOL_MINT, params.amountInLamports, params.slippageBps);
}

export async function quoteSell(params: SellParams & { tokenMint: string }): Promise<SwapQuote> {
  const quote = await getSwapQuote(
    params.connection,
    params.wallet,
    params.poolId,
    params.tokenMint,
    params.amountInTokenBaseUnits,
    params.slippageBps
  );
  if (quote.outputMint !== WSOL_MINT) throw new Error("This sell pool does not trade the selected token against SOL.");
  return quote;
}

function buildTipTransaction(
  wallet: Keypair,
  blockhash: string,
  tipLamports: number
): VersionedTransaction {
  const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  const ix = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: new PublicKey(tipAccount),
    lamports: tipLamports,
  });
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);
  return tx;
}

async function sendViaJitoBundle(txs: VersionedTransaction[]): Promise<string> {
  const encoded = txs.map((tx) => Buffer.from(tx.serialize()).toString("base64"));
  const res = await fetch(`${process.env.SOLANA_JITO_BLOCK_ENGINE}/api/v1/bundles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [encoded],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Jito bundle rejected: ${json.error.message}`);
  return json.result; // bundle id
}

async function signAndSend(
  connection: Connection,
  wallet: Keypair,
  swapTxs: VersionedTransaction[],
  useJitoBundle: boolean,
  jitoTipLamports: number,
  assertCanSubmit?: () => void,
  onLifecycleEvent?: TradeLifecycleObserver
): Promise<string> {
  assertCanSubmit?.();
  swapTxs.forEach((tx) => tx.sign([wallet]));

  if (useJitoBundle) {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tipTx = buildTipTransaction(wallet, blockhash, jitoTipLamports);
    assertCanSubmit?.();
    const transactionRef = bs58.encode(swapTxs[0].signatures[0]);
    onLifecycleEvent?.({ phase: "submitted", kind: "swap", transactionRef });
    const bundleRef = await sendViaJitoBundle([...swapTxs, tipTx]);
    onLifecycleEvent?.({ phase: "submitted", kind: "swap", transactionRef, bundleRef });
    return bundleRef;
  }

  let lastSig = "";
  for (const tx of swapTxs) {
    assertCanSubmit?.();
    const transactionRef = bs58.encode(tx.signatures[0]);
    onLifecycleEvent?.({ phase: "submitted", kind: "swap", transactionRef });
    lastSig = await connection.sendTransaction(tx);
  }
  const confirmation = await connection.confirmTransaction(lastSig, "confirmed");
  if (confirmation.value.err) throw new Error(`Solana transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  onLifecycleEvent?.({ phase: "confirmed", kind: "swap", transactionRef: lastSig });
  return lastSig;
}

export async function executeBuy(params: BuyParams): Promise<string> {
  const { connection, wallet, poolId, amountInLamports, slippageBps, useJitoBundle = true, jitoTipLamports = 100_000, assertCanSubmit, approvedMinimumOut, onLifecycleEvent } = params;
  const swapTxs = await buildSwapTransactions(connection, wallet, poolId, WSOL_MINT, amountInLamports, slippageBps, approvedMinimumOut);
  return signAndSend(connection, wallet, swapTxs, useJitoBundle, jitoTipLamports, assertCanSubmit, onLifecycleEvent);
}

/**
 * Sells a token back to SOL. inputMint here is resolved as "whichever side
 * of the pool isn't SOL" inside buildSwapTransactions, so the caller just
 * passes the token amount being sold — no need to know pool ordering.
 */
export async function executeSell(params: SellParams): Promise<string> {
  const { connection, wallet, poolId, amountInTokenBaseUnits, slippageBps, useJitoBundle = true, jitoTipLamports = 100_000, approvedMinimumOut, onLifecycleEvent } = params;
  const raydium = await getRaydium(connection, wallet);
  const { poolInfo } = await raydium.liquidity.getPoolInfoFromRpc({ poolId });
  const tokenMint = poolInfo.mintA.address === WSOL_MINT ? poolInfo.mintB.address : poolInfo.mintA.address;

  const swapTxs = await buildSwapTransactions(
    connection,
    wallet,
    poolId,
    tokenMint,
    amountInTokenBaseUnits,
    slippageBps,
    approvedMinimumOut
  );
  return signAndSend(connection, wallet, swapTxs, useJitoBundle, jitoTipLamports, undefined, onLifecycleEvent);
}
