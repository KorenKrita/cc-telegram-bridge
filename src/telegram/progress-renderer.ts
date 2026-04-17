/**
 * Progress renderer for Telegram real-time updates.
 * Uses HTML parse_mode for rich formatting with status emojis and tool call lists.
 * Inspired by metabot's card-builder and telegram-sender.
 */

import type { ProgressState } from "../codex/progress-types.js";

const MAX_MESSAGE_LENGTH = 4096;

const STATUS_EMOJIS = {
  thinking: "🔵",
  running: "🔵",
  complete: "🟢",
  error: "🔴",
};

const STATUS_LABELS = {
  thinking: "Thinking...",
  running: "Running...",
  complete: "Complete",
  error: "Error",
};

/**
 * Escape HTML special characters for Telegram HTML parse_mode
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Truncate message to fit Telegram's limit
 */
function truncateMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const half = Math.floor(MAX_MESSAGE_LENGTH / 2) - 30;
  return (
    text.slice(0, half) +
    "\n\n... (truncated) ...\n\n" +
    text.slice(-half)
  );
}

/**
 * Convert Markdown to Telegram-compatible HTML
 * Handles: code blocks, inline code, bold, italic, links, headings, lists
 */
function markdownToTelegramHtml(md: string): string {
  const lines = md.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code block start/end
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
        codeBlockLines = [];
      } else {
        // End of code block
        inCodeBlock = false;
        const codeContent = escapeHtml(codeBlockLines.join("\n"));
        // Telegram HTML parse_mode doesn't support class attributes on code tags
        // Just wrap code blocks in <pre><code> without language class
        result.push(`<pre><code>${codeContent}</code></pre>`);
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Markdown table: collect consecutive table rows and render as <pre>
    if (isTableRow(line)) {
      const tableLines: string[] = [line];
      while (i + 1 < lines.length && isTableRow(lines[i + 1]!)) {
        i++;
        tableLines.push(lines[i]!);
      }
      result.push(renderTable(tableLines));
      continue;
    }

    // Convert inline markdown for non-code-block lines
    result.push(convertInlineMarkdown(line));
  }

  // If code block was never closed, render what we have
  if (inCodeBlock) {
    const codeContent = escapeHtml(codeBlockLines.join("\n"));
    result.push(`<pre>${codeContent}</pre>`);
  }

  return result.join("\n");
}

/**
 * Detects if a line is a Markdown table row: starts and ends with |, or is a separator (|---|---|).
 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|");
}

/**
 * Renders Markdown table rows into a nicely aligned <pre> block.
 * Strips separator rows (|---|---|), pads columns to equal width.
 */
function renderTable(tableLines: string[]): string {
  const parsed: string[][] = [];
  for (const line of tableLines) {
    const trimmed = line.trim();
    // Skip separator rows like |---|---|
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    parsed.push(cells);
  }

  if (parsed.length === 0) return "";

  const colCount = Math.max(...parsed.map((r) => r.length));
  const colWidths: number[] = new Array(colCount).fill(0);
  for (const row of parsed) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      colWidths[c] = Math.max(colWidths[c]!, cell.length);
    }
  }

  const renderedRows: string[] = [];
  for (let r = 0; r < parsed.length; r++) {
    const row = parsed[r]!;
    const cells = [];
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      cells.push(cell.padEnd(colWidths[c]!));
    }
    renderedRows.push("| " + cells.join(" | ") + " |");
    if (r === 0) {
      const sep = colWidths.map((w) => "-".repeat(w));
      renderedRows.push("| " + sep.join(" | ") + " |");
    }
  }

  return `<pre>${escapeHtml(renderedRows.join("\n"))}</pre>`;
}

/**
 * Convert inline Markdown syntax to Telegram HTML for a single line
 */
function convertInlineMarkdown(line: string): string {
  // Headings: # Heading → <b>Heading</b>
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    return `<b>${convertInlineFormatting(headingMatch[2]!)}</b>`;
  }

  // Horizontal rule: --- or *** or ___
  if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
    return "---";
  }

  // Unordered list: - item or * item
  const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (ulMatch) {
    return `${ulMatch[1]}• ${convertInlineFormatting(ulMatch[2]!)}`;
  }

  // Ordered list: 1. item
  const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
  if (olMatch) {
    return `${olMatch[1]}${olMatch[2]}. ${convertInlineFormatting(olMatch[3]!)}`;
  }

  // Blockquote: > text
  const bqMatch = line.match(/^>\s?(.*)$/);
  if (bqMatch) {
    return `┃ <i>${convertInlineFormatting(bqMatch[1]!)}</i>`;
  }

  return convertInlineFormatting(line);
}

/**
 * Converts inline formatting: bold, italic, strikethrough, code, links
 */
function convertInlineFormatting(text: string): string {
  // Split out inline code spans first to avoid processing markdown inside them
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    if (!codeMatch || codeMatch.index === undefined) {
      parts.push(formatNonCode(remaining));
      break;
    }
    // Text before inline code
    if (codeMatch.index > 0) {
      parts.push(formatNonCode(remaining.slice(0, codeMatch.index)));
    }
    // Inline code — only escape HTML, no further formatting
    parts.push(`<code>${escapeHtml(codeMatch[1]!)}</code>`);
    remaining = remaining.slice(codeMatch.index + codeMatch[0].length);
  }

  return parts.join("");
}

/**
 * Apply formatting (bold, italic, strikethrough, links) to non-code text
 */
function formatNonCode(text: string): string {
  let result = escapeHtml(text);

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Bold + Italic: ***text*** or ___text___
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  result = result.replace(/___(.+?)___/g, "<b><i>$1</i></b>");

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_
  result = result.replace(/\*(.+?)\*/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  return result;
}

/**
 * Render progress state as Telegram HTML message
 * Style inspired by metabot's CardState
 */
export function renderProgressHtml(state: ProgressState): string {
  const parts: string[] = [];

  // Header with status emoji and label
  const emoji = STATUS_EMOJIS[state.status];
  const label = STATUS_LABELS[state.status];
  parts.push(`${emoji} <b>${escapeHtml(label)}</b>`);
  parts.push("");

  // Tool calls
  if (state.toolCalls.length > 0) {
    for (const tc of state.toolCalls) {
      const icon = tc.status === "running" ? "⏳" : "✅";
      const detail = tc.detail || tc.name;
      parts.push(`${icon} <b>${escapeHtml(tc.name)}</b> ${escapeHtml(detail)}`);
    }
    parts.push("---");
  }

  // Response text
  if (state.responseText) {
    parts.push(markdownToTelegramHtml(state.responseText));
  } else if (state.status === "thinking") {
    parts.push("<i>Claude is thinking...</i>");
  }

  // Error message
  if (state.errorMessage) {
    parts.push("");
    parts.push(`<b>❌ Error:</b> ${escapeHtml(state.errorMessage)}`);
  }

  // Stats — show context usage during all states, full stats on complete/error
  {
    const statParts: string[] = [];
    // Token usage — show in all states when available
    if (state.usage) {
      const totalTokens = state.usage.inputTokens + state.usage.outputTokens;
      const ctxPercent = totalTokens > 0 ? Math.round((totalTokens / 200000) * 100) : 0;
      const tokensK = totalTokens >= 1000
        ? `${(totalTokens / 1000).toFixed(1)}k`
        : `${totalTokens}`;
      statParts.push(`ctx: ${tokensK}/200k (${ctxPercent}%)`);
    }
    // Model + duration + cost — only on complete/error
    if (state.status === "complete" || state.status === "error") {
      if (state.model) {
        statParts.push(state.model.replace(/^claude-/, ""));
      }
      if (state.durationMs !== undefined && state.durationMs > 0) {
        statParts.push(`${(state.durationMs / 1000).toFixed(1)}s`);
      }
      if (state.usage?.costUsd !== undefined) {
        statParts.push(`$${state.usage.costUsd.toFixed(2)}`);
      }
    }
    if (statParts.length > 0) {
      parts.push("");
      parts.push(`<i>${escapeHtml(statParts.join(" | "))}</i>`);
    }
  }

  return truncateMessage(parts.join("\n"));
}

/**
 * Check if two progress states are different enough to warrant an update
 */
export function shouldUpdateDisplay(prev: ProgressState | null, current: ProgressState): boolean {
  if (!prev) return true;

  // Always update on status change
  if (prev.status !== current.status) return true;

  // Update if tool calls changed
  if (prev.toolCalls.length !== current.toolCalls.length) return true;
  for (let i = 0; i < prev.toolCalls.length; i++) {
    if (prev.toolCalls[i]?.status !== current.toolCalls[i]?.status) return true;
  }

  // Update if response text changed significantly (every ~100 chars or on complete)
  if (current.status === "complete") return true;
  const textDiff = Math.abs(current.responseText.length - prev.responseText.length);
  if (textDiff > 100) return true;

  // Update on error
  if (prev.errorMessage !== current.errorMessage) return true;

  return false;
}

/**
 * Get update interval in ms based on verbosity level
 * 0 = no streaming (direct delivery)
 * 1 = 2 second interval
 * 2 = 1 second interval
 */
export function getUpdateIntervalMs(verbosity: 0 | 1 | 2): number | null {
  switch (verbosity) {
    case 0:
      return null; // No streaming
    case 1:
      return 2000; // 2 seconds
    case 2:
      return 1000; // 1 second
    default:
      return null;
  }
}
