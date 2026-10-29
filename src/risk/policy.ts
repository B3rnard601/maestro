import Database from "better-sqlite3";
import type { AppConfig } from "../config/env.js";
import { getSystemControls, getUser, listDailyBuyExposureAmounts, recordSecurityEvent } from "../db/db.js";
import { isPositiveDecimal, parseUnitsExact } from "../shared/amount.js";

export interface TradePolicyRequest {
  userId: string;
  chain: "solana" | "evm";
  side: "buy" | "sell";
  amount: string;
  source: "sniper" | "copytrade" | "limit_order" | "manual";
  jobId?: string;
  excludeLifecycleId?: string;
}

export interface TradePolicyDecision {
  allowed: boolean;
  reasons: string[];
  policyVersion: number;
  maxSlippageBps: number;
}

export function assertBuyEntryEnabled(
  db: Database.Database,
  userId: string,
  chain: "solana" | "evm",
  source: "sniper" | "copytrade" | "limit_order" | "manual"
): void {
  const reasons: string[] = [];
  const user = getUser(db, userId);
  if (getSystemControls(db).kill_switch_enabled === 1) reasons.push("KILL_SWITCH_ENABLED");
  if (user?.status !== "active") reasons.push("USER_NOT_ACTIVE");
  if (user?.admin_flagged) reasons.push("USER_FLAGGED");
  if (reasons.length === 0) return;
  recordSecurityEvent(db, {
    eventType: "TRADE_SUBMISSION_BLOCKED",
    actorUserId: userId,
    subjectUserId: userId,
    chain,
    side: "buy",
    source,
    details: { reasons, policyVersion: 1 },
  });
  throw new Error(`${reasons.join(", ")}: buy submission blocked.`);
}

export function evaluateTradePolicy(
  db: Database.Database,
  config: Pick<AppConfig, "maxTradeSol" | "maxTradeEth" | "maxDailySpendSol" | "maxDailySpendEth" | "maxSlippageBps">,
  request: TradePolicyRequest
): TradePolicyDecision {
  const controls = getSystemControls(db);
  const user = getUser(db, request.userId);
  const reasons: string[] = [];
  const amountDecimals = request.side === "buy"
    ? request.chain === "solana" ? 9 : 18
    : 255;
  const amountIsValid = isPositiveDecimal(request.amount, amountDecimals);
  const decimals = request.chain === "solana" ? 9 : 18;
  const configuredMaxBuyAmount = request.chain === "solana" ? config.maxTradeSol : config.maxTradeEth;
  const userMaxBuyAmount = request.chain === "solana"
    ? user?.max_trade_sol_exact ?? configuredMaxBuyAmount
    : user?.max_trade_eth_exact ?? configuredMaxBuyAmount;
  const maxBuyAmount = parseUnitsExact(userMaxBuyAmount, decimals) < parseUnitsExact(configuredMaxBuyAmount, decimals)
    ? userMaxBuyAmount
    : configuredMaxBuyAmount;
  const configuredDailySpend = request.chain === "solana" ? config.maxDailySpendSol : config.maxDailySpendEth;
  const userDailySpend = request.chain === "solana"
    ? user?.max_daily_spend_sol_exact ?? configuredDailySpend
    : user?.max_daily_spend_eth_exact ?? configuredDailySpend;
  const dailySpendLimit = parseUnitsExact(userDailySpend, decimals) < parseUnitsExact(configuredDailySpend, decimals)
    ? userDailySpend
    : configuredDailySpend;
  const maxSlippageBps = Math.min(config.maxSlippageBps, user?.max_slippage_bps ?? config.maxSlippageBps);

  if (!amountIsValid) reasons.push("INVALID_AMOUNT");

  if (request.side === "buy" && controls.kill_switch_enabled) {
    reasons.push("KILL_SWITCH_ENABLED");
  }
  if (request.side === "buy" && user?.status !== "active") {
    reasons.push("USER_NOT_ACTIVE");
  }
  if (user?.admin_flagged) {
    reasons.push("USER_FLAGGED");
  }

  if (request.side === "buy" && amountIsValid) {
    if (parseUnitsExact(request.amount, decimals) > parseUnitsExact(maxBuyAmount, decimals)) {
      reasons.push("MAX_ORDER_SIZE_EXCEEDED");
    }

    const now = Date.now();
    const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    const exposureAmounts = listDailyBuyExposureAmounts(
      db,
      request.userId,
      request.chain,
      dayStart,
      request.jobId,
      request.excludeLifecycleId
    );
    const dailySpent = exposureAmounts.reduce((total, amount) => {
      if (!isPositiveDecimal(amount, decimals)) {
        reasons.push("INVALID_DAILY_EXPOSURE_RECORD");
        return total;
      }
      return total + parseUnitsExact(amount, decimals);
    }, 0n);
    if (dailySpent + parseUnitsExact(request.amount, decimals) > parseUnitsExact(dailySpendLimit, decimals)) {
      reasons.push("DAILY_SPEND_LIMIT_EXCEEDED");
    }

    const cooldownSeconds = user?.cooldown_seconds ?? 0;
    if (cooldownSeconds > 0) {
      const recent = db.prepare(`SELECT created_at FROM trade_lifecycle
        WHERE user_id = ? AND side = 'buy' AND transaction_ref IS NOT NULL
          AND status IN ('submitted','confirmed','unknown','failed')
        ORDER BY created_at DESC LIMIT 1`).get(request.userId) as { created_at: number } | undefined;
      if (recent) {
        const remaining = cooldownSeconds - Math.floor((now - recent.created_at) / 1000);
        if (remaining > 0) reasons.push(`COOLDOWN_ACTIVE:${remaining}s`);
      }
    }
  }

  const decision: TradePolicyDecision = {
    allowed: reasons.length === 0,
    reasons,
    policyVersion: 2,
    maxSlippageBps,
  };

  recordSecurityEvent(db, {
    eventType: decision.allowed ? "TRADE_POLICY_ALLOWED" : "TRADE_POLICY_BLOCKED",
    actorUserId: request.userId,
    subjectUserId: request.userId,
    chain: request.chain,
    side: request.side,
    amount: request.amount,
    source: request.source,
    details: {
      reasons: decision.reasons,
      policyVersion: decision.policyVersion,
      killSwitchEnabled: controls.kill_switch_enabled === 1,
      maxBuyAmount: request.side === "buy" ? maxBuyAmount : null,
      dailySpendLimit: request.side === "buy" ? dailySpendLimit : null,
      maxSlippageBps: decision.maxSlippageBps,
    },
  });

  if (!decision.allowed) {
    console.warn(
      `[risk] blocked ${request.chain} ${request.side} for user ${request.userId} (${request.source}): ${reasons.join(", ")}`
    );
  }

  return decision;
}
