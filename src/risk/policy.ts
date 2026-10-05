import Database from "better-sqlite3";
import type { AppConfig } from "../config/env.js";
import { getSystemControls, getUser, recordSecurityEvent } from "../db/db.js";
import { isPositiveDecimal, parseUnitsExact } from "../shared/amount.js";

export interface TradePolicyRequest {
  userId: string;
  chain: "solana" | "evm";
  side: "buy" | "sell";
  amount: string;
  source: "sniper" | "copytrade" | "limit_order" | "manual";
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
  if (getSystemControls(db).kill_switch_enabled === 1) reasons.push("KILL_SWITCH_ENABLED");
  if (getUser(db, userId)?.status !== "active") reasons.push("USER_NOT_ACTIVE");
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
  config: Pick<AppConfig, "maxTradeSol" | "maxTradeEth" | "maxSlippageBps">,
  request: TradePolicyRequest
): TradePolicyDecision {
  const controls = getSystemControls(db);
  const reasons: string[] = [];
  const amountDecimals = request.side === "buy"
    ? request.chain === "solana" ? 9 : 18
    : 255;
  const amountIsValid = isPositiveDecimal(request.amount, amountDecimals);
  const maxBuyAmount = request.chain === "solana" ? config.maxTradeSol : config.maxTradeEth;

  if (!amountIsValid) reasons.push("INVALID_AMOUNT");

  if (request.side === "buy" && controls.kill_switch_enabled) {
    reasons.push("KILL_SWITCH_ENABLED");
  }
  if (request.side === "buy" && getUser(db, request.userId)?.status !== "active") {
    reasons.push("USER_NOT_ACTIVE");
  }

  if (request.side === "buy" && amountIsValid) {
    const decimals = request.chain === "solana" ? 9 : 18;
    if (parseUnitsExact(request.amount, decimals) > parseUnitsExact(maxBuyAmount, decimals)) {
      reasons.push("MAX_ORDER_SIZE_EXCEEDED");
    }
  }

  const decision: TradePolicyDecision = {
    allowed: reasons.length === 0,
    reasons,
    policyVersion: 1,
    maxSlippageBps: config.maxSlippageBps,
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
