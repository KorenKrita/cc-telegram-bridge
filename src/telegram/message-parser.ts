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
      const extracted = this.extractMentionedContent(rawText, sourceType);
      taskContent = extracted.taskContent;
      userContent = extracted.userContent;
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

    // Extract replied message content if available
    let repliedMessageContent: string | undefined;
    if (message.reply_to_message?.text) {
      repliedMessageContent = message.reply_to_message.text;
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

    if (sourceType === "user") {
      // From user: extract everything after @BotName
      const afterMention = text.slice(mentionIndex + matchedPattern.length);
      return { taskContent: afterMention.trim() };
    } else {
      // From bot: split into userContent and taskContent
      const beforeMention = text.slice(0, mentionIndex).trim();
      const afterMention = text.slice(mentionIndex + matchedPattern.length).trim();

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
   */
  isMentioned(text: string): boolean {
    const usernameWithAt = this.botUsername.startsWith("@")
      ? this.botUsername
      : `@${this.botUsername}`;

    return text.includes(usernameWithAt);
  }
}
