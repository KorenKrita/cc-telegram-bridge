import path from "node:path";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { SESSION_STATE_UNREADABLE_WARNING, SessionStore } from "../state/session-store.js";

export interface SessionCommandEnv extends Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR"> {}
export interface SessionSummary {
  chatId: number;
  threadId: string;
  status: string;
  updatedAt: string;
}

function resolveSessionStatePath(env: SessionCommandEnv, instanceName: string): string {
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizeInstanceName(instanceName),
  });

  return path.join(stateDir, "session.json");
}

export async function inspectSessions(
  env: SessionCommandEnv,
  instanceName: string,
): Promise<{ sessions: SessionSummary[]; warning?: string }> {
  const store = new SessionStore(resolveSessionStatePath(env, instanceName));
  const { state, warning } = await store.inspect();

  return {
    sessions: state.chats
    .map((record) => ({
      chatId: record.telegramChatId,
      threadId: record.codexSessionId,
      status: record.status,
      updatedAt: record.updatedAt,
    }))
    .sort((a, b) => a.chatId - b.chatId),
    warning,
  };
}

export async function listSessions(
  env: SessionCommandEnv,
  instanceName: string,
): Promise<SessionSummary[]> {
  return (await inspectSessions(env, instanceName)).sessions;
}

export async function inspectSessionForChat(
  env: SessionCommandEnv,
  instanceName: string,
  chatId: number,
): Promise<{ session: SessionSummary | null; warning?: string }> {
  const store = new SessionStore(resolveSessionStatePath(env, instanceName));
  const { record, warning } = await store.findByChatIdSafe(chatId);

  if (!record) {
    return { session: null, warning };
  }

  return {
    session: {
      chatId: record.telegramChatId,
      threadId: record.codexSessionId,
      status: record.status,
      updatedAt: record.updatedAt,
    },
    warning,
  };
}

export async function getSessionForChat(
  env: SessionCommandEnv,
  instanceName: string,
  chatId: number,
): Promise<SessionSummary | null> {
  return (await inspectSessionForChat(env, instanceName, chatId)).session;
}

export async function resetSessionForChat(
  env: SessionCommandEnv,
  instanceName: string,
  chatId: number,
): Promise<{ cleared: boolean; repaired: boolean }> {
  const store = new SessionStore(resolveSessionStatePath(env, instanceName));
  const result = await store.removeByChatIdRecovering(chatId);

  return {
    cleared: result.removed,
    repaired: result.repaired,
  };
}

export { SESSION_STATE_UNREADABLE_WARNING };
