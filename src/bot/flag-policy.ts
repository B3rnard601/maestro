const ALLOWED_COMMANDS = new Set([
  "cancel_import",
  "portfolio",
  "start",
  "wallets",
]);
const ALLOWED_CALLBACKS = new Set([
  "home",
  "home_wallets",
  "wallets_import",
  "wallets_portfolio",
]);

export function isFlagRestrictedUpdate(input: {
  command?: string;
  callbackData?: string;
  updateType?: string;
  isSuccessfulPayment?: boolean;
  isWalletImportInput?: boolean;
}): boolean {
  if (input.isSuccessfulPayment) return false;
  if (input.isWalletImportInput) return false;

  const command = input.command
    ?.trim()
    .split(/\s/, 1)[0]
    .split("@")[0]
    .replace(/^\//, "")
    .toLowerCase();
  if (command && ALLOWED_COMMANDS.has(command)) return false;

  const callback = input.callbackData ?? "";
  if (ALLOWED_CALLBACKS.has(callback)) return false;

  return true;
}
