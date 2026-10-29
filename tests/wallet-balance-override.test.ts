import assert from "node:assert/strict";
import test from "node:test";
import {
  addWallet,
  getOrCreateUser,
  getWalletBalanceDisplayOverride,
  openDb,
  setWalletBalanceDisplayOverride,
} from "../src/db/db.js";

test("admins can set and clear a display-only native balance override for their own wallet", () => {
  const db = openDb(":memory:");
  try {
    getOrCreateUser(db, "1", "admin", "1");
    const wallet = addWallet(db, {
      userId: "1",
      chain: "solana",
      label: "wallet-1",
      address: "solana-address",
      hasMnemonic: false,
    });

    setWalletBalanceDisplayOverride(db, {
      actorUserId: "1",
      walletId: wallet.id,
      amount: "12.345678901",
    });
    assert.equal(
      getWalletBalanceDisplayOverride(db, "1", wallet.id)?.amount,
      "12.345678901",
    );

    const event = db
      .prepare(
        `SELECT event_type, amount, details_json FROM security_events
         WHERE source = 'admin_display_override'`,
      )
      .get() as {
      event_type: string;
      amount: string;
      details_json: string;
    };
    assert.equal(event.event_type, "ADMIN_WALLET_DISPLAY_BALANCE_SET");
    assert.equal(event.amount, "12.345678901");
    assert.deepEqual(JSON.parse(event.details_json), {
      walletId: wallet.id,
      displayOnly: true,
      affectsOnChainBalance: false,
      affectsTransactions: false,
    });

    setWalletBalanceDisplayOverride(db, {
      actorUserId: "1",
      walletId: wallet.id,
      amount: null,
    });
    assert.equal(getWalletBalanceDisplayOverride(db, "1", wallet.id), null);
  } finally {
    db.close();
  }
});

test("display balance overrides reject non-admins, other users' wallets, and invalid amounts", () => {
  const db = openDb(":memory:");
  try {
    getOrCreateUser(db, "1", "admin", "1");
    getOrCreateUser(db, "2", "user", "1");
    const adminWallet = addWallet(db, {
      userId: "1",
      chain: "evm",
      label: "wallet-1",
      address: "evm-address",
      hasMnemonic: false,
    });
    const userWallet = addWallet(db, {
      userId: "2",
      chain: "solana",
      label: "wallet-1",
      address: "other-solana-address",
      hasMnemonic: false,
    });

    assert.throws(
      () =>
        setWalletBalanceDisplayOverride(db, {
          actorUserId: "2",
          walletId: userWallet.id,
          amount: "1",
        }),
      /Only admins/,
    );
    assert.throws(
      () =>
        setWalletBalanceDisplayOverride(db, {
          actorUserId: "1",
          walletId: userWallet.id,
          amount: "1",
        }),
      /own wallet/,
    );
    assert.throws(
      () =>
        setWalletBalanceDisplayOverride(db, {
          actorUserId: "1",
          walletId: adminWallet.id,
          amount: "1.0000000000000000001",
        }),
      /18 fractional digits/,
    );
    assert.equal(getWalletBalanceDisplayOverride(db, "1", adminWallet.id), null);
  } finally {
    db.close();
  }
});
