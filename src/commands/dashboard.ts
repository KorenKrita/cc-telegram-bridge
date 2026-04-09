import { readdir, readFile, writeFile, stat } from "node:fs/promises";
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
  policy: string;
  pairedUsers: number;
  allowlistCount: number;
  pendingPairs: number;
  sessionBindings: number;
  lastHandledUpdateId: number | null;
  botTokenConfigured: boolean;
  agentMdPreview: string;
  claudeMdExists: boolean;
  usage: {
    requestCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalCostUsd: number;
    lastUpdatedAt: string;
  };
  auditTotal: number;
  lastSuccess: string;
  lastFailure: string;
  lastError: string;
  recentAudit: Array<{ type: string; outcome: string; timestamp: string; detail?: string }>;
  stateDir: string;
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as T; } catch { return fallback; }
}

async function fileExists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; } catch { return false; }
}

async function readTextPreview(filePath: string, maxChars: number): Promise<string> {
  try {
    const raw = await readFile(filePath, "utf8");
    const t = raw.trim();
    return t.length > maxChars ? t.slice(0, maxChars) + "..." : t;
  } catch { return ""; }
}

async function readAllAuditLines(filePath: string): Promise<string[]> {
  try { return (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean); } catch { return []; }
}

async function readLastLine(filePath: string): Promise<string> {
  try {
    const lines = (await readFile(filePath, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.at(-1) ?? "";
  } catch { return ""; }
}

function parseAuditEvent(line: string): InstanceSnapshot["recentAudit"][0] | null {
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    return { type: (e.type as string) ?? "?", outcome: (e.outcome as string) ?? "?", timestamp: (e.timestamp as string) ?? "", detail: typeof e.detail === "string" ? e.detail : undefined };
  } catch { return null; }
}

async function collectInstance(channelsDir: string, name: string): Promise<InstanceSnapshot> {
  const dir = path.join(channelsDir, name);
  const config = await readJsonSafe<{ engine?: string; approvalMode?: string; verbosity?: number }>(path.join(dir, "config.json"), {});
  const lock = await readJsonSafe<{ pid?: number } | null>(path.join(dir, "instance.lock.json"), null);
  const access = await readJsonSafe<{ policy?: string; pairedUsers?: unknown[]; allowlist?: unknown[]; pendingPairs?: unknown[] }>(path.join(dir, "access.json"), {});
  const session = await readJsonSafe<{ chats?: unknown[] }>(path.join(dir, "session.json"), {});
  const runtime = await readJsonSafe<{ lastHandledUpdateId?: number | null }>(path.join(dir, "runtime-state.json"), {});
  const usage = await readJsonSafe<InstanceSnapshot["usage"]>(path.join(dir, "usage.json"), { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0, totalCostUsd: 0, lastUpdatedAt: "" });
  const allAudit = await readAllAuditLines(path.join(dir, "audit.log.jsonl"));
  const recentParsed = allAudit.slice(-10).map(parseAuditEvent).filter((e): e is NonNullable<typeof e> => e !== null);
  let lastSuccess = "", lastFailure = "";
  for (let i = allAudit.length - 1; i >= 0; i--) {
    const evt = parseAuditEvent(allAudit[i]);
    if (!evt) continue;
    if (!lastSuccess && evt.outcome === "success") lastSuccess = evt.timestamp;
    if (!lastFailure && evt.outcome === "error") lastFailure = evt.timestamp;
    if (lastSuccess && lastFailure) break;
  }
  let running = false;
  if (lock?.pid) { try { process.kill(lock.pid, 0); running = true; } catch { running = false; } }

  return {
    name, engine: config.engine ?? "codex", approvalMode: config.approvalMode ?? "normal", verbosity: config.verbosity ?? 1,
    running, pid: running ? (lock?.pid ?? null) : null, policy: access.policy ?? "pairing",
    pairedUsers: Array.isArray(access.pairedUsers) ? access.pairedUsers.length : 0,
    allowlistCount: Array.isArray(access.allowlist) ? access.allowlist.length : 0,
    pendingPairs: Array.isArray(access.pendingPairs) ? access.pendingPairs.length : 0,
    sessionBindings: Array.isArray(session.chats) ? session.chats.length : 0,
    lastHandledUpdateId: runtime.lastHandledUpdateId ?? null,
    botTokenConfigured: await fileExists(path.join(dir, ".env")),
    agentMdPreview: await readTextPreview(path.join(dir, "agent.md"), 200),
    claudeMdExists: await fileExists(path.join(dir, "workspace", "CLAUDE.md")),
    usage, auditTotal: allAudit.length, lastSuccess, lastFailure,
    lastError: (await readLastLine(path.join(dir, "service.stderr.log"))).slice(0, 200),
    recentAudit: recentParsed, stateDir: dir,
  };
}

function e(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function ft(iso: string): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return iso.slice(0, 16); }
}

function renderHtml(instances: InstanceSnapshot[]): string {
  const now = new Date().toISOString();
  const total = instances.length;
  const alive = instances.filter((i) => i.running).length;
  const reqs = instances.reduce((s, i) => s + i.usage.requestCount, 0);
  const cost = instances.reduce((s, i) => s + i.usage.totalCostUsd, 0);
  const toks = instances.reduce((s, i) => s + i.usage.totalInputTokens + i.usage.totalOutputTokens, 0);

  const statCards = [
    { label: "Fleet", value: `${alive}<span style="font-size:14px;color:#64748B">/${total}</span>`, sub: "instances online", gradient: "linear-gradient(135deg, #818CF820, #818CF808)" },
    { label: "Requests", value: reqs.toLocaleString(), sub: "total processed", gradient: "linear-gradient(135deg, #22D3EE20, #22D3EE08)" },
    { label: "Tokens", value: toks > 1e6 ? `${(toks/1e6).toFixed(1)}M` : toks.toLocaleString(), sub: "in + out", gradient: "linear-gradient(135deg, #FDBA7420, #FDBA7408)" },
    { label: "Spend", value: cost > 0 ? `$${cost.toFixed(2)}` : "—", sub: "estimated USD", gradient: "linear-gradient(135deg, #C084FC20, #C084FC08)" },
  ].map(({ label, value, sub, gradient }) => `
    <div class="stat-card" style="background:${gradient}">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-sub">${sub}</div>
    </div>`).join("");

  const cards = instances.map((inst) => {
    const dot = inst.running ? "#34D399" : "#EF4444";
    const eng = inst.engine === "claude" ? { bg: "#C084FC18", fg: "#D8B4FE", border: "#C084FC30" } : { bg: "#22D3EE18", fg: "#67E8F9", border: "#22D3EE30" };
    const yolo = inst.approvalMode === "bypass" ? `<span class="badge" style="background:#EF444418;color:#FCA5A5;border-color:#EF444430">UNSAFE</span>`
      : inst.approvalMode === "full-auto" ? `<span class="badge" style="background:#F59E0B18;color:#FDE68A;border-color:#F59E0B30">YOLO</span>` : "";
    const costStr = inst.usage.totalCostUsd > 0 ? `$${inst.usage.totalCostUsd.toFixed(4)}` : "—";
    const cacheRatio = (inst.usage.totalInputTokens + inst.usage.totalCachedTokens) > 0
      ? Math.round(inst.usage.totalCachedTokens / (inst.usage.totalInputTokens + inst.usage.totalCachedTokens) * 100) : 0;
    const agentHtml = inst.agentMdPreview
      ? `<div class="agent-preview">${e(inst.agentMdPreview)}</div>` : `<div class="agent-empty">no agent.md</div>`;
    const auditHtml = inst.recentAudit.length > 0
      ? inst.recentAudit.map((ev) => {
          const c = ev.outcome === "error" ? "#FCA5A5" : ev.outcome === "success" ? "#86EFAC" : "#94A3B8";
          return `<div class="audit-line"><span class="audit-time">${ft(ev.timestamp)}</span> <span style="color:${c}">${e(ev.type)} → ${ev.outcome}</span></div>`;
        }).join("") : '<div class="audit-empty">No events yet</div>';

    return `
    <div class="card">
      <div class="card-glass"></div>
      <div class="card-content">
        <div class="card-header">
          <div class="card-title"><div class="status-dot" style="background:${dot};box-shadow:0 0 12px ${dot}60"></div>${e(inst.name)}</div>
          <div class="card-badges"><span class="badge" style="background:${eng.bg};color:${eng.fg};border-color:${eng.border}">${inst.engine}</span>${yolo}</div>
        </div>

        <div class="personality-bar" style="border-left-color:${eng.fg}">
          ${agentHtml}
          ${inst.claudeMdExists ? '<span class="claude-md-tag">+ CLAUDE.md</span>' : ""}
        </div>

        <div class="pill-row">
          <span class="pill">${inst.running ? "Running" : "Stopped"}${inst.pid ? ` · ${inst.pid}` : ""}</span>
          <span class="pill">${inst.policy}${inst.policy === "allowlist" ? ` (${inst.allowlistCount})` : ""}</span>
          <span class="pill">${inst.botTokenConfigured ? "Token ✓" : "No token"}</span>
          <span class="pill">v${inst.verbosity}</span>
        </div>

        <div class="metrics">
          <div class="metric"><div class="metric-val" style="color:#22D3EE">${inst.usage.requestCount.toLocaleString()}</div><div class="metric-label">Requests</div></div>
          <div class="metric"><div class="metric-val" style="color:#C084FC">${costStr}</div><div class="metric-label">Cost</div></div>
          <div class="metric"><div class="metric-val" style="color:#FDBA74">${(inst.usage.totalInputTokens + inst.usage.totalOutputTokens).toLocaleString()}</div><div class="metric-label">Tokens</div></div>
          <div class="metric"><div class="metric-val" style="color:#34D399">${cacheRatio}%</div><div class="metric-label">Cache</div></div>
        </div>

        <div class="detail-grid">
          <div>Sessions <span class="detail-val">${inst.sessionBindings}</span></div>
          <div>Paired <span class="detail-val">${inst.pairedUsers}</span></div>
          <div>Success <span class="detail-val" style="color:#86EFAC">${ft(inst.lastSuccess)}</span></div>
          <div>Failure <span class="detail-val" style="color:#FCA5A5">${ft(inst.lastFailure)}</span></div>
        </div>

        ${inst.lastError ? `<div class="error-bar">${e(inst.lastError)}</div>` : ""}

        <div class="audit-section">
          <div class="audit-header"><span>Activity</span><span class="audit-count">${inst.auditTotal.toLocaleString()}</span></div>
          <div class="audit-scroll">${auditHtml}</div>
        </div>

        <div class="card-footer">${e(inst.stateDir)}</div>
      </div>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CC Telegram Bridge — Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,'Segoe UI',sans-serif;background:#06080F;color:#F1F5F9;min-height:100vh;padding:32px 20px}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 20% 0%,#818CF810 0%,transparent 50%),radial-gradient(ellipse at 80% 100%,#22D3EE08 0%,transparent 50%);pointer-events:none;z-index:0}
.wrap{max-width:1280px;margin:0 auto;position:relative;z-index:1}
.header{text-align:center;margin-bottom:28px}
.header h1{font-size:28px;font-weight:800;background:linear-gradient(90deg,#22D3EE,#818CF8,#C084FC);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-0.5px}
.header .sub{color:#475569;font-size:12px;margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
.stat-card{border:1px solid rgba(148,163,184,0.06);border-radius:16px;padding:20px;text-align:center;backdrop-filter:blur(8px)}
.stat-label{color:#64748B;font-size:10px;text-transform:uppercase;letter-spacing:2px;margin-bottom:6px}
.stat-value{font-size:28px;font-weight:800;color:#F1F5F9;line-height:1.2}
.stat-sub{color:#475569;font-size:10px;margin-top:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(540px,1fr));gap:18px}
.card{position:relative;border-radius:20px;overflow:hidden;border:1px solid rgba(148,163,184,0.06)}
.card-glass{position:absolute;inset:0;background:linear-gradient(135deg,rgba(15,20,40,0.8),rgba(10,15,30,0.95));backdrop-filter:blur(20px)}
.card-content{position:relative;z-index:1;padding:22px;display:flex;flex-direction:column;gap:12px}
.card-header{display:flex;justify-content:space-between;align-items:center}
.card-title{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:700}
.status-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.card-badges{display:flex;gap:6px}
.badge{padding:3px 10px;border-radius:8px;font-size:11px;font-weight:600;border:1px solid}
.personality-bar{background:rgba(255,255,255,0.02);border-left:3px solid;padding:8px 12px;border-radius:0 10px 10px 0}
.agent-preview{color:#94A3B8;font-size:11px;font-style:italic;line-height:1.5;max-height:42px;overflow:hidden}
.agent-empty{color:#334155;font-size:11px}
.claude-md-tag{color:#D8B4FE;font-size:10px;margin-top:2px;display:inline-block}
.pill-row{display:flex;gap:6px;flex-wrap:wrap}
.pill{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.04);padding:3px 10px;border-radius:20px;font-size:11px;color:#94A3B8}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.metric{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.03);border-radius:12px;padding:12px;text-align:center}
.metric-val{font-size:16px;font-weight:700;line-height:1.3}
.metric-label{color:#475569;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-top:2px}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:11px;color:#64748B}
.detail-val{color:#CBD5E1;margin-left:4px}
.error-bar{background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.1);border-radius:10px;padding:8px 12px;font-size:10px;color:#FCA5A5;font-family:'SF Mono',Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.audit-section{}
.audit-header{display:flex;justify-content:space-between;margin-bottom:6px;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:#475569}
.audit-count{color:#334155}
.audit-scroll{background:rgba(0,0,0,0.3);border-radius:10px;padding:8px 10px;max-height:130px;overflow-y:auto}
.audit-line{font-size:10px;padding:2px 0;font-family:'SF Mono',Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.audit-time{color:#334155;margin-right:4px}
.audit-empty{color:#334155;font-size:11px}
.card-footer{color:#1E293B;font-size:9px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.footer{text-align:center;margin-top:36px;color:#334155;font-size:11px}
.footer code{background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:4px;color:#475569}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#1E293B;border-radius:2px}
@media(max-width:620px){.grid{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>CC Telegram Bridge</h1>
    <div class="sub">${now.slice(0,19).replace("T"," ")} UTC</div>
  </div>
  <div class="stats">${statCards}</div>
  <div class="grid">${instances.length > 0 ? cards : '<div style="text-align:center;color:#334155;grid-column:1/-1;padding:80px 0;font-size:15px">No instances found<br><span style="font-size:12px">Run <code>telegram configure &lt;token&gt;</code></span></div>'}</div>
  <div class="footer">Read-only snapshot · <code>telegram dashboard</code> to refresh</div>
</div>
</body>
</html>`;
}

function openBrowser(filePath: string): void {
  const cmd = process.platform === "win32" ? `start "" "${filePath}"` : process.platform === "darwin" ? `open "${filePath}"` : `xdg-open "${filePath}"`;
  exec(cmd, () => {});
}

export async function generateDashboard(env: Pick<EnvSource, "HOME" | "USERPROFILE">, outputPath?: string): Promise<string> {
  const channelsDir = resolveChannelsDir(env);
  let names: string[];
  try { names = (await readdir(channelsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { names = []; }
  const instances = await Promise.all(names.map((n) => collectInstance(channelsDir, n)));
  const html = renderHtml(instances);
  const out = outputPath ?? path.join(channelsDir, "dashboard.html");
  await writeFile(out, html, "utf8");
  openBrowser(out);
  return out;
}
