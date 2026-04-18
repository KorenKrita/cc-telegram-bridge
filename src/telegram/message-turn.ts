import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  applyTelegramOutLimits as defaultApplyTelegramOutLimits,
  createTelegramOutDir as defaultCreateTelegramOutDir,
  describeTelegramOutFiles as defaultDescribeTelegramOutFiles,
} from "../runtime/telegram-out.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import {
  boundArchiveSummaryForTelegram,
  prepareArchiveContinueWorkflow as defaultPrepareArchiveContinueWorkflow,
  prepareAttachmentWorkflow as defaultPrepareAttachmentWorkflow,
  type DownloadedAttachment,
  type FileWorkflowResult,
} from "../runtime/file-workflow.js";
import type { FileWorkflowStore } from "../state/file-workflow-store.js";
import { appendUpdateHandleAuditEventBestEffort, maybeReplyWithBudgetExhausted, recordTurnUsageAndBudgetAudit } from "./turn-bookkeeping.js";
import { chunkTelegramMessage, type Locale } from "./message-renderer.js";
import { renderProgressHtml, shouldUpdateDisplay, getUpdateIntervalMs } from "./progress-renderer.js";
import type { InlineKeyboardButton, TelegramApi } from "./api.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";
import type { ProgressState } from "../codex/progress-types.js";

export interface WorkflowAwareTurnState {
  workflowRecordId?: string;
  archiveSummaryDelivered: boolean;
  failureHint?: string;
  telegramOutDirPath?: string;
}

export interface WorkflowAwareTurnConfig {
  engine: "codex" | "claude";
  budgetUsd?: number;
  resume?: {
    workspacePath: string;
  };
}

export interface WorkflowAwareTurnContext {
  api: Pick<TelegramApi, "sendMessage" | "getFile" | "downloadFile" | "editMessage">;
  bridge: {
    handleAuthorizedMessage(input: {
      chatId: number;
      userId: number;
      chatType: string;
      locale: Locale;
      text: string;
      replyContext?: NormalizedTelegramMessage["replyContext"];
      files: string[];
      requestOutputDir?: string;
      workspaceOverride?: string;
      abortSignal?: AbortSignal;
      onProgressState?: (state: ProgressState) => void;
      onAsyncMessage?: (text: string) => void | Promise<void>;
    }): Promise<{
      text: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        costUsd?: number;
      };
    }>;
  };
  inboxDir: string;
  abortSignal?: AbortSignal;
  instanceName?: string;
  updateId?: number;
  verbosity?: number;
}

function wantsTelegramOut(text: string): boolean {
  return /(发.*文件|传.*文件|发送.*文件|导出.*文件|文件.*传|文件.*发|生成.*文件|generate.*file|send.*file|export.*file)/i.test(text);
}

function defaultBuildContinueAnalysisKeyboard(uploadId: string): { inlineKeyboard: InlineKeyboardButton[][] } {
  return {
    inlineKeyboard: [[{ text: "Continue Analysis", callbackData: `continue-archive:${uploadId}` }]],
  };
}

async function ensureInboxDirExists(inboxDir: string): Promise<void> {
  await mkdir(inboxDir, { recursive: true });
}

export async function executeWorkflowAwareTelegramTurn(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: WorkflowAwareTurnConfig;
  normalized: NormalizedTelegramMessage;
  context: WorkflowAwareTurnContext;
  workflowStore: Pick<FileWorkflowStore, "update">;
  downloadedAttachments: DownloadedAttachment[];
  state: WorkflowAwareTurnState;
  prepareAttachmentWorkflow?: typeof defaultPrepareAttachmentWorkflow;
  prepareArchiveContinueWorkflow?: typeof defaultPrepareArchiveContinueWorkflow;
  createTelegramOutDir?: typeof defaultCreateTelegramOutDir;
  describeTelegramOutFiles?: typeof defaultDescribeTelegramOutFiles;
  applyTelegramOutLimits?: typeof defaultApplyTelegramOutLimits;
  buildContinueAnalysisKeyboard?: typeof defaultBuildContinueAnalysisKeyboard;
  deliverTelegramResponse: (
    api: WorkflowAwareTurnContext["api"],
    chatId: number,
    text: string,
    inboxDir: string,
    workspaceOverride: string | undefined,
    locale: Locale,
  ) => Promise<number>;
  sendTelegramOutFile: (chatId: number, filename: string, contents: Uint8Array) => Promise<void>;
  updateWorkflowBestEffort?: (
    workflowStore: Pick<FileWorkflowStore, "update">,
    workflowRecordId: string,
    mutate: Parameters<FileWorkflowStore["update"]>[1],
  ) => Promise<void>;
}): Promise<void> {
  const {
    stateDir,
    startedAt,
    locale,
    cfg,
    normalized,
    context,
    workflowStore,
    downloadedAttachments,
    state,
    prepareAttachmentWorkflow = defaultPrepareAttachmentWorkflow,
    prepareArchiveContinueWorkflow = defaultPrepareArchiveContinueWorkflow,
    createTelegramOutDir = defaultCreateTelegramOutDir,
    describeTelegramOutFiles = defaultDescribeTelegramOutFiles,
    applyTelegramOutLimits = defaultApplyTelegramOutLimits,
    buildContinueAnalysisKeyboard = defaultBuildContinueAnalysisKeyboard,
    deliverTelegramResponse,
    sendTelegramOutFile,
    updateWorkflowBestEffort = async (store, workflowRecordId, mutate) => {
      try {
        await store.update(workflowRecordId, mutate);
      } catch {
        // bookkeeping-only best effort
      }
    },
  } = input;

  const workflowResult: FileWorkflowResult | null =
    downloadedAttachments.length > 0
      ? await prepareAttachmentWorkflow({
        stateDir,
        chatId: normalized.chatId,
        userId: normalized.userId,
        text: normalized.text,
        downloadedAttachments,
      })
      : await prepareArchiveContinueWorkflow({
        stateDir,
        chatId: normalized.chatId,
        text: normalized.text,
        replyContext: normalized.replyContext,
      });
  state.failureHint = workflowResult?.failureHint;
  if (workflowResult?.workflowRecordId) {
    await appendTimelineEventBestEffort(stateDir, {
      type: "workflow.prepared",
      instanceName: context.instanceName,
      channel: "telegram",
      chatId: normalized.chatId,
      userId: normalized.userId,
      updateId: context.updateId,
      detail: downloadedAttachments.length > 0 ? "attachment workflow prepared" : "workflow prepared",
      metadata: {
        workflowRecordId: workflowResult.workflowRecordId,
        kind: workflowResult.kind,
      },
    });
  }

  if (cfg.engine === "codex" && wantsTelegramOut(normalized.text)) {
    state.telegramOutDirPath = (await createTelegramOutDir(stateDir, `${Date.now()}-${normalized.chatId}`)).dirPath;
  }

  if (workflowResult?.kind === "reply") {
    state.workflowRecordId = workflowResult.workflowRecordId;
    const deliveryText = state.workflowRecordId ? boundArchiveSummaryForTelegram(workflowResult.text) : workflowResult.text;
    const summaryMsg = await context.api.sendMessage(
      normalized.chatId,
      deliveryText,
      downloadedAttachments.length > 0 && workflowResult.workflowRecordId
        ? buildContinueAnalysisKeyboard(workflowResult.workflowRecordId)
        : undefined,
    );
    if (downloadedAttachments.length > 0 && workflowResult.workflowRecordId) {
      await workflowStore.update(workflowResult.workflowRecordId, (record) => {
        record.summaryMessageId = summaryMsg.message_id;
      });
    }
    if (state.workflowRecordId) {
      state.archiveSummaryDelivered = true;
    }
    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: "success",
      metadata: {
        durationMs: Date.now() - startedAt,
        attachments: normalized.attachments.length,
        responseChars: deliveryText.length,
        chunkCount: chunkTelegramMessage(deliveryText).length,
      },
    });
    return;
  }

  state.workflowRecordId = workflowResult?.workflowRecordId;
  const requestText = workflowResult?.kind === "direct" ? workflowResult.text : normalized.text;
  const requestFiles = workflowResult?.kind === "direct"
    ? [...workflowResult.files]
    : downloadedAttachments.map((attachment) => attachment.localPath);

  if (await maybeReplyWithBudgetExhausted(stateDir, cfg.budgetUsd, locale, context, normalized)) {
    return;
  }

  await appendTimelineEventBestEffort(stateDir, {
    type: "turn.started",
    instanceName: context.instanceName,
    channel: "telegram",
    chatId: normalized.chatId,
    userId: normalized.userId,
    updateId: context.updateId,
    metadata: {
      attachments: normalized.attachments.length,
      workflowRecordId: state.workflowRecordId,
    },
  });

  const replyContext =
    workflowResult?.kind === "direct" &&
    (workflowResult.suppressReplyContext || workflowResult.text.includes("[Archive Analysis Context]"))
      ? undefined
      : normalized.replyContext;

  if (replyContext) {
    const quotedFileId = replyContext.photoFileId ?? replyContext.documentFileId;
    if (quotedFileId) {
      try {
        await ensureInboxDirExists(context.inboxDir);
        const telegramFile = await context.api.getFile(quotedFileId);
        const ext = replyContext.photoFileId
          ? ".jpg"
          : (replyContext.documentFileName ? path.extname(replyContext.documentFileName) : path.extname(telegramFile.file_path)) || "";
        const localPath = path.join(context.inboxDir, `quoted-${replyContext.messageId}${ext}`);
        await context.api.downloadFile(telegramFile.file_path, localPath);
        requestFiles.push(localPath);
      } catch {
        // best effort
      }
    }
  }

  // Handle verbosity-based streaming: 0=no streaming, 1=2s interval, 2=1s interval
  const updateIntervalMs = getUpdateIntervalMs((context.verbosity ?? 0) as 0 | 1 | 2);
  let progressMessageId: number | undefined;
  let lastProgressState: ProgressState | null = null;
  let sentProgressState: ProgressState | null = null;
  let progressTimerId: ReturnType<typeof setInterval> | undefined;
  let firstTickTimeout: ReturnType<typeof setTimeout> | undefined;
  let progressUpdateInFlight = false;

  // Send or edit the progress message (internal — called only by the timer)
  const sendOrEditProgress = async (ps: ProgressState): Promise<void> => {
    const html = renderProgressHtml(ps);
    if (!progressMessageId) {
      try {
        const msg = await context.api.sendMessage(normalized.chatId, html, { parseMode: "HTML" });
        progressMessageId = msg.message_id;
      } catch (err: unknown) {
        // Fallback to plain text
        try {
          const fallbackText = ps.status === "thinking" ? "🔵 Thinking..." : "⏳ Running...";
          const msg = await context.api.sendMessage(normalized.chatId, fallbackText);
          progressMessageId = msg.message_id;
        } catch {
          // Both HTML and fallback failed — nothing more we can do
        }
      }
    } else {
      try {
        await context.api.editMessage(normalized.chatId, progressMessageId, html, { parseMode: "HTML" });
      } catch (err: unknown) {
        const desc = (err as { description?: string })?.description ?? "";
        // "message is not modified" — content unchanged, harmless
        if (desc.includes("message is not modified")) return;
        // Message was deleted — next cycle will send a new one
        if (desc.includes("message to edit not found")) {
          progressMessageId = undefined;
          return;
        }
        // Can't parse message text (bad HTML) — fall back to plain text edit
        if (desc.includes("can't parse")) {
          const fallbackText = ps.status === "complete" ? "✅ Complete" : ps.status === "error" ? "❌ Error" : "⏳ Running...";
          await context.api.editMessage(normalized.chatId, progressMessageId, fallbackText).catch(() => {});
          return;
        }
        // Other errors (rate limit, etc.) — ignore, next tick will retry
      }
    }
  };

  // Timer-driven progress send with mutex guard to avoid concurrent API calls
  const tickProgress = async (): Promise<void> => {
    if (progressUpdateInFlight) return;
    if (!lastProgressState || !shouldUpdateDisplay(sentProgressState, lastProgressState)) return;
    progressUpdateInFlight = true;
    sentProgressState = { ...lastProgressState };
    try {
      await sendOrEditProgress(sentProgressState);
    } finally {
      progressUpdateInFlight = false;
    }
  };

  // Flush: cancel timer and send the latest state immediately
  const flushProgress = async (): Promise<void> => {
    if (progressTimerId) { clearInterval(progressTimerId); progressTimerId = undefined; }
    if (firstTickTimeout) { clearTimeout(firstTickTimeout); firstTickTimeout = undefined; }
    if (lastProgressState && !sentProgressState) {
      await sendOrEditProgress(lastProgressState);
    }
  };

  // onProgressState callback saves state. When the engine signals completion,
  // immediately update the progress card.
  const onProgress = (ps: ProgressState): void => {
    lastProgressState = { ...ps };
    if (ps.status === "complete" || ps.status === "error") {
      // Cancel all timers — no more ticks needed
      if (progressTimerId) { clearInterval(progressTimerId); progressTimerId = undefined; }
      if (firstTickTimeout) { clearTimeout(firstTickTimeout); firstTickTimeout = undefined; }
      // Immediately edit the progress card to show the final state.
      sentProgressState = { ...ps };
      progressUpdateInFlight = true;
      sendOrEditProgress(ps).finally(() => { progressUpdateInFlight = false; });
    }
  };

  if (updateIntervalMs !== null) {
    // First tick fires quickly (200ms) to show "Thinking..." without delay
    firstTickTimeout = setTimeout(() => void tickProgress(), 200);
    progressTimerId = setInterval(() => void tickProgress(), updateIntervalMs);
  }

  // Handle async messages (e.g., task notifications from background tasks)
  const onAsyncMessage = async (text: string): Promise<void> => {
    await deliverTelegramResponse(
      context.api,
      normalized.chatId,
      text,
      context.inboxDir,
      cfg.resume?.workspacePath,
      locale,
    );
  };

  const result = await context.bridge.handleAuthorizedMessage({
    chatId: normalized.chatId,
    userId: normalized.userId,
    chatType: normalized.chatType,
    locale,
    text: requestText,
    replyContext,
    files: requestFiles,
    requestOutputDir: state.telegramOutDirPath,
    workspaceOverride: cfg.resume?.workspacePath,
    abortSignal: context.abortSignal,
    onProgressState: updateIntervalMs !== null ? onProgress : undefined,
    onAsyncMessage,
  });

  // Flush the final progress state (adapter already emitted a complete state).
  if (updateIntervalMs !== null) {
    await flushProgress();
  }

  await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);

  // Decide whether to send a separate full-text message after the progress card.
  // In streaming mode, the progress card already displays the final complete text
  // via editMessage. Only send a separate delivery when:
  //   - Non-streaming (no progress card was ever sent)
  //   - Response has file blocks that need extraction ([send-file:] tags, ```file: blocks)
  //   - Response is long enough that the progress card truncated it (4096-char limit)
  const hasFileBlocks = /```file:\S+\n/.test(result.text);
  const hasFileTags = /\[send-file:[^\]]+\]/.test(result.text);
  const needsFileDelivery = hasFileBlocks || hasFileTags;
  // The progress card includes header/tool-call stats which add ~200 chars overhead,
  // plus markdownToTelegramHtml expansion. Use 3200 as a safe threshold to detect
  // responses that would be truncated in the progress card.
  const likelyTruncated = result.text.length > 3200;
  if (updateIntervalMs === null || needsFileDelivery || likelyTruncated) {
    // Non-streaming: always use full delivery
    // Streaming + files: need deliverTelegramResponse to extract and send attachments
    // Streaming + long text: progress card truncated; send full chunked version
    await deliverTelegramResponse(
      context.api,
      normalized.chatId,
      result.text,
      context.inboxDir,
      cfg.resume?.workspacePath,
      locale,
    );
  }

  if (state.telegramOutDirPath) {
    const describedFiles = await describeTelegramOutFiles(state.telegramOutDirPath);
    const limitedFiles = applyTelegramOutLimits(describedFiles, {
      maxFiles: 5,
      maxFileBytes: 512_000,
      maxTotalBytes: 1_500_000,
    });

    for (const file of limitedFiles.accepted) {
      const contents = await readFile(file.path);
      await sendTelegramOutFile(normalized.chatId, file.name, contents);
    }
  }

  if (state.workflowRecordId) {
    await updateWorkflowBestEffort(workflowStore, state.workflowRecordId, (record) => {
      record.status = "completed";
    });
    await appendTimelineEventBestEffort(stateDir, {
      type: "workflow.completed",
      instanceName: context.instanceName,
      channel: "telegram",
      chatId: normalized.chatId,
      userId: normalized.userId,
      updateId: context.updateId,
      detail: "workflow marked completed",
      metadata: {
        workflowRecordId: state.workflowRecordId,
      },
    });
  }

  await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
    outcome: "success",
    metadata: {
      durationMs: Date.now() - startedAt,
      attachments: normalized.attachments.length,
      responseChars: result.text.length,
      chunkCount: chunkTelegramMessage(result.text).length,
    },
  });
}
