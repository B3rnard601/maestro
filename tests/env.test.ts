import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RPC_ENDPOINTS } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/env.js";

const requiredEnvironment = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_OWNER_ID: "123456",
  VAULT_MASTER_KEY: "a".repeat(64),
  SOLANA_JITO_BLOCK_ENGINE: "https://jito.example",
  EVM_RPC_HTTP: "https://evm.example/rpc",
  EVM_RPC_WSS: "wss://evm.example/ws",
  EVM_FLASHBOTS_RPC: "https://flashbots.example",
  UNISWAP_V2_FACTORY: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
};

test("Solana RPC configuration falls back to public endpoints without API keys", () => {
  const config = loadConfig(requiredEnvironment);

  assert.equal(config.solanaRpcHttp, DEFAULT_RPC_ENDPOINTS.solanaHttp);
  assert.equal(config.solanaRpcWss, DEFAULT_RPC_ENDPOINTS.solanaWebSocket);
});

test("blank Solana RPC overrides use public endpoints", () => {
  const config = loadConfig({
    ...requiredEnvironment,
    SOLANA_RPC_HTTP: "",
    SOLANA_RPC_WSS: "",
  });

  assert.equal(config.solanaRpcHttp, DEFAULT_RPC_ENDPOINTS.solanaHttp);
  assert.equal(config.solanaRpcWss, DEFAULT_RPC_ENDPOINTS.solanaWebSocket);
});

test("configured Solana RPC endpoints override public defaults", () => {
  const config = loadConfig({
    ...requiredEnvironment,
    SOLANA_RPC_HTTP: "https://solana.example/rpc",
    SOLANA_RPC_WSS: "wss://solana.example/ws",
  });

  assert.equal(config.solanaRpcHttp, "https://solana.example/rpc");
  assert.equal(config.solanaRpcWss, "wss://solana.example/ws");
});

test("invalid configured RPC endpoints are rejected", () => {
  assert.throws(
    () =>
      loadConfig({
        ...requiredEnvironment,
        SOLANA_RPC_HTTP: "wss://wrong-protocol.example",
      }),
    /SOLANA_RPC_HTTP must use http: or https:/,
  );
});
