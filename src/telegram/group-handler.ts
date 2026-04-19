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
    const message = update.message ?? update.edited_message;
    if (!message) {
      return;
    }

    // Only process group/supergroup messages
    if (message.chat.type !== "group" && message.chat.type !== "supergroup") {
      return;
    }

    // Check allowed chat IDs (must be explicitly configured)
    if (!this.options.allowedChatIds || this.options.allowedChatIds.length === 0) {
      console.warn(
        `[GroupHandler] Rejected message from chat ${message.chat.id}: allowedChatIds not configured`
      );
      return;
    }
    if (!this.options.allowedChatIds.includes(message.chat.id)) {
      console.warn(
        `[GroupHandler] Rejected message from chat ${message.chat.id}: not in allowedChatIds list`
      );
      return;
    }

    // Determine routing
    const routing = this.shouldRoute(message);
    if (!routing) {
      return;
    }

    // Parse the message
    if (!this.parser) {
      console.error("[GroupHandler] Parser not initialized");
      return;
    }

    const parsed = this.parser.parse(message, routing);
    if (!parsed) {
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
    // Parser must be initialized (after start() resolves bot identity)
    if (!this.parser) {
      console.warn("[GroupHandler] Parser not initialized, skipping message");
      return null;
    }
    // Check both text-based and entity-based mentions
    if (this.parser.isMentioned(text) || this.parser.isMentionedInEntities(message)) {
      return { isMentioned: true, isReply: false };
    }

    // Priority 2: Check if replying to this bot
    if (this.isReplyToMe(message)) {
      // If message @mentions another bot, prioritize the explicit mention
      // even when replying to this bot's message
      if (this.isMentioningOtherBot(text)) {
        return null;
      }
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
   * Check if message @mentions any bot other than this bot
   * Pattern: @xxx_bot where xxx_bot is not the current bot's username
   */
  private isMentioningOtherBot(text: string): boolean {
    const currentUsername = this.state.botUsername?.toLowerCase();
    // Match @botname pattern (bot usernames end with "_bot" in Telegram)
    const botMentionPattern = /@(\w+_bot)(?!\w)/gi;
    let match;
    while ((match = botMentionPattern.exec(text)) !== null) {
      const mentionedBot = match[1].toLowerCase();
      if (mentionedBot !== currentUsername) {
        return true;
      }
    }
    return false;
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
