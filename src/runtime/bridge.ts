import type { CodexAdapter } from "../codex/adapter.js";
import { SessionManager } from "./session-manager.js";

export interface AccessStoreLike {
  load(): Promise<{
    policy: "pairing" | "allowlist";
    allowlist: number[];
    pendingPairs: unknown[];
    pairedUsers: unknown[];
  }>;
}

export class Bridge {
  constructor(
    private readonly accessStore: AccessStoreLike,
    private readonly sessionManager: SessionManager,
    private readonly adapter: CodexAdapter,
  ) {}

  async handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    text: string;
    files: string[];
  }) {
    const accessState = await this.accessStore.load();

    if (accessState.policy === "allowlist" && !accessState.allowlist.includes(input.userId)) {
      throw new Error("User is not in the allowlist");
    }

    const session = await this.sessionManager.getOrCreateSession(input.chatId);
    return this.adapter.sendUserMessage(session.sessionId, {
      text: input.text,
      files: input.files,
    });
  }
}
