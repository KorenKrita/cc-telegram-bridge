import { SessionStore } from "../state/session-store.js";
import type { CodexAdapter } from "../codex/adapter.js";

export class SessionManager {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly adapter: CodexAdapter,
  ) {}

  async getOrCreateSession(chatId: number): Promise<{ sessionId: string }> {
    const existing = await this.sessionStore.findByChatId(chatId);

    if (existing) {
      return { sessionId: existing.codexSessionId };
    }

    const created = await this.adapter.createSession(chatId);

    await this.sessionStore.upsert({
      telegramChatId: chatId,
      codexSessionId: created.sessionId,
      status: "idle",
      updatedAt: new Date().toISOString(),
    });

    return created;
  }
}
