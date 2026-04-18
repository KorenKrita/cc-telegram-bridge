export interface CodexSessionHandle {
  sessionId: string;
}

export interface AdapterUsage {
  inputTokens: number;
  outputTokens: number;
  /** @deprecated Use cacheReadTokens instead */
  cachedTokens?: number;
  /** Tokens read from cache (cache hit) */
  cacheReadTokens?: number;
  /** Tokens written to cache (cache creation) */
  cacheCreationTokens?: number;
  costUsd?: number;
}

export interface CodexAdapterResponse {
  text: string;
  sessionId?: string;
  usage?: AdapterUsage;
}

import type { ProgressCallback, ProgressState } from "./progress-types.js";

export type { ProgressCallback, ProgressState } from "./progress-types.js";

export interface CodexUserMessageInput {
  text: string;
  files: string[];
  instructions?: string;
  /** @deprecated Use onProgressState for rich progress updates */
  onProgress?: (partialText: string) => void;
  /** Rich progress callback with state updates (thinking, tool calls, etc.) */
  onProgressState?: ProgressCallback;
  /** Callback for async messages received when no pending turn (e.g., task notifications) */
  onAsyncMessage?: (text: string) => void | Promise<void>;
  requestOutputDir?: string;
  workspaceOverride?: string;
  abortSignal?: AbortSignal;
}

export interface CodexAdapter {
  bridgeInstructionMode?: "generic-file-blocks" | "telegram-out-only";
  createSession(chatId: number): Promise<CodexSessionHandle>;
  sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse>;
  destroy?(): void;
}
