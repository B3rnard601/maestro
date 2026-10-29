import assert from "node:assert/strict";
import test from "node:test";
import { isFlagRestrictedUpdate } from "../src/bot/flag-policy.js";

test("flag policy blocks features while retaining start, wallet import, and portfolio commands", () => {
  for (const command of [
    "/help",
    "/limit_buy solana",
    "/limit_sell evm",
    "/snipe_on",
    "/copytrade_set",
    "/referrals",
    "/premium",
    "/orders",
  ]) {
    assert.equal(isFlagRestrictedUpdate({ command }), true, command);
  }

  for (const command of [
    "/start",
    "/start ref_123",
    "/portfolio",
    "/wallets",
    "/cancel_import",
  ]) {
    assert.equal(isFlagRestrictedUpdate({ command }), false, command);
  }
});

test("flag policy allows only portfolio and home navigation callbacks", () => {
  for (const callbackData of [
    "trade_start_buy",
    "trade_confirm_123",
    "home_snipe",
    "home_copytrade_stop",
    "home_referrals",
    "premium_stars_buy",
    "premium_request",
    "home_help",
    "wdetail_wallet-1",
    "order_cancel_ask_123",
  ]) {
    assert.equal(isFlagRestrictedUpdate({ callbackData }), true, callbackData);
  }

  for (const callbackData of [
    "home",
    "home_wallets",
    "wallets_import",
    "wallets_portfolio",
  ]) {
    assert.equal(isFlagRestrictedUpdate({ callbackData }), false, callbackData);
  }
});

test("flag policy only allows free-text input during an active wallet import", () => {
  assert.equal(isFlagRestrictedUpdate({}), true);
  assert.equal(
    isFlagRestrictedUpdate({ isWalletImportInput: true }),
    false,
  );
});

test("flag policy blocks checkouts but permits processing an already completed payment", () => {
  assert.equal(
    isFlagRestrictedUpdate({ updateType: "pre_checkout_query" }),
    true,
  );
  assert.equal(
    isFlagRestrictedUpdate({
      updateType: "message",
      isSuccessfulPayment: true,
    }),
    false,
  );
});
