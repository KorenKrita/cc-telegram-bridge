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
  GetMeResponse,
} from "./types.js";

export class GroupHandler {
  private state: GroupHandlerState = {
    isRunning: false,
  };
  private parser?: MessageParser;

  constructor(private readonly options: GroupHandlerOptions) {}

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

    console.log("[GroupHandler] Ready to process group messages");
  }

  /**
   * Stop listening
   */
  async stop(): Promise<void> {
    this.state.isRunning = false;
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
   * Process a single update (called by main polling loop)
   */
  async processUpdate(update: TelegramUpdate): Promise<void> {
    console.log(`[GroupHandler] ====== processUpdate START ======`);
    console.log(`[GroupHandler] update_id: ${update.update_id}`);
    console.log(`[GroupHandler] has message: ${!!update.message}, has edited_message: ${!!update.edited_message}`);

    const message = update.message ?? update.edited_message;
    if (!message) {
      console.log(`[GroupHandler] ❌ SKIPPED: no message in update ${update.update_id}`);
      console.log(`[GroupHandler] ====== processUpdate END ======`);
      return;
    }

    // Log full message structure for debugging
    console.log(`[GroupHandler] Message structure:`);
    console.log(`  - message_id: ${message.message_id}`);
    console.log(`  - from: ${message.from ? `id=${message.from.id}, username=${message.from.username}, is_bot=${message.from.is_bot}` : 'null'}`);
    console.log(`  - chat: id=${message.chat.id}, type=${message.chat.type}, title=${message.chat.title || '(no title)'}`);
    console.log(`  - text: "${message.text || '(no text)'}"`);
    console.log(`  - reply_to_message: ${message.reply_to_message ? `yes (from=${message.reply_to_message.from?.id})` : 'no'}`);

    // Only process group/supergroup messages
    if (message.chat.type !== "group" && message.chat.type !== "supergroup") {
      console.log(`[GroupHandler] ❌ SKIPPED: chat type is ${message.chat.type} (expected group/supergroup)`);
      console.log(`[GroupHandler] ====== processUpdate END ======`);
      return;
    }

    console.log(`[GroupHandler] ✅ Chat type OK: ${message.chat.type}`);

    // Check allowed chat IDs (must be explicitly configured)
    console.log(`[GroupHandler] allowedChatIds config: ${JSON.stringify(this.options.allowedChatIds)}`);
    if (!this.options.allowedChatIds || this.options.allowedChatIds.length === 0) {
      console.warn(
        `[GroupHandler] ❌ REJECTED: allowedChatIds not configured (empty or missing)`
      );
      console.log(`[GroupHandler] ====== processUpdate END ======`);
      return;
    }
    if (!this.options.allowedChatIds.includes(message.chat.id)) {
      console.warn(
        `[GroupHandler] ❌ REJECTED: chat ${message.chat.id} not in allowedChatIds list ${JSON.stringify(this.options.allowedChatIds)}`
      );
      console.log(`[GroupHandler] ====== processUpdate END ======`);
      return;
    }
    console.log(`[GroupHandler] ✅ Chat ID ${message.chat.id} is allowed`);

    // Determine routing
    console.log(`[GroupHandler] Checking routing...`);
    const routing = this.shouldRoute(message);
    if (!routing) {
      console.log(`[GroupHandler] ❌ NOT ROUTING: message not targeted at this bot`);
      console.log(`[GroupHandler] ====== processUpdate END ======`);
      return;
    }
    console.log(`[GroupHandler] ✅ Routing decision: isMentioned=${routing.isMentioned}, isReply=${routing.isReply}`);

    // Parse the message
    if (!this.parser) {
      console.error("[GroupHandler] ❌ ERROR: Parser not initialized (bot identity not resolved?)");
      console.log(`[GroupHandler] ====== processUpdate END ======`);
      return;
    }
    console.log(`[GroupHandler] Parser initialized, botUsername=${this.state.botUsername}`);

    const parsed = this.parser.parse(message, routing);
    if (!parsed) {
      console.log(`[GroupHandler] ❌ PARSED: empty or invalid content`);
      console.log(`[GroupHandler] ====== processUpdate END ======`);
      return;
    }
    console.log(`[GroupHandler] ✅ Parsed: taskContent="${parsed.taskContent.slice(0, 50)}..."`);

    // Deliver to handler
    console.log(`[GroupHandler] Calling onMessage handler...`);
    try {
      await this.options.onMessage(parsed);
      console.log(`[GroupHandler] ✅ onMessage handler completed`);
    } catch (error) {
      console.error("[GroupHandler] ❌ onMessage handler error:", error);
    }
    console.log(`[GroupHandler] ====== processUpdate END ======`);
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
    console.log(`[GroupHandler] shouldRoute: text="${text.slice(0, 80)}", parser=${this.parser ? 'ok' : 'null'}`);

    // Priority 1: Check if bot is mentioned
    // Parser must be initialized (after start() resolves bot identity)
    if (!this.parser) {
      console.warn("[GroupHandler] Parser not initialized, skipping message");
      return null;
    }
    const isMentioned = this.parser.isMentioned(text);
    console.log(`[GroupHandler] isMentioned: ${isMentioned}, botUsername: ${this.state.botUsername}`);
    if (isMentioned) {
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
