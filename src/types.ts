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
