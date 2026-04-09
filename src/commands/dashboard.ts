import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";

import type { EnvSource } from "../config.js";

function resolveChannelsDir(env: Pick<EnvSource, "HOME" | "USERPROFILE">): string {
  const homeDir = env.HOME ?? env.USERPROFILE;
  if (!homeDir) throw new Error("HOME or USERPROFILE is required");
  return path.join(homeDir, ".codex", "channels", "telegram");
}

interface InstanceSnapshot {
  name: string;
  engine: string;
  approvalMode: string;
  verbosity: number;
  running: boolean;
  pid: number | null;
  pairedUsers: number;
  allowlistCount: number;
  sessionBindings: number;
  lastHandledUpdateId: number | null;
  usage: {
    requestCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalCostUsd: number;
    lastUpdatedAt: string;
  };
  recentAudit: string[];
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function readTailLines(filePath: string, count: number): Promise<string[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).slice(-count);
  } catch {
    return [];
  }
}

async function collectInstance(channelsDir: string, name: string): Promise<InstanceSnapshot> {
  const dir = path.join(channelsDir, name);

  const config = await readJsonSafe<{ engine?: string; approvalMode?: string; verbosity?: number }>(
    path.join(dir, "config.json"), {},
  );
  const lock = await readJsonSafe<{ pid?: number } | null>(path.join(dir, "instance.lock.json"), null);
  const access = await readJsonSafe<{ policy?: string; pairedUsers?: unknown[]; allowlist?: unknown[]; pendingPairs?: unknown[] }>(
    path.join(dir, "access.json"), {},
  );
  const session = await readJsonSafe<{ chats?: unknown[] }>(path.join(dir, "session.json"), {});
  const runtime = await readJsonSafe<{ lastHandledUpdateId?: number | null }>(path.join(dir, "runtime-state.json"), {});
  const usage = await readJsonSafe<InstanceSnapshot["usage"]>(path.join(dir, "usage.json"), {
    requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0, totalCostUsd: 0, lastUpdatedAt: "",
  });
  const recentAudit = await readTailLines(path.join(dir, "audit.log.jsonl"), 8);

  let running = false;
  if (lock?.pid) {
    try { process.kill(lock.pid, 0); running = true; } catch { running = false; }
  }

  return {
    name,
    engine: config.engine ?? "codex",
    approvalMode: config.approvalMode ?? "normal",
    verbosity: config.verbosity ?? 1,
    running,
    pid: running ? (lock?.pid ?? null) : null,
    pairedUsers: Array.isArray(access.pairedUsers) ? access.pairedUsers.length : 0,
    allowlistCount: Array.isArray(access.allowlist) ? access.allowlist.length : 0,
    sessionBindings: Array.isArray(session.chats) ? session.chats.length : 0,
    lastHandledUpdateId: runtime.lastHandledUpdateId ?? null,
    usage,
    recentAudit,
  };
}

function renderHtml(instances: InstanceSnapshot[]): string {
  const now = new Date().toISOString();
  const cards = instances.map((inst) => {
    const statusDot = inst.running ? "#34D399" : "#EF4444";
    const statusText = inst.running ? "Running" : "Stopped";
    const engineBadge = inst.engine === "claude"
      ? '<span style="background:rgba(192,132,252,0.15);color:#D8B4FE;padding:2px 8px;border-radius:8px;font-size:12px">Claude</span>'
      : '<span style="background:rgba(34,211,238,0.15);color:#67E8F9;padding:2px 8px;border-radius:8px;font-size:12px">Codex</span>';
    const yoloBadge = inst.approvalMode === "bypass"
      ? '<span style="background:rgba(248,113,113,0.15);color:#FCA5A5;padding:2px 8px;border-radius:8px;font-size:12px">YOLO UNSAFE</span>'
      : inst.approvalMode === "full-auto"
        ? '<span style="background:rgba(251,191,36,0.15);color:#FDE68A;padding:2px 8px;border-radius:8px;font-size:12px">YOLO</span>'
        : '';
    const cost = inst.usage.totalCostUsd > 0 ? `$${inst.usage.totalCostUsd.toFixed(4)}` : "—";
    const auditHtml = inst.recentAudit.length > 0
      ? inst.recentAudit.map((line) => {
          try {
            const evt = JSON.parse(line) as { type?: string; outcome?: string; timestamp?: string };
            const color = evt.outcome === "error" ? "#FCA5A5" : evt.outcome === "success" ? "#86EFAC" : "#94A3B8";
            return `<div style="color:${color};font-size:11px;padding:1px 0;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${evt.type ?? "?"} → ${evt.outcome ?? "?"}</div>`;
          } catch {
            return "";
          }
        }).join("")
      : '<div style="color:#64748B;font-size:12px">No audit events yet</div>';

    return `
    <div style="background:rgba(15,20,35,0.7);border:1px solid rgba(148,163,184,0.1);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:10px;height:10px;border-radius:50%;background:${statusDot}"></div>
          <span style="font-size:20px;font-weight:700;color:#F1F5F9">${inst.name}</span>
        </div>
        <div style="display:flex;gap:6px">${engineBadge}${yoloBadge}</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:12px">
          <div style="color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Status</div>
          <div style="color:#F1F5F9;font-size:16px;font-weight:600">${statusText}${inst.pid ? ` <span style="color:#64748B;font-size:12px">PID ${inst.pid}</span>` : ""}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:12px">
          <div style="color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Cost</div>
          <div style="color:#F1F5F9;font-size:16px;font-weight:600">${cost}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:12px">
          <div style="color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Requests</div>
          <div style="color:#F1F5F9;font-size:16px;font-weight:600">${inst.usage.requestCount.toLocaleString()}</div>
        </div>
        <div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:12px">
          <div style="color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Tokens</div>
          <div style="color:#F1F5F9;font-size:14px;font-weight:600">${(inst.usage.totalInputTokens + inst.usage.totalOutputTokens).toLocaleString()}</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12px">
        <div style="color:#64748B">Sessions: <span style="color:#CBD5E1">${inst.sessionBindings}</span></div>
        <div style="color:#64748B">Paired: <span style="color:#CBD5E1">${inst.pairedUsers}</span></div>
        <div style="color:#64748B">Verbosity: <span style="color:#CBD5E1">${inst.verbosity}</span></div>
      </div>

      <div>
        <div style="color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Recent Activity</div>
        <div style="background:rgba(0,0,0,0.2);border-radius:8px;padding:8px 10px;max-height:120px;overflow-y:auto">
          ${auditHtml}
        </div>
      </div>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CC Telegram Bridge — Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #0A0F1C 0%, #0D1425 40%, #111B33 100%);
      color: #F1F5F9;
      min-height: 100vh;
      padding: 40px 24px;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    .header { text-align: center; margin-bottom: 40px; }
    .header h1 {
      font-size: 28px;
      font-weight: 800;
      background: linear-gradient(90deg, #22D3EE, #818CF8, #C084FC);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }
    .header .subtitle { color: #64748B; font-size: 14px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(480px, 1fr));
      gap: 20px;
    }
    .footer {
      text-align: center;
      margin-top: 40px;
      color: #475569;
      font-size: 12px;
    }
    @media (max-width: 560px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>CC Telegram Bridge</h1>
      <div class="subtitle">Instance Dashboard — generated ${now}</div>
    </div>
    <div class="grid">
      ${instances.length > 0 ? cards : '<div style="text-align:center;color:#64748B;grid-column:1/-1;padding:60px 0">No instances found</div>'}
    </div>
    <div class="footer">Read-only snapshot. Run <code>telegram dashboard</code> to refresh.</div>
  </div>
</body>
</html>`;
}

function openBrowser(filePath: string): void {
  const cmd = process.platform === "win32"
    ? `start "" "${filePath}"`
    : process.platform === "darwin"
      ? `open "${filePath}"`
      : `xdg-open "${filePath}"`;
  exec(cmd, () => {});
}

export async function generateDashboard(
  env: Pick<EnvSource, "HOME" | "USERPROFILE">,
  outputPath?: string,
): Promise<string> {
  const channelsDir = resolveChannelsDir(env);

  let instanceNames: string[];
  try {
    const entries = await readdir(channelsDir, { withFileTypes: true });
    instanceNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    instanceNames = [];
  }

  const instances = await Promise.all(instanceNames.map((name) => collectInstance(channelsDir, name)));
  const html = renderHtml(instances);

  const outPath = outputPath ?? path.join(channelsDir, "dashboard.html");
  await writeFile(outPath, html, "utf8");
  openBrowser(outPath);

  return outPath;
}
