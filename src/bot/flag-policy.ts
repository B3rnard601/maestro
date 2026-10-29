const RESTRICTED_COMMANDS = new Set([
  "copytrade_config",
  "copytrade_set",
  "limit_buy",
  "limit_sell",
  "premium",
  "referrals",
  "snipe_on",
  "snipe_size",
]);

const RESTRICTED_PENDING_INPUTS = new Set([
  "auto_snipe",
  "auto_snipe_config",
  "copy_max",
  "copy_ratio",
  "copy_sells",
  "copy_target",
  "manual_trade",
  "order_value",
  "snipe_size",
]);

export function isFlagRestrictedUpdate(input: {
  command?: string;
  callbackData?: string;
  updateType?: string;
  pendingInputKind?: string;
  canEnableSnipe?: boolean;
}): boolean {
  const command = input.command
    ?.trim()
    .split(/\s/, 1)[0]
    .split("@")[0]
    .replace(/^\//, "")
    .toLowerCase();
  const callback = input.callbackData ?? "";

  if (command && RESTRICTED_COMMANDS.has(command)) return true;
  if (input.updateType === "pre_checkout_query") return true;
  if (input.pendingInputKind && RESTRICTED_PENDING_INPUTS.has(input.pendingInputKind)) {
    return true;
  }

  if (
    callback === "home_referrals" ||
    callback === "home_premium" ||
    callback === "premium_stars_buy" ||
    callback === "premium_request" ||
    callback === "home_trade" ||
    callback.startsWith("trade_start_") ||
    callback.startsWith("trade_chain_") ||
    callback.startsWith("trade_confirm_") ||
    callback === "home_snipe" ||
    (callback.startsWith("home_snipe_") &&
      callback !== "home_snipe_disable" &&
      !callback.startsWith("home_snipe_remove_") &&
      !callback.startsWith("home_snipe_toggle_")) ||
    (callback.startsWith("home_snipe_toggle_") && input.canEnableSnipe) ||
    (callback.startsWith("home_copytrade") && callback !== "home_copytrade_stop") ||
    callback === "copy_sells_0" ||
    callback === "copy_sells_1" ||
    callback.startsWith("order_new_") ||
    callback.startsWith("order_chain_") ||
    callback.startsWith("order_direction_")
  ) {
    return true;
  }

  return false;
}
