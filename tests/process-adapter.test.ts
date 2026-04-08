import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";

describe("ProcessCodexAdapter", () => {
  it("creates telegram-scoped sessions", async () => {
    const adapter = new ProcessCodexAdapter("codex");
    const session = await adapter.createSession(12345);

    expect(session.sessionId).toBe("telegram-12345");
  });

  it("passes attachments into the generated prompt", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const child = new FakeChildProcess();
    const spawnCodex = (
      command: string,
      args: string[],
      _options: { stdio: ["ignore", "pipe", "pipe"] },
    ) => {
      calls.push({ command, args });
      return child;
    };

    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: ["a.png", "b.pdf"],
    });

    child.stdout.emitData("ok");
    child.close(0);

    await promise;

    expect(calls).toEqual([
      {
        command: "codex",
        args: ["exec", "Hello\nAttachment: a.png\nAttachment: b.pdf"],
      },
    ]);
  });

  it("returns trimmed stdout when codex exits successfully", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData("  answer from codex  \n");
    child.close(0);

    await expect(promise).resolves.toEqual({ text: "answer from codex" });
  });

  it("falls back when codex returns empty stdout", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Session telegram-12345 completed.",
    });
  });

  it("rejects with stderr text on nonzero exit", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stderr.emitData("codex failed\n");
    child.close(2);

    await expect(promise).rejects.toThrow("codex failed");
  });
});

class FakeStream extends EventEmitter {
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

class FakeChildProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();

  close(code: number | null) {
    this.emit("close", code);
  }
}

function createSpawnHarness() {
  const child = new FakeChildProcess();
  const spawnCodex = (
    _command: string,
    _args: string[],
    _options: { stdio: ["ignore", "pipe", "pipe"] },
  ) => child;

  return { spawnCodex, child };
}
