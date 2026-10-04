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
}

export interface SellParams extends BaseParams {
  amountInTokenBaseUnits: bigint; // token sold, raw base units (caller applies decimals)
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
  slippageBps: number
): Promise<VersionedTransaction[]> {
  const raydium = await getRaydium(connection, wallet);
  const { poolInfo } = await raydium.liquidity.getPoolInfoFromRpc({ poolId });

  const outputMint = poolInfo.mintA.address === inputMint ? poolInfo.mintB.address : poolInfo.mintA.address;
  const amountInBn = toBN(amountIn.toString());

  const { minAmountOut } = raydium.liquidity.computeAmountOut({
    poolInfo,
    amountIn: amountInBn,
    mintIn: inputMint,
    mintOut: outputMint,
    slippage: slippageBps / 10_000,
  });

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
  jitoTipLamports: number
): Promise<string> {
  swapTxs.forEach((tx) => tx.sign([wallet]));

  if (useJitoBundle) {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tipTx = buildTipTransaction(wallet, blockhash, jitoTipLamports);
    return sendViaJitoBundle([...swapTxs, tipTx]);
  }

  let lastSig = "";
  for (const tx of swapTxs) {
    lastSig = await connection.sendTransaction(tx);
  }
  await connection.confirmTransaction(lastSig, "confirmed");
  return lastSig;
}

export async function executeBuy(params: BuyParams): Promise<string> {
  const { connection, wallet, poolId, amountInLamports, slippageBps, useJitoBundle = true, jitoTipLamports = 100_000 } = params;
  const swapTxs = await buildSwapTransactions(connection, wallet, poolId, WSOL_MINT, amountInLamports, slippageBps);
  return signAndSend(connection, wallet, swapTxs, useJitoBundle, jitoTipLamports);
}

/**
 * Sells a token back to SOL. inputMint here is resolved as "whichever side
 * of the pool isn't SOL" inside buildSwapTransactions, so the caller just
 * passes the token amount being sold — no need to know pool ordering.
 */
export async function executeSell(params: SellParams): Promise<string> {
  const { connection, wallet, poolId, amountInTokenBaseUnits, slippageBps, useJitoBundle = true, jitoTipLamports = 100_000 } = params;
  const raydium = await getRaydium(connection, wallet);
  const { poolInfo } = await raydium.liquidity.getPoolInfoFromRpc({ poolId });
  const tokenMint = poolInfo.mintA.address === WSOL_MINT ? poolInfo.mintB.address : poolInfo.mintA.address;

  const swapTxs = await buildSwapTransactions(
    connection,
    wallet,
    poolId,
    tokenMint,
    amountInTokenBaseUnits,
    slippageBps
  );
  return signAndSend(connection, wallet, swapTxs, useJitoBundle, jitoTipLamports);
}
