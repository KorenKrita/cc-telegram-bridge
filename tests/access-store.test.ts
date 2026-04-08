import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AccessStore } from "../src/state/access-store.js";

describe("AccessStore", () => {
  it("persists pairing codes and paired users", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    try {
      const store = new AccessStore(path.join(dir, "access.json"));
      const issued = await store.issuePairingCode({
        telegramUserId: 42,
        telegramChatId: 84,
        now: new Date("2026-04-08T00:00:00Z"),
      });

      expect(issued.code).toHaveLength(6);

      const pairedUser = await store.redeemPairingCode(issued.code, new Date("2026-04-08T00:01:00Z"));

      expect(pairedUser?.telegramUserId).toBe(42);

      const state = await store.load();
      expect(state.pairedUsers).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
