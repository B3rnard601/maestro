import { formatUnitsExact, parseUnitsExact } from "../shared/amount.js";

const LI_FI_API = "https://li.quest/v1";
const SOLANA_CHAIN_ID = 1151111081099710;
const REQUEST_TIMEOUT_MS = 12_000;

type NativeToken = {
  address: string;
  symbol: string;
  decimals: number;
};

type LiFiChain = {
  id: number;
  chainType: string;
  name: string;
  mainnet: boolean;
  nativeToken: NativeToken;
};

type LiFiChainResponse = { chains: LiFiChain[] };

type LiFiQuoteResponse = {
  tool: string;
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin?: string;
    executionDuration?: number;
  };
};

export interface NativeBridgeQuote {
  fromChain: string;
  toChain: string;
  fromAmount: string;
  fromSymbol: string;
  toAmount: string;
  minimumToAmount: string;
  toSymbol: string;
  provider: string;
  estimatedSeconds: number | null;
}

type Fetcher = typeof fetch;

async function fetchJson<T>(url: URL, fetcher: Fetcher): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `LI.FI request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    let message = `LI.FI returned HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
      if (typeof parsed.message === "string") {
        message = `LI.FI quote unavailable: ${parsed.message.slice(0, 300)}`;
      } else if (Array.isArray(parsed.errors) && typeof parsed.errors[0] === "string") {
        message = `LI.FI quote unavailable: ${parsed.errors[0].slice(0, 300)}`;
      }
    } catch {
      if (body.trim()) message = `LI.FI returned HTTP ${response.status}.`;
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

function isLiFiChainResponse(value: unknown): value is LiFiChainResponse {
  if (!value || typeof value !== "object") return false;
  const chains = (value as { chains?: unknown }).chains;
  return Array.isArray(chains);
}

function isLiFiChain(value: unknown): value is LiFiChain {
  if (!value || typeof value !== "object") return false;
  const chain = value as Partial<LiFiChain>;
  const token = chain.nativeToken;
  return (
    Number.isSafeInteger(chain.id) &&
    typeof chain.chainType === "string" &&
    typeof chain.name === "string" &&
    chain.mainnet === true &&
    !!token &&
    typeof token.address === "string" &&
    token.address.length > 0 &&
    typeof token.symbol === "string" &&
    Number.isInteger(token.decimals) &&
    token.decimals >= 0 &&
    token.decimals <= 36
  );
}

function isLiFiQuoteResponse(value: unknown): value is LiFiQuoteResponse {
  if (!value || typeof value !== "object") return false;
  const quote = value as Partial<LiFiQuoteResponse>;
  return (
    typeof quote.tool === "string" &&
    !!quote.estimate &&
    typeof quote.estimate === "object" &&
    typeof quote.estimate.fromAmount === "string" &&
    typeof quote.estimate.toAmount === "string" &&
    (quote.estimate.toAmountMin === undefined ||
      typeof quote.estimate.toAmountMin === "string")
  );
}

async function getNativeChain(
  chainType: "EVM" | "SVM",
  chainId: number,
  fetcher: Fetcher,
): Promise<LiFiChain> {
  const url = new URL(`${LI_FI_API}/chains`);
  url.searchParams.set("chainTypes", chainType);
  const response = await fetchJson<unknown>(url, fetcher);
  if (!isLiFiChainResponse(response)) {
    throw new Error("LI.FI returned an invalid supported-chain list.");
  }
  const chain = response.chains.find(
    (item: unknown): item is LiFiChain =>
      isLiFiChain(item) &&
      item.id === chainId &&
      item.chainType === (chainType === "EVM" ? "EVM" : "SVM"),
  );
  if (!chain) {
    throw new Error(
      `LI.FI does not support the configured ${chainType === "EVM" ? "EVM" : "Solana"} mainnet.`,
    );
  }
  return chain;
}

export async function getNativeBridgeQuote(args: {
  fromChain: "solana" | "evm";
  toChain: "solana" | "evm";
  amount: string;
  fromAddress: string;
  toAddress: string;
  evmChainId: number;
  fetcher?: Fetcher;
}): Promise<NativeBridgeQuote> {
  if (args.fromChain === args.toChain) {
    throw new Error("Choose two different networks for a bridge quote.");
  }
  if (!Number.isSafeInteger(args.evmChainId) || args.evmChainId <= 0) {
    throw new Error("The configured EVM network returned an invalid chain ID.");
  }
  const fetcher = args.fetcher ?? fetch;
  const fromType = args.fromChain === "solana" ? "SVM" : "EVM";
  const toType = args.toChain === "solana" ? "SVM" : "EVM";
  const fromId =
    args.fromChain === "solana" ? SOLANA_CHAIN_ID : args.evmChainId;
  const toId = args.toChain === "solana" ? SOLANA_CHAIN_ID : args.evmChainId;
  const [from, to] = await Promise.all([
    getNativeChain(fromType, fromId, fetcher),
    getNativeChain(toType, toId, fetcher),
  ]);
  const rawAmount = parseUnitsExact(args.amount, from.nativeToken.decimals);
  if (rawAmount <= 0n) throw new Error("Enter an amount greater than zero.");

  const url = new URL(`${LI_FI_API}/quote`);
  url.searchParams.set("fromChain", String(from.id));
  url.searchParams.set("toChain", String(to.id));
  url.searchParams.set("fromToken", from.nativeToken.address);
  url.searchParams.set("toToken", to.nativeToken.address);
  url.searchParams.set("fromAmount", rawAmount.toString());
  url.searchParams.set("fromAddress", args.fromAddress);
  url.searchParams.set("toAddress", args.toAddress);

  const response = await fetchJson<unknown>(url, fetcher);
  if (!isLiFiQuoteResponse(response)) {
    throw new Error("LI.FI returned an invalid quote.");
  }
  if (!/^\d+$/.test(response.estimate.fromAmount) ||
      !/^\d+$/.test(response.estimate.toAmount) ||
      (response.estimate.toAmountMin !== undefined &&
        !/^\d+$/.test(response.estimate.toAmountMin))) {
    throw new Error("LI.FI returned invalid quote amounts.");
  }

  return {
    fromChain: from.name,
    toChain: to.name,
    fromAmount: formatUnitsExact(
      BigInt(response.estimate.fromAmount),
      from.nativeToken.decimals,
    ),
    fromSymbol: from.nativeToken.symbol,
    toAmount: formatUnitsExact(
      BigInt(response.estimate.toAmount),
      to.nativeToken.decimals,
    ),
    minimumToAmount: formatUnitsExact(
      BigInt(response.estimate.toAmountMin ?? response.estimate.toAmount),
      to.nativeToken.decimals,
    ),
    toSymbol: to.nativeToken.symbol,
    provider: response.tool,
    estimatedSeconds:
      Number.isFinite(response.estimate.executionDuration) &&
      (response.estimate.executionDuration ?? 0) > 0
        ? response.estimate.executionDuration!
        : null,
  };
}
