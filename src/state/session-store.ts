import { JsonStore } from "./json-store.js";
import type { SessionRecord, SessionState } from "../types.js";

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionRecord>;
  return (
    typeof candidate.telegramChatId === "number" &&
    typeof candidate.codexSessionId === "string" &&
    (candidate.status === "idle" ||
      candidate.status === "running" ||
      candidate.status === "queued" ||
      candidate.status === "blocked") &&
    isIsoTimestamp(candidate.updatedAt)
  );
}

function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<SessionState>;
  return Array.isArray(candidate.chats) && candidate.chats.every(isSessionRecord);
}

export function createDefaultSessionState(): SessionState {
  return { chats: [] };
}

export class SessionStore {
  private readonly store: JsonStore<SessionState>;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.store = new JsonStore<SessionState>(filePath, (value) => {
      if (isSessionState(value)) {
        return value;
      }

      throw new Error("invalid session state");
    });
  }

  async load(): Promise<SessionState> {
    return this.store.read(createDefaultSessionState());
  }

  async upsert(record: SessionRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.load();
      const index = state.chats.findIndex((entry) => entry.telegramChatId === record.telegramChatId);

      if (index === -1) {
        state.chats.push(record);
      } else {
        state.chats[index] = record;
      }

      await this.store.write(state);
    });
  }

  async findByChatId(telegramChatId: number): Promise<SessionRecord | null> {
    const state = await this.load();
    return state.chats.find((record) => record.telegramChatId === telegramChatId) ?? null;
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = this.pendingWrite.then(task, task);
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}
