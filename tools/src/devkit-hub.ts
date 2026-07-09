import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";

const execFileAsync = promisify(execFile);

type ServiceName = "database" | "server" | "tunnel";
type ProcessSlot = "server" | "tunnel" | "devClient";
type ProfileName = "none" | "dev" | "online";
type ServiceStatus = "healthy" | "starting" | "stopped" | "unmanaged" | "degraded" | "error";

type ManagedProcess = {
  pid: number;
  startedAt: string;
  command: string;
  logPath: string;
};

type HubPrefs = {
  guestMode: boolean;
  autoRestart: boolean;
  autoStartProfile: ProfileName;
  backupMaxCount: number;
  devMode: boolean;
  onlineMode: boolean;
  trayEnabled: boolean;
  windowsAutostart: boolean;
};

type HubState = {
  prefs: HubPrefs;
  desired: Record<ServiceName, boolean>;
  processes: Partial<Record<ProcessSlot, ManagedProcess>>;
  lastAutoRestart: Partial<Record<ServiceName, string>>;
  watchdog: Partial<Record<ServiceName, WatchdogState>>;
  startedAt: string;
};

type WatchdogState = {
  failures: number;
  nextAttemptAt?: string;
  gaveUp?: boolean;
  lastError?: string;
};

type HealthSnapshot = {
  service: ServiceName;
  status: ServiceStatus;
  desired: boolean;
  latencyMs?: number;
  pid?: number;
  uptimeSec?: number;
  detail: string;
  checkedAt: string;
};

type HubContext = {
  repoRoot: string;
  port: number;
  sendJson(response: ServerResponse, statusCode: number, payload: unknown): void;
  readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>>;
};

const defaultPrefs: HubPrefs = {
  guestMode: true,
  autoRestart: true,
  autoStartProfile: "none",
  backupMaxCount: 10,
  devMode: true,
  onlineMode: false,
  trayEnabled: false,
  windowsAutostart: false,
};

const healthCacheMs = 3000;
const tunnelTcpCacheMs = 30_000;
const dockerTableCacheMs = 30_000;
const autoRestartCooldownMs = 30_000;
const watchdogMaxFailures = 4;
const logRotateBytes = 50 * 1024 * 1024;
const logRotateKeep = 3;
const localGameUrl = "http://localhost:5173/";
const localGameProbeUrls = [localGameUrl, "http://127.0.0.1:5173/"];

// game sets its online host
const onlineHost = process.env.GAME_ONLINE_HOST || "yourgame.example";
const onlineWsUrl = `wss://${onlineHost}`;
const onlineHttpUrl = `https://${onlineHost}/`;

function commandName(name: string): string {
  return process.platform === "win32" && name === "pnpm" ? `${name}.cmd` : name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeProfile(value: unknown): ProfileName {
  return value === "dev" || value === "online" || value === "none" ? value : "none";
}

function normalizePrefs(value: unknown): HubPrefs {
  const raw = isRecord(value) ? value : {};
  const backupMaxCount = typeof raw.backupMaxCount === "number" && raw.backupMaxCount >= 1 ? Math.floor(raw.backupMaxCount) : 10;
  return {
    guestMode: raw.guestMode !== false,
    autoRestart: raw.autoRestart !== false,
    autoStartProfile: normalizeProfile(raw.autoStartProfile),
    backupMaxCount,
    devMode: raw.devMode !== false,
    onlineMode: raw.onlineMode === true,
    trayEnabled: raw.trayEnabled === true,
    windowsAutostart: raw.windowsAutostart === true,
  };
}

function defaultState(): HubState {
  return {
    prefs: defaultPrefs,
    desired: { database: false, server: false, tunnel: false },
    processes: {},
    lastAutoRestart: {},
    watchdog: {},
    startedAt: new Date().toISOString(),
  };
}

export function parseDockerJsonLines(output: string): Array<Record<string, unknown>> {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of trimmed.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (Array.isArray(parsed)) {
        rows.push(...parsed.filter(isRecord));
      } else if (isRecord(parsed)) {
        rows.push(parsed);
      }
    } catch {
      // Docker sometimes emits warnings around JSON rows; ignore non-JSON lines.
    }
  }
  return rows;
}

function recordText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function labelValue(labels: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|,)${escaped}=([^,]+)`).exec(labels);
  return match?.[1] ?? "";
}

export type DbIdentityReport = {
  ok: boolean;
  expectedContainer?: string;
  owners: Array<{ name: string; project?: string; service?: string; ports?: string; labels?: string }>;
  detail: string;
};

export function evaluateDbIdentity(expectedRows: Array<Record<string, unknown>>, portRows: Array<Record<string, unknown>>): DbIdentityReport {
  const expected = expectedRows.find((row) => {
    const service = recordText(row, ["Service", "service"]);
    return !service || service === "db";
  });
  const expectedContainer = expected ? recordText(expected, ["Name", "name", "Names", "Container"]) : "";
  const owners = portRows.map((row) => {
    const labels = recordText(row, ["Labels", "labels"]);
    return {
      name: recordText(row, ["Names", "Name", "names"]),
      project: recordText(row, ["Project", "project"]) || labelValue(labels, "com.docker.compose.project"),
      service: recordText(row, ["Service", "service"]) || labelValue(labels, "com.docker.compose.service"),
      ports: recordText(row, ["Ports", "ports"]),
      labels,
    };
  });
  if (!expectedContainer) {
    return { ok: false, owners, detail: owners.length ? `db service is not registered in this compose project; 5432 owners: ${owners.map((o) => o.name).join(", ")}` : "db service is not registered in this compose project and no 5432 owner was found" };
  }
  const matched = owners.find((owner) => owner.name === expectedContainer);
  if (!matched) {
    const ownerText = owners.length ? owners.map((owner) => `${owner.name || "unknown"}${owner.project ? ` project=${owner.project}` : ""}${owner.service ? ` service=${owner.service}` : ""}`).join("; ") : "none";
    return { ok: false, expectedContainer, owners, detail: `5432 is not owned by expected compose db container ${expectedContainer}; owners: ${ownerText}` };
  }
  return { ok: true, expectedContainer, owners, detail: `5432 owned by ${expectedContainer}` };
}

export function watchdogDelayMs(failures: number): number {
  return Math.min(autoRestartCooldownMs * 2 ** Math.max(0, failures - 1), 5 * 60_000);
}

export function nextWatchdogFailureState(previous: WatchdogState | undefined, errorLine: string, now = Date.now()): WatchdogState {
  const failures = (previous?.failures ?? 0) + 1;
  return {
    failures,
    nextAttemptAt: new Date(now + watchdogDelayMs(failures)).toISOString(),
    gaveUp: failures >= watchdogMaxFailures,
    lastError: errorLine,
  };
}

export function isRecoverableLogRotationError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM";
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<number | undefined> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (latency?: number) => {
      socket.destroy();
      resolve(latency);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(Date.now() - started));
    socket.once("timeout", () => done());
    socket.once("error", () => done());
  });
}

async function runTool(command: string, args: string[], cwd: string, timeoutMs = 120_000, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: `${result.stdout}${result.stderr}`.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || String(error) };
  }
}

// Best-effort: on Windows the taskkill result is async and cannot be surfaced
// synchronously, so `true` means "kill dispatched", not "process confirmed dead".
// The error listener prevents a failed spawn (e.g. taskkill missing) from raising
// an unhandled 'error' event that would crash the hub.
function treeKill(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", (error) => {
        console.error(`[devkit-hub] taskkill spawn failed for pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
      });
      return true;
    }
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

export class DevkitHub {
  private state: HubState = defaultState();
  private children = new Map<number, ChildProcess>();
  private healthCache: { at: number; value: HealthSnapshot[] } | undefined;
  private tunnelTcpCache: { at: number; latency?: number } | undefined;
  private dockerTableCache: { at: number; output: string } | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private readonly statePath: string;
  private readonly localRoot: string;
  private readonly backupsRoot: string;
  private readonly serverLog: string;
  private readonly tunnelLog: string;
  private readonly devClientLog: string;

  constructor(private readonly context: HubContext) {
    this.localRoot = path.join(context.repoRoot, ".local");
    this.statePath = path.join(this.localRoot, "hub-state.json");
    this.backupsRoot = path.join(context.repoRoot, "backups");
    this.serverLog = path.join(context.repoRoot, "server.log");
    this.tunnelLog = path.join(this.localRoot, "tunnel.log");
    this.devClientLog = path.join(this.localRoot, "dev-client.log");
  }

  async init(): Promise<void> {
    await mkdir(this.localRoot, { recursive: true });
    await mkdir(this.backupsRoot, { recursive: true });
    await this.loadState();
    await this.rotateLogIfNeeded(this.serverLog);
    await this.rotateLogIfNeeded(this.tunnelLog);
    this.startWatchdog();
    if (this.state.prefs.autoStartProfile !== "none") {
      void this.applyProfile(this.state.prefs.autoStartProfile).catch((error) => this.appendHubLog(`auto-start failed: ${String(error)}`));
    }
  }

  registerRoutes(routes: Map<string, (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>>): void {
    routes.set("GET /api/hub/status", async (_request, response) => this.handleStatus(response));
    routes.set("GET /api/hub/health", async (_request, response) => this.handleHealth(response));
    routes.set("GET /api/hub/prefs", async (_request, response) => this.context.sendJson(response, 200, { ok: true, prefs: this.state.prefs }));
    routes.set("POST /api/hub/prefs", async (request, response) => this.handlePrefs(request, response));
    routes.set("POST /api/hub/service", async (request, response) => this.handleService(request, response));
    routes.set("POST /api/hub/profile", async (request, response) => this.handleProfile(request, response));
    routes.set("POST /api/hub/launcher", async (request, response) => this.handleLauncher(request, response));
    routes.set("GET /api/hub/logs", async (_request, response, url) => this.handleLogs(response, url));
    routes.set("POST /api/hub/logs/clear", async (request, response) => this.handleLogClear(request, response));
    routes.set("POST /api/hub/logs/rotate", async (request, response) => this.handleLogRotate(request, response));
    routes.set("GET /api/hub/backups", async (_request, response) => this.handleBackups(response));
    routes.set("POST /api/hub/backup", async (request, response) => this.handleBackup(request, response));
    routes.set("POST /api/hub/restore", async (request, response) => this.handleRestore(request, response));
    routes.set("GET /api/hub/diagnostics", async (_request, response) => this.handleDiagnostics(response));
    routes.set("POST /api/hub/tray", async (request, response) => this.handleTray(request, response));
    routes.set("POST /api/hub/toast", async (request, response) => this.handleToast(request, response));
  }

  async restartServerForZoneLoop(dryRun = false): Promise<{ ok: boolean; output: string; dryRun?: true }> {
    if (dryRun) return { ok: true, dryRun: true, output: "server restart dry-run accepted" };
    return this.restartService("server");
  }

  private async loadState(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<HubState>;
      const desired: Record<string, unknown> = isRecord(parsed.desired) ? parsed.desired : {};
      this.state = {
        prefs: normalizePrefs(parsed.prefs),
        desired: {
          database: desired.database === true,
          server: desired.server === true,
          tunnel: desired.tunnel === true,
        },
        processes: isRecord(parsed.processes) ? (parsed.processes as HubState["processes"]) : {},
        lastAutoRestart: isRecord(parsed.lastAutoRestart) ? (parsed.lastAutoRestart as HubState["lastAutoRestart"]) : {},
        watchdog: isRecord(parsed.watchdog) ? (parsed.watchdog as HubState["watchdog"]) : {},
        startedAt: parsed.startedAt ?? new Date().toISOString(),
      };
    } catch {
      this.state = defaultState();
      await this.saveState();
    }
  }

  private async saveState(): Promise<void> {
    await mkdir(this.localRoot, { recursive: true });
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  private async appendHubLog(line: string): Promise<void> {
    await mkdir(this.localRoot, { recursive: true });
    const stamp = new Date().toISOString();
    await writeFile(path.join(this.localRoot, "hub.log"), `[${stamp}] ${line}\n`, { flag: "a" });
  }

  private async rotateLogIfNeeded(filePath: string): Promise<void> {
    try {
      const info = await stat(filePath);
      if (info.size < logRotateBytes) return;
      for (let i = logRotateKeep - 1; i >= 1; i--) {
        const from = `${filePath}.${i}`;
        const to = `${filePath}.${i + 1}`;
        if (existsSync(from)) await rename(from, to).catch(() => undefined);
      }
      await rename(filePath, `${filePath}.1`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (isRecoverableLogRotationError(error)) {
        await this.appendHubLog(`log rotation skipped for ${filePath}: ${code}`);
        return;
      }
      await this.appendHubLog(`log rotation skipped for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private spawnTracked(service: ProcessSlot, command: string, args: string[], logPath: string, env?: NodeJS.ProcessEnv, cwd = this.context.repoRoot): ManagedProcess {
    mkdirSync(path.dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, "a");
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    // Child inherited its own dup of logFd via stdio; close the parent's copy on every
    // path (incl. the throw below) so restarts don't leak one fd per launch.
    closeSync(logFd);
    child.unref();
    if (!child.pid) throw new Error(`failed to launch ${service}`);
    this.children.set(child.pid, child);
    child.once("exit", () => {
      this.children.delete(child.pid ?? 0);
    });
    return { pid: child.pid, startedAt: new Date().toISOString(), command: [command, ...args].join(" "), logPath };
  }

  private async startDatabase(): Promise<{ ok: boolean; output: string }> {
    if ((await tcpProbe("127.0.0.1", 5432, 700)) !== undefined) {
      const preflight = await this.checkDbIdentity();
      if (!preflight.ok) return { ok: false, output: `Refusing migration: ${preflight.detail}` };
    }
    const up = await runTool(commandName("docker"), ["compose", "up", "-d"], this.context.repoRoot, 120_000);
    if (!up.ok) return up;
    let ready = false;
    for (let i = 0; i < 20; i++) {
      if ((await tcpProbe("127.0.0.1", 5432, 700)) !== undefined) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (!ready) return { ok: false, output: `${up.output}\nPostgreSQL did not accept TCP connections before migration.` };
    const identity = await this.checkDbIdentity();
    if (!identity.ok) return { ok: false, output: `${up.output}\nRefusing migration: ${identity.detail}` };
    let migrate: { ok: boolean; output: string } = { ok: false, output: "migration not attempted" };
    for (let i = 0; i < 5; i++) {
      migrate = await runTool(commandName("pnpm"), ["db:migrate"], this.context.repoRoot, 120_000, {
        DATABASE_URL: "postgres://gamekit:gamekit_dev@localhost:5432/gamekit",
      });
      if (migrate.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return { ok: migrate.ok, output: [up.output, migrate.output].filter(Boolean).join("\n") };
  }

  private async stopDatabase(): Promise<{ ok: boolean; output: string }> {
    return runTool(commandName("docker"), ["compose", "down"], this.context.repoRoot, 120_000);
  }

  private async startServer(): Promise<{ ok: boolean; output: string }> {
    await this.ensureDependency("database");
    await this.rotateLogIfNeeded(this.serverLog);
    const old = this.state.processes.server;
    if (processAlive(old?.pid)) return { ok: true, output: `server already tracked at pid ${old?.pid}` };
    this.state.processes.server = this.spawnTracked(
      "server",
      process.execPath,
      [path.join(this.context.repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
      this.serverLog,
      {
        DATABASE_URL: "postgres://gamekit:gamekit_dev@localhost:5432/gamekit",
        ALLOW_GUEST_LOGIN: this.state.prefs.guestMode ? "true" : "false",
      },
      path.join(this.context.repoRoot, "server"),
    );
    await this.saveState();
    return { ok: true, output: `server started pid ${this.state.processes.server.pid}` };
  }

  private async startDevClient(): Promise<{ ok: boolean; output: string; pid?: number; url: string }> {
    await this.rotateLogIfNeeded(this.devClientLog);
    const old = this.state.processes.devClient;
    const preflight = await this.probeAllHttp(localGameProbeUrls, 900);
    if (processAlive(old?.pid) && preflight.ok) {
      return { ok: true, pid: old?.pid, url: localGameUrl, output: `dev client already ready at ${localGameUrl}` };
    }
    if (preflight.ok) return { ok: true, url: localGameUrl, output: `dev client already ready at ${localGameUrl}` };
    const partial = await Promise.all(localGameProbeUrls.map(async (url) => ({ url, probe: await this.probeHttp(url, 900) })));
    if (partial.some((item) => item.probe.ok)) {
      const failed = partial.filter((item) => !item.probe.ok).map((item) => `${item.url}: ${item.probe.error ?? `HTTP ${item.probe.status ?? "unknown"}`}`).join("; ");
      return { ok: false, url: localGameUrl, output: `dev client port 5173 is partially reachable; refusing to spawn over an inconsistent listener (${failed})` };
    }
    if (old?.pid && !processAlive(old.pid)) delete this.state.processes.devClient;
    const managed = this.spawnTracked("devClient", commandName("pnpm"), ["dev:client"], this.devClientLog);
    this.state.processes.devClient = managed;
    await this.saveState();
    const ready = await this.waitForAllHttp(localGameProbeUrls, 15_000);
    if (!ready.ok) return { ok: false, pid: managed.pid, url: localGameUrl, output: `dev client spawned pid ${managed.pid}, but ${ready.error}` };
    return { ok: true, pid: managed.pid, url: localGameUrl, output: `dev client ready at ${localGameUrl}` };
  }

  private async stopServer(): Promise<{ ok: boolean; output: string }> {
    const managed = this.state.processes.server;
    delete this.state.processes.server;
    await this.saveState();
    if (!managed?.pid) return { ok: true, output: "no tracked server pid" };
    if (!processAlive(managed.pid)) return { ok: true, output: `tracked server pid ${managed.pid} already exited` };
    return { ok: treeKill(managed.pid), output: `stopped tracked server pid ${managed.pid}` };
  }

  private async startTunnel(): Promise<{ ok: boolean; output: string }> {
    await this.ensureDependency("database");
    await this.ensureDependency("server");
    await this.rotateLogIfNeeded(this.tunnelLog);
    const old = this.state.processes.tunnel;
    if (processAlive(old?.pid)) return { ok: true, output: `tunnel already tracked at pid ${old?.pid}` };
    this.state.processes.tunnel = this.spawnTracked("tunnel", this.cloudflaredCommand(), ["tunnel", "run", "gamekit"], this.tunnelLog);
    await this.saveState();
    return { ok: true, output: `tunnel started pid ${this.state.processes.tunnel.pid}` };
  }

  private async stopTunnel(): Promise<{ ok: boolean; output: string }> {
    const managed = this.state.processes.tunnel;
    delete this.state.processes.tunnel;
    await this.saveState();
    if (!managed?.pid) return { ok: true, output: "no tracked tunnel pid" };
    if (!processAlive(managed.pid)) return { ok: true, output: `tracked tunnel pid ${managed.pid} already exited` };
    return { ok: treeKill(managed.pid), output: `stopped tracked tunnel pid ${managed.pid}` };
  }

  private cloudflaredCommand(): string {
    if (process.platform === "win32") {
      const installed = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
      if (existsSync(installed)) return installed;
    }
    return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  }

  private async ensureDependency(service: ServiceName): Promise<void> {
    const health = await this.healthOne(service, true);
    if (health.status === "healthy") return;
    const result = await this.startService(service, false);
    if (!result.ok) throw new Error(`failed to auto-start ${service}: ${result.output}`);
  }

  private async startService(service: ServiceName, markDesired: boolean): Promise<{ ok: boolean; output: string }> {
    if (markDesired) {
      this.state.desired[service] = true;
      if (service === "server") this.state.desired.database = true;
      if (service === "tunnel") {
        this.state.desired.database = true;
        this.state.desired.server = true;
      }
      await this.saveState();
    }
    const result = service === "database" ? await this.startDatabase() : service === "server" ? await this.startServer() : await this.startTunnel();
    if (result.ok) {
      delete this.state.watchdog[service];
      await this.saveState();
    }
    return result;
  }

  private async stopService(service: ServiceName, markDesired: boolean): Promise<{ ok: boolean; output: string }> {
    if (markDesired) {
      this.state.desired[service] = false;
      if (service === "database") {
        this.state.desired.server = false;
        this.state.desired.tunnel = false;
      }
      if (service === "server") this.state.desired.tunnel = false;
      await this.saveState();
    }
    if (service === "tunnel") return this.stopTunnel();
    if (service === "server") return this.stopServer();
    await this.stopTunnel();
    await this.stopServer();
    return this.stopDatabase();
  }

  private async restartService(service: ServiceName): Promise<{ ok: boolean; output: string }> {
    const stopped = await this.stopService(service, false);
    const started = await this.startService(service, true);
    return { ok: stopped.ok && started.ok, output: [stopped.output, started.output].join("\n") };
  }

  private async healthOne(service: ServiceName, fresh = false): Promise<HealthSnapshot> {
    const checkedAt = new Date().toISOString();
    if (service === "database") {
      const latency = await tcpProbe("127.0.0.1", 5432, 700);
      const identity = latency !== undefined ? await this.checkDbIdentity() : { ok: false, detail: "PostgreSQL is not accepting TCP on 5432" };
      const watchdog = this.state.watchdog.database;
      return {
        service,
        desired: this.state.desired.database,
        status: watchdog?.gaveUp ? "error" : latency !== undefined && identity.ok ? "healthy" : latency !== undefined ? "degraded" : this.state.desired.database ? "starting" : "stopped",
        latencyMs: latency,
        detail: watchdog?.lastError ? `${identity.detail}; watchdog: ${watchdog.lastError}` : identity.detail,
        checkedAt,
      };
    }
    if (service === "server") {
      const managed = this.state.processes.server;
      const pidAlive = processAlive(managed?.pid);
      const latency = await tcpProbe("127.0.0.1", 2567, 700);
      let detail = pidAlive ? "tracked process alive" : managed?.pid ? "tracked process exited" : "no tracked process";
      if (latency !== undefined) {
        try {
          const started = Date.now();
          const response = await fetch("http://127.0.0.1:2567/matchmake/world", { signal: AbortSignal.timeout(1200) });
          detail = `${detail}; /matchmake/world ${response.status} in ${Date.now() - started}ms`;
        } catch (error) {
          detail = `${detail}; matchmake probe failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const watchdog = this.state.watchdog.server;
      if (watchdog?.lastError) detail = `${detail}; watchdog: ${watchdog.lastError}`;
      const status = watchdog?.gaveUp ? "error" : latency !== undefined && pidAlive ? "healthy" : latency !== undefined ? "unmanaged" : this.state.desired.server ? "starting" : "stopped";
      return {
        service,
        desired: this.state.desired.server,
        status,
        pid: managed?.pid,
        uptimeSec: managed ? Math.max(0, Math.floor((Date.now() - Date.parse(managed.startedAt)) / 1000)) : undefined,
        latencyMs: latency,
        detail,
        checkedAt,
      };
    }
    const managed = this.state.processes.tunnel;
    const pidAlive = processAlive(managed?.pid);
    const watchdog = this.state.watchdog.tunnel;
    if (fresh || !this.tunnelTcpCache || Date.now() - this.tunnelTcpCache.at > tunnelTcpCacheMs) {
      this.tunnelTcpCache = { at: Date.now(), latency: await tcpProbe(onlineHost, 443, 1500) };
    }
    return {
      service,
      desired: this.state.desired.tunnel,
      status: watchdog?.gaveUp ? "error" : pidAlive ? "healthy" : this.state.desired.tunnel ? "starting" : "stopped",
      pid: managed?.pid,
      uptimeSec: managed ? Math.max(0, Math.floor((Date.now() - Date.parse(managed.startedAt)) / 1000)) : undefined,
      latencyMs: this.tunnelTcpCache.latency,
      detail: `${pidAlive ? "tracked cloudflared process alive" : managed?.pid ? "tracked cloudflared process exited" : "no tracked tunnel pid"}${watchdog?.lastError ? `; watchdog: ${watchdog.lastError}` : ""}`,
      checkedAt,
    };
  }

  private async healthAll(fresh = false): Promise<HealthSnapshot[]> {
    if (!fresh && this.healthCache && Date.now() - this.healthCache.at < healthCacheMs) return this.healthCache.value;
    // Probe the three services concurrently: they are independent (no shared writes across
    // branches — only the tunnel branch touches tunnelTcpCache), so a fresh refresh costs the
    // slowest single probe, not the sum. When services are down each TCP probe blocks for its
    // full timeout, so sequential summed to ~1.4s worst case (P4 latency budget).
    const value = await Promise.all([this.healthOne("database", fresh), this.healthOne("server", fresh), this.healthOne("tunnel", fresh)]);
    this.healthCache = { at: Date.now(), value };
    return value;
  }

  private startWatchdog(): void {
    this.watchdog = setInterval(() => {
      void this.watchdogTick().catch((error) => this.appendHubLog(`watchdog error: ${String(error)}`));
    }, healthCacheMs);
    this.watchdog.unref();
  }

  private async watchdogTick(): Promise<void> {
    if (!this.state.prefs.autoRestart) return;
    const health = await this.healthAll(true);
    for (const item of health) {
      if (!item.desired || item.status === "healthy") continue;
      const watchdog = this.state.watchdog[item.service];
      if (watchdog?.gaveUp) continue;
      if (watchdog?.nextAttemptAt && Date.now() < Date.parse(watchdog.nextAttemptAt)) continue;
      const last = this.state.lastAutoRestart[item.service] ? Date.parse(this.state.lastAutoRestart[item.service] ?? "") : 0;
      if (Date.now() - last < autoRestartCooldownMs) continue;
      this.state.lastAutoRestart[item.service] = new Date().toISOString();
      await this.saveState();
      await this.appendHubLog(`watchdog restarting ${item.service}: ${item.detail}`);
      const result = await this.startService(item.service, true);
      if (!result.ok) {
        this.state.watchdog[item.service] = nextWatchdogFailureState(watchdog, result.output.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "restart failed");
        await this.saveState();
        await this.appendHubLog(`watchdog restart failed for ${item.service} (${this.state.watchdog[item.service]?.failures ?? 0}/${watchdogMaxFailures}): ${this.state.watchdog[item.service]?.lastError}`);
      }
    }
  }

  private async probeHttp(url: string, timeoutMs: number): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: response.ok, status: response.status, error: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async probeAllHttp(urls: string[], timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    const probes = await Promise.all(urls.map(async (url) => ({ url, probe: await this.probeHttp(url, timeoutMs) })));
    const failed = probes.find((item) => !item.probe.ok);
    if (failed) return { ok: false, error: `${failed.url}: ${failed.probe.error ?? `HTTP ${failed.probe.status ?? "unknown"}`}` };
    return { ok: true };
  }

  private async waitForAllHttp(urls: string[], timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    let last = "not checked";
    while (Date.now() < deadline) {
      const probe = await this.probeAllHttp(urls, 900);
      if (probe.ok) return { ok: true };
      last = probe.error ?? "unknown probe failure";
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { ok: false, error: `${urls.join(" and ")} did not become ready before timeout; last probe: ${last}` };
  }

  private async checkDbIdentity(): Promise<DbIdentityReport> {
    const expected = await runTool(commandName("docker"), ["compose", "ps", "db", "--format", "json"], this.context.repoRoot, 7000);
    const owners = await runTool(commandName("docker"), ["ps", "--filter", "publish=5432", "--format", "{{json .}}"], this.context.repoRoot, 7000);
    return evaluateDbIdentity(parseDockerJsonLines(expected.output), parseDockerJsonLines(owners.output));
  }

  private async dockerTable(): Promise<string> {
    if (this.dockerTableCache && Date.now() - this.dockerTableCache.at < dockerTableCacheMs) return this.dockerTableCache.output;
    const result = await runTool(commandName("docker"), ["compose", "ps", "--format", "table {{.Name}}\t{{.Image}}\t{{.Status}}"], this.context.repoRoot, 7000);
    this.dockerTableCache = { at: Date.now(), output: result.output };
    return result.output;
  }

  private async backupFiles(): Promise<Array<{ file: string; path: string; sizeBytes: number; modifiedAt: string }>> {
    await mkdir(this.backupsRoot, { recursive: true });
    const entries = await readdir(this.backupsRoot, { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql")).map(async (entry) => {
      const full = path.join(this.backupsRoot, entry.name);
      const info = await stat(full);
      return { file: entry.name, path: full, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() };
    }));
    return files.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  }

  private async pruneBackups(maxCount = this.state.prefs.backupMaxCount): Promise<string[]> {
    const files = await this.backupFiles();
    const removed: string[] = [];
    for (const file of files.slice(maxCount)) {
      await unlink(file.path);
      removed.push(file.file);
    }
    return removed;
  }

  private async tail(filePath: string, lines: number): Promise<string[]> {
    if (!existsSync(filePath)) return [];
    const text = await readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines);
  }

  private async diagnostics(): Promise<Record<string, unknown>> {
    return {
      repoRoot: this.context.repoRoot,
      hubUptimeSec: Math.floor((Date.now() - Date.parse(this.state.startedAt)) / 1000),
      docker: await this.dockerTable(),
      health: await this.healthAll(true),
      backups: await this.backupFiles(),
      prefs: this.state.prefs,
      db5432Owners: (await this.checkDbIdentity()).owners,
      logs: {
        server: existsSync(this.serverLog) ? await stat(this.serverLog).then((s) => ({ path: this.serverLog, sizeBytes: s.size })) : null,
        tunnel: existsSync(this.tunnelLog) ? await stat(this.tunnelLog).then((s) => ({ path: this.tunnelLog, sizeBytes: s.size })) : null,
      },
    };
  }

  private async handleStatus(response: ServerResponse): Promise<void> {
    this.context.sendJson(response, 200, {
      ok: true,
      prefs: this.state.prefs,
      desired: this.state.desired,
      processes: this.state.processes,
      health: await this.healthAll(),
      docker: await this.dockerTable(),
      backups: await this.backupFiles(),
      logs: {
        server: this.serverLog,
        tunnel: this.tunnelLog,
        devClient: this.devClientLog,
      },
    });
  }

  private async handleHealth(response: ServerResponse): Promise<void> {
    this.context.sendJson(response, 200, { ok: true, health: await this.healthAll(true), docker: await this.dockerTable() });
  }

  private async handlePrefs(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.context.readRequestJson(request);
    const previousAutostart = this.state.prefs.windowsAutostart;
    this.state.prefs = normalizePrefs({ ...this.state.prefs, ...payload });
    if (payload.windowsAutostart !== undefined && this.state.prefs.windowsAutostart !== previousAutostart) {
      const autostart = await this.configureWindowsAutostart(this.state.prefs.windowsAutostart);
      if (!autostart.ok) {
        this.state.prefs.windowsAutostart = previousAutostart;
        this.context.sendJson(response, 500, { ok: false, error: autostart.output, prefs: this.state.prefs });
        return;
      }
    }
    await this.saveState();
    this.context.sendJson(response, 200, { ok: true, prefs: this.state.prefs });
  }

  private async configureWindowsAutostart(enabled: boolean): Promise<{ ok: boolean; output: string }> {
    if (process.platform !== "win32") return { ok: true, output: "Windows autostart is unavailable on this platform." };
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    if (!enabled) {
      const result = await runTool("reg", ["delete", key, "/v", "GameKitDevKit", "/f"], this.context.repoRoot, 10_000);
      return { ok: true, output: result.output || "Windows autostart disabled." };
    }
    const command = `cmd.exe /c cd /d "${this.context.repoRoot}" && pnpm devkit`;
    return runTool("reg", ["add", key, "/v", "GameKitDevKit", "/t", "REG_SZ", "/d", command, "/f"], this.context.repoRoot, 10_000);
  }

  private async handleService(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.context.readRequestJson(request);
    const service = payload.service;
    const action = payload.action;
    if (payload.dryRun === true) {
      this.context.sendJson(response, 200, { ok: true, dryRun: true, accepted: ["database", "server", "tunnel"], actions: ["start", "stop", "restart"] });
      return;
    }
    if (service !== "database" && service !== "server" && service !== "tunnel") {
      this.context.sendJson(response, 400, { ok: false, error: "service must be database, server, or tunnel" });
      return;
    }
    if (action !== "start" && action !== "stop" && action !== "restart") {
      this.context.sendJson(response, 400, { ok: false, error: "action must be start, stop, or restart" });
      return;
    }
    const result = action === "start" ? await this.startService(service, true) : action === "stop" ? await this.stopService(service, true) : await this.restartService(service);
    this.context.sendJson(response, result.ok ? 200 : 500, { ok: result.ok, service, action, output: result.output, health: await this.healthAll(true) });
  }

  private async handleProfile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.context.readRequestJson(request);
    const profile = normalizeProfile(payload.profile);
    if (payload.save === true) {
      this.state.prefs.autoStartProfile = profile;
      await this.saveState();
    }
    if (payload.dryRun === true) {
      this.context.sendJson(response, 200, { ok: true, dryRun: true, profile });
      return;
    }
    const output = await this.applyProfile(profile);
    this.context.sendJson(response, 200, { ok: true, profile, output });
  }

  private async applyProfile(profile: ProfileName): Promise<string> {
    if (profile === "none") return "profile none saved; no services started";
    if (profile === "dev") {
      this.state.prefs.devMode = true;
      this.state.prefs.onlineMode = false;
      await this.saveState();
      const result = await this.startService("server", true).catch((error) => ({ ok: false, output: error instanceof Error ? error.message : String(error) }));
      const client = await this.startDevClient().catch((error) => ({ ok: false, output: error instanceof Error ? error.message : String(error), url: localGameUrl }));
      return [`server: ${result.output}`, `dev-client: ${client.output}`].filter(Boolean).join("\n");
    }
    this.state.prefs.onlineMode = true;
    this.state.prefs.devMode = false;
    await this.saveState();
    const build = await runTool(commandName("pnpm"), ["build:client"], this.context.repoRoot, 180_000, {
      VITE_COLYSEUS_URL: onlineWsUrl,
    });
    const tunnel = await this.startService("tunnel", true);
    return [build.output, tunnel.output].filter(Boolean).join("\n");
  }

  private async handleLauncher(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.context.readRequestJson(request);
    const action = typeof payload.action === "string" ? payload.action : "";
    if (payload.dryRun === true) {
      this.context.sendJson(response, 200, { ok: true, dryRun: true, actions: ["build-client", "dev-client", "validate", "open-game"] });
      return;
    }
    if (action === "build-client") {
      const result = await runTool(commandName("pnpm"), ["build:client"], this.context.repoRoot, 180_000);
      this.context.sendJson(response, result.ok ? 200 : 500, { ok: result.ok, output: result.output });
      return;
    }
    if (action === "validate") {
      const result = await runTool(commandName("pnpm"), ["validate"], this.context.repoRoot, 240_000);
      this.context.sendJson(response, result.ok ? 200 : 500, { ok: result.ok, output: result.output });
      return;
    }
    if (action === "dev-client") {
      const result = await this.startDevClient();
      this.context.sendJson(response, result.ok ? 200 : 500, result);
      return;
    }
    if (action === "open-game") {
      const url = this.state.prefs.onlineMode ? onlineHttpUrl : localGameUrl;
      const probe = this.state.prefs.onlineMode ? await this.probeHttp(url, 1200) : await this.probeAllHttp(localGameProbeUrls, 1200);
      this.context.sendJson(response, probe.ok ? 200 : 503, { ok: probe.ok, url, status: "status" in probe ? probe.status : undefined, error: probe.ok ? undefined : `game target is not reachable: ${probe.error ?? "unknown probe failure"}` });
      return;
    }
    this.context.sendJson(response, 400, { ok: false, error: "unknown launcher action" });
  }

  private async handleLogs(response: ServerResponse, url: URL): Promise<void> {
    const logName = url.searchParams.get("log") ?? "server";
    const lines = Math.min(200, Math.max(1, Number(url.searchParams.get("lines") ?? "60")));
    const file = logName === "tunnel" ? this.tunnelLog : logName === "dev-client" ? this.devClientLog : logName === "hub" ? path.join(this.localRoot, "hub.log") : this.serverLog;
    this.context.sendJson(response, 200, { ok: true, log: logName, path: file, lines: await this.tail(file, lines) });
  }

  private async handleLogClear(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.context.readRequestJson(request);
    const logName = payload.log === "tunnel" ? "tunnel" : payload.log === "dev-client" ? "dev-client" : payload.log === "hub" ? "hub" : "server";
    if (payload.dryRun === true) {
      this.context.sendJson(response, 200, { ok: true, dryRun: true, log: logName });
      return;
    }
    const file = logName === "tunnel" ? this.tunnelLog : logName === "dev-client" ? this.devClientLog : logName === "hub" ? path.join(this.localRoot, "hub.log") : this.serverLog;
    await writeFile(file, "", "utf8");
    this.context.sendJson(response, 200, { ok: true, log: logName, path: file });
  }

  private async handleLogRotate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.context.readRequestJson(request);
    const file = payload.log === "tunnel" ? this.tunnelLog : this.serverLog;
    if (payload.dryRun === true) {
      this.context.sendJson(response, 200, { ok: true, dryRun: true, path: file });
      return;
    }
    await this.rotateLogIfNeeded(file);
    this.context.sendJson(response, 200, { ok: true, path: file });
  }

  private async handleBackups(response: ServerResponse): Promise<void> {
    const backups = await this.backupFiles();
    const totalBytes = backups.reduce((sum, item) => sum + item.sizeBytes, 0);
    this.context.sendJson(response, 200, { ok: true, backups, totalBytes, maxCount: this.state.prefs.backupMaxCount });
  }

  private async handleBackup(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload: Record<string, unknown> = await this.context.readRequestJson(request).catch(() => ({}));
    if (payload.dryRun === true) {
      this.context.sendJson(response, 200, { ok: true, dryRun: true, dir: this.backupsRoot });
      return;
    }
    await mkdir(this.backupsRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
    const file = path.join(this.backupsRoot, `gamekit_${stamp}.sql`);
    const dump = spawn(commandName("docker"), ["compose", "exec", "-T", "db", "pg_dump", "-U", "gamekit", "gamekit"], {
      cwd: this.context.repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const out = createWriteStream(file);
    let stderr = "";
    // Any spawn error (docker missing) or write-stream error (disk full mid-dump)
    // must be surfaced as a failure so a truncated file never passes as a backup.
    let ioError: string | undefined;
    dump.on("error", (error) => { ioError = ioError ?? `pg_dump spawn failed: ${error instanceof Error ? error.message : String(error)}`; });
    out.on("error", (error) => { ioError = ioError ?? `backup write failed: ${error instanceof Error ? error.message : String(error)}`; });
    dump.stdout.on("error", () => {});
    dump.stdout.pipe(out);
    dump.stderr.on("data", (chunk) => { stderr += String(chunk); });
    // Wait for BOTH the process to close and the write stream to flush/close, so
    // an error surfacing only on the stream side is not missed.
    const code = await new Promise<number | null>((resolve) => dump.once("close", resolve));
    await new Promise<void>((resolve) => { out.end(() => resolve()); });
    const info = existsSync(file) ? await stat(file) : undefined;
    if (ioError || code !== 0 || !info || info.size === 0) {
      // Delete the partial/empty dump so a truncated file can never be mistaken
      // for a good backup.
      if (existsSync(file)) await unlink(file).catch(() => {});
      this.context.sendJson(response, 500, { ok: false, error: ioError || stderr || `pg_dump exited ${code}` });
      return;
    }
    const pruned = await this.pruneBackups();
    this.context.sendJson(response, 200, { ok: true, file, sizeBytes: info.size, pruned });
  }

  private async handleRestore(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.context.readRequestJson(request);
    const fileName = typeof payload.file === "string" ? payload.file : "";
    const restorePath = path.resolve(this.backupsRoot, fileName);
    // Boundary-safe containment: a bare startsWith would accept a sibling like
    // `<repoRoot>/backups-evil/x.sql` (shared "backups" prefix, no separator). Compare
    // via path.relative so `..`-escapes and sibling dirs are rejected.
    const rel = path.relative(this.backupsRoot, restorePath);
    const insideBackups = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    if (!insideBackups || !restorePath.endsWith(".sql") || !existsSync(restorePath)) {
      this.context.sendJson(response, 400, { ok: false, error: "restore file must be an existing .sql backup" });
      return;
    }
    if (payload.confirm !== true && payload.dryRun !== true) {
      this.context.sendJson(response, 400, { ok: false, error: "restore requires confirm:true" });
      return;
    }
    if (payload.dryRun === true) {
      this.context.sendJson(response, 200, { ok: true, dryRun: true, file: restorePath });
      return;
    }
    await this.ensureDependency("database");
    const restore = spawn(commandName("docker"), ["compose", "exec", "-T", "db", "psql", "-U", "gamekit", "-d", "gamekit"], {
      cwd: this.context.repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    // Surface spawn/stream failures instead of hanging or silently passing.
    let ioError: string | undefined;
    restore.on("error", (error) => { ioError = ioError ?? `psql spawn failed: ${error instanceof Error ? error.message : String(error)}`; });
    restore.stdin.on("error", (error) => { ioError = ioError ?? `restore stdin failed: ${error instanceof Error ? error.message : String(error)}`; });
    const source = createReadStream(restorePath);
    source.on("error", (error) => { ioError = ioError ?? `backup read failed: ${error instanceof Error ? error.message : String(error)}`; });
    source.pipe(restore.stdin);
    restore.stdout.on("data", (chunk) => { stdout += String(chunk); });
    restore.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve) => restore.once("close", resolve));
    const ok = code === 0 && !ioError;
    this.context.sendJson(response, ok ? 200 : 500, { ok, file: restorePath, output: ioError ? `${ioError}\n${stdout}${stderr}` : `${stdout}${stderr}` });
  }

  private async handleDiagnostics(response: ServerResponse): Promise<void> {
    this.context.sendJson(response, 200, { ok: true, diagnostics: await this.diagnostics() });
  }

  private async handleTray(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.context.readRequestJson(request);
    const enabled = payload.enabled === true;
    this.state.prefs.trayEnabled = enabled;
    await this.saveState();
    let pid: number | undefined;
    if (enabled && process.platform === "win32") {
      const scriptPath = path.join(this.localRoot, "hub-tray.ps1");
      const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = [System.Windows.Forms.NotifyIcon]::new()
$notify.Text = 'GameKit Hub'
$notify.Icon = [System.Drawing.SystemIcons]::Application
$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$open = $menu.Items.Add('Open GameKit Hub')
$open.add_Click({ Start-Process 'http://127.0.0.1:${this.context.port}/' })
$exit = $menu.Items.Add('Exit Tray')
$exit.add_Click({ $notify.Visible = $false; $notify.Dispose(); [System.Windows.Forms.Application]::Exit() })
$notify.ContextMenuStrip = $menu
$notify.Visible = $true
$notify.ShowBalloonTip(3000, 'GameKit Hub', 'Stack Ops tray is running.', [System.Windows.Forms.ToolTipIcon]::Info)
[System.Windows.Forms.Application]::Run()
`;
      await writeFile(scriptPath, script.trimStart(), "utf8");
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
        cwd: this.context.repoRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      // Best-effort tray: log-once on spawn failure so a missing powershell.exe
      // raises no unhandled 'error' event (which would crash the hub).
      child.on("error", (error) => {
        console.error(`[devkit-hub] tray spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      child.unref();
      pid = child.pid;
    }
    this.context.sendJson(response, 200, {
      ok: true,
      trayEnabled: enabled,
      mode: process.platform === "win32" ? "windows-notifyicon" : "browser-notification",
      pid,
    });
  }

  private async handleToast(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload: Record<string, unknown> = await this.context.readRequestJson(request).catch(() => ({}));
    const message = typeof payload.message === "string" ? payload.message : "GameKit hub notification";
    await this.appendHubLog(`toast: ${message}`);
    if (process.platform === "win32") {
      const escaped = message.replace(/'/g, "''");
      const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n=[System.Windows.Forms.NotifyIcon]::new(); $n.Icon=[System.Drawing.SystemIcons]::Application; $n.Visible=$true; $n.ShowBalloonTip(3000,'GameKit Hub','${escaped}',[System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Milliseconds 3400; $n.Dispose()`;
      const toast = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
        cwd: this.context.repoRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      // Best-effort toast: log-once on spawn failure, never crash the hub.
      toast.on("error", (error) => {
        console.error(`[devkit-hub] toast spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      toast.unref();
    }
    this.context.sendJson(response, 200, { ok: true });
  }
}
