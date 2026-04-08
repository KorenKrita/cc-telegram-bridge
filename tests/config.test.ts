import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("uses the default Windows-first state directory under the user profile", () => {
    const config = resolveConfig({
      USERPROFILE: "C:\\Users\\hangw",
      TELEGRAM_BOT_TOKEN: "abc123",
    });

    expect(config.stateDir).toBe("C:\\Users\\hangw\\.codex\\channels\\telegram");
    expect(config.inboxDir).toBe("C:\\Users\\hangw\\.codex\\channels\\telegram\\inbox");
    expect(config.telegramBotToken).toBe("abc123");
  });
});
