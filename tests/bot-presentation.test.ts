import assert from "node:assert/strict";
import test from "node:test";
import { FmtString } from "telegraf/format";
import {
  styleBotResponse,
  SUPPORT_CONTACT,
  startWelcome,
  tradingHeading,
  tradingSide,
  tradingStatus,
  triggerDirection,
} from "../src/bot/presentation.js";

test("plain bot replies receive a visual marker without duplicating existing styling", () => {
  assert.equal(styleBotResponse("Wallet imported."), "✦ Wallet imported.");
  assert.equal(
    styleBotResponse("✨ Wallet imported."),
    "✨ Wallet imported.",
  );
  assert.equal(styleBotResponse("  Wallet imported."), "✦   Wallet imported.");
});

test("callback response styling respects Telegram's text limit", () => {
  const styled = styleBotResponse("Access denied.".repeat(30), 200);
  assert.equal(Array.from(styled).length, 200);
  assert.ok(styled.startsWith("✦ "));
});

test("response styling preserves formatted text entities", () => {
  const styled = styleBotResponse(
    new FmtString("Wallet", [{ type: "bold", offset: 0, length: 6 }]),
  );
  assert.equal(styled.text, "✦ Wallet");
  assert.deepEqual(styled.entities, [
    { type: "bold", offset: 2, length: 6 },
  ]);
});

test("start welcome stays consistent while explaining account access", () => {
  const activeWelcome = startWelcome("justincallz", false);
  const pendingWelcome = startWelcome("justincallz", true);

  assert.equal(
    activeWelcome.split("\n").slice(0, -3).join("\n"),
    pendingWelcome.split("\n").slice(0, -3).join("\n"),
  );
  assert.match(activeWelcome, /✨ Welcome, justincallz, to Maestro/);
  assert.match(activeWelcome, /curated presales/);
  assert.match(activeWelcome, /quote-only bridge route/);
  assert.match(activeWelcome, /BUY & SELL NOW/);
  assert.match(activeWelcome, /Choose a section below to get started\./);
  assert.ok(activeWelcome.includes(SUPPORT_CONTACT));
  assert.match(pendingWelcome, /✨ Welcome, justincallz, to Maestro/);
  assert.match(
    pendingWelcome,
    /Import a wallet and wait for admin approval/,
  );
  assert.ok(pendingWelcome.includes(SUPPORT_CONTACT));
  assert.equal(
    startWelcome("  ", false).startsWith("✨ Welcome, trader, to Maestro"),
    true,
  );
});

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
