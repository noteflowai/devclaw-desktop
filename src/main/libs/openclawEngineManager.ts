import { type ChildProcess, spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import { app } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { getSkillsRoot } from './coworkUtil';
import {
  atomicWriteJson,
  buildOpenClawCommandPath,
  OPENCLAW_DEFAULT_GATEWAY_PORT,
  type OpenClawGatewayProbeSummary,
  probeOpenClawGateway,
  readOpenClawGlobalConfig,
  resolveOpenClawSystemRuntime,
  summarizeOpenClawConfig,
} from './openclawSystemRuntime';
import { appendPythonRuntimeToEnv } from './pythonRuntime';
import { isSystemProxyEnabled, resolveSystemProxyUrl } from './systemProxy';

const GATEWAY_BOOT_TIMEOUT_MS = 120 * 1000;
const GATEWAY_MAX_RESTART_ATTEMPTS = 3;
const GATEWAY_RESTART_DELAYS = [3_000, 8_000, 15_000];
const RUNNING_GATEWAY_RECHECK_MS = 60_000;

export type OpenClawEnginePhase =
  | 'not_installed'
  | 'installing'
  | 'ready'
  | 'starting'
  | 'running'
  | 'error';

export type OpenClawGatewayMode = 'attached' | 'managed';

export interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  canRetry: boolean;
  gatewayMode?: OpenClawGatewayMode | null;
  binaryPath?: string | null;
  configPath?: string | null;
  gatewayUrl?: string | null;
  gatewayPort?: number | null;
  currentModel?: string | null;
  feishuConfigured?: boolean;
  feishuRunning?: boolean;
}

export interface OpenClawGatewayConnectionInfo {
  version: string | null;
  port: number | null;
  token: string | null;
  url: string | null;
  clientEntryPath: string | null;
}

interface OpenClawEngineManagerEvents {
  status: (status: OpenClawEngineStatus) => void;
}

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const isPortReachable = (host: string, port: number, timeoutMs = 1200): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore close failure
      }
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
};

const waitForPortFree = async (host: string, port: number, timeoutMs = 10_000): Promise<boolean> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!await isPortReachable(host, port, 500)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return !await isPortReachable(host, port, 500);
};

const isGatewayProcessAlive = (child: ChildProcess | null): child is ChildProcess => {
  return Boolean(child && child.pid && child.exitCode === null);
};

const resolveProbeUrl = (probe: OpenClawGatewayProbeSummary, fallbackPort: number): string => {
  return probe.url || `ws://127.0.0.1:${probe.port ?? fallbackPort}`;
};

export class OpenClawEngineManager extends EventEmitter {
  private readonly baseDir: string;
  private readonly logsDir: string;
  private readonly stateDir: string;
  private readonly gatewayTokenPath: string;
  private readonly gatewayLogPath: string;
  private readonly configPath: string;

  private status: OpenClawEngineStatus;
  private gatewayProcess: ChildProcess | null = null;
  private gatewayMode: OpenClawGatewayMode | null = null;
  private gatewayRestartTimer: NodeJS.Timeout | null = null;
  private gatewayRestartAttempt = 0;
  private shutdownRequested = false;
  private gatewayPort: number | null = null;
  private startGatewayPromise: Promise<OpenClawEngineStatus> | null = null;
  private secretEnvVars: Record<string, string> = {};
  private requireManagedGateway = false;
  private lastProbe: OpenClawGatewayProbeSummary | null = null;
  private lastRunningGatewayCheckAt = 0;

  constructor() {
    super();

    const userDataPath = app.getPath('userData');
    this.baseDir = path.join(userDataPath, 'openclaw');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.stateDir = path.join(this.baseDir, 'state');
    this.gatewayTokenPath = path.join(this.stateDir, 'gateway-token');
    this.gatewayLogPath = path.join(this.logsDir, 'gateway.log');
    this.configPath = resolveOpenClawSystemRuntime().configPath;

    ensureDir(this.baseDir);
    ensureDir(this.logsDir);
    ensureDir(this.stateDir);

    const runtime = resolveOpenClawSystemRuntime();
    this.status = runtime.commandPath
      ? this.buildReadyStatus('OpenClaw CLI is ready.')
      : {
          phase: 'not_installed',
          version: null,
          message: `OpenClaw CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
          canRetry: true,
          binaryPath: null,
          configPath: runtime.configPath,
          gatewayPort: runtime.gatewayPort,
        };
  }

  setSecretEnvVars(vars: Record<string, string>): void {
    this.secretEnvVars = vars;
  }

  syncLaunchAgentSecretEnvVars(vars: Record<string, string>): void {
    const envPath = path.join(path.dirname(this.configPath), 'service-env', 'ai.openclaw.gateway.env');
    if (!fs.existsSync(envPath)) return;

    const beginMarker = '# WeSight managed secrets begin';
    const endMarker = '# WeSight managed secrets end';
    try {
      const current = fs.readFileSync(envPath, 'utf8');
      const withoutManagedBlock = current
        .replace(new RegExp(`\\n?${beginMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g'), '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
      const entries = Object.entries(vars)
        .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value)
        .sort(([a], [b]) => a.localeCompare(b));
      const managedBlock = entries.length > 0
        ? [
            beginMarker,
            ...entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`),
            endMarker,
          ].join('\n')
        : '';
      const next = `${withoutManagedBlock}${managedBlock ? `\n\n${managedBlock}` : ''}\n`;
      fs.writeFileSync(envPath, next, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      console.warn('[OpenClaw] failed to sync WeSight secrets into LaunchAgent env file:', error);
    }
  }

  getSecretEnvVars(): Record<string, string> {
    return this.secretEnvVars;
  }

  setRequireManagedGateway(value: boolean): void {
    this.requireManagedGateway = value;
  }

  override on<U extends keyof OpenClawEngineManagerEvents>(
    event: U,
    listener: OpenClawEngineManagerEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override emit<U extends keyof OpenClawEngineManagerEvents>(
    event: U,
    ...args: Parameters<OpenClawEngineManagerEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getStatus(): OpenClawEngineStatus {
    return { ...this.status };
  }

  setExternalError(message: string): OpenClawEngineStatus {
    const runtime = resolveOpenClawSystemRuntime();
    this.setStatus({
      ...this.buildStatusBase(),
      phase: 'error',
      version: runtime.version || this.status.version || null,
      message: message.slice(0, 500),
      canRetry: true,
    });
    return this.getStatus();
  }

  getDesiredVersion(): string {
    return resolveOpenClawSystemRuntime().version || 'unknown';
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getStateDir(): string {
    return this.stateDir;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getGatewayConnectionInfo(): OpenClawGatewayConnectionInfo {
    const runtime = resolveOpenClawSystemRuntime();
    const port = this.gatewayPort ?? runtime.gatewayPort ?? OPENCLAW_DEFAULT_GATEWAY_PORT;
    const token = runtime.gatewayToken ?? this.readGatewayToken();
    return {
      version: runtime.version,
      port,
      token,
      url: port ? `ws://127.0.0.1:${port}` : null,
      clientEntryPath: runtime.clientEntryPath,
    };
  }

  getGatewayToken(): string | null {
    return resolveOpenClawSystemRuntime().gatewayToken ?? this.readGatewayToken();
  }

  getLocalChannelStatus(): OpenClawGatewayProbeSummary {
    const runtime = resolveOpenClawSystemRuntime();
    if (!runtime.commandPath) {
      return {
        ok: false,
        url: null,
        port: null,
        version: null,
        configPath: runtime.configPath,
        feishuConfigured: summarizeOpenClawConfig(readOpenClawGlobalConfig()).feishuConfigured,
        feishuRunning: false,
        error: 'OpenClaw CLI is not installed.',
      };
    }
    const probe = probeOpenClawGateway(runtime.commandPath);
    this.lastProbe = probe;
    return probe;
  }

  async ensureReady(options: { forceReinstall?: boolean } = {}): Promise<OpenClawEngineStatus> {
    const runtime = resolveOpenClawSystemRuntime();
    if (!runtime.commandPath || options.forceReinstall) {
      this.setStatus({
        phase: runtime.commandPath ? 'ready' : 'not_installed',
        version: runtime.version,
        message: runtime.commandPath
          ? 'OpenClaw CLI is already installed. Use the installer to update it.'
          : `OpenClaw CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
        canRetry: true,
        binaryPath: runtime.commandPath,
        configPath: runtime.configPath,
        gatewayPort: runtime.gatewayPort,
        currentModel: runtime.currentModel,
      });
      return this.getStatus();
    }

    if (this.status.phase === 'running') {
      return this.getStatus();
    }

    this.setStatus(this.buildReadyStatus('OpenClaw CLI is ready.'));
    return this.getStatus();
  }

  async startGateway(): Promise<OpenClawEngineStatus> {
    if (this.isRunningGatewayRecentlyChecked()) {
      return this.getStatus();
    }
    if (this.startGatewayPromise) {
      return this.startGatewayPromise;
    }
    this.startGatewayPromise = this.doStartGateway().finally(() => {
      this.startGatewayPromise = null;
    });
    return this.startGatewayPromise;
  }

  private async doStartGateway(): Promise<OpenClawEngineStatus> {
    this.shutdownRequested = false;
    const ensured = await this.ensureReady();
    if (ensured.phase !== 'ready' && ensured.phase !== 'running') {
      return ensured;
    }

    const runtime = resolveOpenClawSystemRuntime();
    if (!runtime.commandPath) {
      this.setStatus({
        ...this.buildStatusBase(),
        phase: 'not_installed',
        version: null,
        message: `OpenClaw CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    const port = runtime.gatewayPort || OPENCLAW_DEFAULT_GATEWAY_PORT;
    this.gatewayPort = port;

    const runningProbe = probeOpenClawGateway(runtime.commandPath);
    this.lastProbe = runningProbe;
    if (
      !this.requireManagedGateway
      && runningProbe.ok
      && (runningProbe.port === null || runningProbe.port === port || await isPortReachable('127.0.0.1', runningProbe.port))
    ) {
      this.gatewayMode = 'attached';
      this.gatewayRestartAttempt = 0;
      this.setStatus({
        ...this.buildStatusBase(),
        phase: 'running',
        version: runningProbe.version || runtime.version,
        progressPercent: 100,
        message: `Attached to local OpenClaw gateway at ${resolveProbeUrl(runningProbe, port)}.`,
        canRetry: false,
        gatewayMode: 'attached',
        gatewayUrl: resolveProbeUrl(runningProbe, port),
        gatewayPort: runningProbe.port ?? port,
        feishuConfigured: runningProbe.feishuConfigured,
        feishuRunning: runningProbe.feishuRunning,
      });
      this.markRunningGatewayChecked();
      return this.getStatus();
    }

    if (this.requireManagedGateway && !isGatewayProcessAlive(this.gatewayProcess) && await isPortReachable('127.0.0.1', port)) {
      this.setStatus({
        ...this.buildStatusBase(),
        phase: 'starting',
        version: runtime.version,
        progressPercent: 5,
        message: 'Stopping local OpenClaw gateway service before starting WeSight-managed gateway...',
        canRetry: false,
        gatewayMode: 'managed',
        gatewayPort: port,
      });
      this.stopExternalGatewayService(runtime.commandPath, runtime.configPath);
      await waitForPortFree('127.0.0.1', port, 12_000);
    }

    const portReachable = await isPortReachable('127.0.0.1', port);
    if (portReachable && !this.requireManagedGateway) {
      this.setStatus({
        ...this.buildStatusBase(),
        phase: 'error',
        version: runtime.version,
        message: `Loopback port ${port} is already in use, but OpenClaw probe did not recognize it as an OpenClaw gateway.`,
        canRetry: true,
        gatewayPort: port,
      });
      return this.getStatus();
    }

    if (isGatewayProcessAlive(this.gatewayProcess)) {
      this.markRunningGatewayChecked();
      return this.getStatus();
    }

    const token = this.ensureGatewayTokenForManagedStart();
    this.setStatus({
      ...this.buildStatusBase(),
      phase: 'starting',
      version: runtime.version,
      progressPercent: 10,
      message: 'Starting system OpenClaw gateway...',
      canRetry: false,
      gatewayMode: 'managed',
      gatewayPort: port,
    });

    const env = await this.buildGatewayEnv(runtime, port, token);
    const args = [
      'gateway',
      ...(this.requireManagedGateway && portReachable ? ['--force'] : []),
      '--port',
      String(port),
      '--token',
      token,
      '--bind',
      'loopback',
    ];
    const child = spawn(runtime.commandPath, args, {
      cwd: path.dirname(runtime.configPath),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.gatewayProcess = child;
    this.gatewayMode = 'managed';
    this.attachGatewayProcessLogs(child);
    this.attachGatewayExitHandlers(child);

    const ready = await this.waitForGatewayReady(runtime.commandPath, port, GATEWAY_BOOT_TIMEOUT_MS);
    if (!ready) {
      this.setStatus({
        ...this.buildStatusBase(),
        phase: 'error',
        version: runtime.version,
        message: 'System OpenClaw gateway did not become reachable in time.',
        canRetry: true,
        gatewayMode: 'managed',
        gatewayPort: port,
      });
      await this.stopGatewayProcess(child);
      return this.getStatus();
    }

    const probe = this.lastProbe ?? probeOpenClawGateway(runtime.commandPath);
    this.gatewayRestartAttempt = 0;
    this.setStatus({
      ...this.buildStatusBase(),
      phase: 'running',
      version: probe.version || runtime.version,
      progressPercent: 100,
      message: `System OpenClaw gateway is running on loopback:${port}.`,
      canRetry: false,
      gatewayMode: 'managed',
      gatewayUrl: resolveProbeUrl(probe, port),
      gatewayPort: port,
      feishuConfigured: probe.feishuConfigured,
      feishuRunning: probe.feishuRunning,
    });
    this.markRunningGatewayChecked();

    return this.getStatus();
  }

  async stopGateway(): Promise<void> {
    this.shutdownRequested = true;
    this.lastRunningGatewayCheckAt = 0;
    if (this.gatewayRestartTimer) {
      clearTimeout(this.gatewayRestartTimer);
      this.gatewayRestartTimer = null;
    }

    if (this.gatewayMode === 'managed' && this.gatewayProcess) {
      await this.stopGatewayProcess(this.gatewayProcess);
    }
    this.gatewayProcess = null;
    this.gatewayMode = null;
    this.setStatus(this.buildReadyStatus('OpenClaw CLI is ready. Gateway is disconnected.'));
  }

  async restartGateway(): Promise<OpenClawEngineStatus> {
    this.lastRunningGatewayCheckAt = 0;
    if (this.gatewayMode === 'managed' && this.gatewayProcess) {
      await this.stopGateway();
      this.gatewayRestartAttempt = 0;
    }
    return this.startGateway();
  }

  private buildStatusBase(): Partial<OpenClawEngineStatus> {
    const runtime = resolveOpenClawSystemRuntime();
    const configSummary = summarizeOpenClawConfig(readOpenClawGlobalConfig());
    return {
      version: runtime.version,
      binaryPath: runtime.commandPath,
      configPath: runtime.configPath,
      gatewayPort: runtime.gatewayPort,
      gatewayMode: this.gatewayMode,
      currentModel: runtime.currentModel,
      feishuConfigured: this.lastProbe?.feishuConfigured ?? configSummary.feishuConfigured,
      feishuRunning: this.lastProbe?.feishuRunning ?? false,
    };
  }

  private buildReadyStatus(message: string): OpenClawEngineStatus {
    const runtime = resolveOpenClawSystemRuntime();
    const configSummary = summarizeOpenClawConfig(readOpenClawGlobalConfig());
    return {
      phase: runtime.commandPath ? 'ready' : 'not_installed',
      version: runtime.version,
      message: runtime.commandPath ? message : `OpenClaw CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
      canRetry: !runtime.commandPath,
      binaryPath: runtime.commandPath,
      configPath: runtime.configPath,
      gatewayPort: runtime.gatewayPort,
      gatewayMode: null,
      currentModel: runtime.currentModel,
      feishuConfigured: configSummary.feishuConfigured,
      feishuRunning: false,
    };
  }

  private ensureGatewayTokenForManagedStart(): string {
    const runtime = resolveOpenClawSystemRuntime();
    if (runtime.gatewayToken) return runtime.gatewayToken;

    const token = this.readGatewayToken() || crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(this.gatewayTokenPath, token, 'utf8');

    const currentConfig = readOpenClawGlobalConfig(runtime.configPath) ?? {};
    const gateway = currentConfig.gateway && typeof currentConfig.gateway === 'object' && !Array.isArray(currentConfig.gateway)
      ? currentConfig.gateway as Record<string, unknown>
      : {};
    const auth = gateway.auth && typeof gateway.auth === 'object' && !Array.isArray(gateway.auth)
      ? gateway.auth as Record<string, unknown>
      : {};
    atomicWriteJson(runtime.configPath, {
      ...currentConfig,
      gateway: {
        ...gateway,
        mode: gateway.mode || 'local',
        port: gateway.port || runtime.gatewayPort || OPENCLAW_DEFAULT_GATEWAY_PORT,
        bind: gateway.bind || 'loopback',
        auth: {
          ...auth,
          mode: auth.mode || 'token',
          token,
        },
      },
    });
    return token;
  }

  private stopExternalGatewayService(commandPath: string, configPath: string): void {
    const result = spawnSync(commandPath, ['gateway', 'stop'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: buildOpenClawCommandPath(),
        OPENCLAW_CONFIG_PATH: configPath,
      },
    });
    if (result.status !== 0) {
      const output = `${result.stderr || ''}${result.stdout || ''}`.trim();
      console.warn('[OpenClaw] failed to stop local gateway service before managed start:', output || result.error);
    }
  }

  private readGatewayToken(): string | null {
    try {
      const token = fs.readFileSync(this.gatewayTokenPath, 'utf8').trim();
      return token || null;
    } catch {
      return null;
    }
  }

  private async buildGatewayEnv(
    runtime: ReturnType<typeof resolveOpenClawSystemRuntime>,
    port: number,
    token: string,
  ): Promise<NodeJS.ProcessEnv> {
    const skillsRoot = getSkillsRoot().replace(/\\/g, '/');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: buildOpenClawCommandPath(),
      SKILLS_ROOT: skillsRoot,
      WESIGHT_SKILLS_ROOT: skillsRoot,
      OPENCLAW_CONFIG_PATH: runtime.configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_LOG_LEVEL: process.env.WESIGHT_OPENCLAW_LOG_LEVEL || process.env.OPENCLAW_LOG_LEVEL || 'warn',
      ...this.secretEnvVars,
    };
    appendPythonRuntimeToEnv(env as Record<string, string | undefined>);
    const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (hostTimezone && !env.TZ) {
      env.TZ = hostTimezone;
    }
    if (isSystemProxyEnabled()) {
      const proxyUrl = await resolveSystemProxyUrl('https://openrouter.ai');
      if (proxyUrl) {
        env.http_proxy = proxyUrl;
        env.https_proxy = proxyUrl;
        env.HTTP_PROXY = proxyUrl;
        env.HTTPS_PROXY = proxyUrl;
      }
    }
    return env;
  }

  private waitForGatewayReady(commandPath: string, port: number, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    let pollCount = 0;
    return new Promise((resolve) => {
      const tick = async (): Promise<void> => {
        if (this.shutdownRequested || !this.gatewayProcess) {
          resolve(false);
          return;
        }

        pollCount += 1;
        const elapsedMs = Date.now() - startedAt;
        const reachable = await isPortReachable('127.0.0.1', port, 1200);
        const probe = reachable ? probeOpenClawGateway(commandPath) : null;
        if (probe) this.lastProbe = probe;
        if (reachable && (!probe || probe.ok || elapsedMs > 2500)) {
          resolve(true);
          return;
        }

        if (elapsedMs >= timeoutMs) {
          resolve(false);
          return;
        }

        this.setStatus({
          ...this.buildStatusBase(),
          phase: 'starting',
          version: this.status.version,
          progressPercent: Math.min(90, 10 + Math.round((elapsedMs / timeoutMs) * 80)),
          message: `Starting system OpenClaw gateway... (${Math.round(elapsedMs / 1000)}s)`,
          canRetry: false,
          gatewayMode: 'managed',
          gatewayPort: port,
        });

        if (pollCount % 10 === 0) {
          console.debug(`[OpenClaw] waiting for system gateway on loopback:${port}`);
        }

        setTimeout(() => {
          void tick();
        }, 700);
      };
      void tick();
    });
  }

  private stopGatewayProcess(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', done);
      try {
        child.kill();
      } catch {
        // ignore kill failure
      }
      setTimeout(done, 5_000);
    });
  }

  private attachGatewayProcessLogs(child: ChildProcess): void {
    ensureDir(path.dirname(this.gatewayLogPath));
    const appendLog = (chunk: Buffer | string, stream: 'stdout' | 'stderr'): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      fs.appendFile(this.gatewayLogPath, `[${new Date().toISOString()}] [${stream}] ${text}`, () => {});
    };
    child.stdout?.on('data', (chunk) => appendLog(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => appendLog(chunk, 'stderr'));
  }

  private attachGatewayExitHandlers(child: ChildProcess): void {
    child.once('error', (error) => {
      if (this.shutdownRequested) return;
      this.setStatus({
        ...this.buildStatusBase(),
        phase: 'error',
        version: this.status.version,
        message: `OpenClaw gateway process error: ${error.message}`,
        canRetry: true,
      });
    });

    child.once('exit', (code) => {
      if (this.gatewayProcess === child) {
        this.gatewayProcess = null;
      }
      if (this.shutdownRequested) return;
      this.setStatus({
        ...this.buildStatusBase(),
        phase: 'error',
        version: this.status.version,
        message: `OpenClaw gateway exited unexpectedly with code ${code ?? 'unknown'}.`,
        canRetry: true,
      });
      this.scheduleGatewayRestart();
    });
  }

  private scheduleGatewayRestart(): void {
    if (this.shutdownRequested || this.gatewayRestartTimer) return;
    if (this.gatewayRestartAttempt >= GATEWAY_MAX_RESTART_ATTEMPTS) {
      this.setStatus({
        ...this.buildStatusBase(),
        phase: 'error',
        version: this.status.version,
        message: 'OpenClaw gateway auto-restart limit reached. Reconnect manually from settings.',
        canRetry: true,
      });
      return;
    }
    const delay = GATEWAY_RESTART_DELAYS[Math.min(this.gatewayRestartAttempt, GATEWAY_RESTART_DELAYS.length - 1)];
    this.gatewayRestartAttempt += 1;
    this.gatewayRestartTimer = setTimeout(() => {
      this.gatewayRestartTimer = null;
      if (this.shutdownRequested) return;
      void this.startGateway();
    }, delay);
  }

  private isRunningGatewayRecentlyChecked(): boolean {
    if (this.status.phase !== 'running') {
      return false;
    }
    if (this.gatewayMode !== 'managed' || !isGatewayProcessAlive(this.gatewayProcess)) {
      return false;
    }
    return Date.now() - this.lastRunningGatewayCheckAt < RUNNING_GATEWAY_RECHECK_MS;
  }

  private markRunningGatewayChecked(): void {
    this.lastRunningGatewayCheckAt = Date.now();
  }

  private setStatus(next: OpenClawEngineStatus): void {
    this.status = {
      ...next,
      message: next.message ? next.message.slice(0, 500) : undefined,
    };
    this.emit('status', this.getStatus());
  }
}
