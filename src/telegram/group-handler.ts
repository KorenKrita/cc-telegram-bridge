/**
 * Group Handler
 *
 * Receives Telegram group messages, routes them based on priority:
 * 1. @mention > 2. reply_to > 3. ignore
 *
 * Bot identity is resolved at runtime via getMe API.
 */

import { MessageParser } from "./message-parser.js";
import type {
  TelegramMessage,
  TelegramUpdate,
  GroupMessageInput,
  GroupHandlerOptions,
  GroupHandlerState,
  BotIdentity,
  RoutingContext,
  GetUpdatesResponse,
  GetMeResponse,
} from "./types.js";

export class GroupHandler {
  private state: GroupHandlerState = {
    isRunning: false,
  };
  private parser?: MessageParser;
  private pollingTimer?: ReturnType<typeof setTimeout>;
  private readonly pollingIntervalMs: number;

  constructor(private readonly options: GroupHandlerOptions) {
    this.pollingIntervalMs = options.pollingIntervalMs ?? 1000;
  }

  /**
   * Start listening for group messages
   * Runs in background, doesn't block
   */
  async start(): Promise<void> {
    if (this.state.isRunning) {
      return;
    }

    this.state.isRunning = true;

    // Resolve bot identity on first start
    if (!this.state.botUsername || !this.state.botId) {
      try {
        const identity = await this.resolveBotIdentity();
        this.state.botUsername = identity.username;
        this.state.botId = identity.id;
        this.parser = new MessageParser(identity.username);
        console.log(
          `[GroupHandler] Bot identity resolved: @${identity.username} (id: ${identity.id})`
        );
      } catch (error) {
        console.error("[GroupHandler] Failed to resolve bot identity:", error);
        this.state.isRunning = false;
        throw error;
      }
    }

    // Start polling loop
    this.scheduleNextPoll();
    console.log("[GroupHandler] Started polling for group messages");
  }

  /**
   * Stop listening
   */
  async stop(): Promise<void> {
    this.state.isRunning = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    console.log("[GroupHandler] Stopped");
  }

  /**
   * Resolve bot identity via getMe API
   */
  private async resolveBotIdentity(): Promise<BotIdentity> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.options.botToken}/getMe`
    );

    if (!response.ok) {
      throw new Error(
        `getMe API failed: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as GetMeResponse;

    if (!data.ok) {
      throw new Error("getMe API returned ok: false");
    }

    return {
      username: data.result.username,
      id: data.result.id,
      fetchedAt: Date.now(),
    };
  }

  /**
   * Schedule next polling iteration
   */
  private scheduleNextPoll(): void {
    if (!this.state.isRunning) {
      return;
    }

    this.pollingTimer = setTimeout(() => {
      void this.pollOnce();
    }, this.pollingIntervalMs);
  }

  /**
   * Single polling iteration
   */
  private async pollOnce(): Promise<void> {
    if (!this.state.isRunning) {
      return;
    }

    try {
      const updates = await this.fetchUpdates();

      for (const update of updates) {
        await this.processUpdate(update);
        // Update last processed update_id
        this.state.lastUpdateId = update.update_id;
      }
    } catch (error) {
      console.error("[GroupHandler] Polling error:", error);
    } finally {
      this.scheduleNextPoll();
    }
  }

  /**
   * Fetch updates from Telegram API
   */
  private async fetchUpdates(): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams();
    params.set("limit", "100");

    if (this.state.lastUpdateId) {
      // Fetch updates after the last processed one
      params.set("offset", String(this.state.lastUpdateId + 1));
    }

    const response = await fetch(
      `https://api.telegram.org/bot${this.options.botToken}/getUpdates?${params.toString()}`
    );

    if (!response.ok) {
      throw new Error(
        `getUpdates API failed: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as GetUpdatesResponse;

    if (!data.ok) {
      throw new Error("getUpdates API returned ok: false");
    }

    return data.result;
  }

  /**
   * Process a single update
   */
  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message ?? update.edited_message;
    if (!message) {
      return;
    }

    // Only process group/supergroup messages
    if (message.chat.type !== "group" && message.chat.type !== "supergroup") {
      return;
    }

    // Check allowed chat IDs if configured
    if (
      this.options.allowedChatIds &&
      this.options.allowedChatIds.length > 0 &&
      !this.options.allowedChatIds.includes(message.chat.id)
    ) {
      return;
    }

    // Determine routing
    const routing = this.shouldRoute(message);
    if (!routing) {
      // Not for this bot
      return;
    }

    // Parse the message
    if (!this.parser) {
      console.error("[GroupHandler] Parser not initialized");
      return;
    }

    const parsed = this.parser.parse(message, routing);
    if (!parsed) {
      // Empty or invalid content
      return;
    }

    // Deliver to handler
    try {
      await this.options.onMessage(parsed);
    } catch (error) {
      console.error("[GroupHandler] onMessage handler error:", error);
    }
  }

  /**
   * Determine if message should be routed to this bot
   *
   * Priority:
   * 1. @mention → route to mentioned bot
   * 2. reply_to → route if replying to this bot
   * 3. Otherwise → ignore
   */
  private shouldRoute(message: TelegramMessage): RoutingContext | null {
    const text = message.text ?? "";

    // Priority 1: Check if bot is mentioned
    if (this.parser?.isMentioned(text)) {
      return { isMentioned: true, isReply: false };
    }

    // Priority 2: Check if replying to this bot
    if (this.isReplyToMe(message)) {
      return {
        isMentioned: false,
        isReply: true,
        replyToBotId: message.reply_to_message?.from?.id,
      };
    }

    // Not for this bot
    return null;
  }

  /**
   * Check if message is a reply to this bot's message
   */
  private isReplyToMe(message: TelegramMessage): boolean {
    const replyTo = message.reply_to_message;
    if (!replyTo?.from) {
      return false;
    }

    // Check if the replied message is from this bot
    return replyTo.from.id === this.state.botId;
  }

  /**
   * Get current bot username (available after start())
   */
  getBotUsername(): string | undefined {
    return this.state.botUsername;
  }

  /**
   * Get current bot ID (available after start())
   */
  getBotId(): number | undefined {
    return this.state.botId;
  }
}

export { MessageParser };
export type { GroupMessageInput, GroupHandlerOptions };
