import assert from "node:assert/strict";
import test from "node:test";
import { getOrCreateUser, openDb } from "../src/db/db.js";
import {
  assertBuyEntryEnabled,
  evaluateTradePolicy,
} from "../src/risk/policy.js";

const limits = {
  maxTradeSol: "1",
  maxTradeEth: "1",
  maxDailySpendSol: "10",
  maxDailySpendEth: "10",
  maxSlippageBps: 500,
};

test("flagged users cannot submit direct or queued buys and sells", () => {
  const db = openDb(":memory:");
  try {
    getOrCreateUser(db, "55", "flagged-trader");
    db.prepare(
      `UPDATE users SET status = 'active', admin_flagged = 1 WHERE telegram_id = '55'`,
    ).run();

    for (const side of ["buy", "sell"] as const) {
      const decision = evaluateTradePolicy(db, limits, {
        userId: "55",
        chain: "solana",
        side,
        amount: "0.1",
        source: "manual",
      });
      assert.equal(decision.allowed, false);
      assert.ok(decision.reasons.includes("USER_FLAGGED"));
    }

    assert.throws(
      () => assertBuyEntryEnabled(db, "55", "solana", "manual"),
      /USER_FLAGGED/,
    );
  } finally {
    db.close();
  }
});
