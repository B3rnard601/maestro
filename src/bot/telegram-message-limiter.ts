import type { Telegram } from "telegraf";

type PendingMessage = {
  chatId: string;
  priority: "user" | "admin";
  send: () => Promise<unknown>;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
};

function retryAfterSeconds(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const response = error as {
    code?: number;
    parameters?: { retry_after?: number };
  };
  if (response.code !== 429) return undefined;

  const retryAfter = response.parameters?.retry_after;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter)
    ? retryAfter
    : 1;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class TelegramMessageLimiter {
  private readonly userQueue: PendingMessage[] = [];
  private readonly adminQueue: PendingMessage[] = [];
  private readonly nextChatSendAt = new Map<string, number>();
  private processing = false;
  private nextGlobalSendAt = 0;
  private wakeWaiter: (() => void) | undefined;

  constructor(
    private readonly globalIntervalMs = 40,
    private readonly chatIntervalMs = 1100,
  ) {}

  send<T>(
    chatId: number | string,
    send: () => Promise<T>,
    priority: "user" | "admin" = "user",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending = {
        chatId: String(chatId),
        priority,
        send,
        resolve: (result) => resolve(result as T),
        reject,
      } satisfies PendingMessage;
      (priority === "user" ? this.userQueue : this.adminQueue).push(pending);
      this.wakeWaiter?.();
      void this.processQueue();
    });
  }

  private async waitForQueueOrTimeout(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeWaiter = undefined;
        resolve();
      }, milliseconds);
      this.wakeWaiter = () => {
        clearTimeout(timer);
        this.wakeWaiter = undefined;
        resolve();
      };
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.userQueue.length > 0 || this.adminQueue.length > 0) {
        const now = Date.now();
        const globalWait = this.nextGlobalSendAt - now;
        if (globalWait > 0) {
          await wait(globalWait);
          continue;
        }

        const userIndex = this.userQueue.findIndex(
          (message) => (this.nextChatSendAt.get(message.chatId) ?? 0) <= now,
        );
        const adminIndex = this.adminQueue.findIndex(
          (message) => (this.nextChatSendAt.get(message.chatId) ?? 0) <= now,
        );
        const pending =
          userIndex >= 0
            ? this.userQueue.splice(userIndex, 1)[0]
            : adminIndex >= 0
              ? this.adminQueue.splice(adminIndex, 1)[0]
              : undefined;

        if (!pending) {
          const nextChatSendAt = [
            ...this.userQueue,
            ...this.adminQueue,
          ].reduce(
            (earliest, message) =>
              Math.min(
                earliest,
                this.nextChatSendAt.get(message.chatId) ?? 0,
              ),
            Number.POSITIVE_INFINITY,
          );
          await this.waitForQueueOrTimeout(
            Math.max(1, nextChatSendAt - Date.now()),
          );
          continue;
        }

        try {
          while (true) {
            this.nextGlobalSendAt = Date.now() + this.globalIntervalMs;
            this.nextChatSendAt.set(
              pending.chatId,
              Date.now() + this.chatIntervalMs,
            );

            try {
              pending.resolve(await pending.send());
              break;
            } catch (error) {
              const retryAfter = retryAfterSeconds(error);
              if (retryAfter === undefined) throw error;

              const retryAt = Date.now() + retryAfter * 1000;
              this.nextChatSendAt.set(
                pending.chatId,
                Math.max(
                  this.nextChatSendAt.get(pending.chatId) ?? 0,
                  retryAt,
                ),
              );
              console.warn(
                `[bot] Telegram rate limit reached; retrying message in ${retryAfter}s.`,
              );
              (pending.priority === "user" ? this.userQueue : this.adminQueue)
                .unshift(pending);
              break;
            }
          }
        } catch (error) {
          pending.reject(error);
        }
      }
    } finally {
      this.processing = false;
      if (this.userQueue.length > 0 || this.adminQueue.length > 0) {
        void this.processQueue();
      }
    }
  }
}

export function rateLimitTelegramMessages(
  telegram: Telegram,
  limiter: TelegramMessageLimiter,
  adminChatId: string,
): void {
  const sendMessage = telegram.sendMessage.bind(telegram);
  telegram.sendMessage = (chatId, text, extra) => {
    const priority = String(chatId) === adminChatId ? "admin" : "user";
    return limiter.send(
      chatId,
      () => sendMessage(chatId, text, extra),
      priority,
    );
  };
}
