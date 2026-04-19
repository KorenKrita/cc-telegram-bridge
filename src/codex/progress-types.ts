import type { AdapterUsage } from "./adapter.js";

/**
 * Progress types for real-time streaming updates in Telegram.
 * Similar to metabot's CardState but adapted for Claude CLI stream-json output.
 */

export type ProgressStatus = "thinking" | "running" | "complete" | "error";

export interface ToolCall {
  name: string;
  detail: string;
  status: "running" | "done";
}

export interface ProgressState {
  status: ProgressStatus;
  userPrompt: string;
  responseText: string;
  toolCalls: ToolCall[];
  errorMessage?: string;
  model?: string;
  durationMs?: number;
  usage?: AdapterUsage;
}

export interface ProgressCallback {
  (state: ProgressState): void;
}
