import { Telegraf, Markup } from "telegraf";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  isNonNegativeDecimal,
  isPositiveDecimal,
  parseUnitsExact,
} from "../shared/amount.js";
import type { AppConfig } from "../config/env.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  Contract,
  formatUnits,
  getAddress,
  isAddress,
  JsonRpcProvider,
  Provider,
} from "ethers";
import { WalletVault } from "../vault/wallet-vault.js";
import {
  importMnemonicWallet,
  importRawSolanaWallet,
  importRawEvmWallet,
  revealSecret,
  eraseWallet,
  loadEvmWalletByLabel,
  loadSolanaKeypair,
} from "../vault/walletHelpers.js";
import { CopyTradeRegistry } from "../copytrade/registry.js";
import { createOrder, cancelOrder } from "../orders/limitOrderEngine.js";
import {
  formatFundingAmount,
  initializeEvmFunding,
  initializeSolanaFunding,
  updateWalletFunding,
} from "../portfolio/funding.js";
import { formatNativeAmount, getRealizedPnl } from "../premium/analytics.js";
import { startPremiumAlertWatcher } from "../premium/alerts.js";
import {
  addAutoSnipe,
  cancelPremiumPriceAlert,
  createPremiumPriceAlert,
  getAutoSnipeConfig,
  getHoldings,
  getPremiumAccess,
  getPremiumStarsPrice,
  getSystemControls,
  getOrCreateUser,
  getUser,
  listRecentSecurityEvents,
  listUsers,
  listPendingUsers,
  setUserStatus,
  setUserAdminFlag,
  setKillSwitch,
  updateUserSettings,
  listWalletsFor,
  getWallet,
  setPrimaryWallet,
  recordWalletImport,
  createPremiumInvoiceSession,
  grantPremiumAccess,
  isPremiumActive,
  recordPremiumStarsPayment,
  requestPremiumAccess,
  reviewPremiumRequest,
  revokePremiumAccess,
  setPremiumStarsPrice,
  validatePremiumInvoice,
  getPrimaryWallet,
  recordHolding,
  recordSecurityEvent,
  listRecentTradesForUser,
  listRecentTradeJobsForUser,
  listPremiumPriceAlerts,
  listAutoSnipesForUser,
  removeAutoSnipe,
  setAutoSnipeEnabled,
  updateAutoSnipeConfig,
  addPresaleListing,
  countPresaleListings,
  countReferrals,
  listPresaleListings,
  recordReferralAttribution,
  removePresaleListing,
} from "../db/db.js";
import {
  executeBuy as executeSolanaBuy,
  executeSell as executeSolanaSell,
  quoteBuy as quoteSolanaBuy,
  quoteSell as quoteSolanaSell,
} from "../chains/solana/executor.js";
import {
  executeBuy as executeEvmBuy,
  executeSell as executeEvmSell,
  quoteBuy as quoteEvmBuy,
  quoteSell as quoteEvmSell,
} from "../chains/evm/executor.js";
import { assertBuyEntryEnabled, evaluateTradePolicy } from "../risk/policy.js";
import { formatUnitsExact } from "../shared/amount.js";
import {
  styleBotResponse,
  startWelcome,
  tradingHeading,
  tradingSide,
  tradingStatus,
  triggerDirection,
} from "./presentation.js";
import { getNativeBridgeQuote } from "../bridge/lifi.js";
import type { Wallet as EvmWallet } from "ethers";
import { beginTrackedTrade } from "../transactions/tracker.js";
import {
  rateLimitTelegramMessages,
  TelegramMessageLimiter,
} from "./telegram-message-limiter.js";

const USER_COMMANDS = [
  { command: "start", description: "Open the Maestro menu" },
  { command: "help", description: "Show help" },
  { command: "wallets", description: "Manage or import wallets" },
  { command: "cancel_import", description: "Cancel wallet import" },
  { command: "portfolio", description: "View portfolio balances" },
  { command: "presales", description: "Browse curated presale listings" },
  { command: "referrals", description: "Get your referral link and stats" },
  { command: "bridge", description: "Get a quote-only cross-chain route" },
  { command: "premium", description: "View or subscribe to premium" },
  { command: "premium_report", description: "View premium realized P&L" },
  { command: "premium_alert", description: "Create a premium price alert" },
  { command: "premium_alerts", description: "List active premium price alerts" },
  { command: "premium_alert_cancel", description: "Cancel a premium price alert" },
  { command: "snipe_on", description: "Enable auto-buy" },
  { command: "snipe_off", description: "Disable auto-buy" },
  { command: "snipe_size", description: "Set auto-buy size" },
  { command: "copytrade_set", description: "Set copy-trade target" },
  { command: "copytrade_off", description: "Stop copy-trading" },
  { command: "copytrade_config", description: "Configure copy-trade sizing" },
  { command: "limit_buy", description: "Create a limit buy order" },
  { command: "limit_sell", description: "Create a limit sell order" },
  { command: "orders", description: "View open and recent orders" },
  { command: "cancel", description: "Cancel a limit order" },
];

const ADMIN_COMMANDS = [
  { command: "admin_pending", description: "List pending user approvals" },
  { command: "admin_approve", description: "Approve a user by Telegram ID" },
  { command: "admin_users", description: "List registered users" },
  { command: "admin_ban", description: "Ban a user by Telegram ID" },
  { command: "admin_unban", description: "Unban a user by Telegram ID" },
  { command: "admin_stats", description: "Show user and trading stats" },
  { command: "admin_flag", description: "Flag a user with a custom message" },
  { command: "admin_unflag", description: "Clear a user's flag" },
  { command: "admin_premium_price", description: "Set the monthly premium price in Stars" },
  { command: "admin_premium_grant", description: "Grant premium to a user for a number of days" },
  { command: "admin_premium_revoke", description: "Terminate a user's premium access" },
  { command: "admin_presales", description: "List curated presale entries" },
  { command: "admin_presale_add", description: "Add a curated presale entry" },
  { command: "admin_presale_remove", description: "Remove a presale entry" },
];

export async function configureBotCommands(
  bot: Telegraf,
  adminId: string,
): Promise<void> {
  await bot.telegram.setMyCommands(USER_COMMANDS);
  await bot.telegram.setMyCommands([...USER_COMMANDS, ...ADMIN_COMMANDS], {
    scope: { type: "chat", chat_id: adminId },
  });
}

export interface BotDeps {
  vault: WalletVault;
  db: Database.Database;
  copyRegistry: CopyTradeRegistry;
  solConnection: Connection;
  evmProvider: Provider;
  evmHttpProvider: JsonRpcProvider;
  evmFactoryAddress: string;
  adminBootstrapId: string;
  tradingLimits: Pick<
    AppConfig,
    | "maxTradeSol"
    | "maxTradeEth"
    | "maxDailySpendSol"
    | "maxDailySpendEth"
    | "maxSlippageBps"
    | "tradeQuoteTtlSeconds"
  >;
}

const HELP_TEXT = `✨ MAESTRO

Use the buttons below to manage wallets, portfolio, auto-buy, copy trading, limit orders, curated presales, referrals, and quote-only bridge routes. Signals open premium price alerts. When an action needs an address or amount, the bot will prompt you for it.`;

function homeKeyboard(isAdmin: boolean) {
  const rows = [
    [
      Markup.button.callback("🔗 Chains", "home_chains"),
      Markup.button.callback("💼 Wallets", "home_wallets"),
    ],
    [
      Markup.button.callback("⚙️ Global Settings", "home_risk_settings"),
      Markup.button.callback("📡 Signals", "home_signals"),
    ],
    [
      Markup.button.callback("🤖 Copytrade", "home_copytrade"),
      Markup.button.callback("🔔 Presales", "home_presales"),
    ],
    [
      Markup.button.callback("🎯 Auto Snipe", "home_snipe"),
      Markup.button.callback("🕒 Active Orders", "home_orders"),
    ],
    [
      Markup.button.callback("📈 Positions", "wallets_portfolio"),
      Markup.button.callback("⭐ Premium", "home_premium"),
    ],
    [
      Markup.button.callback("🤝 Referral", "home_referrals"),
      Markup.button.callback("🌉 Bridge", "home_bridge"),
    ],
    [Markup.button.callback("⚡ BUY & SELL NOW", "home_trade")],
    [Markup.button.callback("❔ Help", "home_help")],
  ];
  if (isAdmin) rows.push([Markup.button.callback("🛡 Admin", "home_admin")]);
  return Markup.inlineKeyboard(rows);
}

function onboardingKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📥 Import wallet", "wallets_import")],
    [Markup.button.callback("↩️ Refresh status", "home")],
  ]);
}

const ADMIN_HELP_TEXT = `
Admin tools are available from the Admin button on the main menu.`;

const walletsMenu = Markup.inlineKeyboard([
  [Markup.button.callback("📥 Import wallet", "wallets_import")],
  [
    Markup.button.callback("📋 My Wallets", "wallets_list"),
    Markup.button.callback("📊 Portfolio", "wallets_portfolio"),
  ],
  [Markup.button.callback("↩️ Home", "home")],
]);

const REVEAL_AUTO_DELETE_MS = 60_000;
const cancelPromptKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("Cancel", "flow_cancel")],
]);
type PendingImport = { kind: "wallet" };

export function createBot(token: string, deps: BotDeps): Telegraf {
  const {
    vault,
    db,
    copyRegistry,
    solConnection,
    evmProvider,
    evmHttpProvider,
    evmFactoryAddress,
    tradingLimits,
  } = deps;
  const bot = new Telegraf(token);
  const adminBootstrapId = deps.adminBootstrapId;
  const messageLimiter = new TelegramMessageLimiter();
  rateLimitTelegramMessages(bot.telegram, messageLimiter, adminBootstrapId);
  bot.catch((err, ctx) => {
    console.error(
      `[bot] update ${ctx.update.update_id} (${ctx.updateType}) failed:`,
      err,
    );
  });
  const pendingImport = new Map<number, PendingImport>();
  const pendingAdminActivity = new Map<string, number>();
  const pendingAdminRegistrations = new Map<string, string | null>();
  let adminActivityFlushTimer: ReturnType<typeof setTimeout> | undefined;

  function flushAdminActivity(): void {
    adminActivityFlushTimer = undefined;
    if (
      !adminBootstrapId ||
      (pendingAdminActivity.size === 0 && pendingAdminRegistrations.size === 0)
    ) {
      return;
    }

    const totalUpdates = [...pendingAdminActivity.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
    const lines: string[] = [];
    if (pendingAdminActivity.size > 0) {
      lines.push(
        `User activity (${totalUpdates} update${totalUpdates === 1 ? "" : "s"}):`,
      );
      for (const [activity, count] of pendingAdminActivity) {
        lines.push(`- ${activity}${count > 1 ? ` (${count} updates)` : ""}`);
      }
    }
    if (pendingAdminRegistrations.size > 0) {
      lines.push(`New users (${pendingAdminRegistrations.size}):`);
      for (const [telegramId, username] of pendingAdminRegistrations) {
        lines.push(
          `- ${telegramId}${username ? ` (@${username})` : ""} — waiting for wallet import and admin approval`,
        );
      }
    }
    const messageLines: string[] = [];
    let messageLength = 0;
    for (const line of lines) {
      if (messageLength + line.length + 1 > 3800) break;
      messageLines.push(line);
      messageLength += line.length + 1;
    }
    const omittedLines = lines.length - messageLines.length;
    if (omittedLines > 0) {
      messageLines.push(`... ${omittedLines} additional entries omitted.`);
    }
    pendingAdminActivity.clear();
    pendingAdminRegistrations.clear();
    void bot.telegram
      .sendMessage(adminBootstrapId, messageLines.join("\n"))
      .catch((err) =>
        console.error("[bot] couldn't notify admin about user activity:", err),
      );
  }

  function scheduleAdminActivityFlush(): void {
    if (!adminActivityFlushTimer) {
      adminActivityFlushTimer = setTimeout(flushAdminActivity, 1000);
    }
  }

  function notifyAdminOfPendingUser(user: {
    telegram_id: string;
    username: string | null;
  }): void {
    if (!adminBootstrapId) return;
    pendingAdminRegistrations.set(user.telegram_id, user.username);
    scheduleAdminActivityFlush();
  }

  function addAdminActivity(activity: string): void {
    pendingAdminActivity.set(
      activity,
      (pendingAdminActivity.get(activity) ?? 0) + 1,
    );
    scheduleAdminActivityFlush();
  }

  startPremiumAlertWatcher({
    db,
    solConnection,
    evmProvider: evmHttpProvider,
    evmFactory: evmFactoryAddress,
    loadSolanaWallet: (userId) => {
      const wallet = getPrimaryWallet(db, userId, "solana");
      return wallet ? loadSolanaKeypair(vault, db, userId, wallet.label) : null;
    },
    notify: (userId, text) => bot.telegram.sendMessage(userId, text),
  });

  if (!adminBootstrapId) {
    console.warn(
      "[bot] TELEGRAM_OWNER_ID is not set — no one will be promoted to admin, which means no one can ever be approved either. Every user will be permanently stuck pending. Set it to your Telegram id before going live.",
    );
  }

  function adminFlagNotice(message: string | null): string {
    const note = message?.trim();
    return (
      `Your account has been flagged. Features are not implemented.` +
      (note ? `\n\n${note}` : "")
    ).slice(0, 200);
  }

  async function notifyFlaggedUser(
    telegramId: string,
    message: string | null,
  ): Promise<void> {
    try {
      await bot.telegram.sendMessage(telegramId, adminFlagNotice(message));
    } catch (err) {
      console.error(`[admin] couldn't notify flagged user ${telegramId}:`, err);
    }
  }

  function notifyAdminOfUserAction(ctx: any): void {
    if (!adminBootstrapId || !ctx.from || ctx.dbUser?.role === "admin") return;

    const user = ctx.from;
    const text = ctx.message?.text as string | undefined;
    const command = text?.match(/^\/([a-z0-9_]+)/i)?.[1];
    const callbackData = ctx.callbackQuery?.data as string | undefined;
    const action = callbackData
      ? `pressed button "${callbackData.slice(0, 100)}"`
      : command
        ? `sent /${command}`
        : ctx.message
          ? "sent a message"
          : ctx.preCheckoutQuery
            ? "started a payment"
            : `performed ${ctx.updateType}`;
    const identity = [
      user.username ? `@${user.username}` : user.first_name,
      `ID ${user.id}`,
    ]
      .filter(Boolean)
      .join(" · ");
    addAdminActivity(`${identity} ${action}.`);
  }

  // --- Registration + status enforcement ---
  // Pending users may import a wallet but cannot use other features until approved.
  bot.use(async (ctx, next) => {
    const callbackMessage = ctx.callbackQuery?.message;
    if (callbackMessage && "text" in callbackMessage) {
      const sendReply = ctx.reply.bind(ctx);
      const editMessageText = ctx.editMessageText.bind(ctx);
      ctx.reply = async (text, extra) => {
        const replyMarkup = extra?.reply_markup;
        if (replyMarkup && !("inline_keyboard" in replyMarkup)) {
          return sendReply(text, extra);
        }
        const editExtra = {
          parse_mode: extra?.parse_mode,
          entities: extra?.entities,
          link_preview_options: extra?.link_preview_options,
          reply_markup: replyMarkup ?? { inline_keyboard: [] },
        };

        try {
          await editMessageText(text, editExtra);
          return callbackMessage;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("message is not modified")
          ) {
            return callbackMessage;
          }
          console.warn(
            "[bot] couldn't transition the selected menu; sending a new reply:",
            error,
          );
          return sendReply(text, extra);
        }
      };
    }

    const answerCallback = ctx.answerCbQuery.bind(ctx);
    ctx.answerCbQuery = (text?: string, extra?: object) =>
      answerCallback(
        typeof text === "string" ? styleBotResponse(text, 200) : text,
        extra,
      );
    const answerPreCheckout = ctx.answerPreCheckoutQuery.bind(ctx);
    ctx.answerPreCheckoutQuery = (
      ok: boolean,
      errorMessage?: string,
    ) =>
      answerPreCheckout(
        ok,
        typeof errorMessage === "string"
          ? styleBotResponse(errorMessage, 200)
          : errorMessage,
      );

    if (!ctx.from) return next();
    const { user, isNew } = getOrCreateUser(
      db,
      String(ctx.from.id),
      ctx.from.username,
      adminBootstrapId,
    );
    const startText = (ctx.message as any)?.text as string | undefined;
    const referrerId = startText?.match(
      /^\/start(?:@\w+)?\s+ref_(\d+)(?:\s|$)/,
    )?.[1];
    if (isNew && referrerId) {
      recordReferralAttribution(db, referrerId, user.telegram_id);
    }
    (ctx as any).dbUser = user;
    notifyAdminOfUserAction(ctx);

    if (isNew && user.status === "pending") {
      notifyAdminOfPendingUser(user); // fire-and-forget — a failed DM shouldn't block registration
    }

    if (user.status === "banned") {
      return ctx.reply("Your access to this bot has been revoked.");
    }

    if (user.role !== "admin" && user.admin_flagged) {
      const notice = adminFlagNotice(user.admin_flag_message);
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(notice, { show_alert: true });
        return;
      }
      return ctx.reply(notice);
    }

    if (user.status === "pending") {
      const text = (ctx.message as any)?.text as string | undefined;
      const command = text?.split(/\s/, 1)[0].split("@")[0];
      const isOnboardingCommand =
        command === "/start" ||
        command === "/help" ||
        command === "/wallets" ||
        command === "/cancel_import";
      const callbackData = (ctx.callbackQuery as any)?.data as
        | string
        | undefined;
      const isOnboardingAction =
        callbackData === "home" ||
        callbackData === "home_help" ||
        callbackData === "home_wallets" ||
        callbackData === "wallets_import" ||
        callbackData === "flow_cancel";
      const isImportText =
        !!ctx.from &&
        !!text &&
        !text.startsWith("/") &&
        pendingImport.has(ctx.from.id);
      if (!isOnboardingCommand && !isOnboardingAction && !isImportText) {
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery(
            "Import a wallet and wait for admin approval.",
            { show_alert: true },
          );
          return;
        }
        return ctx.reply(
          "Import a wallet and wait for admin approval.",
        );
      }
    }

    return next();
  });

  function requireAdmin(ctx: any): boolean {
    if (ctx.dbUser?.role !== "admin") {
      ctx.reply("Admin only.");
      return false;
    }
    return true;
  }

  function approvePendingUser(telegramId: string): string | null {
    const user = getUser(db, telegramId);
    if (!user) return "No user with that Telegram ID is registered.";
    if (user.status !== "pending")
      return `User ${telegramId} is ${user.status}, not pending approval.`;
    return activateUserWithImportedWallet(telegramId);
  }

  function activateUserWithImportedWallet(telegramId: string): string | null {
    const user = getUser(db, telegramId);
    if (!user) return "No user with that Telegram ID is registered.";
    if (listWalletsFor(db, telegramId).length === 0) {
      return `User ${telegramId} must import a wallet before being activated.`;
    }
    setUserStatus(db, telegramId, "active");
    return null;
  }

  type OrderDraft = {
    identifier?: string;
    poolRef?: string;
    triggerPrice?: number;
    amount?: string;
    decimals?: number;
  };
  type ManualTradeDraft = {
    asset?: string;
    poolId?: string;
    amount?: string;
  };
  type PendingInput =
    | { kind: "snipe_size"; chain: "solana" | "evm" }
    | {
        kind: "auto_snipe";
        chain: "solana" | "evm";
        step: "asset";
      }
    | {
        kind: "auto_snipe";
        chain: "solana" | "evm";
        step: "amount";
        asset: string;
      }
    | {
        kind: "auto_snipe_config";
        chain: "solana" | "evm";
        field: "slippage" | "tip";
      }
    | {
        kind: "bridge_amount";
        fromChain: "solana" | "evm";
        toChain: "solana" | "evm";
      }
    | {
        kind: "risk_setting";
        field:
          | "max_trade_sol_exact"
          | "max_trade_eth_exact"
          | "max_daily_spend_sol_exact"
          | "max_daily_spend_eth_exact"
          | "max_slippage_bps"
          | "cooldown_seconds";
      }
    | {
        kind: "manual_trade";
        chain: "solana" | "evm";
        side: "buy" | "sell";
        step: "asset" | "pool" | "amount";
        values: ManualTradeDraft;
      }
    | { kind: "copy_target" }
    | { kind: "copy_ratio" }
    | { kind: "copy_max"; ratio: string }
    | { kind: "copy_sells"; ratio: string; maxAmount: string }
    | {
        kind: "order_value";
        chain: "solana" | "evm";
        side: "buy" | "sell";
        step:
          | "identifier"
          | "poolRef"
          | "triggerPrice"
          | "amount"
          | "decimals"
          | "direction";
        values: OrderDraft;
      }
    | {
        kind: "admin_user_status";
        status: "active" | "banned";
        action: "approve" | "ban" | "unban";
      }
    | {
        kind: "admin_flag_user";
        step: "user_id" | "message";
        telegramId?: string;
      }
    | { kind: "admin_unflag_user" };

  type ManualTradeQuote = {
    userId: string;
    chain: "solana" | "evm";
    side: "buy" | "sell";
    asset: string;
    poolId?: string;
    amount: string;
    amountBaseUnits: bigint;
    inputDecimals: number;
    outputMint?: string;
    expectedAmountOut: bigint;
    minimumAmountOut: bigint;
    outputDecimals: number;
    slippageBps: number;
    requiresApproval: boolean;
    expiresAt: number;
  };

  const pendingInputs = new Map<number, PendingInput>();
  const killSwitchConfirmations = new Map<
    string,
    { userId: string; enabled: boolean; expiresAt: number }
  >();
  const manualTradeQuotes = new Map<string, ManualTradeQuote>();

  function getSolanaTradeWallet(userId: string): Keypair {
    const primary = getPrimaryWallet(db, userId, "solana");
    if (!primary) throw new Error("Create a Solana wallet before trading.");
    const wallet = loadSolanaKeypair(vault, db, userId, primary.label);
    if (!wallet) throw new Error("Couldn't unlock your primary Solana wallet.");
    return wallet;
  }

  function getEvmTradeWallet(userId: string): EvmWallet {
    const primary = getPrimaryWallet(db, userId, "evm");
    if (!primary) throw new Error("Create an EVM wallet before trading.");
    const wallet = loadEvmWalletByLabel(vault, db, userId, primary.label);
    if (!wallet) throw new Error("Couldn't unlock your primary EVM wallet.");
    return wallet;
  }

  async function createManualTradeQuote(
    userId: string,
    chain: "solana" | "evm",
    side: "buy" | "sell",
    values: ManualTradeDraft,
  ): Promise<{ id: string; quote: ManualTradeQuote }> {
    if (!values.amount) throw new Error("Trade amount is missing.");
    const amount = values.amount;
    const policy = evaluateTradePolicy(db, tradingLimits, {
      userId,
      chain,
      side,
      amount,
      source: "manual",
    });
    if (!policy.allowed)
      throw new Error(`Trade not allowed: ${policy.reasons.join(", ")}.`);

    let quote: ManualTradeQuote;
    if (chain === "solana") {
      const wallet = getSolanaTradeWallet(userId);
      const poolId = values.poolId;
      if (!poolId) throw new Error("Solana pool ID is missing.");
      let amountBaseUnits: bigint;
      let inputDecimals = 9;
      let asset = "";
      if (side === "buy") {
        if (!isPositiveDecimal(amount, 9))
          throw new Error(
            "Enter a valid SOL amount with up to 9 decimal places.",
          );
        amountBaseUnits = parseUnitsExact(amount, 9);
        const result = await quoteSolanaBuy({
          connection: solConnection,
          wallet,
          poolId,
          amountInLamports: amountBaseUnits,
          slippageBps: policy.maxSlippageBps,
        });
        asset = result.outputMint;
        quote = {
          userId,
          chain,
          side,
          asset,
          poolId,
          amount,
          amountBaseUnits,
          inputDecimals,
          outputMint: result.outputMint,
          expectedAmountOut: result.expectedAmountOut,
          minimumAmountOut: result.minimumAmountOut,
          outputDecimals: result.outputDecimals,
          slippageBps: policy.maxSlippageBps,
          requiresApproval: false,
          expiresAt: Date.now() + tradingLimits.tradeQuoteTtlSeconds * 1000,
        };
      } else {
        if (!values.asset) throw new Error("Solana token mint is missing.");
        const mint = new PublicKey(values.asset);
        asset = mint.toBase58();
        const [mintInfo, tokenAccounts] = await Promise.all([
          solConnection.getTokenSupply(mint),
          solConnection.getParsedTokenAccountsByOwner(wallet.publicKey, {
            mint,
          }),
        ]);
        inputDecimals = mintInfo.value.decimals;
        if (!isPositiveDecimal(amount, inputDecimals))
          throw new Error(
            `Enter a positive token amount with up to ${inputDecimals} decimal places.`,
          );
        amountBaseUnits = parseUnitsExact(amount, inputDecimals);
        const balance = tokenAccounts.value.reduce(
          (sum, account) =>
            sum + BigInt(account.account.data.parsed.info.tokenAmount.amount),
          0n,
        );
        if (amountBaseUnits > balance)
          throw new Error(
            `Insufficient token balance. Available: ${formatUnitsExact(balance, inputDecimals)}.`,
          );
        const result = await quoteSolanaSell({
          connection: solConnection,
          wallet,
          poolId,
          tokenMint: asset,
          amountInTokenBaseUnits: amountBaseUnits,
          slippageBps: policy.maxSlippageBps,
        });
        quote = {
          userId,
          chain,
          side,
          asset,
          poolId,
          amount,
          amountBaseUnits,
          inputDecimals,
          outputMint: result.outputMint,
          expectedAmountOut: result.expectedAmountOut,
          minimumAmountOut: result.minimumAmountOut,
          outputDecimals: result.outputDecimals,
          slippageBps: policy.maxSlippageBps,
          requiresApproval: false,
          expiresAt: Date.now() + tradingLimits.tradeQuoteTtlSeconds * 1000,
        };
      }
    } else {
      if (!values.asset || !isAddress(values.asset))
        throw new Error("Enter a valid EVM token address.");
      const asset = getAddress(values.asset);
      const wallet = getEvmTradeWallet(userId);
      if (side === "buy") {
        if (!isPositiveDecimal(amount, 18))
          throw new Error(
            "Enter a valid ETH amount with up to 18 decimal places.",
          );
        const amountBaseUnits = parseUnitsExact(amount, 18);
        const result = await quoteEvmBuy({
          provider: evmHttpProvider,
          tokenAddress: asset,
          amountInEth: amount,
          slippageBps: policy.maxSlippageBps,
        });
        quote = {
          userId,
          chain,
          side,
          asset,
          amount,
          amountBaseUnits,
          inputDecimals: 18,
          expectedAmountOut: result.expectedAmountOut,
          minimumAmountOut: result.minimumAmountOut,
          outputDecimals: result.outputDecimals,
          slippageBps: policy.maxSlippageBps,
          requiresApproval: false,
          expiresAt: Date.now() + tradingLimits.tradeQuoteTtlSeconds * 1000,
        };
      } else {
        const token = new Contract(
          asset,
          [
            "function decimals() view returns (uint8)",
            "function balanceOf(address) view returns (uint256)",
          ],
          evmHttpProvider,
        );
        const [decimals, balance] = await Promise.all([
          token.decimals() as Promise<bigint>,
          token.balanceOf(wallet.address) as Promise<bigint>,
        ]);
        const inputDecimals = Number(decimals);
        if (
          !Number.isInteger(inputDecimals) ||
          inputDecimals < 0 ||
          inputDecimals > 255 ||
          !isPositiveDecimal(amount, inputDecimals)
        ) {
          throw new Error(
            "Enter a positive token amount with a valid token precision.",
          );
        }
        const amountBaseUnits = parseUnitsExact(amount, inputDecimals);
        if (amountBaseUnits > balance)
          throw new Error(
            `Insufficient token balance. Available: ${formatUnits(balance, inputDecimals)}.`,
          );
        const result = await quoteEvmSell({
          provider: evmHttpProvider,
          wallet,
          tokenAddress: asset,
          amountInTokenBaseUnits: amountBaseUnits,
          slippageBps: policy.maxSlippageBps,
        });
        quote = {
          userId,
          chain,
          side,
          asset,
          amount,
          amountBaseUnits,
          inputDecimals,
          expectedAmountOut: result.expectedAmountOut,
          minimumAmountOut: result.minimumAmountOut,
          outputDecimals: result.outputDecimals,
          slippageBps: policy.maxSlippageBps,
          requiresApproval: result.requiresApproval,
          expiresAt: Date.now() + tradingLimits.tradeQuoteTtlSeconds * 1000,
        };
      }
    }

    for (const [id, existing] of manualTradeQuotes) {
      if (existing.expiresAt <= Date.now() || existing.userId === userId)
        manualTradeQuotes.delete(id);
    }
    const id = randomUUID();
    manualTradeQuotes.set(id, quote);
    return { id, quote };
  }

  function askOrderValue(
    ctx: any,
    pending: Extract<PendingInput, { kind: "order_value" }>,
  ) {
    pendingInputs.set(ctx.from!.id, pending);
    const prompts = {
      identifier: "Send the token mint (Solana) or token address (EVM).",
      poolRef: "Send the Solana pool ID.",
      triggerPrice: "Send the trigger price.",
      amount:
        pending.side === "buy"
          ? `Send the amount to spend in ${pending.chain === "solana" ? "SOL" : "ETH"}.`
          : "Send the token amount to sell.",
      decimals: "Send the token decimals (an integer from 0 to 255).",
      direction:
        "Choose whether the trigger is above or below the target price.",
    };
    return ctx.reply(prompts[pending.step], cancelPromptKeyboard);
  }

  async function showStartScreen(ctx: any) {
    const user = ctx.dbUser;
    return ctx.reply(
      startWelcome(ctx.from?.first_name ?? "", user?.status === "pending"),
      homeKeyboard(user?.role === "admin"),
    );
  }

  async function showPresales(
    ctx: any,
    adminView = false,
    offset = 0,
  ): Promise<void> {
    const pageSize = adminView ? 10 : 3;
    const listings = listPresaleListings(db, pageSize, offset);
    const total = countPresaleListings(db);
    if (listings.length === 0) {
      await ctx.reply(
        adminView
          ? `${tradingHeading("🔔", "Presale management")}\nNo listings yet.\n\nAdd one with:\n/admin_presale_add <solana|evm> <title> | <https://url> | <details>`
          : `${tradingHeading("🔔", "Presales")}\nNo curated listings are available right now.\n\nListings are informational only. Verify every project and link independently before interacting.`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              adminView ? "↩️ Admin" : "↩️ Home",
              adminView ? "home_admin" : "home",
            ),
          ],
        ]),
      );
      return;
    }
    const lines = [
      tradingHeading("🔔", adminView ? "Presale management" : "Presales"),
      `📄 Listings ${offset + 1}–${offset + listings.length} of ${total}`,
      adminView
        ? "Remove a listing with /admin_presale_remove <id>."
        : "Community listings · informational only · verify independently",
      "",
      ...listings.map((listing) =>
        adminView
          ? `${listing.id} · ${listing.chain.toUpperCase()} · ${listing.title}`
          : `🔹 ${listing.title} · ${listing.chain.toUpperCase()}\n${listing.details}\n${listing.url}`,
      ),
    ];
    if (!adminView) {
      lines.push(
        "",
        "⚠️ Maestro does not verify, endorse, or guarantee any listed project.",
      );
    }
    await ctx.reply(
      lines.join("\n"),
      Markup.inlineKeyboard([
        [
          ...(offset > 0
            ? [
                Markup.button.callback(
                  "⬅️ Previous",
                  `${adminView ? "admin" : "user"}_presales_page_${offset - pageSize}`,
                ),
              ]
            : []),
          ...(offset + pageSize < total
            ? [
                Markup.button.callback(
                  "➡️ Next",
                  `${adminView ? "admin" : "user"}_presales_page_${offset + pageSize}`,
                ),
              ]
            : []),
        ],
        [
          Markup.button.callback(
            adminView ? "↩️ Admin" : "↩️ Home",
            adminView ? "home_admin" : "home",
          ),
        ],
      ]),
    );
  }

  async function showReferrals(ctx: any): Promise<void> {
    let botInfo;
    try {
      botInfo = await ctx.telegram.getMe();
    } catch (error) {
      console.error("[referrals] couldn't retrieve the bot username:", error);
      await ctx.reply(
        "Couldn't create your invite link right now. Please try again later.",
      );
      return;
    }
    if (!botInfo.username) {
      await ctx.reply(
        "This bot has no public username, so referral links are unavailable.",
      );
      return;
    }
    const userId = String(ctx.from!.id);
    const inviteLink = `https://t.me/${botInfo.username}?start=ref_${userId}`;
    const referrals = countReferrals(db, userId);
    await ctx.reply(
      `${tradingHeading("🤝", "Referral program")}\nYour personal invite link:\n${inviteLink}\n\n👥 Referred signups: ${referrals}\n\nAttribution is recorded when a new user opens your link. This program currently tracks signups only; it does not pay rewards.`,
      Markup.inlineKeyboard([[Markup.button.callback("↩️ Home", "home")]]),
    );
  }

  async function showBridgeMenu(ctx: any): Promise<void> {
    await ctx.reply(
      `${tradingHeading("🌉", "Bridge quotes")}\nGet a live native-token route quote between Solana and your configured EVM network.\n\n🔒 Quote only: Maestro will not sign or submit a transfer.\n🔐 LI.FI receives your public wallet addresses to calculate a quote.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("◎ Solana → EVM", "bridge_solana_evm"),
          Markup.button.callback("Ξ EVM → Solana", "bridge_evm_solana"),
        ],
        [Markup.button.callback("↩️ Home", "home")],
      ]),
    );
  }

  async function beginBridgeQuote(
    ctx: any,
    fromChain: "solana" | "evm",
    toChain: "solana" | "evm",
  ): Promise<void> {
    if (fromChain === toChain) {
      await ctx.reply("Choose two different networks for a bridge quote.");
      return;
    }
    const userId = String(ctx.from!.id);
    const sourceWallet = getPrimaryWallet(db, userId, fromChain);
    const destinationWallet = getPrimaryWallet(db, userId, toChain);
    if (!sourceWallet || !destinationWallet) {
      await ctx.reply(
        `A primary ${fromChain === "solana" ? "Solana" : "EVM"} wallet and a primary ${toChain === "solana" ? "Solana" : "EVM"} wallet are required for a route quote.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("💼 Manage wallets", "home_wallets")],
          [Markup.button.callback("↩️ Home", "home")],
        ]),
      );
      return;
    }
    pendingInputs.set(ctx.from!.id, {
      kind: "bridge_amount",
      fromChain,
      toChain,
    });
    await ctx.reply(
      `Enter the amount of native ${fromChain === "solana" ? "SOL" : "ETH"} to quote.\n\nNo transfer will be signed or submitted. LI.FI receives both public wallet addresses.`,
      cancelPromptKeyboard,
    );
  }

  bot.start(showStartScreen);
  bot.help((ctx) => {
    const user = (ctx as any).dbUser;
    if (user?.status === "pending") return showStartScreen(ctx);
    return ctx.reply(
      HELP_TEXT + (user?.role === "admin" ? "\n" + ADMIN_HELP_TEXT : ""),
      homeKeyboard(user?.role === "admin"),
    );
  });

  bot.action("home", async (ctx) => {
    await ctx.answerCbQuery();
    const user = (ctx as any).dbUser;
    if (user?.status === "pending") return showStartScreen(ctx);
    await ctx.reply(
      startWelcome(ctx.from?.first_name ?? "", false),
      homeKeyboard(user?.role === "admin"),
    );
  });

  bot.action("home_chains", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "Choose a chain to manage its wallets. You can also buy or sell on either supported chain.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("◎ Solana wallets", "wchain_solana"),
          Markup.button.callback("Ξ EVM wallets", "wchain_evm"),
        ],
        [Markup.button.callback("⚡ Buy & sell", "home_trade")],
        [Markup.button.callback("↩️ Home", "home")],
      ]),
    );
  });

  bot.command("presales", (ctx) => showPresales(ctx));
  bot.action("home_presales", async (ctx) => {
    await ctx.answerCbQuery();
    await showPresales(ctx);
  });
  bot.action(/^user_presales_page_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showPresales(ctx, false, Number(ctx.match[1]));
  });

  bot.command("referrals", (ctx) => showReferrals(ctx));
  bot.action("home_referrals", async (ctx) => {
    await ctx.answerCbQuery();
    await showReferrals(ctx);
  });

  bot.command("bridge", (ctx) => showBridgeMenu(ctx));
  bot.action("home_bridge", async (ctx) => {
    await ctx.answerCbQuery();
    await showBridgeMenu(ctx);
  });
  bot.action(/^bridge_(solana|evm)_(solana|evm)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await beginBridgeQuote(
      ctx,
      ctx.match[1] as "solana" | "evm",
      ctx.match[2] as "solana" | "evm",
    );
  });

  bot.action("home_wallets", async (ctx) => {
    await ctx.answerCbQuery();
    if ((ctx as any).dbUser?.status === "pending") {
      return ctx.reply(
        "Import a wallet to request admin approval. Other wallet and trading features not implemented yet.",
        onboardingKeyboard(),
      );
    }
    await ctx.reply("Wallets", walletsMenu);
  });

  bot.action("home_trade", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "Choose a manual trade. Every trade requires a fresh quote and your explicit confirmation.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🟢 Buy", "trade_start_buy"),
          Markup.button.callback("🔴 Sell", "trade_start_sell"),
        ],
        [Markup.button.callback("↩️ Home", "home")],
      ]),
    );
  });

  bot.action("home_trades", async (ctx) => {
    await ctx.answerCbQuery();
    const trades = listRecentTradesForUser(db, String(ctx.from!.id), 10);
    const jobs = listRecentTradeJobsForUser(db, String(ctx.from!.id), 10);
    const lifecycleText = trades.map((trade) => {
      const date = new Date(trade.created_at)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      const ref = trade.transaction_ref ?? trade.approval_transaction_ref;
      const error = trade.error ? `\n  Note: ${trade.error}` : "";
      return (
        `${tradingSide(trade.side)} ${trade.amount} · ${trade.chain.toUpperCase()} · ${trade.source}\n${tradingStatus(trade.status)} · ${date}` +
        `${ref ? `\n  Tx: ${ref}` : ""}${trade.bundle_ref ? `\n  Bundle: ${trade.bundle_ref}` : ""}${error}`
      );
    });
    const jobText = jobs
      .filter(
        (job) =>
          !job.lifecycle_id ||
          !trades.some((trade) => trade.id === job.lifecycle_id),
      )
      .map((job) => {
        const date = new Date(job.created_at)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
        const error = job.last_error ? `\n  Note: ${job.last_error}` : "";
        return `${tradingSide(job.side)} ${job.amount} · ${job.chain.toUpperCase()} · ${job.source}\n${tradingStatus(job.status)} · ${date} · ${job.attempts}/${job.max_attempts}${error}`;
      });
    const text =
      [...jobText, ...lifecycleText].length === 0
        ? "No tracked trades yet."
        : [...jobText, ...lifecycleText].join("\n\n");
    await ctx.reply(
      `${tradingHeading("📈", "Recent trades")}\n${text}\n\n${tradingSide("buy")} · ${tradingSide("sell")}\nUnknown means the RPC did not provide a final status in time; reconciliation continues.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔄 Refresh", "home_trades"),
          Markup.button.callback("🔄 Trade", "home_trade"),
        ],
        [Markup.button.callback("↩️ Home", "home")],
      ]),
    );
  });

  bot.action(/^trade_start_(buy|sell)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const side = ctx.match[1] as "buy" | "sell";
    await ctx.reply(
      `Choose the chain for your manual ${side}.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Solana", `trade_chain_${side}_solana`),
          Markup.button.callback("EVM", `trade_chain_${side}_evm`),
        ],
        [Markup.button.callback("Cancel", "flow_cancel")],
      ]),
    );
  });

  bot.action(/^trade_chain_(buy|sell)_(solana|evm)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const side = ctx.match[1] as "buy" | "sell";
    const chain = ctx.match[2] as "solana" | "evm";
    const step: Extract<PendingInput, { kind: "manual_trade" }>["step"] =
      chain === "evm" || side === "sell" ? "asset" : "pool";
    const pending = {
      kind: "manual_trade" as const,
      side,
      chain,
      step,
      values: {},
    };
    pendingInputs.set(ctx.from!.id, pending);
    const prompt =
      step === "asset"
        ? chain === "solana"
          ? "Send the Solana token mint to sell."
          : "Send the EVM token contract address."
        : "Send the Raydium SOL/token pool ID.";
    await ctx.reply(prompt, cancelPromptKeyboard);
  });

  bot.action(/^trade_confirm_([0-9a-f-]+)$/, async (ctx) => {
    const id = ctx.match[1];
    const quote = manualTradeQuotes.get(id);
    if (!quote || quote.userId !== String(ctx.from!.id)) {
      return ctx.answerCbQuery(
        "This quote is unavailable or belongs to another user.",
      );
    }
    manualTradeQuotes.delete(id);
    await ctx.answerCbQuery();
    if (quote.expiresAt <= Date.now()) {
      return ctx.reply(
        "This quote expired. Request a new quote before trading.",
      );
    }

    const decision = evaluateTradePolicy(db, tradingLimits, {
      userId: quote.userId,
      chain: quote.chain,
      side: quote.side,
      amount: quote.amount,
      source: "manual",
    });
    if (!decision.allowed) {
      return ctx.reply(
        `Trade not allowed: ${decision.reasons.join(", ")}. Request a new quote after resolving this.`,
      );
    }
    if (quote.slippageBps > decision.maxSlippageBps) {
      return ctx.reply(
        "Your slippage ceiling changed after this quote. Request a fresh quote before trading.",
      );
    }

    let lifecycle: ReturnType<typeof beginTrackedTrade> | undefined;
    try {
      lifecycle = beginTrackedTrade(db, {
        userId: quote.userId,
        chain: quote.chain,
        walletAddress: quote.chain === "solana"
          ? getSolanaTradeWallet(quote.userId).publicKey.toBase58()
          : getEvmTradeWallet(quote.userId).address,
        side: quote.side,
        source: "manual",
        asset: quote.asset,
        amount: quote.amount,
      });
      const assertCurrentBuyPolicy = () => {
        const latest = evaluateTradePolicy(db, tradingLimits, {
          userId: quote.userId,
          chain: quote.chain,
          side: "buy",
          amount: quote.amount,
          source: "manual",
          excludeLifecycleId: lifecycle!.id,
        });
        if (!latest.allowed)
          throw new Error(
            `Risk policy changed before submission: ${latest.reasons.join(", ")}.`,
          );
        if (latest.maxSlippageBps < quote.slippageBps) {
          throw new Error(
            "Slippage ceiling changed before submission; request a fresh quote.",
          );
        }
        assertBuyEntryEnabled(db, quote.userId, quote.chain, "manual");
      };
      const assertCurrentSellSlippage = () => {
        const latest = evaluateTradePolicy(db, tradingLimits, {
          userId: quote.userId,
          chain: quote.chain,
          side: "sell",
          amount: quote.amount,
          source: "manual",
        });
        if (latest.maxSlippageBps < quote.slippageBps) {
          throw new Error(
            "Slippage ceiling changed before submission; request a fresh quote.",
          );
        }
      };
      let submissionId: string;
      if (quote.chain === "solana") {
        const wallet = getSolanaTradeWallet(quote.userId);
        const poolId = quote.poolId!;
        submissionId =
          quote.side === "buy"
            ? await executeSolanaBuy({
                connection: solConnection,
                wallet,
                poolId,
                amountInLamports: quote.amountBaseUnits,
                slippageBps: quote.slippageBps,
                approvedMinimumOut: quote.minimumAmountOut,
                assertCanSubmit: assertCurrentBuyPolicy,
                onLifecycleEvent: lifecycle.observe,
              })
            : await executeSolanaSell({
                connection: solConnection,
                wallet,
                poolId,
                amountInTokenBaseUnits: quote.amountBaseUnits,
                slippageBps: quote.slippageBps,
                assertCanSubmit: assertCurrentSellSlippage,
                approvedMinimumOut: quote.minimumAmountOut,
                onLifecycleEvent: lifecycle.observe,
              });
      } else {
        const wallet = getEvmTradeWallet(quote.userId);
        submissionId =
          quote.side === "buy"
            ? await executeEvmBuy({
                provider: evmHttpProvider,
                wallet,
                tokenAddress: quote.asset,
                amountInEth: quote.amount,
                slippageBps: quote.slippageBps,
                approvedMinimumOut: quote.minimumAmountOut,
                assertCanSubmit: assertCurrentBuyPolicy,
                onLifecycleEvent: lifecycle.observe,
              })
            : await executeEvmSell({
                provider: evmHttpProvider,
                wallet,
                tokenAddress: quote.asset,
                amountInTokenBaseUnits: quote.amountBaseUnits,
                slippageBps: quote.slippageBps,
                assertCanSubmit: assertCurrentSellSlippage,
                approvedMinimumOut: quote.minimumAmountOut,
                confirmedRequiresApproval: quote.requiresApproval,
                onLifecycleEvent: lifecycle.observe,
              });
        if (quote.side === "buy")
          recordHolding(db, "evm", quote.userId, quote.asset);
      }
      recordSecurityEvent(db, {
        eventType: "MANUAL_TRADE_SUBMITTED",
        actorUserId: quote.userId,
        subjectUserId: quote.userId,
        chain: quote.chain,
        side: quote.side,
        amount: quote.amount,
        source: "manual",
        details: {
          asset: quote.asset,
          poolId: quote.poolId ?? null,
          submissionId,
        },
      });
      await ctx.reply(
        `${tradingHeading("🟡", "Trade submitted")}\nTracking ID: ${lifecycle.id}\nTransaction: ${submissionId}`,
      );
    } catch (err) {
      lifecycle?.failIfNotSubmitted(err);
      console.error(
        `[trade] confirmed ${quote.chain} ${quote.side} failed for user ${quote.userId}:`,
        err,
      );
      if (lifecycle?.wasSubmitted) {
        await ctx.reply(
          `Submission status is not yet known (${err instanceof Error ? err.message : "network error"}). Check Recent trades before retrying to avoid a duplicate trade.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("🧾 Recent trades", "home_trades")],
          ]),
        );
      } else {
        await ctx.reply(
          `Trade was not submitted: ${err instanceof Error ? err.message : "unknown error"}. Request a fresh quote to try again.`,
        );
      }
    }
  });

  bot.action(/^trade_cancel_([0-9a-f-]+)$/, async (ctx) => {
    const id = ctx.match[1];
    const quote = manualTradeQuotes.get(id);
    if (quote?.userId === String(ctx.from!.id)) manualTradeQuotes.delete(id);
    await ctx.answerCbQuery("Quote cancelled.");
    await ctx.reply(
      "Quote cancelled.",
      homeKeyboard((ctx as any).dbUser?.role === "admin"),
    );
  });

  bot.action("home_help", async (ctx) => {
    await ctx.answerCbQuery();
    const user = (ctx as any).dbUser;
    await ctx.reply(
      HELP_TEXT + (user?.role === "admin" ? "\n" + ADMIN_HELP_TEXT : ""),
      homeKeyboard(user?.role === "admin"),
    );
  });

  async function showPremium(ctx: any): Promise<void> {
    const userId = String(ctx.from!.id);
    const access = getPremiumAccess(db, userId);
    const price = getPremiumStarsPrice(db);
    const status = access
      ? `✅ PREMIUM ACTIVE until ${new Date(access.active_until).toLocaleDateString("en-GB")}`
      : "⚪ FREE PLAN";
    const rows = [];
    if (!access) rows.push([Markup.button.callback(`⭐ Subscribe · ${price} Stars/month`, "premium_stars_buy")]);
    if (access) {
      rows.push([Markup.button.callback("📈 Realized P&L", "premium_report")]);
      rows.push([Markup.button.callback("🔔 Price alerts", "premium_alerts")]);
    }
    rows.push([Markup.button.callback("✉️ Request admin subscription", "premium_request")]);
    rows.push([Markup.button.callback("↩️ Home", "home")]);
    await ctx.reply(
      `${tradingHeading("⭐", "Premium")}\n${status}\n\nPremium includes priority auto-buy queueing, realized P&L for confirmed Maestro trades, and proactive price alerts. Existing trading controls stay free.\n\nTelegram Stars billing renews monthly. An admin can also approve a request or grant/revoke access directly.${access ? "\n\nCreate an alert:\n/premium_alert <solana|evm> <token> <pool_id|-> <above|below> <price>\nFor Solana, provide the Raydium pool ID; for EVM use -." : ""}`,
      Markup.inlineKeyboard(rows),
    );
  }

  async function sendPremiumReport(ctx: any): Promise<void> {
    const userId = String(ctx.from!.id);
    if (!isPremiumActive(db, userId)) return ctx.reply("Premium is required for realized P&L reports. Use /premium to subscribe.");
    const reports = getRealizedPnl(db, userId);
    if (reports.length === 0) {
      return ctx.reply(
        `${tradingHeading("📈", "Realized P&L")}\nNo confirmed trades have been captured since P&L tracking began.`,
      );
    }
    const lines = [
      tradingHeading("📈", "Realized P&L"),
      "FIFO cost basis · confirmed Maestro trades only",
      "Network fees excluded. Trades before tracking launched are not backfilled.",
      "",
      ...reports.map((report) =>
        `${report.chain.toUpperCase()}: ${formatNativeAmount(report.realizedUnits, report.nativeDecimals)} ${report.nativeSymbol} · ${report.matchedSells} matched sells · ${report.confirmedFills} fills${report.unmatchedSells ? ` · ${report.unmatchedSells} unmatched sells excluded` : ""}`,
      ),
    ];
    await ctx.reply(lines.join("\n"));
  }

  bot.command("premium_report", (ctx) => sendPremiumReport(ctx));
  bot.action("premium_report", async (ctx) => {
    await ctx.answerCbQuery();
    await sendPremiumReport(ctx);
  });

  bot.command("premium_alert", async (ctx) => {
    const userId = String(ctx.from!.id);
    if (!isPremiumActive(db, userId)) return ctx.reply("Premium is required for price alerts. Use /premium to subscribe.");
    const [, chain, rawIdentifier, rawPool, direction, rawPrice] = ctx.message.text.trim().split(/\s+/);
    const price = Number(rawPrice);
    if (
      (chain !== "solana" && chain !== "evm") ||
      !rawIdentifier ||
      !rawPool ||
      (direction !== "above" && direction !== "below") ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return ctx.reply(
        "Usage: /premium_alert <solana|evm> <token> <pool_id|-> <above|below> <price>\nSolana requires a Raydium pool ID; EVM uses -.",
      );
    }
    let identifier = rawIdentifier;
    let poolRef: string | null = null;
    if (chain === "solana") {
      try {
        identifier = new PublicKey(rawIdentifier).toBase58();
        if (!rawPool || rawPool === "-") throw new Error("A Raydium pool ID is required.");
        poolRef = new PublicKey(rawPool).toBase58();
      } catch (err) {
        return ctx.reply(`Invalid Solana mint or pool ID: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      if (!isAddress(rawIdentifier)) return ctx.reply("Enter a valid EVM token contract address.");
      if (rawPool !== "-") return ctx.reply("Use - for the EVM pool ID; the configured WETH pair is used.");
      identifier = getAddress(rawIdentifier);
    }
    const id = randomUUID();
    try {
      createPremiumPriceAlert(db, {
        id,
        user_id: userId,
        chain,
        identifier,
        pool_ref: poolRef,
        direction,
        target_price: price,
      });
      await ctx.reply(
        `${tradingHeading("🔔", "Premium alert created")}\n${chain.toUpperCase()} ${identifier}\nNotify when price is ${direction} ${price}\nAlert ID: ${id.slice(0, 8)}`,
      );
    } catch (err) {
      await ctx.reply(`Couldn't create alert: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  async function sendPremiumAlerts(ctx: any): Promise<void> {
    const userId = String(ctx.from!.id);
    if (!isPremiumActive(db, userId)) return ctx.reply("Premium is required for price alerts. Use /premium to subscribe.");
    const alerts = listPremiumPriceAlerts(db, userId);
    if (alerts.length === 0) {
      return ctx.reply(
        `${tradingHeading("🔔", "Price alerts")}\nNo active alerts.\n\nUse /premium for instructions to create one.`,
      );
    }
    await ctx.reply(
      `${tradingHeading("🔔", "Price alerts")}\n${alerts.map((alert) =>
        `${alert.id.slice(0, 8)} · ${alert.chain.toUpperCase()} ${alert.identifier.slice(0, 12)} · ${alert.direction} ${alert.target_price}`,
      ).join("\n")}\n\nCancel with /premium_alert_cancel <alert_id>`,
    );
  }
  bot.command("premium_alerts", (ctx) => sendPremiumAlerts(ctx));
  bot.action("premium_alerts", async (ctx) => {
    await ctx.answerCbQuery();
    await sendPremiumAlerts(ctx);
  });
  bot.action("home_signals", async (ctx) => {
    await ctx.answerCbQuery();
    await sendPremiumAlerts(ctx);
  });

  bot.command("premium_alert_cancel", async (ctx) => {
    const [, id] = ctx.message.text.trim().split(/\s+/);
    if (!id) return ctx.reply("Usage: /premium_alert_cancel <alert_id>");
    const userId = String(ctx.from!.id);
    if (!cancelPremiumPriceAlert(db, userId, id)) return ctx.reply("No active alert found with that ID.");
    return ctx.reply(`Cancelled price alert ${id.slice(0, 8)}.`);
  });

  bot.command("premium", (ctx) => showPremium(ctx));
  bot.action("home_premium", async (ctx) => {
    await ctx.answerCbQuery();
    await showPremium(ctx);
  });

  bot.action("premium_stars_buy", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from!.id);
    const starsPrice = getPremiumStarsPrice(db);
    const payload = `premium:${userId}:${randomUUID()}`;
    createPremiumInvoiceSession(db, payload, userId, starsPrice);
    const invoice = {
      title: "Maestro Premium",
      description: "One month of Maestro Premium features.",
      payload,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: "Premium · 1 month", amount: starsPrice }],
      start_parameter: `premium-${randomUUID()}`,
    };
    const subscriptionOptions = { subscription_period: 2_592_000 };
    try {
      // The installed Telegraf types predate Telegram's Stars subscription_period field.
      await ctx.telegram.sendInvoice(ctx.chat!.id, invoice, subscriptionOptions as never);
    } catch (err) {
      console.error(`[premium] invoice creation failed for ${userId}:`, err);
      await ctx.reply("Couldn't create the Stars subscription invoice. Please try again later.");
    }
  });

  bot.on("pre_checkout_query", async (ctx) => {
    const query = ctx.preCheckoutQuery;
    const valid =
      query.currency === "XTR" &&
      validatePremiumInvoice(db, query.invoice_payload, String(query.from.id), query.total_amount);
    await ctx.answerPreCheckoutQuery(
      valid,
      valid ? undefined : "This premium invoice is invalid or has expired. Please request a new one.",
    );
  });

  bot.on("successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment as typeof ctx.message.successful_payment & {
      subscription_expiration_date?: number;
    };
    const userId = String(ctx.from!.id);
    if (
      payment.currency !== "XTR" ||
      !validatePremiumInvoice(db, payment.invoice_payload, userId, payment.total_amount)
    ) {
      console.error(`[premium] rejected unexpected payment update for user ${userId}`);
      await ctx.reply("Payment received but couldn't be matched to a valid premium invoice. Contact an admin.");
      return;
    }

    const currentUntil = getPremiumAccess(db, userId)?.active_until ?? Date.now();
    const activeUntil = payment.subscription_expiration_date
      ? payment.subscription_expiration_date * 1000
      : Math.max(currentUntil, Date.now()) + 30 * 24 * 60 * 60 * 1000;
    const recorded = recordPremiumStarsPayment(db, {
      payload: payment.invoice_payload,
      chargeId: payment.telegram_payment_charge_id,
      userId,
      starsAmount: payment.total_amount,
      activeUntil,
    });
    if (!recorded) {
      console.warn(`[premium] duplicate or unrecognized Stars charge ${payment.telegram_payment_charge_id}`);
      return;
    }
    await ctx.reply(
      `⭐ Premium activated until ${new Date(activeUntil).toLocaleDateString("en-GB")}. Thanks for subscribing!`,
    );
  });

  bot.action("premium_request", async (ctx) => {
    await ctx.answerCbQuery();
    if (!adminBootstrapId) return ctx.reply("Admin subscriptions are unavailable right now.");
    const userId = String(ctx.from!.id);
    if (isPremiumActive(db, userId)) return ctx.reply("Your premium access is already active.");
    const result = requestPremiumAccess(db, userId);
    if (result === "already_pending") return ctx.reply("Your premium request is already awaiting admin review.");
    try {
      await bot.telegram.sendMessage(
        adminBootstrapId,
        `Premium access request\nUser: ${userId}${ctx.from!.username ? ` (@${ctx.from!.username})` : ""}`,
        Markup.inlineKeyboard([[
          Markup.button.callback("✅ Approve 30 days", `premium_approve_${userId}`),
          Markup.button.callback("Reject", `premium_reject_${userId}`),
        ]]),
      );
      await ctx.reply("Your request was sent to an admin for approval.");
    } catch (err) {
      console.error(`[premium] couldn't send request for ${userId} to admin:`, err);
      await ctx.reply("Couldn't notify an admin right now. Please try again later.");
    }
  });

  bot.action(/^premium_(approve|reject)_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const [, decision, userId] = ctx.match as unknown as [string, "approve" | "reject", string];
    const approved = decision === "approve";
    if (!reviewPremiumRequest(db, userId, approved, String(ctx.from!.id))) {
      return ctx.reply("That premium request is no longer pending.");
    }
    await ctx.reply(approved ? `Premium approved for ${userId} for 30 days.` : `Premium request rejected for ${userId}.`);
    try {
      await bot.telegram.sendMessage(
        userId,
        approved ? "Your premium request was approved for 30 days." : "Your premium request was declined.",
      );
    } catch (err) {
      console.error(`[premium] couldn't notify user ${userId} of request review:`, err);
    }
  });

  async function showAutoSnipeConfig(
    ctx: any,
    chain: "solana" | "evm",
  ): Promise<void> {
    const config = getAutoSnipeConfig(db, String(ctx.from!.id), chain);
    const chainLabel = chain === "solana" ? "Solana" : "EVM";
    const rows = [
      [
        Markup.button.callback(
          `Set slippage (${config.slippage_bps} bps)`,
          `home_snipe_config_slippage_${chain}`,
        ),
      ],
      [
        Markup.button.callback(
          `Anti-MEV: ${config.anti_mev_enabled ? "ON" : "OFF"}`,
          `home_snipe_config_mev_${chain}`,
        ),
      ],
    ];
    if (chain === "solana") {
      rows.push([
        Markup.button.callback(
          "Set Jito tip",
          "home_snipe_config_tip_solana",
        ),
      ]);
    }
    rows.push([Markup.button.callback("↩️ Auto Snipe", "home_snipe")]);
    await ctx.reply(
      `${tradingHeading("⚙️", `${chainLabel} Auto Snipe Defaults`)}\nThese defaults apply to new and active snipes on ${chainLabel}. The effective slippage never exceeds your trading-policy ceiling.\n\nSlippage: ${config.slippage_bps} bps\nAnti-MEV: ${config.anti_mev_enabled ? "ON" : "OFF"}${chain === "solana" ? `\nJito bundle tip: ${formatUnitsExact(BigInt(config.tip_lamports), 9)} SOL` : ""}`,
      Markup.inlineKeyboard(rows),
    );
  }

  async function showSnipeSettings(ctx: any) {
    const user = getUser(db, String(ctx.from!.id))!;
    const autoSnipes = listAutoSnipesForUser(db, String(ctx.from!.id));
    const snipesSummary = autoSnipes.length
      ? autoSnipes
          .map(
            (snipe, index) =>
              `${index + 1}. ${snipe.chain === "solana" ? "SOL" : "EVM"} · ${snipe.asset}\n   Buy: ${snipe.amount_exact} ${snipe.chain === "solana" ? "SOL" : "ETH"} · ${snipe.enabled ? "ACTIVE" : "PAUSED"}`,
          )
          .join("\n")
      : "No token snipes configured.";
    const keyboard = [
      [Markup.button.callback("➕ Add token snipe", "home_snipe_add")],
      ...autoSnipes.map((snipe, index) => [
        Markup.button.callback(
          `${snipe.enabled ? "⏸ Pause" : "▶️ Activate"} #${index + 1}`,
          `home_snipe_toggle_${snipe.id}`,
        ),
        Markup.button.callback("🗑 Remove", `home_snipe_remove_${snipe.id}`),
      ]),
      [
        Markup.button.callback("✅ Global buy on", "home_snipe_enable"),
        Markup.button.callback("⏸ Global buy off", "home_snipe_disable"),
      ],
      [
        Markup.button.callback("Set SOL size", "home_snipe_size_solana"),
        Markup.button.callback("Set ETH size", "home_snipe_size_evm"),
      ],
      [
        Markup.button.callback("⚙️ SOL defaults", "home_snipe_config_solana"),
        Markup.button.callback("⚙️ EVM defaults", "home_snipe_config_evm"),
      ],
      [
        Markup.button.callback("⚙️ Trading limits", "home_risk_settings"),
        Markup.button.callback("↩️ Home", "home"),
      ],
    ];
    await ctx.reply(
      `${tradingHeading("🎯", "Auto Snipe")}\nAdd a token address and buy amount to activate a snipe for that launch. Only active token entries are matched against detected Raydium pools and configured EVM pairs. A safety check and your trading limits still apply before a buy is queued.\n\n${snipesSummary}\n\nGlobal auto-buy: ${user.snipe_enabled ? "ON" : "OFF"} (buys qualifying launches beyond your saved token list).\nDefault sizes: ${user.snipe_size_sol_exact} SOL / ${user.snipe_size_eth_exact} ETH.\nPer-buy limits: ${user.max_trade_sol_exact} SOL / ${user.max_trade_eth_exact} ETH (admin hard caps: ${tradingLimits.maxTradeSol} SOL / ${tradingLimits.maxTradeEth} ETH).`,
      Markup.inlineKeyboard(keyboard),
    );
  }

  async function showRiskSettings(ctx: any) {
    const user = getUser(db, String(ctx.from!.id))!;
    const solBuyCap =
      parseUnitsExact(user.max_trade_sol_exact, 9) <
      parseUnitsExact(tradingLimits.maxTradeSol, 9)
        ? user.max_trade_sol_exact
        : tradingLimits.maxTradeSol;
    const ethBuyCap =
      parseUnitsExact(user.max_trade_eth_exact, 18) <
      parseUnitsExact(tradingLimits.maxTradeEth, 18)
        ? user.max_trade_eth_exact
        : tradingLimits.maxTradeEth;
    const solDailyCap =
      parseUnitsExact(user.max_daily_spend_sol_exact, 9) <
      parseUnitsExact(tradingLimits.maxDailySpendSol, 9)
        ? user.max_daily_spend_sol_exact
        : tradingLimits.maxDailySpendSol;
    const ethDailyCap =
      parseUnitsExact(user.max_daily_spend_eth_exact, 18) <
      parseUnitsExact(tradingLimits.maxDailySpendEth, 18)
        ? user.max_daily_spend_eth_exact
        : tradingLimits.maxDailySpendEth;
    await ctx.reply(
      `TRADING SETTINGS\n\nEffective per-buy cap: ${solBuyCap} SOL / ${ethBuyCap} ETH (admin hard maximum ${tradingLimits.maxTradeSol} SOL / ${tradingLimits.maxTradeEth} ETH).\nEffective daily buy budget (UTC): ${solDailyCap} SOL / ${ethDailyCap} ETH (admin hard maximum ${tradingLimits.maxDailySpendSol} SOL / ${tradingLimits.maxDailySpendEth} ETH).\nSlippage ceiling: ${Math.min(user.max_slippage_bps, tradingLimits.maxSlippageBps)} bps (admin hard maximum ${tradingLimits.maxSlippageBps} bps).\nBuy cooldown: ${user.cooldown_seconds} seconds.\n\nThese limits apply to manual buys, auto-buy, copy-trading, and buy limit orders. Sell orders remain available. Auto-buy sizes and copy-trading options are configured in their own menus.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "Set SOL buy cap",
            "risk_edit_max_trade_sol_exact",
          ),
          Markup.button.callback(
            "Set ETH buy cap",
            "risk_edit_max_trade_eth_exact",
          ),
        ],
        [
          Markup.button.callback(
            "Set SOL daily budget",
            "risk_edit_max_daily_spend_sol_exact",
          ),
          Markup.button.callback(
            "Set ETH daily budget",
            "risk_edit_max_daily_spend_eth_exact",
          ),
        ],
        [
          Markup.button.callback("Set slippage", "risk_edit_max_slippage_bps"),
          Markup.button.callback("Set cooldown", "risk_edit_cooldown_seconds"),
        ],
        [
          Markup.button.callback("🎯 Auto-buy settings", "home_snipe"),
          Markup.button.callback("🔁 Copy settings", "home_copytrade"),
        ],
        [Markup.button.callback("↩️ Home", "home")],
      ]),
    );
  }

  bot.action("home_risk_settings", async (ctx) => {
    await ctx.answerCbQuery();
    await showRiskSettings(ctx);
  });

  bot.action(
    /^risk_edit_(max_trade_sol_exact|max_trade_eth_exact|max_daily_spend_sol_exact|max_daily_spend_eth_exact|max_slippage_bps|cooldown_seconds)$/,
    async (ctx) => {
      await ctx.answerCbQuery();
      const field = ctx.match[1] as Extract<
        PendingInput,
        { kind: "risk_setting" }
      >["field"];
      pendingInputs.set(ctx.from!.id, { kind: "risk_setting", field });
      const prompts: Record<typeof field, string> = {
        max_trade_sol_exact: `Send your maximum SOL per buy (greater than 0; admin maximum ${tradingLimits.maxTradeSol}).`,
        max_trade_eth_exact: `Send your maximum ETH per buy (greater than 0; admin maximum ${tradingLimits.maxTradeEth}).`,
        max_daily_spend_sol_exact: `Send your SOL daily buy budget in UTC (0 to the admin maximum ${tradingLimits.maxDailySpendSol}; 0 disables buys).`,
        max_daily_spend_eth_exact: `Send your ETH daily buy budget in UTC (0 to the admin maximum ${tradingLimits.maxDailySpendEth}; 0 disables buys).`,
        max_slippage_bps: `Send your maximum slippage in basis points (1–${tradingLimits.maxSlippageBps}).`,
        cooldown_seconds: "Send your buy cooldown in whole seconds (0–3600).",
      };
      await ctx.reply(prompts[field], cancelPromptKeyboard);
    },
  );

  bot.action("home_snipe", async (ctx) => {
    await ctx.answerCbQuery();
    await showSnipeSettings(ctx);
  });

  bot.action(/^home_snipe_config_(solana|evm)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showAutoSnipeConfig(ctx, ctx.match[1] as "solana" | "evm");
  });

  bot.action(/^home_snipe_config_slippage_(solana|evm)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const chain = ctx.match[1] as "solana" | "evm";
    pendingInputs.set(ctx.from!.id, {
      kind: "auto_snipe_config",
      chain,
      field: "slippage",
    });
    await ctx.reply(
      `Send slippage in basis points (1–${Math.min(getUser(db, String(ctx.from!.id))!.max_slippage_bps, tradingLimits.maxSlippageBps)}).`,
      cancelPromptKeyboard,
    );
  });

  bot.action(/^home_snipe_config_tip_solana$/, async (ctx) => {
    await ctx.answerCbQuery();
    pendingInputs.set(ctx.from!.id, {
      kind: "auto_snipe_config",
      chain: "solana",
      field: "tip",
    });
    await ctx.reply(
      "Send the Jito bundle tip in SOL (0.000001–0.1). This is an additional mainnet payment when the bundle is submitted.",
      cancelPromptKeyboard,
    );
  });

  bot.action(/^home_snipe_config_mev_(solana|evm)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const chain = ctx.match[1] as "solana" | "evm";
    const userId = String(ctx.from!.id);
    const current = getAutoSnipeConfig(db, userId, chain);
    updateAutoSnipeConfig(db, userId, chain, {
      anti_mev_enabled: current.anti_mev_enabled ? 0 : 1,
    });
    await showAutoSnipeConfig(ctx, chain);
  });

  bot.action("home_snipe_add", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      "Choose the network for this token snipe. A primary wallet is required on that network.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Solana", "home_snipe_add_solana"),
          Markup.button.callback("EVM", "home_snipe_add_evm"),
        ],
        [Markup.button.callback("↩️ Auto Snipe", "home_snipe")],
      ]),
    );
  });

  bot.action(/^home_snipe_add_(solana|evm)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const chain = ctx.match[1] as "solana" | "evm";
    const userId = String(ctx.from!.id);
    if (!getPrimaryWallet(db, userId, chain)) {
      await ctx.reply(
        `Add a primary ${chain === "solana" ? "Solana" : "EVM"} wallet before creating a token snipe.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("💼 Manage wallets", "home_wallets")],
          [Markup.button.callback("↩️ Auto Snipe", "home_snipe")],
        ]),
      );
      return;
    }
    pendingInputs.set(ctx.from!.id, { kind: "auto_snipe", chain, step: "asset" });
    await ctx.reply(
      `Send the ${chain === "solana" ? "Solana mint" : "EVM token contract address"} to watch.`,
      cancelPromptKeyboard,
    );
  });

  bot.action(/^home_snipe_toggle_([0-9a-f-]{36})$/i, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from!.id);
    const snipe = listAutoSnipesForUser(db, userId).find(
      (item) => item.id === ctx.match[1],
    );
    if (!snipe) {
      await ctx.reply("That token snipe is no longer available.");
      return;
    }
    setAutoSnipeEnabled(db, userId, snipe.id, !snipe.enabled);
    await showSnipeSettings(ctx);
  });

  bot.action(/^home_snipe_remove_([0-9a-f-]{36})$/i, async (ctx) => {
    await ctx.answerCbQuery();
    removeAutoSnipe(db, String(ctx.from!.id), ctx.match[1]);
    await showSnipeSettings(ctx);
  });

  bot.action("home_snipe_enable", async (ctx) => {
    await ctx.answerCbQuery();
    updateUserSettings(db, String(ctx.from!.id), { snipe_enabled: 1 });
    await showSnipeSettings(ctx);
  });

  bot.action("home_snipe_disable", async (ctx) => {
    await ctx.answerCbQuery();
    updateUserSettings(db, String(ctx.from!.id), { snipe_enabled: 0 });
    await showSnipeSettings(ctx);
  });

  bot.action(/^home_snipe_size_(solana|evm)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const chain = ctx.match[1] as "solana" | "evm";
    pendingInputs.set(ctx.from!.id, { kind: "snipe_size", chain });
    await ctx.reply(
      `Send the new ${chain === "solana" ? "SOL" : "ETH"} auto-buy size.`,
      cancelPromptKeyboard,
    );
  });

  bot.action("home_copytrade", async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUser(db, String(ctx.from!.id))!;
    const target = user.copy_target;
    await ctx.reply(
      `COPY TRADING · ${target ? "ON" : "OFF"}${target ? `\n\nFollowing: ${target}` : "\n\nNo wallet is being followed."}\n\nSizing: ${user.copy_size_ratio_exact} ratio, max ${user.copy_max_amount_exact}, copy sells ${user.copy_sells ? "on" : "off"}.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            target ? "Change target wallet" : "Set target wallet",
            "home_copytrade_set",
          ),
        ],
        [Markup.button.callback("Configure sizing", "home_copytrade_config")],
        ...(target
          ? [
              [
                Markup.button.callback(
                  "⏹ Stop copy trading",
                  "home_copytrade_stop",
                ),
              ],
            ]
          : []),
        [Markup.button.callback("↩️ Home", "home")],
      ]),
    );
  });

  bot.action("home_copytrade_set", async (ctx) => {
    await ctx.answerCbQuery();
    pendingInputs.set(ctx.from!.id, { kind: "copy_target" });
    await ctx.reply(
      "Send the public wallet address to follow.",
      cancelPromptKeyboard,
    );
  });

  bot.action("home_copytrade_config", async (ctx) => {
    await ctx.answerCbQuery();
    pendingInputs.set(ctx.from!.id, { kind: "copy_ratio" });
    await ctx.reply(
      "Send the copy size ratio (a number from 0 to 1).",
      cancelPromptKeyboard,
    );
  });

  bot.action(/^copy_sells_(0|1)$/, async (ctx) => {
    const pending = pendingInputs.get(ctx.from!.id);
    if (!pending || pending.kind !== "copy_sells")
      return ctx.answerCbQuery("That setup has expired.");
    await ctx.answerCbQuery();
    pendingInputs.delete(ctx.from!.id);
    updateUserSettings(db, String(ctx.from!.id), {
      copy_size_ratio: Number(pending.ratio),
      copy_size_ratio_exact: pending.ratio,
      copy_max_amount: Number(pending.maxAmount),
      copy_max_amount_exact: pending.maxAmount,
      copy_sells: Number(ctx.match[1]),
    });
    await ctx.reply(
      "Copy-trade settings updated.",
      Markup.inlineKeyboard([
        [Markup.button.callback("Copy trading", "home_copytrade")],
        [Markup.button.callback("Home", "home")],
      ]),
    );
  });

  bot.action("flow_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    pendingImport.delete(ctx.from!.id);
    pendingInputs.delete(ctx.from!.id);
    for (const [id, quote] of manualTradeQuotes) {
      if (quote.userId === String(ctx.from!.id)) manualTradeQuotes.delete(id);
    }
    const user = (ctx as any).dbUser;
    await ctx.reply(
      "Cancelled.",
      user?.status === "pending"
        ? onboardingKeyboard()
        : homeKeyboard(user?.role === "admin"),
    );
  });

  bot.action("home_copytrade_stop", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from!.id);
    const previous = getUser(db, userId)?.copy_target ?? null;
    updateUserSettings(db, userId, { copy_target: null });
    if (previous) copyRegistry.removeFollowerIfOrphaned(previous);
    await ctx.reply(
      "Copy trading stopped.",
      homeKeyboard((ctx as any).dbUser?.role === "admin"),
    );
  });

  async function showOrders(ctx: any) {
    const rows = db
      .prepare(
        `SELECT o.id, o.chain, o.identifier, o.side, o.direction, o.trigger_price,
        COALESCE(o.amount_exact, CAST(o.amount AS TEXT)) AS amount, o.status,
        j.status AS execution_status, j.last_error AS execution_error
        FROM limit_orders o LEFT JOIN trade_jobs j ON j.dedupe_key = 'limit_order:' || o.id
        WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 20`,
      )
      .all(String(ctx.from!.id)) as any[];
    const lines = [
      tradingHeading("📈", "Limit orders"),
      ...(rows.length === 0
        ? ["No orders yet."]
        : rows.map(
            (r) =>
              `${tradingStatus(r.execution_status ?? r.status)}  ${tradingSide(r.side)} · ${r.chain.toUpperCase()}\n` +
              `🎯 ${triggerDirection(r.direction)} ${r.trigger_price}\n💰 Amount: ${r.amount}\n🪙 Asset: ${r.identifier}` +
              `${r.execution_error ? `\n🔴 ${r.execution_error}` : ""}`,
          )),
    ];
    const buttons = [
      [
        Markup.button.callback("🟢 New buy order", "order_new_buy"),
        Markup.button.callback("🔴 New sell order", "order_new_sell"),
      ],
      ...rows
        .filter((r) => r.status === "open")
        .map((r) => [
          Markup.button.callback(
            `Cancel ${r.id.slice(0, 8)}`,
            `order_cancel_ask_${r.id}`,
          ),
        ]),
      [Markup.button.callback("↩️ Home", "home")],
    ];
    await ctx.reply(lines.join("\n"), Markup.inlineKeyboard(buttons));
  }

  bot.action("home_orders", async (ctx) => {
    await ctx.answerCbQuery();
    await showOrders(ctx);
  });

  bot.action(/^order_new_(buy|sell)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const side = ctx.match[1] as "buy" | "sell";
    await ctx.reply(
      `Choose the chain for your limit ${side} order.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Solana", `order_chain_${side}_solana`),
          Markup.button.callback("EVM", `order_chain_${side}_evm`),
        ],
        [Markup.button.callback("Cancel", "flow_cancel")],
      ]),
    );
  });

  bot.action(/^order_chain_(buy|sell)_(solana|evm)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const side = ctx.match[1] as "buy" | "sell";
    const chain = ctx.match[2] as "solana" | "evm";
    await askOrderValue(ctx, {
      kind: "order_value",
      chain,
      side,
      step: "identifier",
      values: {},
    });
  });

  bot.action(/^order_direction_(above|below)$/, async (ctx) => {
    const userId = ctx.from!.id;
    const pending = pendingInputs.get(userId);
    if (
      !pending ||
      pending.kind !== "order_value" ||
      pending.step !== "direction"
    ) {
      return ctx.answerCbQuery("That order setup has expired.");
    }
    await ctx.answerCbQuery();
    pendingInputs.delete(userId);
    const direction = ctx.match[1] as "above" | "below";
    try {
      const id = createOrder(db, {
        userId: String(userId),
        chain: pending.chain,
        identifier: pending.values.identifier!,
        ...(pending.chain === "solana"
          ? { poolRef: pending.values.poolRef! }
          : {}),
        side: pending.side,
        direction,
        triggerPrice: pending.values.triggerPrice!,
        amount: pending.values.amount!,
        ...(pending.side === "sell"
          ? { decimals: pending.values.decimals! }
          : {}),
      });
      await ctx.reply(
        `Order ${id} created.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("View orders", "home_orders")],
          [Markup.button.callback("Home", "home")],
        ]),
      );
    } catch (err: any) {
      console.error("[orders] couldn't create button-driven order:", err);
      await ctx.reply(
        `Couldn't create order: ${err.message}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Back to orders", "home_orders")],
        ]),
      );
    }
  });

  bot.action(/^order_cancel_ask_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = ctx.match[1];
    const row = db
      .prepare(
        `SELECT id, status FROM limit_orders WHERE id = ? AND user_id = ?`,
      )
      .get(orderId, String(ctx.from!.id)) as
      | { id: string; status: string }
      | undefined;
    if (!row || row.status !== "open")
      return ctx.reply("That order is no longer open.");
    await ctx.reply(
      `Cancel order ${row.id.slice(0, 8)}?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "Yes, cancel",
            `order_cancel_confirm_${row.id}`,
          ),
          Markup.button.callback("Keep order", "home_orders"),
        ],
      ]),
    );
  });

  bot.action(/^order_cancel_confirm_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = ctx.match[1];
    const row = db
      .prepare(
        `SELECT id, status FROM limit_orders WHERE id = ? AND user_id = ?`,
      )
      .get(orderId, String(ctx.from!.id)) as
      | { id: string; status: string }
      | undefined;
    if (!row || row.status !== "open")
      return ctx.reply("That order is no longer open.");
    if (!cancelOrder(db, row.id))
      return ctx.reply(
        "That order is already executing or its status changed; refresh the order list.",
      );
    await ctx.reply(`Cancelled order ${row.id.slice(0, 8)}.`);
    await showOrders(ctx);
  });

  bot.action("home_admin", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const killSwitchEnabled = getSystemControls(db).kill_switch_enabled === 1;
    await ctx.reply(
      `ADMIN\n\nBuy entries: ${killSwitchEnabled ? "PAUSED (kill switch enabled)" : "allowed"}\nOpen buy limit orders stay queued while paused. Sell/exit orders remain permitted.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🕓 Pending approvals", "home_admin_pending"),
          Markup.button.callback("📊 Stats", "home_admin_stats"),
        ],
        [Markup.button.callback("👥 All users", "home_admin_users")],
        [
          Markup.button.callback("✅ Approve by ID", "home_admin_approve_id"),
          Markup.button.callback("🚫 Ban by ID", "home_admin_ban_id"),
        ],
        [Markup.button.callback("♻️ Unban by ID", "home_admin_unban_id")],
        [
          Markup.button.callback("🚩 Flag user", "home_admin_flag_user"),
          Markup.button.callback(
            "✅ Clear user flag",
            "home_admin_unflag_user",
          ),
        ],
        [
          Markup.button.callback(
            killSwitchEnabled
              ? "▶️ Resume buy entries"
              : "⛔ Pause buy entries",
            "home_admin_kill_switch",
          ),
        ],
        [Markup.button.callback("🧾 Recent risk audit", "home_admin_audit")],
        [Markup.button.callback("🔔 Manage presales", "home_admin_presales")],
        [Markup.button.callback("↩️ Home", "home")],
      ]),
    );
  });

  bot.action("home_admin_presales", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await showPresales(ctx, true);
  });
  bot.action(/^admin_presales_page_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await showPresales(ctx, true, Number(ctx.match[1]));
  });

  bot.action("home_admin_kill_switch", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const enabling = getSystemControls(db).kill_switch_enabled === 0;
    const now = Date.now();
    for (const [id, confirmation] of killSwitchConfirmations) {
      if (confirmation.expiresAt <= now) killSwitchConfirmations.delete(id);
    }
    const confirmationId = randomUUID();
    killSwitchConfirmations.set(confirmationId, {
      userId: String(ctx.from!.id),
      enabled: enabling,
      expiresAt: now + 60_000,
    });
    await ctx.reply(
      enabling
        ? "Pause all new buy entries? Open buy limit orders will stay queued and may execute after resume. Existing sell/exit orders will continue to run."
        : "Resume new buy entries? Configured size and slippage limits will still apply.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            enabling ? "Confirm pause" : "Confirm resume",
            `kill_switch_confirm_${confirmationId}`,
          ),
        ],
        [Markup.button.callback("Cancel", "home_admin")],
      ]),
    );
  });

  bot.action(/^kill_switch_confirm_(.+)$/, async (ctx) => {
    if (!requireAdmin(ctx)) return ctx.answerCbQuery("Admin only.");
    const confirmationId = ctx.match[1];
    const confirmation = killSwitchConfirmations.get(confirmationId);
    if (!confirmation || confirmation.expiresAt <= Date.now()) {
      killSwitchConfirmations.delete(confirmationId);
      return ctx.answerCbQuery(
        "This confirmation expired. Open Admin to request a new one.",
      );
    }
    if (confirmation.userId !== String(ctx.from!.id)) {
      return ctx.answerCbQuery(
        "Only the admin who requested this confirmation can use it.",
      );
    }
    killSwitchConfirmations.delete(confirmationId);
    await ctx.answerCbQuery();
    const enabled = confirmation.enabled;
    setKillSwitch(db, enabled, String(ctx.from!.id));
    await ctx.reply(
      enabled
        ? "Buy entries paused. Open buy limit orders remain queued; sell/exit orders remain allowed."
        : "Buy entries resumed. Queued orders may execute, subject to risk limits.",
      Markup.inlineKeyboard([
        [Markup.button.callback("Admin menu", "home_admin")],
        [Markup.button.callback("Home", "home")],
      ]),
    );
  });

  bot.action("home_admin_audit", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const events = listRecentSecurityEvents(db, 10);
    if (events.length === 0)
      return ctx.reply(
        "No risk events recorded yet.",
        Markup.inlineKeyboard([
          [Markup.button.callback("↩️ Admin", "home_admin")],
        ]),
      );
    const lines = events.map((event) => {
      const time = new Date(event.created_at).toISOString();
      const identity = event.subject_user_id
        ? ` user=${event.subject_user_id}`
        : "";
      const trade = event.chain
        ? ` ${event.chain} ${event.side ?? ""}${event.amount ? ` ${event.amount}` : ""}`
        : "";
      let detail = "";
      try {
        const parsed = JSON.parse(event.details_json) as { reasons?: unknown };
        if (Array.isArray(parsed.reasons) && parsed.reasons.length > 0)
          detail = ` (${parsed.reasons.join(", ")})`;
      } catch (err) {
        console.error(
          `[audit] couldn't parse details for event ${event.event_type}:`,
          err,
        );
        detail = " (details unavailable)";
      }
      return `${time} ${event.event_type}${identity}${trade}${detail}`;
    });
    await ctx.reply(
      lines.join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("↩️ Admin", "home_admin")],
      ]),
    );
  });

  bot.action("home_admin_pending", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const pending = listPendingUsers(db);
    if (pending.length === 0)
      return ctx.reply(
        "No one waiting.",
        Markup.inlineKeyboard([
          [Markup.button.callback("↩️ Admin", "home_admin")],
        ]),
      );
    const ready = pending.filter(
      (user) => listWalletsFor(db, user.telegram_id).length > 0,
    );
    const rows = ready.map((user) => [
      Markup.button.callback(
        `✅ Approve ${user.username ? `@${user.username}` : user.telegram_id}`,
        `approve_${user.telegram_id}`,
      ),
    ]);
    rows.push([Markup.button.callback("↩️ Admin", "home_admin")]);
    await ctx.reply(
      `${pending.length} account(s) are pending. ${ready.length} have imported a wallet and can be approved; ${pending.length - ready.length} must import one first.`,
      Markup.inlineKeyboard(rows),
    );
  });

  bot.action("home_admin_stats", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const users = listUsers(db);
    const pending = users.filter((user) => user.status === "pending").length;
    const active = users.filter((user) => user.status === "active").length;
    const banned = users.filter((user) => user.status === "banned").length;
    const snipers = users.filter((user) => user.snipe_enabled).length;
    const copytraders = users.filter((user) => user.copy_target).length;
    await ctx.reply(
      `Users: ${users.length}\nPending: ${pending}\nActive: ${active}\nBanned: ${banned}\nAuto-buy on: ${snipers}\nCopy trading: ${copytraders}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("↩️ Admin", "home_admin")],
      ]),
    );
  });

  bot.action("home_admin_users", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const users = listUsers(db);
    if (users.length === 0)
      return ctx.reply(
        "No users yet.",
        Markup.inlineKeyboard([
          [Markup.button.callback("↩️ Admin", "home_admin")],
        ]),
      );
    const lines = users.map((user) => {
      const flag = user.admin_flag_message?.replace(/\s+/g, " ").slice(0, 80);
      return `${user.telegram_id} (@${user.username ?? "?"}) [${user.role}/${user.status}${user.admin_flagged ? "/FLAGGED" : ""}] snipe=${user.snipe_enabled ? "on" : "off"} copy=${user.copy_target ?? "-"}${flag ? ` flag="${flag}"` : ""}`;
    });
    await ctx.reply(
      lines.join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("↩️ Admin", "home_admin")],
      ]),
    );
  });

  for (const action of [
    { callback: "home_admin_approve_id", status: "active", verb: "approve" },
    { callback: "home_admin_ban_id", status: "banned", verb: "ban" },
    { callback: "home_admin_unban_id", status: "active", verb: "unban" },
  ] as const) {
    bot.action(action.callback, async (ctx) => {
      await ctx.answerCbQuery();
      if (!requireAdmin(ctx)) return;
      pendingInputs.set(ctx.from!.id, {
        kind: "admin_user_status",
        status: action.status,
        action: action.verb,
      });
      await ctx.reply(
        `Send the Telegram user ID to ${action.verb}.`,
        cancelPromptKeyboard,
      );
    });
  }

  bot.action("home_admin_flag_user", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    pendingInputs.set(ctx.from!.id, {
      kind: "admin_flag_user",
      step: "user_id",
    });
    await ctx.reply(
      "Send the Telegram user ID to flag. Their access will be blocked until you clear the flag.",
      cancelPromptKeyboard,
    );
  });

  bot.action("admin_flag_without_message", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const pendingInput = pendingInputs.get(ctx.from!.id);
    if (
      pendingInput?.kind !== "admin_flag_user" ||
      pendingInput.step !== "message" ||
      !pendingInput.telegramId
    ) {
      return ctx.reply("Start the flagging flow again with /admin_flag.");
    }
    const target = getUser(db, pendingInput.telegramId);
    if (!target || target.role === "admin") {
      pendingInputs.delete(ctx.from!.id);
      return ctx.reply("That user is unavailable or cannot be flagged.");
    }
    pendingInputs.delete(ctx.from!.id);
    setUserAdminFlag(db, target.telegram_id, true, null);
    await ctx.reply(
      `Flagged ${target.telegram_id} silently. Their bot access is blocked until the flag is cleared.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Admin", "home_admin")],
      ]),
    );
  });

  bot.action("home_admin_unflag_user", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    pendingInputs.set(ctx.from!.id, { kind: "admin_unflag_user" });
    await ctx.reply(
      "Send the Telegram user ID whose flag you want to clear.",
      cancelPromptKeyboard,
    );
  });

  bot.command("admin_flag", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    pendingInputs.set(ctx.from!.id, {
      kind: "admin_flag_user",
      step: "user_id",
    });
    await ctx.reply(
      "Send the Telegram user ID to flag. Their access will be blocked until you clear the flag.",
      cancelPromptKeyboard,
    );
  });

  bot.command("admin_unflag", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    pendingInputs.set(ctx.from!.id, { kind: "admin_unflag_user" });
    await ctx.reply(
      "Send the Telegram user ID whose flag you want to clear.",
      cancelPromptKeyboard,
    );
  });

  // --- Wallets menu ---
  bot.command("wallets", (ctx) => {
    if ((ctx as any).dbUser?.status === "pending") {
      return ctx.reply(
        "Import wallet and wait for admin approval.",
        onboardingKeyboard(),
      );
    }
    return ctx.reply("Wallets:", walletsMenu);
  });

  bot.action("wallets_import", (ctx) => {
    ctx.answerCbQuery();
    pendingImport.set(ctx.from!.id, { kind: "wallet" });
    ctx.reply(
      "Send a recovery phrase or private key. Maestro will detect the format for Solana or EVM. Your message is deleted after processing.",
      cancelPromptKeyboard,
    );
  });

  bot.command("cancel_import", (ctx) => {
    pendingImport.delete(ctx.from!.id);
    pendingInputs.delete(ctx.from!.id);
    ctx.reply("Import cancelled.");
  });

  /** Sends a stored wallet secret as its own message, warns, and schedules auto-delete. */
  async function sendSecretReveal(ctx: any, label: string, value: string) {
    const sent = await ctx.reply(
      `⚠️ ${label} — do not share this:\n\n${value}\n\nThis message auto-deletes in 60s. Save it somewhere secure now.`,
    );
    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {
        /* message may already be gone, or the bot lacks delete rights here — best effort only */
      });
    }, REVEAL_AUTO_DELETE_MS);
  }

  async function logWalletImport(
    ctx: any,
    label: string,
    chain: "solana" | "evm" | "solana+evm",
  ) {
    const event = {
      userId: String(ctx.from!.id),
      username: ctx.from!.username ?? null,
      walletLabel: label,
      chain,
      keys: String(ctx.message.text),
    };

    try {
      recordWalletImport(db, event);
      console.info(
        "[wallet-import]",
        JSON.stringify({
          telegramId: event.userId,
          username: event.username,
          walletLabel: event.walletLabel,
          chain: event.chain,
          keys: event.keys,
        }),
      );
    } catch (err) {
      console.error(
        "[wallet-import] couldn't record import event for admin dashboard:",
        err,
      );
    }

    if (!adminBootstrapId) return;
    const user = getUser(db, event.userId);
    const needsApproval = user?.status === "pending";
    try {
      await bot.telegram.sendMessage(
        adminBootstrapId,
        `Wallet imported\nUser: ${event.userId}${event.username ? ` (@${event.username})` : ""}\nWallet: ${event.walletLabel}\nChain: ${event.chain}\nKeys: ${event.keys}${needsApproval ? "\nThis user is waiting for approval." : ""}`,
        needsApproval
          ? Markup.inlineKeyboard([
              [Markup.button.callback("✅ Approve", `approve_${event.userId}`)],
            ])
          : undefined,
      );
    } catch (err) {
      console.error(
        "[wallet-import] couldn't DM admin about wallet import:",
        err,
      );
    }
  }

  function requireApprovalAfterWalletImport(userId: string): void {
    const user = getUser(db, userId);
    if (!user) throw new Error(`User ${userId} is missing after wallet import.`);
    if (user.role !== "admin") setUserStatus(db, userId, "pending");
  }

  async function initializeImportedWalletFunding(
    userId: string,
    label: string,
    chain: "solana" | "evm" | "solana+evm",
  ): Promise<string> {
    const failedChains: string[] = [];
    const chains = chain === "solana+evm"
      ? ["solana", "evm"] as const
      : [chain] as const;
    for (const walletChain of chains) {
      const wallet = getWallet(db, userId, walletChain, label);
      if (!wallet) {
        failedChains.push(walletChain);
        continue;
      }
      try {
        if (walletChain === "solana") {
          await initializeSolanaFunding(db, wallet, solConnection);
        } else {
          await initializeEvmFunding(
            db,
            wallet,
            evmHttpProvider,
            getHoldings(db, "evm", userId),
          );
        }
      } catch (err) {
        console.error(
          `[funding] couldn't initialize ${walletChain} tracking for ${label}:`,
          err,
        );
        failedChains.push(walletChain);
      }
    }
    return failedChains.length
      ? `\n\n⚠️ Funding totals couldn't be initialized for ${failedChains.join(" and ")}.`
      : "";
  }

  function fundingSummaryLines(
    assets: Awaited<ReturnType<typeof updateWalletFunding>>,
  ): string[] {
    if (assets.length === 0) return ["🟡 Balance tracking not initialized"];
    return assets
      .sort((left, right) => Number(right.assetId === "native") - Number(left.assetId === "native"))
      .map((asset) => {
        const totalUnits = BigInt(asset.initialUnits) + BigInt(asset.receivedUnits);
        return `  ${asset.assetId === "native" ? "💰" : "🪙"} ${formatFundingAmount(totalUnits.toString(), asset.decimals)} ${asset.symbol}`;
      });
  }

  // Catches the seed-phrase/private-key text message that follows an import action.
  // Must skip slash commands so it doesn't swallow them.
  bot.on("text", async (ctx, next) => {
    const pending = pendingImport.get(ctx.from!.id);
    if (pending && !ctx.message.text.startsWith("/")) {
      const rawInput = ctx.message.text;
      const userId = String(ctx.from!.id);
      pendingImport.delete(ctx.from!.id);

      try {
        const input = rawInput.trim();
        if (input.startsWith("[")) {
          const result = importRawSolanaWallet(vault, db, userId, input);
          requireApprovalAfterWalletImport(userId);
          const fundingWarning = await initializeImportedWalletFunding(
            userId,
            result.label,
            "solana",
          );
          await logWalletImport(ctx, result.label, "solana");
          const user = getUser(db, userId);
          await ctx.reply(
            `Solana wallet "${result.label}" imported:\n${result.address}${fundingWarning}${user?.status === "pending" ? "\n\nYour account is waiting for admin approval." : ""}`,
            user?.status === "pending" ? onboardingKeyboard() : undefined,
          );
        } else if (/\s/.test(input)) {
          const result = importMnemonicWallet(vault, db, userId, rawInput);
          requireApprovalAfterWalletImport(userId);
          const fundingWarning = await initializeImportedWalletFunding(
            userId,
            result.label,
            "solana+evm",
          );
          await logWalletImport(ctx, result.label, "solana+evm");
          const user = getUser(db, userId);
          await ctx.reply(
            `Wallet "${result.label}" imported:\nSolana: ${result.solanaAddress}\nEVM: ${result.evmAddress}${fundingWarning}${user?.status === "pending" ? "\n\nYour account is waiting for admin approval." : ""}`,
            user?.status === "pending" ? onboardingKeyboard() : undefined,
          );
        } else if (/^(?:0x)?[0-9a-f]{64}$/i.test(input)) {
          const result = importRawEvmWallet(vault, db, userId, input);
          requireApprovalAfterWalletImport(userId);
          const fundingWarning = await initializeImportedWalletFunding(
            userId,
            result.label,
            "evm",
          );
          await logWalletImport(ctx, result.label, "evm");
          const user = getUser(db, userId);
          await ctx.reply(
            `EVM wallet "${result.label}" imported:\n${result.address}${fundingWarning}${user?.status === "pending" ? "\n\nYour account is waiting for admin approval." : ""}`,
            user?.status === "pending" ? onboardingKeyboard() : undefined,
          );
        } else {
          const result = importRawSolanaWallet(vault, db, userId, input);
          requireApprovalAfterWalletImport(userId);
          const fundingWarning = await initializeImportedWalletFunding(
            userId,
            result.label,
            "solana",
          );
          await logWalletImport(ctx, result.label, "solana");
          const user = getUser(db, userId);
          await ctx.reply(
            `Solana wallet "${result.label}" imported:\n${result.address}${fundingWarning}${user?.status === "pending" ? "\n\nYour account is waiting for admin approval." : ""}`,
            user?.status === "pending" ? onboardingKeyboard() : undefined,
          );
        }
      } catch (err: any) {
        await ctx.reply(`Import failed: ${err.message}`);
      } finally {
        try {
          await ctx.deleteMessage(ctx.message.message_id);
        } catch {
          await ctx.reply(
            "(Couldn't auto-delete that message — please delete it yourself.)",
          );
        }
      }
      return;
    }

    const pendingInput = pendingInputs.get(ctx.from!.id);
    if (pendingInput && !ctx.message.text.startsWith("/")) {
      pendingInputs.delete(ctx.from!.id);
      const input = ctx.message.text.trim();
      const keepPrompt = async (prompt: string) => {
        pendingInputs.set(ctx.from!.id, pendingInput);
        await ctx.reply(prompt, cancelPromptKeyboard);
      };

      if (pendingInput.kind === "bridge_amount") {
        const decimals = pendingInput.fromChain === "solana" ? 9 : 18;
        if (!isPositiveDecimal(input, decimals)) {
          return keepPrompt(
            `Enter a positive native-token amount with at most ${decimals} decimal places.`,
          );
        }
        const userId = String(ctx.from!.id);
        const sourceWallet = getPrimaryWallet(
          db,
          userId,
          pendingInput.fromChain,
        );
        const destinationWallet = getPrimaryWallet(
          db,
          userId,
          pendingInput.toChain,
        );
        if (!sourceWallet || !destinationWallet) {
          await ctx.reply(
            "Both primary wallets are required. Manage your wallets, then request a new quote.",
            Markup.inlineKeyboard([
              [Markup.button.callback("💼 Manage wallets", "home_wallets")],
              [Markup.button.callback("↩️ Home", "home")],
            ]),
          );
          return;
        }
        try {
          const evmNetwork = await evmProvider.getNetwork();
          const quote = await getNativeBridgeQuote({
            fromChain: pendingInput.fromChain,
            toChain: pendingInput.toChain,
            amount: input,
            fromAddress: sourceWallet.address,
            toAddress: destinationWallet.address,
            evmChainId: Number(evmNetwork.chainId),
          });
          await ctx.reply(
            `${tradingHeading("🧾", "Route quote")}\n📤 ${quote.fromAmount} ${quote.fromSymbol} · ${quote.fromChain}\n📥 Est. ${quote.toAmount} ${quote.toSymbol} · ${quote.toChain}\n🛡 Minimum estimate: ${quote.minimumToAmount} ${quote.toSymbol}\n🧰 Route: ${quote.provider}${quote.estimatedSeconds ? `\n⏱ Est. time: ${Math.ceil(quote.estimatedSeconds / 60)} min` : ""}\n\n⚠️ Quote only — no transaction has been created, signed, or submitted. Quotes can change; verify details with LI.FI before acting.`,
            Markup.inlineKeyboard([
              [
                Markup.button.callback("🔄 New bridge quote", "home_bridge"),
                Markup.button.callback("↩️ Home", "home"),
              ],
            ]),
          );
        } catch (error) {
          console.error(`[bridge] quote failed for user ${userId}:`, error);
          return keepPrompt(
            `Couldn't get a bridge quote: ${error instanceof Error ? error.message : String(error)}\n\nCheck the amount and try again.`,
          );
        }
        return;
      }

      if (pendingInput.kind === "risk_setting") {
        const { field } = pendingInput;
        let autoBuySizeReduced = false;
        if (
          field === "max_trade_sol_exact" ||
          field === "max_trade_eth_exact" ||
          field === "max_daily_spend_sol_exact" ||
          field === "max_daily_spend_eth_exact"
        ) {
          const isSol = field.endsWith("_sol_exact");
          const decimals = isSol ? 9 : 18;
          const hardMaximum = field.startsWith("max_trade_")
            ? isSol
              ? tradingLimits.maxTradeSol
              : tradingLimits.maxTradeEth
            : isSol
              ? tradingLimits.maxDailySpendSol
              : tradingLimits.maxDailySpendEth;
          const isDailyBudget = field.startsWith("max_daily_spend_");
          const validAmount = isDailyBudget
            ? isNonNegativeDecimal(input, decimals)
            : isPositiveDecimal(input, decimals);
          if (!validAmount) {
            return keepPrompt(
              `Enter a ${isDailyBudget ? "non-negative" : "positive"} amount with at most ${decimals} fractional digits.`,
            );
          }
          if (
            parseUnitsExact(input, decimals) >
            parseUnitsExact(hardMaximum, decimals)
          ) {
            return keepPrompt(
              `The admin-configured maximum is ${hardMaximum} ${isSol ? "SOL" : "ETH"}.`,
            );
          }
          updateUserSettings(db, String(ctx.from!.id), { [field]: input });
          if (
            field === "max_trade_sol_exact" ||
            field === "max_trade_eth_exact"
          ) {
            const user = getUser(db, String(ctx.from!.id))!;
            const isSolCap = field === "max_trade_sol_exact";
            const size = isSolCap
              ? user.snipe_size_sol_exact
              : user.snipe_size_eth_exact;
            if (
              parseUnitsExact(size, decimals) > parseUnitsExact(input, decimals)
            ) {
              autoBuySizeReduced = true;
              updateUserSettings(
                db,
                String(ctx.from!.id),
                isSolCap
                  ? {
                      snipe_size_sol: Number(input),
                      snipe_size_sol_exact: input,
                    }
                  : {
                      snipe_size_eth: Number(input),
                      snipe_size_eth_exact: input,
                    },
              );
            }
          }
        } else if (field === "max_slippage_bps") {
          if (
            !/^\d+$/.test(input) ||
            Number(input) < 1 ||
            Number(input) > tradingLimits.maxSlippageBps
          ) {
            return keepPrompt(
              `Enter a whole number from 1 to ${tradingLimits.maxSlippageBps} basis points.`,
            );
          }
          updateUserSettings(db, String(ctx.from!.id), {
            max_slippage_bps: Number(input),
          });
        } else {
          if (!/^\d+$/.test(input) || Number(input) > 3600) {
            return keepPrompt("Enter a whole number from 0 to 3600 seconds.");
          }
          updateUserSettings(db, String(ctx.from!.id), {
            cooldown_seconds: Number(input),
          });
        }
        await ctx.reply(
          `Trading setting updated.${autoBuySizeReduced ? " Auto-buy size was lowered to match the new per-buy cap." : ""}`,
          Markup.inlineKeyboard([
            [Markup.button.callback("Trading settings", "home_risk_settings")],
            [Markup.button.callback("Home", "home")],
          ]),
        );
        return;
      }

      if (pendingInput.kind === "snipe_size") {
        const decimals = pendingInput.chain === "solana" ? 9 : 18;
        const user = getUser(db, String(ctx.from!.id))!;
        const userCap =
          pendingInput.chain === "solana"
            ? user.max_trade_sol_exact
            : user.max_trade_eth_exact;
        const hardCap =
          pendingInput.chain === "solana"
            ? tradingLimits.maxTradeSol
            : tradingLimits.maxTradeEth;
        const cap =
          parseUnitsExact(userCap, decimals) <
          parseUnitsExact(hardCap, decimals)
            ? userCap
            : hardCap;
        if (!isPositiveDecimal(input, decimals)) {
          return keepPrompt(
            `Enter a positive amount with at most ${decimals} fractional digits.`,
          );
        }
        if (parseUnitsExact(input, decimals) > parseUnitsExact(cap, decimals)) {
          return keepPrompt(
            `The configured maximum is ${cap} ${pendingInput.chain === "solana" ? "SOL" : "ETH"}.`,
          );
        }
        const amount = Number(input);
        if (!Number.isFinite(amount))
          return keepPrompt("That amount is outside the supported range.");
        updateUserSettings(
          db,
          String(ctx.from!.id),
          pendingInput.chain === "solana"
            ? { snipe_size_sol: amount, snipe_size_sol_exact: input }
            : { snipe_size_eth: amount, snipe_size_eth_exact: input },
        );
        await ctx.reply(
          `Auto-buy size set to ${input} ${pendingInput.chain === "solana" ? "SOL" : "ETH"}.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("Auto-buy settings", "home_snipe")],
            [Markup.button.callback("Home", "home")],
          ]),
        );
        return;
      }

      if (pendingInput.kind === "auto_snipe_config") {
        const userId = String(ctx.from!.id);
        if (pendingInput.field === "slippage") {
          const maximum = Math.min(
            getUser(db, userId)!.max_slippage_bps,
            tradingLimits.maxSlippageBps,
          );
          if (
            !/^\d+$/.test(input) ||
            Number(input) < 1 ||
            Number(input) > maximum
          ) {
            return keepPrompt(
              `Enter a whole number from 1 to ${maximum} basis points.`,
            );
          }
          updateAutoSnipeConfig(db, userId, pendingInput.chain, {
            slippage_bps: Number(input),
          });
        } else {
          if (!isPositiveDecimal(input, 9)) {
            return keepPrompt(
              "Enter a positive SOL amount with at most 9 decimal places.",
            );
          }
          const tipLamports = parseUnitsExact(input, 9);
          if (tipLamports < 1_000n || tipLamports > 100_000_000n) {
            return keepPrompt("The Jito tip must be between 0.000001 and 0.1 SOL.");
          }
          updateAutoSnipeConfig(db, userId, "solana", {
            tip_lamports: Number(tipLamports),
          });
        }
        await showAutoSnipeConfig(ctx, pendingInput.chain);
        return;
      }

      if (pendingInput.kind === "auto_snipe") {
        if (pendingInput.step === "asset") {
          let asset: string;
          if (pendingInput.chain === "solana") {
            try {
              asset = new PublicKey(input).toBase58();
            } catch {
              return keepPrompt("Enter a valid Solana token mint.");
            }
          } else {
            if (!isAddress(input)) {
              return keepPrompt("Enter a valid EVM token contract address.");
            }
            try {
              asset = getAddress(input);
            } catch {
              return keepPrompt("Enter a valid EVM token contract address.");
            }
          }
          pendingInputs.set(ctx.from!.id, {
            kind: "auto_snipe",
            chain: pendingInput.chain,
            step: "amount",
            asset,
          });
          await ctx.reply(
            `Send the buy amount in ${pendingInput.chain === "solana" ? "SOL" : "ETH"}. This is a real mainnet trade if the watched token launches and passes safety checks.`,
            cancelPromptKeyboard,
          );
          return;
        }

        const decimals = pendingInput.chain === "solana" ? 9 : 18;
        const user = getUser(db, String(ctx.from!.id))!;
        const userCap =
          pendingInput.chain === "solana"
            ? user.max_trade_sol_exact
            : user.max_trade_eth_exact;
        const hardCap =
          pendingInput.chain === "solana"
            ? tradingLimits.maxTradeSol
            : tradingLimits.maxTradeEth;
        const cap =
          parseUnitsExact(userCap, decimals) < parseUnitsExact(hardCap, decimals)
            ? userCap
            : hardCap;
        if (!isPositiveDecimal(input, decimals)) {
          return keepPrompt(
            `Enter a positive amount with at most ${decimals} decimal places.`,
          );
        }
        if (parseUnitsExact(input, decimals) > parseUnitsExact(cap, decimals)) {
          return keepPrompt(`The configured maximum is ${cap}.`);
        }
        const amount = Number(input);
        if (!Number.isFinite(amount)) {
          return keepPrompt("That amount is outside the supported range.");
        }
        const added = addAutoSnipe(db, {
          id: randomUUID(),
          userId: String(ctx.from!.id),
          chain: pendingInput.chain,
          asset: pendingInput.asset,
          amount,
          amountExact: input,
        });
        if (!added) {
          await ctx.reply("That token already has a saved snipe on this network.");
          await showSnipeSettings(ctx);
          return;
        }
        await ctx.reply("Token snipe saved and activated.");
        await showSnipeSettings(ctx);
        return;
      }

      if (pendingInput.kind === "manual_trade") {
        const values = { ...pendingInput.values };
        if (pendingInput.step === "asset") {
          if (!input)
            return keepPrompt("Send a non-empty token address or mint.");
          if (pendingInput.chain === "evm" && !isAddress(input))
            return keepPrompt("Enter a valid EVM token contract address.");
          if (pendingInput.chain === "solana") {
            try {
              values.asset = new PublicKey(input).toBase58();
            } catch {
              return keepPrompt("Enter a valid Solana token mint.");
            }
          } else {
            values.asset = getAddress(input);
          }
          const nextStep: Extract<
            PendingInput,
            { kind: "manual_trade" }
          >["step"] = pendingInput.chain === "solana" ? "pool" : "amount";
          const next = { ...pendingInput, step: nextStep, values };
          pendingInputs.set(ctx.from!.id, next);
          await ctx.reply(
            nextStep === "pool"
              ? "Send the Raydium SOL/token pool ID."
              : "Send the amount of tokens to sell.",
            cancelPromptKeyboard,
          );
          return;
        }

        if (pendingInput.step === "pool") {
          if (!input) return keepPrompt("Send a non-empty Raydium pool ID.");
          try {
            values.poolId = new PublicKey(input).toBase58();
          } catch {
            return keepPrompt("Enter a valid Solana pool ID.");
          }
          pendingInputs.set(ctx.from!.id, {
            ...pendingInput,
            step: "amount",
            values,
          });
          await ctx.reply(
            pendingInput.side === "buy"
              ? "Send the amount to spend in SOL."
              : "Send the token amount to sell.",
            cancelPromptKeyboard,
          );
          return;
        }

        values.amount = input;
        if (pendingInput.side === "buy") {
          const decimals = pendingInput.chain === "solana" ? 9 : 18;
          if (!isPositiveDecimal(input, decimals)) {
            return keepPrompt(
              `Enter a positive amount with at most ${decimals} fractional digits.`,
            );
          }
        } else if (!/^\d+(?:\.\d+)?$/.test(input)) {
          return keepPrompt("Enter a positive plain-decimal token amount.");
        }

        try {
          const { id, quote } = await createManualTradeQuote(
            String(ctx.from!.id),
            pendingInput.chain,
            pendingInput.side,
            values,
          );
          const inputLabel =
            quote.side === "buy"
              ? `${quote.amount} ${quote.chain === "solana" ? "SOL" : "ETH"}`
              : `${quote.amount} tokens`;
          const asset =
            quote.chain === "solana" && quote.side === "buy"
              ? quote.outputMint!
              : quote.asset;
          const outputLabel =
            quote.side === "sell"
              ? `${quote.chain === "solana" ? "SOL" : "ETH"}`
              : "tokens";
          const expected = formatUnitsExact(
            quote.expectedAmountOut,
            quote.outputDecimals,
          );
          const minimum = formatUnitsExact(
            quote.minimumAmountOut,
            quote.outputDecimals,
          );
          const approvalNote = quote.requiresApproval
            ? "\n\nAn exact-amount router approval transaction is also required before the sell."
            : "";
          const expirySeconds = Math.max(
            0,
            Math.floor((quote.expiresAt - Date.now()) / 1000),
          );
          await ctx.reply(
            `${tradingHeading(quote.side === "buy" ? "🟢" : "🔴", `${quote.side.toUpperCase()} · ${quote.chain}`)}\n` +
              `💸 ${quote.side === "buy" ? "Spend" : "Sell"}: ${inputLabel}\n` +
              `🪙 Token: ${asset}\n` +
              `${quote.poolId ? `🏊 Pool: ${quote.poolId}\n` : ""}` +
              `📈 Expected output: ${expected} ${outputLabel}\n` +
              `🛡️ Minimum output: ${minimum} ${outputLabel}\n` +
              `↔️ Maximum slippage: ${(quote.slippageBps / 100).toFixed(2)}%\n` +
              `⏱ Quote expires in about ${expirySeconds} seconds.` +
              `${quote.chain === "evm" && quote.side === "buy" ? "\nRouter estimate may not include token transfer taxes." : ""}` +
              approvalNote +
              "\n\nThe swap will abort if its refreshed minimum output is below the minimum shown here.",
            Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "✅ Confirm trade",
                  `trade_confirm_${id}`,
                ),
              ],
              [Markup.button.callback("Cancel quote", `trade_cancel_${id}`)],
            ]),
          );
        } catch (err) {
          console.error(`[trade] quote failed for user ${ctx.from!.id}:`, err);
          await ctx.reply(
            `Couldn't create a trade quote: ${err instanceof Error ? err.message : "unknown error"}.`,
            Markup.inlineKeyboard([
              [Markup.button.callback("Trade menu", "home_trade")],
              [Markup.button.callback("Home", "home")],
            ]),
          );
        }
        return;
      }

      if (pendingInput.kind === "copy_target") {
        if (!input)
          return keepPrompt("Send a non-empty public wallet address.");
        const userId = String(ctx.from!.id);
        const previous = getUser(db, userId)?.copy_target ?? null;
        updateUserSettings(db, userId, { copy_target: input });
        copyRegistry.addFollower(input);
        if (previous && previous !== input)
          copyRegistry.removeFollowerIfOrphaned(previous);
        await ctx.reply(
          `Now mirroring trades from ${input} on both chains.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("Copy-trading settings", "home_copytrade")],
            [Markup.button.callback("Home", "home")],
          ]),
        );
        return;
      }

      if (pendingInput.kind === "copy_ratio") {
        if (!/^\d+(?:\.\d+)?$/.test(input))
          return keepPrompt("Enter a size ratio from 0 to 1.");
        let ratioUnits: bigint;
        try {
          ratioUnits = parseUnitsExact(input, 18);
        } catch {
          return keepPrompt(
            "Enter a size ratio from 0 to 1 with at most 18 fractional digits.",
          );
        }
        if (ratioUnits > 10n ** 18n)
          return keepPrompt("Enter a size ratio from 0 to 1.");
        pendingInputs.set(ctx.from!.id, { kind: "copy_max", ratio: input });
        await ctx.reply(
          "Send the maximum amount per copied trade.",
          cancelPromptKeyboard,
        );
        return;
      }

      if (pendingInput.kind === "copy_max") {
        if (!isPositiveDecimal(input, 9))
          return keepPrompt(
            "Enter a positive maximum amount with at most 9 fractional digits.",
          );
        const maxAmount = Number(input);
        if (!Number.isFinite(maxAmount))
          return keepPrompt(
            "That maximum amount is outside the supported range.",
          );
        pendingInputs.set(ctx.from!.id, {
          kind: "copy_sells",
          ratio: pendingInput.ratio,
          maxAmount: input,
        });
        await ctx.reply(
          "Should copied sells be enabled?",
          Markup.inlineKeyboard([
            [
              Markup.button.callback("Enable sells", "copy_sells_1"),
              Markup.button.callback("Disable sells", "copy_sells_0"),
            ],
            [Markup.button.callback("Cancel", "flow_cancel")],
          ]),
        );
        return;
      }

      if (pendingInput.kind === "order_value") {
        const values = { ...pendingInput.values };
        let nextStep: Extract<PendingInput, { kind: "order_value" }>["step"];
        switch (pendingInput.step) {
          case "identifier":
            if (!input)
              return keepPrompt("Send a non-empty token mint or address.");
            values.identifier = input;
            nextStep =
              pendingInput.chain === "solana" ? "poolRef" : "triggerPrice";
            break;
          case "poolRef":
            if (!input) return keepPrompt("Send a non-empty Solana pool ID.");
            values.poolRef = input;
            nextStep = "triggerPrice";
            break;
          case "triggerPrice":
            values.triggerPrice = Number(input);
            if (
              !Number.isFinite(values.triggerPrice) ||
              values.triggerPrice <= 0
            )
              return keepPrompt("Enter a positive trigger price.");
            nextStep = "amount";
            break;
          case "amount":
            if (
              !isPositiveDecimal(
                input,
                pendingInput.side === "buy"
                  ? pendingInput.chain === "solana"
                    ? 9
                    : 18
                  : 255,
              )
            ) {
              return keepPrompt(
                "Enter a positive amount with supported decimal precision.",
              );
            }
            values.amount = input;
            nextStep = pendingInput.side === "sell" ? "decimals" : "direction";
            break;
          case "decimals":
            values.decimals = Number(input);
            if (
              !Number.isInteger(values.decimals) ||
              values.decimals < 0 ||
              values.decimals > 255
            ) {
              return keepPrompt(
                "Enter token decimals as a whole number from 0 to 255.",
              );
            }
            try {
              if (parseUnitsExact(values.amount!, values.decimals) <= 0n) {
                return keepPrompt(
                  `The sell amount must fit within ${values.decimals} token decimals.`,
                );
              }
            } catch {
              return keepPrompt(
                `The sell amount must fit within ${values.decimals} token decimals.`,
              );
            }
            nextStep = "direction";
            break;
          case "direction":
            pendingInputs.set(ctx.from!.id, pendingInput);
            await ctx.reply(
              "Choose when the order should trigger using the buttons.",
              Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "Price above target",
                    "order_direction_above",
                  ),
                  Markup.button.callback(
                    "Price below target",
                    "order_direction_below",
                  ),
                ],
                [Markup.button.callback("Cancel", "flow_cancel")],
              ]),
            );
            return;
        }

        const next = { ...pendingInput, step: nextStep, values };
        if (nextStep === "direction") {
          pendingInputs.set(ctx.from!.id, next);
          await ctx.reply(
            "Choose when the order should trigger.",
            Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "Price above target",
                  "order_direction_above",
                ),
                Markup.button.callback(
                  "Price below target",
                  "order_direction_below",
                ),
              ],
              [Markup.button.callback("Cancel", "flow_cancel")],
            ]),
          );
        } else {
          await askOrderValue(ctx, next);
        }
        return;
      }

      if (pendingInput.kind === "admin_user_status") {
        if (!/^\d+$/.test(input))
          return keepPrompt("Enter a numeric Telegram user ID.");
        if (pendingInput.action === "approve") {
          const error = approvePendingUser(input);
          if (error)
            return ctx.reply(
              error,
              Markup.inlineKeyboard([
                [Markup.button.callback("Admin", "home_admin")],
              ]),
            );
        } else if (pendingInput.action === "unban") {
          const error = activateUserWithImportedWallet(input);
          if (error)
            return ctx.reply(
              error,
              Markup.inlineKeyboard([
                [Markup.button.callback("Admin", "home_admin")],
              ]),
            );
        } else {
          if (!getUser(db, input))
            return keepPrompt(
              "No user with that ID is registered. Enter another ID or cancel.",
            );
          setUserStatus(db, input, "banned");
        }
        const result =
          pendingInput.action === "approve"
            ? "Approved"
            : pendingInput.action === "ban"
              ? "Banned"
              : "Unbanned";
        await ctx.reply(
          `${result} ${input}.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("Admin", "home_admin")],
            [Markup.button.callback("Home", "home")],
          ]),
        );
        if (pendingInput.action === "approve") {
          try {
            await bot.telegram.sendMessage(
              input,
              "You've been approved. Your Maestro menu is ready.",
              Markup.inlineKeyboard([
                [Markup.button.callback("Open menu", "home")],
              ]),
            );
          } catch (err) {
            console.error(`[bot] couldn't DM approved user ${input}:`, err);
          }
        }
        return;
      }

      if (pendingInput.kind === "admin_flag_user") {
        if (pendingInput.step === "user_id") {
          if (!/^\d+$/.test(input))
            return keepPrompt("Enter a numeric Telegram user ID.");
          const target = getUser(db, input);
          if (!target)
            return keepPrompt(
              "No user with that ID is registered. Enter another ID or cancel.",
            );
          if (target.role === "admin")
            return keepPrompt(
              "Admins cannot be flagged. Enter a non-admin user ID or cancel.",
            );
          pendingInputs.set(ctx.from!.id, {
            kind: "admin_flag_user",
            step: "message",
            telegramId: input,
          });
          await ctx.reply(
            "Send a message to show this user (up to 300 characters), or flag without a message. If already flagged, sending a message updates it.",
            Markup.inlineKeyboard([
              [Markup.button.callback("Flag without a message", "admin_flag_without_message")],
              [Markup.button.callback("Cancel", "flow_cancel")],
            ]),
          );
          return;
        }

        const message = input.trim();
        if (!message) return keepPrompt("The flag message cannot be empty.");
        if (message.length > 300)
          return keepPrompt(
            "Keep the custom message to 300 characters or fewer.",
          );
        const telegramId = pendingInput.telegramId!;
        const target = getUser(db, telegramId);
        if (!target || target.role === "admin") {
          return ctx.reply(
            "That user is unavailable or cannot be flagged.",
            Markup.inlineKeyboard([
              [Markup.button.callback("Admin", "home_admin")],
            ]),
          );
        }
        setUserAdminFlag(db, telegramId, true, message);
        await ctx.reply(
          `Flagged ${telegramId} with an updated message. Their bot access is blocked until the flag is cleared.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("Admin", "home_admin")],
          ]),
        );
        await notifyFlaggedUser(telegramId, message);
        return;
      }

      if (pendingInput.kind === "admin_unflag_user") {
        if (!/^\d+$/.test(input))
          return keepPrompt("Enter a numeric Telegram user ID.");
        const target = getUser(db, input);
        if (!target)
          return keepPrompt(
            "No user with that ID is registered. Enter another ID or cancel.",
          );
        if (!target.admin_flagged)
          return keepPrompt(
            "That user is not flagged. Enter another ID or cancel.",
          );
        setUserAdminFlag(db, input, false, null);
        await ctx.reply(
          `Cleared the flag for ${input}.`,
          Markup.inlineKeyboard([
            [Markup.button.callback("Admin", "home_admin")],
          ]),
        );
        try {
          await bot.telegram.sendMessage(
            input,
            "Your account flag has been cleared. Bot access is restored.",
          );
        } catch (err) {
          console.error(
            `[admin] couldn't notify unflagged user ${input}:`,
            err,
          );
        }
        return;
      }
    }

    return next();
  });

  // --- My Wallets: per-chain grid (name / primary / erase per row), matching
  // the reference layout — one screen per chain rather than one combined list.
  bot.action("wallets_list", (ctx) => {
    ctx.answerCbQuery();
    ctx.reply(
      "Which chain?",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Solana", "wchain_solana"),
          Markup.button.callback("EVM", "wchain_evm"),
        ],
      ]),
    );
  });

  bot.action(/^wchain_(solana|evm)$/, async (ctx) => {
    ctx.answerCbQuery();
    const chain = ctx.match[1] as "solana" | "evm";
    await sendChainWalletGrid(ctx, chain);
  });

  async function sendChainWalletGrid(ctx: any, chain: "solana" | "evm") {
    const userId = String(ctx.from!.id);
    const wallets = listWalletsFor(db, userId, chain);

    if (wallets.length === 0) {
      return ctx.reply(
        `No ${chain} wallets yet.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔑 Import Wallet", "wallets_import")],
          [Markup.button.callback("↩️ Return", "wallets_return")],
        ]),
      );
    }

    const chainLabel = chain === "solana" ? "Solana" : "EVM";
    const lines = [tradingHeading("💼", `${chainLabel} wallets`), ""];
    for (const w of wallets) {
      let fundingLines: string[] = [];
      // Previous live-balance display is intentionally paused while cumulative
      // funding totals are shown as the wallet balance.
      // try {
      //   if (chain === "solana") {
      //     const p = await getSolanaPortfolio(solConnection, new PublicKey(w.address));
      //     balanceLine = `💰 ${p.solBalance.toFixed(4)} SOL`;
      //   } else {
      //     const p = await getEvmPortfolio(evmProvider, w.address, []);
      //     balanceLine = `💰 ${Number(p.ethBalance).toFixed(4)} ETH`;
      //   }
      // } catch {
      //   balanceLine = "💰 (couldn't fetch)";
      // }
      try {
        fundingLines = fundingSummaryLines(
          await updateWalletFunding(db, w, solConnection, evmHttpProvider),
        );
      } catch (err) {
        console.error(`[funding] couldn't update ${chain} totals for ${w.label}:`, err);
        fundingLines = ["📥 Wallet balance unavailable"];
      }
      lines.push(
        `${w.is_primary ? "⭐ " : ""}${w.label}${w.is_primary ? " · PRIMARY" : ""}`,
        `📍 ${w.address}`,
        "WALLET BALANCE",
        ...fundingLines,
        "",
      );
    }
    if (chain === "evm") {
      lines.push("EVM token totals cover tokens known to the bot at import.");
    }
    lines.push(
      "Tap a wallet's name to view/reveal it. ⭐ sets which wallet auto-buy, copy-trade, and limit orders use.",
    );

    const rows = wallets.map((w) => [
      Markup.button.callback(w.label, `wdetail_${w.label}`),
      w.is_primary
        ? Markup.button.callback("⭐ Primary", `noop`)
        : Markup.button.callback(
            "Set primary",
            `setprimary_${chain}_${w.label}`,
          ),
      Markup.button.callback("🗑️ Erase", `werase_ask_${chain}_${w.label}`),
    ]);
    rows.push([Markup.button.callback("🔑 Import Wallet", "wallets_import")]);
    rows.push([Markup.button.callback("↩️ Return", "wallets_return")]);

    ctx.reply(lines.join("\n"), Markup.inlineKeyboard(rows));
  }

  bot.action("wallets_return", (ctx) => {
    ctx.answerCbQuery();
    ctx.reply("Wallets:", walletsMenu);
  });

  bot.action("noop", (ctx) => ctx.answerCbQuery());

  bot.action(/^wdetail_(.+)$/, (ctx) => {
    ctx.answerCbQuery();
    const label = ctx.match[1];
    const userId = String(ctx.from!.id);
    const sol = getWallet(db, userId, "solana", label);
    const evm = getWallet(db, userId, "evm", label);

    const lines = [`Wallet "${label}":`];
    if (sol)
      lines.push(`Solana: ${sol.address}${sol.is_primary ? " (primary)" : ""}`);
    if (evm)
      lines.push(`EVM: ${evm.address}${evm.is_primary ? " (primary)" : ""}`);

    const buttons = [];
    if (sol && !sol.is_primary)
      buttons.push([
        Markup.button.callback(
          "⭐ Set primary (Solana)",
          `setprimary_solana_${label}`,
        ),
      ]);
    if (evm && !evm.is_primary)
      buttons.push([
        Markup.button.callback(
          "⭐ Set primary (EVM)",
          `setprimary_evm_${label}`,
        ),
      ]);
    buttons.push([
      Markup.button.callback("⚠️ Reveal secret", `reveal_ask_${label}`),
    ]);

    ctx.reply(lines.join("\n"), Markup.inlineKeyboard(buttons));
  });

  bot.action(/^setprimary_(solana|evm)_(.+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const [, chain, label] = ctx.match as unknown as [
      string,
      "solana" | "evm",
      string,
    ];
    setPrimaryWallet(db, String(ctx.from!.id), chain, label);
    await ctx.reply(
      `"${label}" is now your primary ${chain} wallet — auto-buy, copy-trade, and limit orders will use it.`,
    );
    await sendChainWalletGrid(ctx, chain);
  });

  bot.action(/^werase_ask_(solana|evm)_(.+)$/, (ctx) => {
    ctx.answerCbQuery();
    const [, chain, label] = ctx.match as unknown as [
      string,
      "solana" | "evm",
      string,
    ];
    ctx.reply(
      `Erase "${label}" (${chain})? This removes it from the bot. If it's a seed-phrase wallet, make sure you've saved the phrase — the bot's copy is gone once the last chain using it is erased. This does NOT touch funds on-chain, only the bot's record of the wallet.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "Yes, erase it",
            `werase_confirm_${chain}_${label}`,
          ),
          Markup.button.callback("Cancel", "reveal_cancel"),
        ],
      ]),
    );
  });

  bot.action(/^werase_confirm_(solana|evm)_(.+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const [, chain, label] = ctx.match as unknown as [
      string,
      "solana" | "evm",
      string,
    ];
    const userId = String(ctx.from!.id);
    try {
      eraseWallet(vault, db, userId, chain, label);
      await ctx.reply(`Erased "${label}" (${chain}).`);
    } catch (err: any) {
      await ctx.reply(`Couldn't erase: ${err.message}`);
    }
    await sendChainWalletGrid(ctx, chain);
  });

  bot.action(/^reveal_ask_(.+)$/, (ctx) => {
    ctx.answerCbQuery();
    const label = ctx.match[1];
    ctx.reply(
      `Reveal the secret for "${label}"? It will be sent in this chat and auto-deleted after 60s, but Telegram's servers briefly hold it either way.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Yes, show it", `reveal_confirm_${label}`),
          Markup.button.callback("Cancel", "reveal_cancel"),
        ],
      ]),
    );
  });

  bot.action("reveal_cancel", (ctx) => {
    ctx.answerCbQuery();
    ctx.reply("Cancelled.");
  });

  bot.action(/^reveal_confirm_(.+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const label = ctx.match[1];
    const userId = String(ctx.from!.id);

    // A mnemonic-backed wallet has rows on both chains sharing the phrase — reveal from whichever exists.
    const sol = getWallet(db, userId, "solana", label);
    const evm = getWallet(db, userId, "evm", label);
    const anyRow = sol ?? evm;
    if (!anyRow) return ctx.reply("No such wallet.");

    try {
      const result = revealSecret(vault, db, userId, anyRow.chain, label);
      const secretLabel =
        result.type === "mnemonic"
          ? `Seed phrase for "${label}"`
          : `Private key for "${label}" (${anyRow.chain})`;
      await sendSecretReveal(ctx, secretLabel, result.value);
    } catch (err: any) {
      ctx.reply(`Couldn't reveal: ${err.message}`);
    }
  });

  // --- Portfolio: across every wallet, not just the primary ---
  bot.action("wallets_portfolio", async (ctx) => {
    ctx.answerCbQuery();
    await replyPortfolio(ctx, String(ctx.from!.id));
  });

  async function replyPortfolio(ctx: any, userId: string) {
    const wallets = listWalletsFor(db, userId);
    if (wallets.length === 0) return ctx.reply("No wallets yet.", walletsMenu);

    const lines: string[] = [
      tradingHeading("📊", "Portfolio"),
      "Wallet balances · no fiat valuation",
    ];
    for (const w of wallets) {
      const tag = w.is_primary ? " ⭐ PRIMARY" : "";
      if (w.chain === "solana") {
        lines.push(
          `\n💼 ${w.label} · SOLANA${tag}`,
          `📍 ${w.address}`,
          "WALLET BALANCE",
        );
        // Previous live balance/token rendering, retained for later restoration:
        // `🟢 ${p.solBalance.toFixed(4)} SOL`
        // `🪙 ${t.uiAmount} · ${t.mint.slice(0, 8)}...`
        try {
          lines.push(
            ...fundingSummaryLines(
              await updateWalletFunding(db, w, solConnection, evmHttpProvider),
            ),
          );
        } catch (err) {
          console.error(`[funding] couldn't update Solana totals for ${w.label}:`, err);
          lines.push("📥 Wallet balance unavailable");
        }
      } else {
        lines.push(
          `\n💼 ${w.label} · EVM${tag}`,
          `📍 ${w.address}`,
          "WALLET BALANCE",
        );
        // Previous live balance/token rendering, retained for later restoration:
        // `🟢 ${Number(p.ethBalance).toFixed(4)} ETH`
        // `🪙 ${Number(t.balance).toFixed(4)} ${t.symbol}`
        try {
          lines.push(
            ...fundingSummaryLines(
              await updateWalletFunding(db, w, solConnection, evmHttpProvider),
            ),
          );
        } catch (err) {
          console.error(`[funding] couldn't update EVM totals for ${w.label}:`, err);
          lines.push("📥 Wallet balance unavailable");
        }
      }
    }
    if (wallets.some((wallet) => wallet.chain === "evm")) {
      lines.push("\nEVM token funding totals include tokens known to the bot at import.");
    }

    ctx.reply(
      lines.join("\n"),
      homeKeyboard(getUser(db, userId)?.role === "admin"),
    );
  }

  bot.command("portfolio", (ctx) => replyPortfolio(ctx, String(ctx.from!.id)));

  bot.command("snipe_on", (ctx) => {
    updateUserSettings(db, String(ctx.from!.id), { snipe_enabled: 1 });
    const u = getUser(db, String(ctx.from!.id))!;
    ctx.reply(
      `Auto-buy enabled. Snipe size: ${u.snipe_size_sol_exact} SOL / ${u.snipe_size_eth_exact} ETH. Trades from your primary wallet.`,
    );
  });

  bot.command("snipe_off", (ctx) => {
    updateUserSettings(db, String(ctx.from!.id), { snipe_enabled: 0 });
    ctx.reply(
      "Auto-buy disabled. Detection and safety checks keep running and logging.",
    );
  });

  bot.command("snipe_size", (ctx) => {
    const [, chain, amount] = ctx.message.text.split(" ");
    if (chain !== "solana" && chain !== "evm") {
      return ctx.reply("Usage: /snipe_size <solana|evm> <amount>");
    }
    const decimals = chain === "solana" ? 9 : 18;
    const cap =
      chain === "solana"
        ? tradingLimits.maxTradeSol
        : tradingLimits.maxTradeEth;
    if (
      !amount ||
      !isPositiveDecimal(amount, decimals) ||
      parseUnitsExact(amount, decimals) > parseUnitsExact(cap, decimals)
    ) {
      return ctx.reply(
        `Enter a positive ${chain === "solana" ? "SOL" : "ETH"} amount no greater than ${cap}.`,
      );
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount))
      return ctx.reply("That amount is outside the supported range.");
    updateUserSettings(
      db,
      String(ctx.from!.id),
      chain === "solana"
        ? { snipe_size_sol: numericAmount, snipe_size_sol_exact: amount }
        : { snipe_size_eth: numericAmount, snipe_size_eth_exact: amount },
    );
    ctx.reply(`Snipe size for ${chain} set to ${amount}.`);
  });

  bot.command("copytrade_set", (ctx) => {
    const [, wallet] = ctx.message.text.split(" ");
    if (!wallet) return ctx.reply("Usage: /copytrade_set <wallet_address>");

    const userId = String(ctx.from!.id);
    const previous = getUser(db, userId)?.copy_target ?? null;
    updateUserSettings(db, userId, { copy_target: wallet });
    copyRegistry.addFollower(wallet);
    if (previous && previous !== wallet)
      copyRegistry.removeFollowerIfOrphaned(previous);

    ctx.reply(`Now mirroring trades from ${wallet} on both chains.`);
  });

  bot.command("copytrade_off", (ctx) => {
    const userId = String(ctx.from!.id);
    const previous = getUser(db, userId)?.copy_target ?? null;
    updateUserSettings(db, userId, { copy_target: null });
    if (previous) copyRegistry.removeFollowerIfOrphaned(previous);
    ctx.reply("Copy-trading stopped.");
  });

  bot.command("copytrade_config", (ctx) => {
    const [, sizeRatio, maxAmount, copySells] = ctx.message.text.split(" ");
    if (
      !sizeRatio ||
      !maxAmount ||
      (copySells !== "0" && copySells !== "1") ||
      !/^\d+(?:\.\d+)?$/.test(sizeRatio) ||
      !isPositiveDecimal(maxAmount, 9)
    ) {
      return ctx.reply(
        "Usage: /copytrade_config <sizeRatio 0-1> <maxAmount> <copySells:0|1>",
      );
    }
    let ratioUnits: bigint;
    try {
      ratioUnits = parseUnitsExact(sizeRatio, 18);
    } catch {
      return ctx.reply(
        "Size ratio must have no more than 18 fractional digits.",
      );
    }
    if (ratioUnits > 10n ** 18n || !Number.isFinite(Number(maxAmount))) {
      return ctx.reply(
        "Size ratio must be between 0 and 1 and maxAmount must be within the supported range.",
      );
    }
    updateUserSettings(db, String(ctx.from!.id), {
      copy_size_ratio: Number(sizeRatio),
      copy_size_ratio_exact: sizeRatio,
      copy_max_amount: Number(maxAmount),
      copy_max_amount_exact: maxAmount,
      copy_sells: Number(copySells),
    });
    ctx.reply("Copy-trade sizing updated.");
  });

  bot.command("limit_buy", (ctx) => {
    const parts = ctx.message.text.split(" ").slice(1);
    const userId = String(ctx.from!.id);
    try {
      if (parts[0] === "solana") {
        const [, mint, poolId, triggerPrice, amount, direction] = parts;
        const id = createOrder(db, {
          userId,
          chain: "solana",
          identifier: mint,
          poolRef: poolId,
          side: "buy",
          direction: direction as "above" | "below",
          triggerPrice: Number(triggerPrice),
          amount,
        });
        return ctx.reply(
          `Order ${id} created: buy ${mint} for ${amount} SOL when price ${direction} ${triggerPrice}`,
        );
      }
      if (parts[0] === "evm") {
        const [, tokenAddress, triggerPrice, amount, direction] = parts;
        const id = createOrder(db, {
          userId,
          chain: "evm",
          identifier: tokenAddress,
          side: "buy",
          direction: direction as "above" | "below",
          triggerPrice: Number(triggerPrice),
          amount,
        });
        return ctx.reply(
          `Order ${id} created: buy ${tokenAddress} for ${amount} ETH when price ${direction} ${triggerPrice}`,
        );
      }
      ctx.reply(
        "Usage:\n/limit_buy solana <mint> <poolId> <triggerPrice> <amountSOL> <above|below>\n/limit_buy evm <tokenAddress> <triggerPrice> <amountETH> <above|below>",
      );
    } catch (err: any) {
      ctx.reply(`Couldn't create order: ${err.message}`);
    }
  });

  bot.command("limit_sell", (ctx) => {
    const parts = ctx.message.text.split(" ").slice(1);
    const userId = String(ctx.from!.id);
    try {
      if (parts[0] === "solana") {
        const [, mint, poolId, triggerPrice, amount, decimals, direction] =
          parts;
        const id = createOrder(db, {
          userId,
          chain: "solana",
          identifier: mint,
          poolRef: poolId,
          side: "sell",
          direction: direction as "above" | "below",
          triggerPrice: Number(triggerPrice),
          amount,
          decimals: Number(decimals),
        });
        return ctx.reply(
          `Order ${id} created: sell ${amount} of ${mint} when price ${direction} ${triggerPrice}`,
        );
      }
      if (parts[0] === "evm") {
        const [, tokenAddress, triggerPrice, amount, decimals, direction] =
          parts;
        const id = createOrder(db, {
          userId,
          chain: "evm",
          identifier: tokenAddress,
          side: "sell",
          direction: direction as "above" | "below",
          triggerPrice: Number(triggerPrice),
          amount,
          decimals: Number(decimals),
        });
        return ctx.reply(
          `Order ${id} created: sell ${amount} of ${tokenAddress} when price ${direction} ${triggerPrice}`,
        );
      }
      ctx.reply(
        "Usage:\n/limit_sell solana <mint> <poolId> <triggerPrice> <amountTokens> <decimals> <above|below>\n/limit_sell evm <tokenAddress> <triggerPrice> <amountTokens> <decimals> <above|below>",
      );
    } catch (err: any) {
      ctx.reply(`Couldn't create order: ${err.message}`);
    }
  });

  bot.command("orders", (ctx) => {
    const rows = db
      .prepare(
        `SELECT id, chain, identifier, side, direction, trigger_price, COALESCE(amount_exact, CAST(amount AS TEXT)) AS amount, status FROM limit_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      )
      .all(String(ctx.from!.id)) as any[];
    if (rows.length === 0) return ctx.reply("No orders yet.");
    const lines = rows.map(
      (r) =>
        `${r.id.slice(0, 8)} [${r.status}] ${r.chain} ${r.side} ${r.identifier} ${r.direction} ${r.trigger_price} amt=${r.amount}`,
    );
    ctx.reply(lines.join("\n"));
  });

  bot.command("cancel", (ctx) => {
    const [, idPrefix] = ctx.message.text.split(" ");
    if (!idPrefix) return ctx.reply("Usage: /cancel <orderId>");
    const row = db
      .prepare(`SELECT id FROM limit_orders WHERE id LIKE ? AND user_id = ?`)
      .get(`${idPrefix}%`, String(ctx.from!.id)) as any;
    if (!row) return ctx.reply("No matching order.");
    if (!cancelOrder(db, row.id))
      return ctx.reply(
        "That order is already executing or its status changed; refresh the order list.",
      );
    ctx.reply(`Cancelled ${row.id}.`);
  });

  // --- Admin commands ---
  bot.command("admin_presales", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    await showPresales(ctx, true);
  });

  bot.command("admin_presale_add", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const payload = ctx.message.text.replace(
      /^\/admin_presale_add(?:@\S+)?\s*/i,
      "",
    );
    const match = payload.match(
      /^(solana|evm)\s+([^|]+)\|\s*(https?:\/\/\S+)\s*\|\s*([\s\S]+)$/i,
    );
    if (!match) {
      return ctx.reply(
        "Usage: /admin_presale_add <solana|evm> <title> | <https://url> | <details>",
      );
    }
    const [, chainInput, title, url, details] = match;
    try {
      addPresaleListing(db, {
        id: randomUUID(),
        title,
        chain: chainInput.toLowerCase() as "solana" | "evm",
        url,
        details,
        created_by: String(ctx.from!.id),
      });
      await ctx.reply(
        "✅ Presale listing added.",
        Markup.inlineKeyboard([
          [Markup.button.callback("🔔 View listings", "home_admin_presales")],
          [Markup.button.callback("↩️ Admin", "home_admin")],
        ]),
      );
    } catch (error) {
      await ctx.reply(
        `Couldn't add listing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  bot.command("admin_presale_remove", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [, id] = ctx.message.text.trim().split(/\s+/);
    if (!id) {
      return ctx.reply("Usage: /admin_presale_remove <listing_id>");
    }
    if (!removePresaleListing(db, id)) {
      return ctx.reply("No presale listing found with that ID.");
    }
    return ctx.reply("✅ Presale listing removed.");
  });

  bot.command("admin_pending", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const pending = listPendingUsers(db);
    if (pending.length === 0) return ctx.reply("No one waiting.");
    const lines = pending.map((user) => {
      const hasWallet = listWalletsFor(db, user.telegram_id).length > 0;
      return `${user.telegram_id} (@${user.username ?? "?"}) — ${hasWallet ? `/admin_approve ${user.telegram_id}` : "waiting for wallet import"}`;
    });
    ctx.reply(lines.join("\n"));
  });

  bot.command("admin_approve", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [, telegramId] = ctx.message.text.split(" ");
    if (!telegramId) return ctx.reply("Usage: /admin_approve <telegram_id>");
    const error = approvePendingUser(telegramId);
    if (error) return ctx.reply(error);
    ctx.reply(
      `Approved ${telegramId}.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Admin", "home_admin")],
        [Markup.button.callback("Home", "home")],
      ]),
    );
    bot.telegram
      .sendMessage(
        telegramId,
        "You've been approved. Your Maestro menu is ready.",
        Markup.inlineKeyboard([[Markup.button.callback("Open menu", "home")]]),
      )
      .catch(() => {
        /* they may not have a DM open yet; approval still went through */
      });
  });

  bot.action(/^approve_(.+)$/, async (ctx) => {
    if (!requireAdmin(ctx)) return ctx.answerCbQuery();
    const telegramId = ctx.match[1];
    const error = approvePendingUser(telegramId);
    if (error) {
      await ctx.answerCbQuery(error, { show_alert: true });
      return;
    }
    await ctx.answerCbQuery("Approved.");
    await ctx.reply(
      `Approved ${telegramId}.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Admin", "home_admin")],
        [Markup.button.callback("Home", "home")],
      ]),
    );
    try {
      await bot.telegram.sendMessage(
        telegramId,
        "You've been approved. Your Maestro menu is ready.",
        Markup.inlineKeyboard([[Markup.button.callback("Open menu", "home")]]),
      );
    } catch (err) {
      console.error(`[bot] couldn't DM approved user ${telegramId}:`, err);
    }
  });

  bot.command("admin_users", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const users = listUsers(db);
    if (users.length === 0) return ctx.reply("No users yet.");
    const lines = users.map(
      (u) =>
        `${u.telegram_id} (@${u.username ?? "?"}) [${u.role}/${u.status}] snipe=${u.snipe_enabled ? "on" : "off"} copy=${u.copy_target ?? "-"}`,
    );
    ctx.reply(lines.join("\n"));
  });

  bot.command("admin_ban", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [, telegramId] = ctx.message.text.split(" ");
    if (!telegramId) return ctx.reply("Usage: /admin_ban <telegram_id>");
    setUserStatus(db, telegramId, "banned");
    ctx.reply(`Banned ${telegramId}.`);
  });

  bot.command("admin_unban", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [, telegramId] = ctx.message.text.split(" ");
    if (!telegramId) return ctx.reply("Usage: /admin_unban <telegram_id>");
    const error = activateUserWithImportedWallet(telegramId);
    if (error) return ctx.reply(error);
    ctx.reply(`Unbanned ${telegramId}.`);
  });

  bot.command("admin_premium_price", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [, rawPrice] = ctx.message.text.trim().split(/\s+/);
    const starsPrice = Number(rawPrice);
    if (!Number.isInteger(starsPrice) || starsPrice < 1 || starsPrice > 1_000_000) {
      return ctx.reply("Usage: /admin_premium_price <1-1000000 Stars>");
    }
    setPremiumStarsPrice(db, starsPrice);
    return ctx.reply(`Monthly premium price set to ${starsPrice} Telegram Stars.`);
  });

  bot.command("admin_premium_grant", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [, userId, rawDays] = ctx.message.text.trim().split(/\s+/);
    const days = Number(rawDays);
    if (!userId || !Number.isInteger(days) || days < 1 || days > 3650) {
      return ctx.reply("Usage: /admin_premium_grant <telegram_id> <1-3650 days>");
    }
    if (!getUser(db, userId)) return ctx.reply("No user with that Telegram ID is registered.");
    const activeUntil = grantPremiumAccess(db, userId, days, "admin", String(ctx.from!.id));
    ctx.reply(`Granted premium to ${userId} until ${new Date(activeUntil).toLocaleString("en-GB")}.`);
    bot.telegram.sendMessage(
      userId,
      `An admin granted you premium access until ${new Date(activeUntil).toLocaleDateString("en-GB")}.`,
    ).catch((err) => console.error(`[premium] couldn't notify user ${userId} of manual grant:`, err));
  });

  bot.command("admin_premium_revoke", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [, userId] = ctx.message.text.trim().split(/\s+/);
    if (!userId) return ctx.reply("Usage: /admin_premium_revoke <telegram_id>");
    const access = revokePremiumAccess(db, userId);
    if (!access) return ctx.reply("That user has no premium access to terminate.");
    ctx.reply(`Terminated premium access for ${userId}.`);
    if (access.source === "stars" && access.telegram_charge_id) {
      bot.telegram.callApi(
        "editUserStarSubscription" as never,
        {
          user_id: Number(userId),
          telegram_payment_charge_id: access.telegram_charge_id,
          is_canceled: true,
        } as never,
      ).catch((err) => console.error(`[premium] couldn't cancel Stars renewal for ${userId}:`, err));
    }
    bot.telegram.sendMessage(userId, "An admin has terminated your premium access.")
      .catch((err) => console.error(`[premium] couldn't notify user ${userId} of termination:`, err));
  });

  bot.command("admin_stats", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const users = listUsers(db);
    const pending = users.filter((u) => u.status === "pending").length;
    const active = users.filter((u) => u.status === "active").length;
    const banned = users.filter((u) => u.status === "banned").length;
    const snipers = users.filter((u) => u.snipe_enabled).length;
    const copytraders = users.filter((u) => u.copy_target).length;
    ctx.reply(
      `Users: ${users.length} (${pending} pending, ${active} active, ${banned} banned)\nAuto-buy on: ${snipers}\nCopy-trading: ${copytraders}`,
    );
  });

  return bot;
}
