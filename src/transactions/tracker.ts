import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  createTradeLifecycle,
  recordTradeSubmission,
  updateTradeLifecycle,
  type TradeLifecycleInput,
} from "../db/db.js";
import type { TradeLifecycleEvent, TradeLifecycleObserver } from "./types.js";

export function beginTrackedTrade(
  db: Database.Database,
  trade: Omit<TradeLifecycleInput, "id">
): { id: string; observe: TradeLifecycleObserver; failIfNotSubmitted: (error: unknown) => void; readonly wasSubmitted: boolean } {
  const id = randomUUID();
  createTradeLifecycle(db, { id, ...trade });
  let submitted = false;

  const observe = (event: TradeLifecycleEvent) => {
    recordTradeSubmission(db, id, event);
    submitted = true;
    if (event.phase === "confirmed" && event.kind === "swap") {
      updateTradeLifecycle(db, id, "confirmed");
    }
  };

  const failIfNotSubmitted = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const row = db.prepare(`SELECT status FROM trade_lifecycle WHERE id = ?`).get(id) as { status: string };
    if (row.status === "prepared") updateTradeLifecycle(db, id, "failed", message.slice(0, 500));
  };

  return { id, observe, failIfNotSubmitted, get wasSubmitted() { return submitted; } };
}
