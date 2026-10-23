import assert from "node:assert/strict";
import test from "node:test";
import { TelegramMessageLimiter } from "../src/bot/telegram-message-limiter.js";

test("Telegram messages to the same chat are spaced out", async () => {
  const limiter = new TelegramMessageLimiter(0, 25);
  const sentAt: number[] = [];

  await Promise.all(
    Array.from({ length: 3 }, () =>
      limiter.send("123", async () => {
        sentAt.push(Date.now());
      }),
    ),
  );

  assert.equal(sentAt.length, 3);
  assert.ok(sentAt[1] - sentAt[0] >= 20);
  assert.ok(sentAt[2] - sentAt[1] >= 20);
});

test("Telegram messages across chats respect the global send interval", async () => {
  const limiter = new TelegramMessageLimiter(25, 0);
  const sentAt: number[] = [];

  await Promise.all(
    ["123", "456", "789"].map((chatId) =>
      limiter.send(chatId, async () => {
        sentAt.push(Date.now());
      }),
    ),
  );

  assert.equal(sentAt.length, 3);
  assert.ok(sentAt[1] - sentAt[0] >= 20);
  assert.ok(sentAt[2] - sentAt[1] >= 20);
});

test("user messages are sent before queued admin notifications", async () => {
  const limiter = new TelegramMessageLimiter(0, 0);
  const sent: string[] = [];
  let releaseFirstSend: (() => void) | undefined;
  let markFirstSendStarted: (() => void) | undefined;
  const firstSendStarted = new Promise<void>((resolve) => {
    markFirstSendStarted = resolve;
  });
  const firstSendGate = new Promise<void>((resolve) => {
    releaseFirstSend = resolve;
  });

  const first = limiter.send(
    "admin",
    async () => {
      markFirstSendStarted?.();
      await firstSendGate;
      sent.push("first");
    },
    "admin",
  );
  await firstSendStarted;

  const adminNotification = limiter.send(
    "admin",
    async () => {
      sent.push("admin");
    },
    "admin",
  );
  const userReply = limiter.send("user", async () => {
    sent.push("user");
  });
  releaseFirstSend?.();

  await Promise.all([first, adminNotification, userReply]);
  assert.deepEqual(sent, ["first", "user", "admin"]);
});

test("Telegram messages retry after a 429 using retry_after", async () => {
  const limiter = new TelegramMessageLimiter(0, 0);
  let attempts = 0;

  const result = await limiter.send("123", async () => {
    attempts += 1;
    if (attempts === 1) {
      throw { code: 429, parameters: { retry_after: 0 } };
    }
    return "sent";
  });

  assert.equal(result, "sent");
  assert.equal(attempts, 2);
});

test("a chat-specific 429 does not delay other users", async () => {
  const limiter = new TelegramMessageLimiter(0, 0);
  let releaseRetry: (() => void) | undefined;
  let markFirstAttempt: (() => void) | undefined;
  const firstAttempt = new Promise<void>((resolve) => {
    markFirstAttempt = resolve;
  });
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let attempts = 0;

  const rateLimitedMessage = limiter.send("user-1", async () => {
    attempts += 1;
    if (attempts === 1) {
      markFirstAttempt?.();
      await retryGate;
      throw { code: 429, parameters: { retry_after: 1 } };
    }
    return "retried";
  });
  await firstAttempt;

  const otherUserMessage = limiter.send("user-2", async () => "sent");
  releaseRetry?.();

  assert.equal(await otherUserMessage, "sent");
  assert.equal(attempts, 1);
  assert.equal(await rateLimitedMessage, "retried");
});
