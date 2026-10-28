import { isAddress } from "ethers";
import { parseUnitsExact } from "../shared/amount.js";
import { DEFAULT_RPC_ENDPOINTS } from "./defaults.js";

export interface AppConfig {
  telegramBotToken: string;
  telegramOwnerId: string;
  vaultMasterKey: string;
  solanaRpcHttp: string;
  solanaRpcWss: string;
  solanaJitoBlockEngine: string;
  evmRpcHttp: string;
  evmRpcWss: string;
  evmFlashbotsRpc: string;
  uniswapV2Factory: string;
  maxTradeSol: string;
  maxTradeEth: string;
  maxDailySpendSol: string;
  maxDailySpendEth: string;
  maxSlippageBps: number;
  tradeQuoteTtlSeconds: number;
}

function readUrl(
  env: NodeJS.ProcessEnv,
  name: string,
  protocols: string[],
  errors: string[],
  fallback?: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    if (fallback) return fallback;
    errors.push(`${name} is required.`);
    return "";
  }

  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol)) errors.push(`${name} must use ${protocols.join(" or ")}.`);
  } catch {
    errors.push(`${name} must be a valid URL.`);
  }
  return value;
}

function readPositiveAmount(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
  decimals: number,
  errors: string[]
): string {
  const value = env[name]?.trim() || fallback;
  try {
    if (parseUnitsExact(value, decimals) <= 0n) errors.push(`${name} must be greater than zero.`);
  } catch {
    errors.push(`${name} must be a plain decimal amount with at most ${decimals} fractional digits.`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const telegramOwnerId = env.TELEGRAM_OWNER_ID?.trim() ?? "";
  const vaultMasterKey = env.VAULT_MASTER_KEY?.trim() ?? "";
  const uniswapV2Factory = env.UNISWAP_V2_FACTORY?.trim() ?? "";

  if (!telegramBotToken) errors.push("TELEGRAM_BOT_TOKEN is required.");
  if (!/^\d+$/.test(telegramOwnerId)) errors.push("TELEGRAM_OWNER_ID must be a numeric Telegram user ID.");
  if (!/^[0-9a-fA-F]{64}$/.test(vaultMasterKey)) errors.push("VAULT_MASTER_KEY must be exactly 32 bytes encoded as 64 hexadecimal characters.");
  if (!isAddress(uniswapV2Factory)) errors.push("UNISWAP_V2_FACTORY must be a valid EVM address.");

  const solanaRpcHttp = readUrl(env, "SOLANA_RPC_HTTP", ["http:", "https:"], errors, DEFAULT_RPC_ENDPOINTS.solanaHttp);
  const solanaRpcWss = readUrl(env, "SOLANA_RPC_WSS", ["ws:", "wss:"], errors, DEFAULT_RPC_ENDPOINTS.solanaWebSocket);
  const solanaJitoBlockEngine = readUrl(env, "SOLANA_JITO_BLOCK_ENGINE", ["http:", "https:"], errors);
  const evmRpcHttp = readUrl(env, "EVM_RPC_HTTP", ["http:", "https:"], errors);
  const evmRpcWss = readUrl(env, "EVM_RPC_WSS", ["ws:", "wss:"], errors);
  const evmFlashbotsRpc = readUrl(env, "EVM_FLASHBOTS_RPC", ["http:", "https:"], errors);

  const maxTradeSol = readPositiveAmount(env, "MAX_TRADE_SOL", "0.1", 9, errors);
  const maxTradeEth = readPositiveAmount(env, "MAX_TRADE_ETH", "0.05", 18, errors);
  const maxDailySpendSol = readPositiveAmount(env, "MAX_DAILY_SPEND_SOL", "1", 9, errors);
  const maxDailySpendEth = readPositiveAmount(env, "MAX_DAILY_SPEND_ETH", "0.5", 18, errors);
  const maxSlippageBps = Number(env.MAX_SLIPPAGE_BPS ?? "500");
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 1 || maxSlippageBps > 500) {
    errors.push("MAX_SLIPPAGE_BPS must be an integer between 1 and 500.");
  }
  const tradeQuoteTtlSeconds = Number(env.TRADE_QUOTE_TTL_SECONDS ?? "60");
  if (!Number.isInteger(tradeQuoteTtlSeconds) || tradeQuoteTtlSeconds < 10 || tradeQuoteTtlSeconds > 300) {
    errors.push("TRADE_QUOTE_TTL_SECONDS must be an integer between 10 and 300.");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join("\n- ")}`);
  }

  return {
    telegramBotToken,
    telegramOwnerId,
    vaultMasterKey,
    solanaRpcHttp,
    solanaRpcWss,
    solanaJitoBlockEngine,
    evmRpcHttp,
    evmRpcWss,
    evmFlashbotsRpc,
    uniswapV2Factory,
    maxTradeSol,
    maxTradeEth,
    maxDailySpendSol,
    maxDailySpendEth,
    maxSlippageBps,
    tradeQuoteTtlSeconds,
  };
}
