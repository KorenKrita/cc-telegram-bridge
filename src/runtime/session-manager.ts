import { SessionStore } from "../state/session-store.js";
import type { CodexAdapter } from "../codex/adapter.js";

const SESSION_STATE_UNREADABLE_ERROR =
  "Session state is unreadable right now. Reset the chat and try again.";

export class SessionManager {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly adapter: CodexAdapter,
  ) {}

  async getOrCreateSession(chatId: number): Promise<{ sessionId: string }> {
    const existing = await this.sessionStore.findByChatIdSafe(chatId);

    if (existing.warning) {
      throw new Error(SESSION_STATE_UNREADABLE_ERROR);
    }

    if (existing.record) {
      return { sessionId: existing.record.codexSessionId };
    }

    return { sessionId: `telegram-${chatId}` };
  }

  async bindSession(chatId: number, sessionId: string): Promise<void> {
    await this.sessionStore.upsert({
      telegramChatId: chatId,
      codexSessionId: sessionId,
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
  }
}
