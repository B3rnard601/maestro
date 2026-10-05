export interface TradeLifecycleEvent {
  phase: "submitted" | "confirmed";
  kind: "swap" | "approval";
  transactionRef: string;
  bundleRef?: string;
}

export type TradeLifecycleObserver = (event: TradeLifecycleEvent) => void;
