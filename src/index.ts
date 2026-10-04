import "dotenv/config";
import dns from "node:dns";
import { Wallet as EvmWallet } from "ethers";
import { WalletVault } from "./vault/wallet-vault.js";
import { getPrimarySolanaKeypair, getPrimaryEvmWallet } from "./vault/walletHelpers.js";
import { createBot } from "./bot/telegram.js";
import { getSolanaConnection } from "./chains/solana/connection.js";
import { startPoolListener } from "./chains/solana/poolListener.js";
import { extractRaydiumPoolKeysFromTx, getPoolIdByMint } from "./chains/solana/poolKeys.js";
import { getRaydium } from "./chains/solana/raydiumClient.js";
import { executeBuy as executeSolanaBuy } from "./chains/solana/executor.js";
import { runSolanaSafetyChecks } from "./chains/solana/safetyChecks.js";
import { getEvmWsProvider, getEvmHttpProvider } from "./chains/evm/provider.js";
import { startPairListener } from "./chains/evm/pairListener.js";
import { runEvmSafetyChecks } from "./chains/evm/safetyChecks.js";
import { executeBuy as executeEvmBuy } from "./chains/evm/executor.js";
import { CopyTradeRegistry } from "./copytrade/registry.js";
import { scaleTrade } from "./copytrade/engine.js";
import { openDb, recordHolding, listActiveSnipers } from "./db/db.js";
import { startLimitOrderEngine } from "./orders/limitOrderEngine.js";

/**
 * Many ISPs hand out IPv6 addresses that don't route well internationally.
 * Browsers fall back to IPv4 transparently when that happens (Happy
 * Eyeballs); Node's networking — which is what Telegraf's HTTP calls to the
 * Bot API run on — generally doesn't, and just hangs until it times out.
 * Forcing IPv4-first here fixes that class of failure for every outbound
 * connection this process makes (Telegram, RPC endpoints, everything), not
 * just the one that happened to surface it first.
 */
dns.setDefaultResultOrder("ipv4first");

const WSOL_MINT = "So11111111111111111111111111111111111111";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

async function main() {
  const vault = new WalletVault(process.env.VAULT_MASTER_KEY!, "./data/vault.json");
  const db = openDb();

  const solConn = getSolanaConnection();
  const evmProvider = getEvmWsProvider();
  const evmHttp = getEvmHttpProvider();
  const simWallet = EvmWallet.createRandom().address; // no funds needed — safety checks use state overrides

  // --- Solana new-pool detection: safety check, then fan out to every active sniper ---
  startPoolListener(solConn, async (event) => {
    console.log(`[SOL] new pool via ${event.source}: ${event.signature}`);
    if (event.source !== "raydium") {
      console.log(`[SOL] pump.fun pools use a bonding-curve program, not the Raydium executor — detection only, no auto-buy path for these yet.`);
      return;
    }

    const tx = await solConn.getParsedTransaction(event.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) return;
    const keys = extractRaydiumPoolKeysFromTx(tx);
    if (!keys) {
      console.log(`[SOL] couldn't extract pool keys from ${event.signature} — instruction layout may not match the expected initialize2 offsets`);
      return;
    }

    const mint = keys.coinMint === WSOL_MINT ? keys.pcMint : keys.coinMint;
    const result = await runSolanaSafetyChecks(solConn, mint, keys.lpMint);
    console.log(`[SOL] safety check for ${mint}: safe=${result.safe}`, result.reasons);
    if (!result.safe) return;

    const snipers = listActiveSnipers(db, "solana");
    for (const user of snipers) {
      const wallet = getPrimarySolanaKeypair(vault, db, user.telegram_id);
      if (!wallet) continue; // enabled sniping before creating a wallet — nothing to do until they do
      try {
        await executeSolanaBuy({
          connection: solConn,
          wallet,
          poolId: keys.poolId,
          amountInLamports: BigInt(Math.floor(user.snipe_size_sol * 1e9)),
          slippageBps: 500,
        });
      } catch (err) {
        console.error(`[SOL] snipe buy failed for user ${user.telegram_id}:`, err);
      }
    }
  });

  // --- EVM new-pair detection: safety check, then fan out to every active sniper ---
  startPairListener(evmProvider, process.env.UNISWAP_V2_FACTORY!, async (event) => {
    console.log(`[EVM] new pair: ${event.pair} (${event.token0}/${event.token1})`);
    const newToken = event.token0.toLowerCase() === WETH.toLowerCase() ? event.token1 : event.token0;

    const result = await runEvmSafetyChecks(evmHttp, newToken, simWallet);
    console.log(`[EVM] safety check for ${newToken}: safe=${result.safe}`, result.reasons);
    if (!result.safe) return;

    const snipers = listActiveSnipers(db, "evm");
    for (const user of snipers) {
      const wallet = getPrimaryEvmWallet(vault, db, user.telegram_id);
      if (!wallet) continue;
      try {
        await executeEvmBuy({
          provider: evmHttp,
          wallet,
          tokenAddress: newToken,
          amountInEth: String(user.snipe_size_eth),
          slippageBps: 500,
        });
        recordHolding(db, "evm", user.telegram_id, newToken);
      } catch (err) {
        console.error(`[EVM] snipe buy failed for user ${user.telegram_id}:`, err);
      }
    }
  });

  // --- Copy-trade registry: one watcher per unique target, fanned out to all followers ---
  const copyRegistry = new CopyTradeRegistry(
    db,
    solConn,
    evmProvider,
    async (target, followers, trade) => {
      for (const user of followers) {
        const scaled = scaleTrade(
          { targetWallet: target, sizeRatio: user.copy_size_ratio, maxAmountPerTrade: user.copy_max_amount, copySells: !!user.copy_sells },
          Math.abs(trade.solChange),
          trade.side,
          trade.mint,
          trade.signature
        );
        if (!scaled || scaled.action !== "buy") continue;

        const wallet = getPrimarySolanaKeypair(vault, db, user.telegram_id);
        if (!wallet) continue;
        try {
          const raydium = await getRaydium(solConn, wallet);
          const poolId = await getPoolIdByMint(raydium, scaled.identifier);
          if (!poolId) continue;
          await executeSolanaBuy({
            connection: solConn,
            wallet,
            poolId,
            amountInLamports: BigInt(Math.floor(scaled.amount * 1e9)),
            slippageBps: 500,
          });
        } catch (err) {
          console.error(`[copytrade/sol] buy failed for user ${user.telegram_id}:`, err);
        }
      }
    },
    async (target, followers, trade) => {
      const ethAmount = Number(trade.ethAmount) / 1e18;
      for (const user of followers) {
        const scaled = scaleTrade(
          { targetWallet: target, sizeRatio: user.copy_size_ratio, maxAmountPerTrade: user.copy_max_amount, copySells: !!user.copy_sells },
          ethAmount,
          trade.side,
          trade.tokenAddress,
          trade.txHash
        );
        if (!scaled || scaled.action !== "buy") continue;

        const wallet = getPrimaryEvmWallet(vault, db, user.telegram_id);
        if (!wallet) continue;
        try {
          const result = await runEvmSafetyChecks(evmHttp, scaled.identifier, simWallet);
          if (!result.safe) continue;
          await executeEvmBuy({
            provider: evmHttp,
            wallet,
            tokenAddress: scaled.identifier,
            amountInEth: String(scaled.amount),
            slippageBps: 500,
          });
          recordHolding(db, "evm", user.telegram_id, scaled.identifier);
        } catch (err) {
          console.error(`[copytrade/evm] buy failed for user ${user.telegram_id}:`, err);
        }
      }
    }
  );
  copyRegistry.loadFromDb(); // pick up any targets already set from a previous run

  // --- Limit order engine ---
  startLimitOrderEngine({
    db,
    solConnection: solConn,
    loadSolWallet: (userId) => getPrimarySolanaKeypair(vault, db, userId),
    evmProvider: evmHttp,
    loadEvmWallet: (userId) => getPrimaryEvmWallet(vault, db, userId),
    evmFactoryAddress: process.env.UNISWAP_V2_FACTORY!,
  });

  // --- Telegram control surface ---
  const bot = createBot(process.env.TELEGRAM_BOT_TOKEN!, { vault, db, copyRegistry, solConnection: solConn, evmProvider });
  await launchWithRetry(bot);
  console.log("maestro running.");
}

/**
 * bot.launch() calls Telegram's getMe to verify the token before it starts
 * polling — a single transient network blip there (DNS hiccup, a dropped
 * TLS handshake, momentary ISP routing issue) would otherwise take the
 * entire process down along with every listener/engine already running.
 * Retries a few times with backoff before giving up for real.
 */
async function launchWithRetry(bot: ReturnType<typeof createBot>, attempts = 5, delayMs = 3000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await bot.launch();
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.error(`[bot] launch failed (attempt ${attempt}/${attempts}), retrying in ${delayMs / 1000}s:`, (err as Error).message);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
