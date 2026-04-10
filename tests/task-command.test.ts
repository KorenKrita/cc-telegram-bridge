import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { clearTask } from "../src/commands/task.js";

describe("task commands", () => {
  it("clears the workflow record without deleting paths outside the telegram-files root", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(homeDir, ".codex", "channels", "telegram", "alpha");
    const hostileUploadId = ["..", "outside-root"].join(path.sep);
    const outsideDir = path.join(stateDir, "workspace", "outside-root");
    const sentinelPath = path.join(outsideDir, "sentinel.txt");

    try {
      await mkdir(outsideDir, { recursive: true });
      await writeFile(sentinelPath, "keep me", "utf8");
      await writeFile(
        path.join(stateDir, "file-workflow.json"),
        JSON.stringify({
          records: [
            {
              uploadId: hostileUploadId,
              chatId: 100,
              userId: 100,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "archive summary",
              createdAt: "2026-04-10T00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(clearTask({ USERPROFILE: homeDir }, "alpha", hostileUploadId)).resolves.toBe(true);
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep me");
      await expect(access(sentinelPath)).resolves.toBeUndefined();
      await expect(readFile(path.join(stateDir, "file-workflow.json"), "utf8")).resolves.toContain('"records": []');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("clears a hostile in-root traversal record without deleting a sibling workspace", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(homeDir, ".codex", "channels", "telegram", "alpha");
    const hostileUploadId = ["foo", "..", "victim"].join(path.sep);
    const victimDir = path.join(stateDir, "workspace", ".telegram-files", "victim");
    const sentinelPath = path.join(victimDir, "sentinel.txt");

    try {
      await mkdir(victimDir, { recursive: true });
      await writeFile(sentinelPath, "keep me", "utf8");
      await writeFile(
        path.join(stateDir, "file-workflow.json"),
        JSON.stringify({
          records: [
            {
              uploadId: hostileUploadId,
              chatId: 100,
              userId: 100,
              kind: "archive",
              status: "awaiting_continue",
              sourceFiles: ["repo.zip"],
              derivedFiles: [],
              summary: "archive summary",
              createdAt: "2026-04-10T00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await expect(clearTask({ USERPROFILE: homeDir }, "alpha", hostileUploadId)).resolves.toBe(true);
      await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep me");
      await expect(readFile(path.join(stateDir, "file-workflow.json"), "utf8")).resolves.toContain('"records": []');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
