import { FmtString } from "telegraf/format";

const SECTION_RULE = "━━━━━━━━━━━━━━━━";

export function styleBotResponse(text: string, maxLength?: number): string;
export function styleBotResponse(text: FmtString<string>): FmtString<string>;
export function styleBotResponse(
  text: string | FmtString<string>,
): string | FmtString<string>;
export function styleBotResponse(
  text: string | FmtString<string>,
  maxLength?: number,
): string | FmtString<string> {
  const content = typeof text === "string" ? text : text.text;
  const firstVisibleCharacter = content.trimStart();
  const needsMarker = !/^[\p{Extended_Pictographic}\p{S}]/u.test(
    firstVisibleCharacter,
  );
  const styled =
    typeof text === "string"
      ? needsMarker
        ? `✦ ${text}`
        : text
      : needsMarker
        ? new FmtString(
            `✦ ${text.text}`,
            text.entities?.map((entity) => ({
              ...entity,
              offset: entity.offset + 2,
            })),
          )
        : text;
  return typeof styled === "string" && maxLength !== undefined
    ? Array.from(styled).slice(0, maxLength).join("")
    : styled;
}

export function startWelcome(firstName: string, requiresApproval: boolean): string {
  const greeting = firstName.trim() || "trader";
  return [
    `✨ Welcome, ${greeting}, to Maestro — your on-chain trading desk!`,
    "",
    "Explore chains, wallets, settings, premium price signals, auto-snipe, copy trading, orders, and positions. Browse curated presales, track referrals, or request a quote-only bridge route below.",
    "",
    "⚡ For a quick buy or sell, tap BUY & SELL NOW. Every trade is quoted and requires your confirmation.",
    requiresApproval
      ? "Import a wallet and wait for admin approval to unlock account features."
      : "Choose a section below to get started.",
  ].join("\n");
}

export function tradingHeading(icon: string, title: string): string {
  return `${icon}  ${title.toUpperCase()}\n${SECTION_RULE}`;
}

export function tradingSide(side: string): string {
  if (side.toLowerCase() === "buy") return "🟢 BUY";
  if (side.toLowerCase() === "sell") return "🔴 SELL";
  return `🔹 ${side.toUpperCase()}`;
}

const STATUS_STYLES: Record<string, string> = {
  active: "🟢 ACTIVE",
  approved: "✅ APPROVED",
  banned: "🔴 BANNED",
  cancelled: "⚪ CANCELLED",
  completed: "✅ COMPLETED",
  confirmed: "✅ CONFIRMED",
  failed: "🔴 FAILED",
  filled: "✅ FILLED",
  open: "🟢 OPEN",
  pending: "🟡 PENDING",
  prepared: "🟡 PREPARED",
  processing: "🟡 PROCESSING",
  queued: "🟡 QUEUED",
  retrying: "🟠 RETRYING",
  submitted: "🟡 SUBMITTED",
  unknown: "🟠 STATUS UNKNOWN",
};

export function tradingStatus(status: string): string {
  return STATUS_STYLES[status.toLowerCase()] ?? `🔹 ${status.toUpperCase()}`;
}

export function triggerDirection(direction: string): string {
  if (direction.toLowerCase() === "above") return "↗️ ABOVE";
  if (direction.toLowerCase() === "below") return "↘️ BELOW";
  return direction.toUpperCase();
}
