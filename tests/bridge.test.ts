import { describe, expect, it, vi } from "vitest";

import { Bridge, type AccessStoreLike, type SessionManagerLike } from "../src/runtime/bridge.js";
import type { CodexAdapter } from "../src/codex/adapter.js";

describe("Bridge", () => {
  it("routes an authorized message through the current session", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [84],
        pendingPairs: [],
      }),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      text: "hello",
      files: [],
    });

    expect(accessStore.load).toHaveBeenCalledTimes(1);
    expect(sessionManager.getOrCreateSession).toHaveBeenCalledWith(84);
    expect(adapter.sendUserMessage).toHaveBeenCalledWith("telegram-84", {
      text: "hello",
      files: [],
    });
    expect(result.text).toBe("done");
  });

  it("rejects a message when the chat is not on the allowlist", async () => {
    const accessStore: AccessStoreLike = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [99],
        pendingPairs: [],
      }),
    };
    const sessionManager: SessionManagerLike = {
      getOrCreateSession: vi.fn(),
    };
    const adapter: CodexAdapter = {
      sendUserMessage: vi.fn(),
      createSession: vi.fn(),
    };

    const bridge = new Bridge(accessStore, sessionManager, adapter);

    await expect(
      bridge.handleAuthorizedMessage({
        chatId: 84,
        userId: 42,
        text: "hello",
        files: [],
      }),
    ).rejects.toThrow("User is not in the allowlist");
    expect(sessionManager.getOrCreateSession).not.toHaveBeenCalled();
    expect(adapter.sendUserMessage).not.toHaveBeenCalled();
  });
});
