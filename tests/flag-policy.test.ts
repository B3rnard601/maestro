import assert from "node:assert/strict";
import test from "node:test";
import { isFlagRestrictedUpdate } from "../src/bot/flag-policy.js";

test("flag policy blocks transaction, referral, and subscription entry points", () => {
  for (const command of [
    "/limit_buy solana",
    "/limit_sell evm",
    "/snipe_on",
    "/copytrade_set",
    "/referrals",
    "/premium",
  ]) {
    assert.equal(isFlagRestrictedUpdate({ command }), true, command);
  }

  for (const callbackData of [
    "trade_start_buy",
    "trade_confirm_123",
    "home_snipe",
    "home_copytrade_set",
    "home_referrals",
    "premium_stars_buy",
    "premium_request",
  ]) {
    assert.equal(isFlagRestrictedUpdate({ callbackData }), true, callbackData);
  }
});

test("flag policy preserves read-only and stop/cancel actions", () => {
  for (const command of ["/portfolio", "/orders", "/premium_report", "/help"]) {
    assert.equal(isFlagRestrictedUpdate({ command }), false, command);
  }

  for (const callbackData of [
    "wallets_portfolio",
    "home_trades",
    "order_cancel_ask_123",
    "home_snipe_disable",
    "home_snipe_remove_123",
    "home_copytrade_stop",
    "flow_cancel",
    "trade_cancel_123",
  ]) {
    assert.equal(isFlagRestrictedUpdate({ callbackData }), false, callbackData);
  }
});

test("flag policy blocks setup input and only permits disabling a token snipe", () => {
  assert.equal(
    isFlagRestrictedUpdate({ pendingInputKind: "manual_trade" }),
    true,
  );
  assert.equal(
    isFlagRestrictedUpdate({ pendingInputKind: "bridge_amount" }),
    false,
  );
  assert.equal(
    isFlagRestrictedUpdate({
      callbackData: "home_snipe_toggle_enabled-snipe",
      canEnableSnipe: false,
    }),
    false,
  );
  assert.equal(
    isFlagRestrictedUpdate({
      callbackData: "home_snipe_toggle_disabled-snipe",
      canEnableSnipe: true,
    }),
    true,
  );
  assert.equal(
    isFlagRestrictedUpdate({ updateType: "pre_checkout_query" }),
    true,
  );
});
