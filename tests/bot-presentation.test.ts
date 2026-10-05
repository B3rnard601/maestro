import assert from "node:assert/strict";
import test from "node:test";
import {
  tradingHeading,
  tradingSide,
  tradingStatus,
  triggerDirection,
} from "../src/bot/presentation.js";

test("trading headings use a consistent uppercase section treatment", () => {
  assert.equal(
    tradingHeading("📊", "Portfolio"),
    "📊  PORTFOLIO\n━━━━━━━━━━━━━━━━"
  );
});

test("buy and sell labels use distinct trading colors", () => {
  assert.equal(tradingSide("buy"), "🟢 BUY");
  assert.equal(tradingSide("sell"), "🔴 SELL");
  assert.equal(tradingSide("swap"), "🔹 SWAP");
});

test("trade statuses distinguish success, risk, and unknown outcomes", () => {
  assert.equal(tradingStatus("confirmed"), "✅ CONFIRMED");
  assert.equal(tradingStatus("failed"), "🔴 FAILED");
  assert.equal(tradingStatus("unknown"), "🟠 STATUS UNKNOWN");
  assert.equal(tradingStatus("processing"), "🟡 PROCESSING");
  assert.equal(tradingStatus("completed"), "✅ COMPLETED");
  assert.equal(tradingStatus("custom"), "🔹 CUSTOM");
});

test("limit-order trigger directions display clear arrows", () => {
  assert.equal(triggerDirection("above"), "↗️ ABOVE");
  assert.equal(triggerDirection("below"), "↘️ BELOW");
  assert.equal(triggerDirection("at"), "AT");
});
