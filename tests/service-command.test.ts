import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/commands/cli.js";
import { resolveInstanceLockPath } from "../src/state/instance-lock.js";

const REPO_ROOT = "C:\\Users\\hangw\\codex-telegram-channel";

describe("telegram service commands", () => {
  it("starts a named instance through the CLI", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const spawnDetached = vi.fn();

    try {
      const handled = await runCli(["telegram", "service", "start", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: REPO_ROOT,
          spawnDetached,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Started instance "alpha".']);
      expect(spawnDetached).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a running instance in service status", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".codex", "channels", "telegram", "alpha");
    const lockPath = resolveInstanceLockPath(stateDir);

    try {
      await import("node:fs/promises").then((fs) =>
        fs.mkdir(stateDir, { recursive: true }).then(() =>
          fs.writeFile(
            lockPath,
            JSON.stringify({
              pid: 12345,
              token: "token",
              acquiredAt: new Date().toISOString(),
            }),
          ),
        ),
      );

      const handled = await runCli(["telegram", "service", "status", "--instance", "alpha"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          isProcessAlive: (pid) => pid === 12345,
        },
      });

      expect(handled).toBe(true);
      expect(messages[0]).toContain("Instance: alpha");
      expect(messages[0]).toContain("Running: yes");
      expect(messages[0]).toContain("Pid: 12345");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stops a running instance through the CLI", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const messages: string[] = [];
    const stateDir = path.join(tempDir, ".codex", "channels", "telegram", "default");
    const lockPath = resolveInstanceLockPath(stateDir);
    const killProcessTree = vi.fn();

    try {
      await import("node:fs/promises").then((fs) =>
        fs.mkdir(stateDir, { recursive: true }).then(() =>
          fs.writeFile(
            lockPath,
            JSON.stringify({
              pid: 54321,
              token: "token",
              acquiredAt: new Date().toISOString(),
            }),
          ),
        ),
      );

      const handled = await runCli(["telegram", "service", "stop"], {
        env: { USERPROFILE: tempDir },
        logger: { log: (message) => messages.push(message) },
        serviceDeps: {
          cwd: tempDir,
          isProcessAlive: (pid) => pid === 54321,
          killProcessTree,
        },
      });

      expect(handled).toBe(true);
      expect(messages).toEqual(['Stopped instance "default".']);
      expect(killProcessTree).toHaveBeenCalledWith(54321);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
