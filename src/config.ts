import path from "node:path";

import type { AppConfig } from "./types.js";

export interface EnvSource {
  USERPROFILE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
  CODEX_EXECUTABLE?: string;
}

export function resolveConfig(env: EnvSource = process.env): AppConfig {
  const userProfile = env.USERPROFILE;
  if (!userProfile) {
    throw new Error("USERPROFILE is required");
  }

  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  if (!telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const stateDir =
    env.CODEX_TELEGRAM_STATE_DIR ??
    path.win32.join(userProfile, ".codex", "channels", "telegram");

  return {
    telegramBotToken,
    stateDir,
    inboxDir: path.win32.join(stateDir, "inbox"),
    accessStatePath: path.win32.join(stateDir, "access.json"),
    sessionStatePath: path.win32.join(stateDir, "session.json"),
    runtimeLogPath: path.win32.join(stateDir, "runtime.log"),
    codexExecutable: env.CODEX_EXECUTABLE ?? "codex",
  };
}
