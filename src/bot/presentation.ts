const SECTION_RULE = "━━━━━━━━━━━━━━━━";

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
