import assert from "node:assert/strict";
import test from "node:test";
import { getNativeBridgeQuote } from "../src/bridge/lifi.js";

const solanaChain = {
  id: 1151111081099710,
  chainType: "SVM",
  name: "Solana",
  mainnet: true,
  nativeToken: {
    address: "11111111111111111111111111111111",
    symbol: "SOL",
    decimals: 9,
  },
};

const ethereumChain = {
  id: 1,
  chainType: "EVM",
  name: "Ethereum",
  mainnet: true,
  nativeToken: {
    address: "0x0000000000000000000000000000000000000000",
    symbol: "ETH",
    decimals: 18,
  },
};

test("bridge quote requests use native token addresses and never submit transactions", async () => {
  const requestedUrls: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    if (url.pathname.endsWith("/chains")) {
      return Response.json({
        chains: url.searchParams.get("chainTypes") === "SVM"
          ? [solanaChain]
          : [ethereumChain],
      });
    }
    return Response.json({
      tool: "test-bridge",
      transactionRequest: { to: "must-not-be-returned" },
      estimate: {
        fromAmount: "100000000",
        toAmount: "2000000000000000",
        toAmountMin: "1900000000000000",
        executionDuration: 120,
      },
    });
  };

  const quote = await getNativeBridgeQuote({
    fromChain: "solana",
    toChain: "evm",
    amount: "0.1",
    fromAddress: "solana-public-address",
    toAddress: "0x0000000000000000000000000000000000000001",
    evmChainId: 1,
    fetcher,
  });

  assert.equal(quote.fromAmount, "0.1");
  assert.equal(quote.fromSymbol, "SOL");
  assert.equal(quote.toAmount, "0.002");
  assert.equal(quote.minimumToAmount, "0.0019");
  assert.equal(quote.estimatedSeconds, 120);
  assert.equal("transactionRequest" in quote, false);
  const quoteUrl = requestedUrls.find((url) => url.pathname.endsWith("/quote"));
  assert.ok(quoteUrl);
  assert.equal(quoteUrl.searchParams.get("fromAmount"), "100000000");
  assert.equal(
    quoteUrl.searchParams.get("fromToken"),
    "11111111111111111111111111111111",
  );
});

test("bridge quote rejects same-chain requests before contacting LI.FI", async () => {
  let requests = 0;
  await assert.rejects(
    getNativeBridgeQuote({
      fromChain: "evm",
      toChain: "evm",
      amount: "1",
      fromAddress: "0x1",
      toAddress: "0x2",
      evmChainId: 1,
      fetcher: async () => {
        requests += 1;
        return Response.json({});
      },
    }),
    /Choose two different networks/,
  );
  assert.equal(requests, 0);
});
