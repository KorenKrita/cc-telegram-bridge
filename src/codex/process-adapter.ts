import { spawn } from "node:child_process";

import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
} from "./adapter.js";

type SpawnOptions = {
  stdio: ["ignore", "pipe", "pipe"];
};

type ProcessStreamLike = {
  on(event: "data", listener: (chunk: { toString(): string } | string) => void): void;
};

type ProcessChildLike = {
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnCodex = (command: string, args: string[], options: SpawnOptions) => ProcessChildLike;

export class ProcessCodexAdapter implements CodexAdapter {
  /**
   * First-pass adapter that runs Codex as a process.
   * The returned session id is a logical Telegram binding key for now, not
   * persisted Codex conversation continuity.
   */
  constructor(
    private readonly codexExecutable: string,
    private readonly spawnCodex: SpawnCodex = spawn as unknown as SpawnCodex,
  ) {}

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `telegram-${chatId}` };
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const prompt = [input.text, ...input.files.map((file) => `Attachment: ${file}`)].join("\n");
    const child = this.spawnCodex(this.codexExecutable, ["exec", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    return await new Promise<CodexAdapterResponse>((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve({ text: stdout.trim() || `Session ${sessionId} completed.` });
          return;
        }

        reject(new Error(stderr.trim() || `codex exited with code ${code}`));
      });
    });
  }
}
