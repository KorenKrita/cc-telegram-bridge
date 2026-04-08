import { SessionStore } from "../state/session-store.js";
import type { CodexAdapter } from "../codex/adapter.js";

export class SessionManager {
  private readonly pendingSessions = new Map<number, Promise<{ sessionId: string }>>();

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly adapter: CodexAdapter,
  ) {}

  async getOrCreateSession(chatId: number): Promise<{ sessionId: string }> {
    const existing = await this.sessionStore.findByChatId(chatId);

    if (existing) {
      return { sessionId: existing.codexSessionId };
    }

    const pending = this.pendingSessions.get(chatId);
    if (pending) {
      return pending;
    }

    const creation = this.createAndPersistSession(chatId);
    this.pendingSessions.set(chatId, creation);

    return creation.finally(() => {
      if (this.pendingSessions.get(chatId) === creation) {
        this.pendingSessions.delete(chatId);
      }
    });
  }

  private async createAndPersistSession(chatId: number): Promise<{ sessionId: string }> {
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
