/**
 * Group chat message handling types
 *
 * Types for Telegram group message processing, routing, and parsing.
 */

// Telegram raw types (simplified)
export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot: boolean;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser; // for text_mention type
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from: TelegramUser;
  text?: string;
  date: number; // Unix timestamp
  entities?: TelegramMessageEntity[];
  reply_to_message?: {
    message_id: number;
    from?: TelegramUser;
    text?: string;
    date?: number;
  };
}

// Parsed unified input format
export interface GroupMessageInput {
  from: {
    type: "user" | "bot";
    id: number;
    username?: string;
  };
  /** Content before @BotName (for bot messages) */
  userContent?: string;
  /** Actual content to process */
  taskContent: string;
  /** Original raw message text */
  rawText: string;
  messageId: number;
  chatId: number;
  replyToMessageId?: number;
  /**
   * Content of the replied message
   * Extracted directly from Telegram Update's reply_to_message.text
   * No additional API call needed
   */
  repliedMessageContent?: string;
  /** Sender of the replied message (for context) */
  repliedMessageFrom?: {
    type: 'user' | 'bot';
    id: number;
    username?: string;
  };
  timestamp: number;
  routing: {
    isMentioned: boolean;
    isReply: boolean;
  };
}

// Routing context
export interface RoutingContext {
  isMentioned: boolean;
  isReply: boolean;
  replyToBotId?: number;
}

// Group handler options
export interface GroupHandlerOptions {
  /** Bot Token for getMe API */
  botToken: string;
  /** Callback when a message is routed to this bot */
  onMessage: (input: GroupMessageInput) => Promise<void>;
  /** Optional: restrict to specific chat IDs */
  allowedChatIds?: number[];
}

// Group handler state
export interface GroupHandlerState {
  botUsername?: string;
  botId?: number;
  isRunning: boolean;
}

// Bot identity (fetched at runtime)
export interface BotIdentity {
  username: string;
  id: number;
  fetchedAt: number;
}

// Update response from Telegram API
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface GetMeResponse {
  ok: boolean;
  result: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username: string;
  };
}
