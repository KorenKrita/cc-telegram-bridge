import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { resolveInstanceLockPath } from "../state/instance-lock.js";
import { AccessStore } from "../state/access-store.js";

export interface ServiceCommandEnv extends Pick<EnvSource, "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR"> {}

export interface ServiceCommandDeps {
  cwd?: string;
  isProcessAlive?: (pid: number) => boolean;
  spawnDetached?: (command: string, args: string[]) => void;
  killProcessTree?: (pid: number) => void;
}

export interface ServicePaths {
  instanceName: string;
  stateDir: string;
  lockPath: string;
  stdoutPath: string;
  stderrPath: string;
  entryPath: string;
}

export interface ServiceStatus {
  instanceName: string;
  running: boolean;
  pid: number | null;
  stateDir: string;
  stdoutPath: string;
  stderrPath: string;
  policy: string;
  pairedUsers: number;
  allowlistCount: number;
  pendingPairs: number;
}

type LockRecord = {
  pid: number;
};

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return false;
      }

      if (code === "EPERM") {
        return true;
      }
    }

    throw error;
  }
}

function defaultSpawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function defaultKillProcessTree(pid: number): void {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Failed to stop pid ${pid}`).trim());
  }
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      typeof (parsed as LockRecord).pid === "number"
    ) {
      return (parsed as LockRecord).pid;
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
  }

  return null;
}

export function resolveServicePaths(
  env: ServiceCommandEnv,
  instanceName: string,
  cwd: string,
): ServicePaths {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });

  return {
    instanceName: normalizedInstanceName,
    stateDir,
    lockPath: resolveInstanceLockPath(stateDir),
    stdoutPath: path.join(stateDir, "service.stdout.log"),
    stderrPath: path.join(stateDir, "service.stderr.log"),
    entryPath: path.join(cwd, "dist", "src", "index.js"),
  };
}

export async function startServiceInstance(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const spawnDetachedProcess = deps.spawnDetached ?? defaultSpawnDetached;

  if (!existsSync(paths.entryPath)) {
    throw new Error(`Built entrypoint not found: ${paths.entryPath}`);
  }

  const existingPid = await readLockPid(paths.lockPath);
  if (existingPid !== null && isProcessAlive(existingPid)) {
    throw new Error(`Instance "${paths.instanceName}" is already running with pid ${existingPid}.`);
  }

  await mkdir(paths.stateDir, { recursive: true });

  const command = "pwsh";
  const script = [
    `Set-Location '${cwd.replace(/'/g, "''")}'`,
    `node '${paths.entryPath.replace(/'/g, "''")}' --instance ${paths.instanceName}`,
    `1>> '${paths.stdoutPath.replace(/'/g, "''")}'`,
    `2>> '${paths.stderrPath.replace(/'/g, "''")}'`,
  ].join("; ");

  spawnDetachedProcess(command, ["-NoProfile", "-Command", script]);
  return `Started instance "${paths.instanceName}".`;
}

export async function stopServiceInstance(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const killProcessTree = deps.killProcessTree ?? defaultKillProcessTree;

  const existingPid = await readLockPid(paths.lockPath);
  if (existingPid === null || !isProcessAlive(existingPid)) {
    return `Instance "${paths.instanceName}" is not running.`;
  }

  killProcessTree(existingPid);
  return `Stopped instance "${paths.instanceName}".`;
}

export async function getServiceStatus(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
): Promise<ServiceStatus> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const pid = await readLockPid(paths.lockPath);
  const running = pid !== null && isProcessAlive(pid);
  const accessStore = new AccessStore(path.join(paths.stateDir, "access.json"));
  const accessStatus = await accessStore.getStatus();

  return {
    instanceName: paths.instanceName,
    running,
    pid: running ? pid : null,
    stateDir: paths.stateDir,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    policy: accessStatus.policy,
    pairedUsers: accessStatus.pairedUsers,
    allowlistCount: accessStatus.allowlist.length,
    pendingPairs: accessStatus.pendingPairs.length,
  };
}
