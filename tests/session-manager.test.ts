import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import type { CodexAdapter } from "../src/codex/adapter.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function waitForCalls<T>(assertion: () => T, timeoutMs = 1000): Promise<T> {
  const start = Date.now();
  while (true) {
    try {
      return assertion();
    } catch (error) {
      if (Date.now() - start >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

describe("SessionManager", () => {
  it("reuses a pending first session creation for the same chat", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const sessionStore = new SessionStore(path.join(tempDir, "session.json"));
    const creation = createDeferred<{ sessionId: string }>();
    const adapter: CodexAdapter = {
      createSession: vi.fn().mockReturnValue(creation.promise),
      sendUserMessage: vi.fn(),
    };
    const manager = new SessionManager(sessionStore, adapter);

    try {
      const first = manager.getOrCreateSession(84);
      const second = manager.getOrCreateSession(84);

      await waitForCalls(() => {
        expect(adapter.createSession).toHaveBeenCalledTimes(1);
      });

      creation.resolve({ sessionId: "telegram-84" });

      await expect(first).resolves.toEqual({ sessionId: "telegram-84" });
      await expect(second).resolves.toEqual({ sessionId: "telegram-84" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
