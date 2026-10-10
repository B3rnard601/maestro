import assert from "node:assert/strict";
import test from "node:test";
import {
  claimNextTradeJob,
  createPremiumPriceAlert,
  enqueueTradeJob,
  grantPremiumAccess,
  openDb,
  recordTradeFill,
  setPremiumStarsPrice,
} from "../src/db/db.js";
import { formatNativeAmount, getRealizedPnl } from "../src/premium/analytics.js";

test("premium price, alert limits, and manual grants are persisted", () => {
  const db = openDb(":memory:");
  try {
    setPremiumStarsPrice(db, 325);
    grantPremiumAccess(db, "42", 14, "admin", "1");
    createPremiumPriceAlert(db, {
      id: "alert-1",
      user_id: "42",
      chain: "evm",
      identifier: "0x0000000000000000000000000000000000000001",
      pool_ref: null,
      direction: "above",
      target_price: 0.25,
    });
    const price = db.prepare("SELECT stars_price FROM premium_config WHERE id = 1").get() as { stars_price: number };
    const access = db.prepare("SELECT active_until FROM premium_access WHERE user_id = '42'").get() as { active_until: number };
    const alertCount = db.prepare("SELECT COUNT(*) AS count FROM premium_price_alerts WHERE status = 'active'").get() as { count: number };
    assert.equal(price.stars_price, 325);
    assert.ok(access.active_until > Date.now());
    assert.equal(alertCount.count, 1);
  } finally {
    db.close();
  }
});

test("premium auto-buy jobs are claimed ahead of standard jobs", () => {
  const db = openDb(":memory:");
  try {
    const base = {
      chain: "solana" as const,
      side: "buy" as const,
      source: "sniper" as const,
      asset: "mint",
      amount: "0.1",
      poolRef: "pool",
    };
    enqueueTradeJob(db, { ...base, dedupeKey: "free", userId: "free-user" });
    grantPremiumAccess(db, "premium-user", 30, "admin", "admin");
    enqueueTradeJob(db, { ...base, dedupeKey: "premium", userId: "premium-user" });
    assert.equal(claimNextTradeJob(db)?.user_id, "premium-user");
    assert.equal(claimNextTradeJob(db)?.user_id, "free-user");
  } finally {
    db.close();
  }
});

test("realized P&L matches confirmed sells against FIFO buy costs", () => {
  const db = openDb(":memory:");
  try {
    const insertTrade = db.prepare(
      `INSERT INTO trade_lifecycle
        (id, user_id, chain, wallet_address, side, source, asset, amount, status, transaction_ref,
         created_at, updated_at, confirmed_at)
       VALUES (?, 'u1', 'evm', '0xwallet', ?, 'manual', '0xtoken', ?, 'confirmed', ?, ?, ?, ?)`
    );
    const first = Date.now();
    insertTrade.run("buy-1", "buy", "1", "tx-buy-1", first, first, first);
    insertTrade.run("buy-2", "buy", "1", "tx-buy-2", first + 1, first + 1, first + 1);
    insertTrade.run("sell-1", "sell", "1", "tx-sell", first + 2, first + 2, first + 2);
    recordTradeFill(db, {
      lifecycleId: "buy-1",
      userId: "u1",
      chain: "evm",
      asset: "0xtoken",
      tokenDecimals: 0,
      tokenUnits: "100",
      nativeUnits: "10",
    });
    recordTradeFill(db, {
      lifecycleId: "buy-2",
      userId: "u1",
      chain: "evm",
      asset: "0xtoken",
      tokenDecimals: 0,
      tokenUnits: "100",
      nativeUnits: "20",
    });
    recordTradeFill(db, {
      lifecycleId: "sell-1",
      userId: "u1",
      chain: "evm",
      asset: "0xtoken",
      tokenDecimals: 0,
      tokenUnits: "150",
      nativeUnits: "30",
    });

    const pnl = getRealizedPnl(db, "u1");
    assert.equal(pnl.length, 1);
    assert.equal(pnl[0].realizedUnits, 10n);
    assert.equal(pnl[0].matchedSells, 1);
    assert.equal(formatNativeAmount(1_234_567_890_000_000_000n, 18), "1.234567");
  } finally {
    db.close();
  }
});
