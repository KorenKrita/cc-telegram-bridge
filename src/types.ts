export type AccessPolicy = "pairing" | "allowlist";

export interface AppConfig {
  telegramBotToken: string;
  stateDir: string;
  inboxDir: string;
  accessStatePath: string;
  sessionStatePath: string;
  runtimeLogPath: string;
  codexExecutable: string;
}

export interface SessionRecord {
  telegramChatId: number;
  codexSessionId: string;
  status: "idle" | "running" | "queued" | "blocked";
  updatedAt: string;
}

export interface SessionState {
  chats: SessionRecord[];
}
