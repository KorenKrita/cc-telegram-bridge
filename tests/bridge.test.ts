import { describe, expect, it, vi } from "vitest";

import { Bridge } from "../src/runtime/bridge.js";

describe("Bridge", () => {
  it("routes an authorized message through the current session", async () => {
    const accessStore = {
      load: vi.fn().mockResolvedValue({
        policy: "allowlist",
        pairedUsers: [],
        allowlist: [42],
        pendingPairs: [],
      }),
    };
    const sessionManager = {
      getOrCreateSession: vi.fn().mockResolvedValue({ sessionId: "telegram-84" }),
    };
    const adapter = {
      sendUserMessage: vi.fn().mockResolvedValue({ text: "done" }),
    };

    const bridge = new Bridge(accessStore as any, sessionManager as any, adapter as any);
    const result = await bridge.handleAuthorizedMessage({
      chatId: 84,
      userId: 42,
      text: "hello",
      files: [],
    });

    expect(result.text).toBe("done");
  });
});
