import "dotenv/config";
import dns from "node:dns";
import { Wallet as EvmWallet } from "ethers";
import { loadConfig } from "./config/env.js";
import { WalletVault } from "./vault/wallet-vault.js";
import { getPrimarySolanaKeypair, getPrimaryEvmWallet } from "./vault/walletHelpers.js";
import { configureBotCommands, createBot } from "./bot/telegram.js";
import { getSolanaConnection } from "./chains/solana/connection.js";
import { startPoolListener } from "./chains/solana/poolListener.js";
import { extractRaydiumPoolKeysFromTx, getPoolIdByMint } from "./chains/solana/poolKeys.js";
import { getRaydium } from "./chains/solana/raydiumClient.js";
import { runSolanaSafetyChecks } from "./chains/solana/safetyChecks.js";
import { getEvmWsProvider, getEvmHttpProvider } from "./chains/evm/provider.js";
import { startPairListener } from "./chains/evm/pairListener.js";
import { runEvmSafetyChecks } from "./chains/evm/safetyChecks.js";
import { CopyTradeRegistry } from "./copytrade/registry.js";
import { scaleTrade } from "./copytrade/engine.js";
import { openDb, listActiveSnipers } from "./db/db.js";
import { startLimitOrderEngine } from "./orders/limitOrderEngine.js";
import { evaluateTradePolicy } from "./risk/policy.js";
import { formatUnitsExact, parseUnitsExact } from "./shared/amount.js";
import { startTradeReconciler } from "./transactions/reconciler.js";
import { enqueueAutomatedTrade, startTradeWorker } from "./transactions/worker.js";

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
  const config = loadConfig();

  function minimumAmount(values: string[], decimals: number): string {
    return values.reduce((minimum, amount) =>
      parseUnitsExact(amount, decimals) < parseUnitsExact(minimum, decimals) ? amount : minimum
    );
  }
  console.info(
    `[risk] max buy size: ${config.maxTradeSol} SOL / ${config.maxTradeEth} ETH; max slippage: ${config.maxSlippageBps} bps`
  );
  const vault = new WalletVault(config.vaultMasterKey, "./data/vault.json");
  const db = openDb();

  const solConn = getSolanaConnection();
  const evmProvider = getEvmWsProvider();
  const evmHttp = getEvmHttpProvider();
  const simWallet = EvmWallet.createRandom().address; // no funds needed — safety checks use state overrides
  startTradeReconciler(db, solConn, evmHttp);

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
        const amount = user.snipe_size_sol_exact ?? String(user.snipe_size_sol);
        const decision = evaluateTradePolicy(db, config, {
          userId: user.telegram_id,
          chain: "solana",
          side: "buy",
          amount,
          source: "sniper",
        });
        if (!decision.allowed) continue;
        const job = enqueueAutomatedTrade(db, {
          dedupeKey: `sniper:solana:${event.signature}:${user.telegram_id}`,
          userId: user.telegram_id,
          chain: "solana",
          side: "buy",
          source: "sniper",
          asset: mint,
          amount,
          poolRef: keys.poolId,
        });
        console.info(`[queue] sniping entry queued: ${job.id} user=${user.telegram_id} mint=${mint}`);
      } catch (err) {
        console.error(`[SOL] snipe buy failed for user ${user.telegram_id}:`, err);
      }
    }
  });

  // --- EVM new-pair detection: safety check, then fan out to every active sniper ---
  startPairListener(evmProvider, config.uniswapV2Factory, async (event) => {
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
        const amount = user.snipe_size_eth_exact ?? String(user.snipe_size_eth);
        const decision = evaluateTradePolicy(db, config, {
          userId: user.telegram_id,
          chain: "evm",
          side: "buy",
          amount,
          source: "sniper",
        });
        if (!decision.allowed) continue;
        const job = enqueueAutomatedTrade(db, {
          dedupeKey: `sniper:evm:${event.pair}:${user.telegram_id}`,
          userId: user.telegram_id,
          chain: "evm",
          side: "buy",
          source: "sniper",
          asset: newToken,
          amount,
          poolRef: event.pair,
        });
        console.info(`[queue] sniping entry queued: ${job.id} user=${user.telegram_id} token=${newToken}`);
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
      const solDelta = BigInt(trade.solChangeLamports);
      const targetSpend = formatUnitsExact(solDelta < 0n ? -solDelta : solDelta, 9);
      for (const user of followers) {
        const scaled = scaleTrade(
          {
            targetWallet: target,
            sizeRatio: user.copy_size_ratio_exact ?? String(user.copy_size_ratio),
            maxAmountPerTrade: minimumAmount([
              user.copy_max_amount_exact ?? String(user.copy_max_amount),
              user.max_trade_sol_exact,
              config.maxTradeSol,
            ], 9),
            copySells: !!user.copy_sells,
          },
          targetSpend,
          trade.side,
          trade.mint,
          trade.signature,
          9
        );
        if (!scaled || scaled.action !== "buy") continue;

        const wallet = getPrimarySolanaKeypair(vault, db, user.telegram_id);
        if (!wallet) continue;
        try {
          const decision = evaluateTradePolicy(db, config, {
            userId: user.telegram_id,
            chain: "solana",
            side: "buy",
            amount: scaled.amount,
            source: "copytrade",
          });
          if (!decision.allowed) continue;
          const raydium = await getRaydium(solConn, wallet);
          const poolId = await getPoolIdByMint(raydium, scaled.identifier);
          if (!poolId) continue;
          const job = enqueueAutomatedTrade(db, {
            dedupeKey: `copytrade:solana:${trade.signature}:${user.telegram_id}`,
            userId: user.telegram_id,
            chain: "solana",
            side: "buy",
            source: "copytrade",
            asset: scaled.identifier,
            amount: scaled.amount,
            poolRef: poolId,
          });
          console.info(`[queue] copy entry queued: ${job.id} user=${user.telegram_id} mint=${scaled.identifier}`);
        } catch (err) {
          console.error(`[copytrade/sol] buy failed for user ${user.telegram_id}:`, err);
        }
      }
    },
    async (target, followers, trade) => {
      const ethAmount = formatUnitsExact(BigInt(trade.ethAmount), 18);
      for (const user of followers) {
        const scaled = scaleTrade(
          {
            targetWallet: target,
            sizeRatio: user.copy_size_ratio_exact ?? String(user.copy_size_ratio),
            maxAmountPerTrade: minimumAmount([
              user.copy_max_amount_exact ?? String(user.copy_max_amount),
              user.max_trade_eth_exact,
              config.maxTradeEth,
            ], 18),
            copySells: !!user.copy_sells,
          },
          ethAmount,
          trade.side,
          trade.tokenAddress,
          trade.txHash,
          18
        );
        if (!scaled || scaled.action !== "buy") continue;

        const wallet = getPrimaryEvmWallet(vault, db, user.telegram_id);
        if (!wallet) continue;
        try {
          const decision = evaluateTradePolicy(db, config, {
            userId: user.telegram_id,
            chain: "evm",
            side: "buy",
            amount: scaled.amount,
            source: "copytrade",
          });
          if (!decision.allowed) continue;
          const result = await runEvmSafetyChecks(evmHttp, scaled.identifier, simWallet);
          if (!result.safe) continue;
          const job = enqueueAutomatedTrade(db, {
            dedupeKey: `copytrade:evm:${trade.txHash}:${user.telegram_id}`,
            userId: user.telegram_id,
            chain: "evm",
            side: "buy",
            source: "copytrade",
            asset: scaled.identifier,
            amount: scaled.amount,
            poolRef: undefined,
          });
          console.info(`[queue] copy entry queued: ${job.id} user=${user.telegram_id} token=${scaled.identifier}`);
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
    evmFactoryAddress: config.uniswapV2Factory,
    config,
  });

  startTradeWorker({
    db,
    config,
    solConnection: solConn,
    evmProvider: evmHttp,
    loadSolWallet: (userId) => getPrimarySolanaKeypair(vault, db, userId),
    loadEvmWallet: (userId) => getPrimaryEvmWallet(vault, db, userId),
  });

  // --- Telegram control surface ---
  const bot = createBot(config.telegramBotToken, {
    vault,
    db,
    copyRegistry,
    solConnection: solConn,
    evmProvider,
    adminBootstrapId: config.telegramOwnerId,
    tradingLimits: {
      maxTradeSol: config.maxTradeSol,
      maxTradeEth: config.maxTradeEth,
      maxDailySpendSol: config.maxDailySpendSol,
      maxDailySpendEth: config.maxDailySpendEth,
      maxSlippageBps: config.maxSlippageBps,
      tradeQuoteTtlSeconds: config.tradeQuoteTtlSeconds,
    },
    evmHttpProvider: evmHttp,
    evmFactoryAddress: config.uniswapV2Factory,
  });
  await launchWithRetry(bot, config.telegramOwnerId);
  console.log("maestro running.");
}

/**
 * bot.launch() calls Telegram's getMe to verify the token before it starts
 * polling — a single transient network blip there (DNS hiccup, a dropped
 * TLS handshake, momentary ISP routing issue) would otherwise take the
 * entire process down along with every listener/engine already running.
 * Retries a few times with backoff before giving up for real.
 */
async function launchWithRetry(
  bot: ReturnType<typeof createBot>,
  adminId: string,
  attempts = 5,
  delayMs = 3000
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await configureBotCommands(bot, adminId);
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
