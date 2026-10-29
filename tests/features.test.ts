import assert from "node:assert/strict";
import test from "node:test";
import {
  addAutoSnipe,
  addPresaleListing,
  claimNextTradeJob,
  countPresaleListings,
  countReferrals,
  enqueueTradeJob,
  getAutoSnipeConfig,
  getOrCreateUser,
  listActiveAutoSnipes,
  listActiveSnipers,
  listAutoSnipesForUser,
  listAllCopyTargets,
  listCopyFollowers,
  listPresaleListings,
  openDb,
  recordReferralAttribution,
  removeAutoSnipe,
  removePresaleListing,
  setAutoSnipeEnabled,
  updateAutoSnipeConfig,
} from "../src/db/db.js";

test("auto-snipe defaults persist and are copied into queued trade settings", () => {
  const db = openDb(":memory:");
  try {
    const defaults = getAutoSnipeConfig(db, "10", "solana");
    assert.equal(defaults.slippage_bps, 500);
    assert.equal(defaults.anti_mev_enabled, 1);
    assert.equal(defaults.tip_lamports, 100_000);

    updateAutoSnipeConfig(db, "10", "solana", {
      slippage_bps: 275,
      anti_mev_enabled: 0,
      tip_lamports: 250_000,
    });
    assert.deepEqual(
      {
        slippage: getAutoSnipeConfig(db, "10", "solana").slippage_bps,
        antiMev: getAutoSnipeConfig(db, "10", "solana").anti_mev_enabled,
        tip: getAutoSnipeConfig(db, "10", "solana").tip_lamports,
      },
      { slippage: 275, antiMev: 0, tip: 250_000 },
    );

    enqueueTradeJob(db, {
      dedupeKey: "snipe-config",
      userId: "10",
      chain: "solana",
      side: "buy",
      source: "sniper",
      asset: "mint",
      amount: "0.1",
      poolRef: "pool",
      requestedSlippageBps: 275,
      antiMevEnabled: false,
      tipLamports: 250_000,
    });
    const job = claimNextTradeJob(db);
    assert.equal(job?.requested_slippage_bps, 275);
    assert.equal(job?.anti_mev_enabled, 0);
    assert.equal(job?.tip_lamports, 250_000);
  } finally {
    db.close();
  }
});

test("auto-snipes are scoped to a user and match active targets by chain", () => {
  const db = openDb(":memory:");
  try {
    getOrCreateUser(db, "10", "solana-user");
    getOrCreateUser(db, "20", "evm-user");
    db.prepare("UPDATE users SET status = 'active'").run();

    const solanaSnipe = {
      id: "solana-snipe",
      userId: "10",
      chain: "solana" as const,
      asset: "So11111111111111111111111111111111111112",
      amount: 0.25,
      amountExact: "0.25",
    };
    const evmSnipe = {
      id: "evm-snipe",
      userId: "20",
      chain: "evm" as const,
      asset: "0x0000000000000000000000000000000000000001",
      amount: 0.05,
      amountExact: "0.05",
    };
    assert.equal(addAutoSnipe(db, solanaSnipe), true);
    assert.equal(addAutoSnipe(db, evmSnipe), true);
    assert.equal(addAutoSnipe(db, { ...evmSnipe, id: "duplicate" }), false);
    assert.equal(
      listActiveAutoSnipes(db, "solana", solanaSnipe.asset)[0].telegram_id,
      "10",
    );
    assert.equal(
      listActiveAutoSnipes(db, "evm", evmSnipe.asset.toUpperCase())[0]
        .auto_snipe_amount,
      "0.05",
    );
    assert.equal(listActiveAutoSnipes(db, "solana", evmSnipe.asset).length, 0);
    assert.equal(listAutoSnipesForUser(db, "10").length, 1);

    assert.equal(setAutoSnipeEnabled(db, "other-user", "solana-snipe", false), false);
    assert.equal(setAutoSnipeEnabled(db, "10", "solana-snipe", false), true);
    assert.equal(listActiveAutoSnipes(db, "solana", solanaSnipe.asset).length, 0);
    assert.equal(removeAutoSnipe(db, "other-user", "solana-snipe"), false);
    assert.equal(removeAutoSnipe(db, "10", "solana-snipe"), true);
    assert.equal(listAutoSnipesForUser(db, "10").length, 0);
  } finally {
    db.close();
  }
});

test("presales and referral features persist safely", () => {
  const db = openDb(":memory:");
  try {
    addPresaleListing(db, {
      id: "presale-1",
      title: "Example launch",
      chain: "solana",
      url: "https://example.com/sale",
      details: "Community submission; verify the project independently.",
      created_by: "1",
    });

    assert.equal(listPresaleListings(db).length, 1);
    assert.equal(listPresaleListings(db)[0].chain, "solana");
    assert.equal(removePresaleListing(db, "presale-1"), true);
    assert.equal(removePresaleListing(db, "presale-1"), false);

    for (let index = 1; index <= 4; index += 1) {
      addPresaleListing(db, {
        id: `presale-${index}`,
        title: `Launch ${index}`,
        chain: "evm",
        url: `https://example.com/${index}`,
        details: `Details ${index}`,
        created_by: "1",
      });
    }
    assert.equal(countPresaleListings(db), 4);
    assert.equal(listPresaleListings(db, 2, 0).length, 2);
    assert.equal(listPresaleListings(db, 2, 2).length, 2);
    assert.throws(
      () =>
        addPresaleListing(db, {
          id: "invalid-url",
          title: "Example",
          chain: "evm",
          url: "javascript:alert(1)",
          details: "Details",
          created_by: "1",
        }),
      /HTTP or HTTPS/,
    );
    assert.throws(
      () =>
        addPresaleListing(db, {
          id: "invalid-title",
          title: "x".repeat(81),
          chain: "evm",
          url: "https://example.com",
          details: "Details",
          created_by: "1",
        }),
      /title must be between/,
    );

    getOrCreateUser(db, "10", "referrer", "10");
    getOrCreateUser(db, "20", "invitee");
    assert.equal(recordReferralAttribution(db, "10", "20"), true);
    assert.equal(recordReferralAttribution(db, "10", "20"), false);
    assert.equal(recordReferralAttribution(db, "20", "20"), false);
    assert.equal(countReferrals(db, "10"), 1);

    getOrCreateUser(db, "40", "pending-referrer");
    getOrCreateUser(db, "30", "pending-invitee");
    assert.equal(recordReferralAttribution(db, "40", "30"), false);
    assert.equal(countReferrals(db, "10"), 1);

    getOrCreateUser(db, "50", "flagged-referrer", "50");
    db.prepare("UPDATE users SET admin_flagged = 1 WHERE telegram_id = '50'").run();
    assert.equal(recordReferralAttribution(db, "50", "30"), false);
  } finally {
    db.close();
  }
});

test("flagged users are excluded from automated transaction followers", () => {
  const db = openDb(":memory:");
  try {
    getOrCreateUser(db, "55", "flagged-trader");
    db.prepare(
      `UPDATE users
       SET status = 'active', admin_flagged = 1, snipe_enabled = 1,
           copy_target = 'target-wallet'
       WHERE telegram_id = '55'`,
    ).run();
    addAutoSnipe(db, {
      id: "flagged-auto-snipe",
      userId: "55",
      chain: "solana",
      asset: "mint",
      amount: 0.1,
      amountExact: "0.1",
    });

    assert.equal(listActiveSnipers(db, "solana").length, 0);
    assert.equal(listActiveAutoSnipes(db, "solana", "mint").length, 0);
    assert.equal(listCopyFollowers(db, "target-wallet").length, 0);
    assert.deepEqual(listAllCopyTargets(db), []);
  } finally {
    db.close();
  }
});
