/**
 * Message Parser
 *
 * Parses Telegram group messages, extracts @mentions, handles reply_to,
 * and truncates bot messages according to PRD-v2 rules.
 */

import type {
  TelegramMessage,
  TelegramUser,
  GroupMessageInput,
  RoutingContext,
} from "./types.js";

export class MessageParser {
  constructor(private readonly botUsername: string) {}

  /**
   * Parse a Telegram message into structured GroupMessageInput
   * Returns null if the message should be ignored (empty content)
   */
  parse(
    message: TelegramMessage,
    routing: RoutingContext
  ): GroupMessageInput | null {
    const rawText = message.text ?? "";

    // Skip empty messages
    if (!rawText || rawText.trim().length === 0) {
      return null;
    }

    const sourceType = this.determineSource(message.from);

    let taskContent: string;
    let userContent: string | undefined;

    if (routing.isMentioned) {
      // Handle @mention
      // Check if this is an entity-based mention first
      if (this.isMentionedInEntities(message)) {
        const extracted = this.extractEntityMentionedContent(message, sourceType);
        taskContent = extracted.taskContent;
        userContent = extracted.userContent;
      } else {
        const extracted = this.extractMentionedContent(rawText, sourceType);
        taskContent = extracted.taskContent;
        userContent = extracted.userContent;
      }
    } else if (routing.isReply) {
      // Handle reply
      taskContent = rawText.trim();
    } else {
      // Should not reach here if routing is correct
      return null;
    }

    // Skip if task content is empty (e.g., only @BotName)
    if (!taskContent || taskContent.trim().length === 0) {
      return null;
    }

    // Extract replied message content and sender if available
    let repliedMessageContent: string | undefined;
    let repliedMessageFrom: GroupMessageInput['repliedMessageFrom'] | undefined;
    if (message.reply_to_message) {
      if (message.reply_to_message.text) {
        repliedMessageContent = message.reply_to_message.text;
      }
      if (message.reply_to_message.from) {
        repliedMessageFrom = {
          type: this.determineSource(message.reply_to_message.from),
          id: message.reply_to_message.from.id,
          username: message.reply_to_message.from.username,
        };
      }
    }

    return {
      from: {
        type: sourceType,
        id: message.from.id,
        username: message.from.username,
      },
      userContent,
      taskContent: taskContent.trim(),
      rawText,
      messageId: message.message_id,
      chatId: message.chat.id,
      replyToMessageId: message.reply_to_message?.message_id,
      repliedMessageContent,
      repliedMessageFrom,
      timestamp: message.date,
      routing: {
        isMentioned: routing.isMentioned,
        isReply: routing.isReply,
      },
    };
  }

  /**
   * Determine if message is from user or bot
   */
  private determineSource(from: TelegramUser): "user" | "bot" {
    return from.is_bot ? "bot" : "user";
  }

  /**
   * Extract content when bot is mentioned (@BotName)
   *
   * For user messages: extract everything after @BotName
   * For bot messages: split into userContent (before @) and taskContent (after @)
   */
  private extractMentionedContent(
    text: string,
    sourceType: "user" | "bot"
  ): { userContent?: string; taskContent: string } {
    // Normalize username for matching (with or without @)
    const usernameWithAt = this.botUsername.startsWith("@")
      ? this.botUsername
      : `@${this.botUsername}`;
    const usernameWithoutAt = this.botUsername.startsWith("@")
      ? this.botUsername.slice(1)
      : this.botUsername;

    // Find the position of @BotName in the text
    const patterns = [
      usernameWithAt,
      usernameWithAt + " ",
      usernameWithAt + "\n",
    ];

    let mentionIndex = -1;
    let matchedPattern = "";

    for (const pattern of patterns) {
      mentionIndex = text.indexOf(pattern);
      if (mentionIndex !== -1) {
        matchedPattern = pattern;
        break;
      }
    }

    // Also try without space/newline at the end
    if (mentionIndex === -1) {
      mentionIndex = text.indexOf(usernameWithAt);
      if (mentionIndex !== -1) {
        matchedPattern = usernameWithAt;
      }
    }

    if (mentionIndex === -1) {
      // Username not found (should not happen if routing is correct)
      return { taskContent: text.trim() };
    }

    return this.sliceContent(text, mentionIndex + matchedPattern.length, sourceType);
  }

  /**
   * Extract content when bot is mentioned via Telegram entities
   * Handles mentions from autocomplete which use entity format
   */
  private extractEntityMentionedContent(
    message: { text?: string; entities?: Array<{ type: string; offset: number; length: number; user?: { username?: string } }> },
    sourceType: "user" | "bot"
  ): { userContent?: string; taskContent: string } {
    if (!message.text || !message.entities) {
      return { taskContent: message.text?.trim() ?? "" };
    }

    const usernameWithoutAt = this.botUsername.startsWith("@")
      ? this.botUsername.slice(1)
      : this.botUsername;

    // Find the mention entity for this bot
    for (const entity of message.entities) {
      if (entity.type === "mention") {
        const mentionText = message.text.slice(entity.offset, entity.offset + entity.length);
        if (mentionText.toLowerCase() === `@${usernameWithoutAt}`.toLowerCase()) {
          // Found the mention, extract content after it
          const endOfMention = entity.offset + entity.length;
          return this.sliceContent(message.text, endOfMention, sourceType);
        }
      }
      if (entity.type === "text_mention" && entity.user?.username) {
        if (entity.user.username.toLowerCase() === usernameWithoutAt.toLowerCase()) {
          // Found text_mention for this bot
          const endOfMention = entity.offset + entity.length;
          return this.sliceContent(message.text, endOfMention, sourceType);
        }
      }
    }

    // Fallback: return full text if mention not found in entities
    return { taskContent: message.text.trim() };
  }

  /**
   * Slice content from a position based on source type
   */
  private sliceContent(
    text: string,
    startIndex: number,
    sourceType: "user" | "bot"
  ): { userContent?: string; taskContent: string } {
    if (sourceType === "user") {
      // From user: extract everything after @BotName
      const afterMention = text.slice(startIndex);
      return { taskContent: afterMention.trim() };
    } else {
      // From bot: split into userContent and taskContent
      // Find the position where mention starts (for bot messages with @Bot in middle)
      const mentionStart = text.slice(0, startIndex).lastIndexOf("@");
      const beforeMention = mentionStart > 0 ? text.slice(0, mentionStart).trim() : "";
      const afterMention = text.slice(startIndex).trim();

      // Remove trailing newlines from userContent
      const cleanUserContent = beforeMention.replace(/\n+$/, "");

      return {
        userContent: cleanUserContent || undefined,
        taskContent: afterMention,
      };
    }
  }

  /**
   * Check if text contains mention of this bot
   * Uses word boundary to avoid partial matches (e.g., @Bot matching @BotName)
   */
  isMentioned(text: string): boolean {
    const usernameWithoutAt = this.botUsername.startsWith("@")
      ? this.botUsername.slice(1)
      : this.botUsername;
    // Use negative lookahead: match @BotName as long as it's not followed by a word character
    const pattern = new RegExp(`@${usernameWithoutAt}(?!\\w)`);
    return pattern.test(text);
  }

  /**
   * Check if message entities contain mention of this bot
   * Handles Telegram entity-based mentions (from autocomplete)
   */
  isMentionedInEntities(message: { text?: string; entities?: Array<{ type: string; offset: number; length: number; user?: { username?: string } }> }): boolean {
    if (!message.entities || !message.text) {
      return false;
    }

    const usernameWithoutAt = this.botUsername.startsWith("@")
      ? this.botUsername.slice(1)
      : this.botUsername;

    for (const entity of message.entities) {
      // Check mention entity type
      if (entity.type === "mention") {
        const mentionText = message.text.slice(entity.offset, entity.offset + entity.length);
        if (mentionText.toLowerCase() === `@${usernameWithoutAt}`.toLowerCase()) {
          return true;
        }
      }
      // Check text_mention entity type (mention without username)
      if (entity.type === "text_mention" && entity.user?.username) {
        if (entity.user.username.toLowerCase() === usernameWithoutAt.toLowerCase()) {
          return true;
        }
      }
    }

    return false;
  }
}
