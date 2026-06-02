import { type ChildProcessWithoutNullStreams,spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import { app } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { isSystemProxyEnabled, resolveSystemProxyUrl } from './systemProxy';

const DEFAULT_GATEWAY_PORT = 18879;
const GATEWAY_PORT_SCAN_LIMIT = 80;
const GATEWAY_BOOT_TIMEOUT_MS = 180_000;
const GATEWAY_MAX_RESTART_ATTEMPTS = 5;
const GATEWAY_RESTART_DELAYS = [3_000, 5_000, 10_000, 20_000, 30_000];

export type HermesEnginePhase =
  | 'not_installed'
  | 'installing'
  | 'ready'
  | 'starting'
  | 'running'
  | 'error';

export interface HermesEngineStatus {
  phase: HermesEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  canRetry: boolean;
}

export interface HermesGatewayConnectionInfo {
  version: string | null;
  port: number | null;
  token: string | null;
  url: string | null;
}

interface HermesEngineManagerEvents {
  status: (status: HermesEngineStatus) => void;
}

type HermesInstallProgressPhase =
  | 'starting'
  | 'installing'
  | 'verifying'
  | 'success'
  | 'error'
  | 'unsupported';

type RuntimeMetadata = {
  commandPath: string | null;
  version: string | null;
  expectedPathHint: string;
};

const isWindowsCommandShim = (commandPath: string): boolean => {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath);
};

const buildWindowsCommandShimArgs = (commandPath: string, args: string[]): string[] => {
  return ['/d', '/s', '/c', `call "${commandPath}" ${args.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(' ')}`];
};

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const findPath = (candidates: string[]): string | null => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
};

const buildHermesSearchPath = (): string => {
  const paths = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    paths.push(
      path.join(appData, 'npm'),
      path.join(os.homedir(), '.hermes', 'bin'),
      path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts'),
    );
  }

  paths.push(process.env.PATH ?? '');
  return paths.join(path.delimiter);
};

const progressPercentForInstallPhase = (phase: HermesInstallProgressPhase): number | undefined => {
  switch (phase) {
    case 'starting':
      return 8;
    case 'installing':
      return 40;
    case 'verifying':
      return 85;
    case 'success':
      return 100;
    default:
      return undefined;
  }
};

const parseJsonFile = <T>(filePath: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
};

const isPortAvailable = async (port: number): Promise<boolean> => {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
};

const fetchWithTimeout = async (url: string, token: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timeout);
  }
};

const isProcessAlive = (child: ChildProcessWithoutNullStreams | null): child is ChildProcessWithoutNullStreams => {
  return Boolean(child && child.pid && child.exitCode === null);
};

export class HermesEngineManager extends EventEmitter {
  private readonly baseDir: string;
  private readonly logsDir: string;
  private readonly stateDir: string;
  private readonly configPath: string;
  private readonly envPath: string;
  private readonly gatewayTokenPath: string;
  private readonly gatewayPortPath: string;
  private readonly gatewayLogPath: string;

  private desiredVersion: string | null;
  private status: HermesEngineStatus;
  private gatewayProcess: ChildProcessWithoutNullStreams | null = null;
  private gatewayPort: number | null = null;
  private gatewayRestartAttempt = 0;
  private gatewayRestartTimer: NodeJS.Timeout | null = null;
  private shutdownRequested = false;
  private startGatewayPromise: Promise<HermesEngineStatus> | null = null;
  private secretEnvVars: Record<string, string> = {};

  constructor() {
    super();

    const userDataPath = app.getPath('userData');
    this.baseDir = path.join(userDataPath, 'hermes');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.stateDir = path.join(this.baseDir, 'state');
    this.configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
    this.envPath = path.join(os.homedir(), '.hermes', '.env');
    this.gatewayTokenPath = path.join(this.stateDir, 'gateway-token');
    this.gatewayPortPath = path.join(this.stateDir, 'gateway-port.json');
    this.gatewayLogPath = path.join(this.logsDir, 'gateway.log');

    ensureDir(this.baseDir);
    ensureDir(this.logsDir);
    ensureDir(this.stateDir);

    const runtime = this.resolveRuntimeMetadata();
    this.desiredVersion = runtime.version;
    this.status = runtime.commandPath
      ? {
          phase: 'ready',
          version: this.desiredVersion,
          message: `Hermes Agent CLI is ready at ${runtime.commandPath}.`,
          canRetry: false,
        }
      : {
          phase: 'not_installed',
          version: null,
          message: `Hermes Agent CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
          canRetry: true,
        };
  }

  override on<U extends keyof HermesEngineManagerEvents>(
    event: U,
    listener: HermesEngineManagerEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override emit<U extends keyof HermesEngineManagerEvents>(
    event: U,
    ...args: Parameters<HermesEngineManagerEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getStatus(): HermesEngineStatus {
    return { ...this.status };
  }

  getStateDir(): string {
    return this.stateDir;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getEnvPath(): string {
    return this.envPath;
  }

  setSecretEnvVars(vars: Record<string, string>): void {
    this.secretEnvVars = vars;
  }

  getSecretEnvVars(): Record<string, string> {
    return this.secretEnvVars;
  }

  reportInstallProgress(progress: {
    phase: HermesInstallProgressPhase;
    message: string;
    detail?: string;
  }): void {
    const message = progress.detail
      ? `${progress.message} ${progress.detail}`
      : progress.message;
    if (progress.phase === 'error' || progress.phase === 'unsupported') {
      this.setStatus({
        phase: 'error',
        version: this.status.version,
        message,
        canRetry: true,
      });
      return;
    }

    if (progress.phase === 'success') {
      const runtime = this.resolveRuntimeMetadata();
      this.desiredVersion = runtime.version || this.desiredVersion;
      this.setStatus({
        phase: runtime.commandPath ? 'ready' : 'not_installed',
        version: runtime.version || this.status.version,
        progressPercent: 100,
        message,
        canRetry: !runtime.commandPath,
      });
      return;
    }

    this.setStatus({
      phase: 'installing',
      version: this.status.version,
      progressPercent: progressPercentForInstallPhase(progress.phase),
      message,
      canRetry: false,
    });
  }

  getConnectionInfo(): HermesGatewayConnectionInfo {
    const port = this.gatewayPort ?? this.readGatewayPort();
    const token = this.readGatewayToken();
    return {
      version: this.status.version,
      port,
      token,
      url: port ? `http://127.0.0.1:${port}` : null,
    };
  }

  async ensureReady(): Promise<HermesEngineStatus> {
    const runtime = this.resolveRuntimeMetadata();
    if (!runtime.commandPath) {
      this.setStatus({
        phase: 'not_installed',
        version: null,
        message: `Hermes Agent CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    this.desiredVersion = runtime.version;
    if (this.status.phase !== 'running' && this.status.phase !== 'starting') {
      this.setStatus({
        phase: 'ready',
        version: this.desiredVersion,
        message: `Hermes Agent CLI is ready at ${runtime.commandPath}.`,
        canRetry: false,
      });
    }
    return this.getStatus();
  }

  async startGateway(): Promise<HermesEngineStatus> {
    if (this.startGatewayPromise) {
      return this.startGatewayPromise;
    }
    this.startGatewayPromise = this.doStartGateway().finally(() => {
      this.startGatewayPromise = null;
    });
    return this.startGatewayPromise;
  }

  async restartGateway(): Promise<HermesEngineStatus> {
    await this.stopGateway();
    this.gatewayRestartAttempt = 0;
    return this.startGateway();
  }

  async stopGateway(): Promise<void> {
    this.shutdownRequested = true;
    if (this.gatewayRestartTimer) {
      clearTimeout(this.gatewayRestartTimer);
      this.gatewayRestartTimer = null;
    }
    if (this.gatewayProcess) {
      await this.stopGatewayProcess(this.gatewayProcess);
      this.gatewayProcess = null;
    }
    const runtime = this.resolveRuntimeMetadata();
    this.setStatus({
      phase: runtime.commandPath ? 'ready' : 'not_installed',
      version: runtime.version,
      message: runtime.commandPath
        ? 'Hermes Agent gateway is stopped.'
        : `Hermes Agent CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
      canRetry: !runtime.commandPath,
    });
  }

  private async doStartGateway(): Promise<HermesEngineStatus> {
    this.shutdownRequested = false;
    const ensured = await this.ensureReady();
    if (ensured.phase !== 'ready' && ensured.phase !== 'running') {
      return ensured;
    }

    const existingPort = this.readGatewayPort();
    const existingToken = this.readGatewayToken();
    if (existingPort && existingToken && await this.isGatewayHealthy(existingPort, existingToken)) {
      this.gatewayPort = existingPort;
      this.gatewayRestartAttempt = 0;
      this.setStatus({
        phase: 'running',
        version: this.desiredVersion,
        progressPercent: 100,
        message: `Hermes Agent gateway is running on loopback:${existingPort}.`,
        canRetry: false,
      });
      return this.getStatus();
    }

    if (isProcessAlive(this.gatewayProcess)) {
      const port = this.gatewayPort ?? this.readGatewayPort();
      const token = this.readGatewayToken();
      if (port && token && await this.isGatewayHealthy(port, token)) {
        this.setStatus({
          phase: 'running',
          version: this.desiredVersion,
          message: `Hermes Agent gateway is running on loopback:${port}.`,
          canRetry: false,
        });
        return this.getStatus();
      }
      await this.stopGatewayProcess(this.gatewayProcess);
      this.gatewayProcess = null;
    }

    const runtime = this.resolveRuntimeMetadata();
    if (!runtime.commandPath) {
      this.setStatus({
        phase: 'not_installed',
        version: null,
        message: `Hermes Agent CLI was not found. Expected one of: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    const token = this.ensureGatewayToken();
    const port = await this.resolveGatewayPort();
    this.gatewayPort = port;
    this.writeGatewayPort(port);
    this.ensureGatewayStateFiles();

    this.setStatus({
      phase: 'starting',
      version: runtime.version,
      progressPercent: 10,
      message: 'Starting Hermes Agent gateway...',
      canRetry: false,
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_CONFIG_PATH: this.configPath,
      HERMES_DOTENV_PATH: this.envPath,
      API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: '127.0.0.1',
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: token,
      HERMES_GATEWAY_TOKEN: token,
      HERMES_GATEWAY_PORT: String(port),
      HERMES_LOG_LEVEL: 'INFO',
      PYTHONUNBUFFERED: '1',
      PATH: buildHermesSearchPath(),
      ...this.secretEnvVars,
    };
    if (isSystemProxyEnabled()) {
      const proxyUrl = await resolveSystemProxyUrl('https://api.openai.com');
      if (proxyUrl) {
        env.http_proxy = proxyUrl;
        env.https_proxy = proxyUrl;
        env.HTTP_PROXY = proxyUrl;
        env.HTTPS_PROXY = proxyUrl;
      }
    }

    const gatewayArgs = ['gateway', 'run', '--replace'];
    const spawnCommand = isWindowsCommandShim(runtime.commandPath) ? 'cmd.exe' : runtime.commandPath;
    const spawnArgs = isWindowsCommandShim(runtime.commandPath)
      ? buildWindowsCommandShimArgs(runtime.commandPath, gatewayArgs)
      : gatewayArgs;
    const child = spawn(
      spawnCommand,
      spawnArgs,
      {
        cwd: os.homedir(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: isWindowsCommandShim(runtime.commandPath),
        windowsHide: process.platform === 'win32',
      },
    );
    this.gatewayProcess = child;
    this.attachGatewayLogs(child);
    this.attachGatewayExitHandlers(child);

    this.setStatus({
      phase: 'starting',
      version: runtime.version,
      progressPercent: 35,
      message: 'Waiting for Hermes Agent API server...',
      canRetry: false,
    });

    const healthy = await this.waitForGatewayHealthy(port, token);
    if (!healthy) {
      this.setStatus({
        phase: 'error',
        version: runtime.version,
        message: `Hermes Agent gateway did not become ready on loopback:${port}.`,
        canRetry: true,
      });
      return this.getStatus();
    }

    this.gatewayRestartAttempt = 0;
    this.setStatus({
      phase: 'running',
      version: runtime.version,
      progressPercent: 100,
      message: `Hermes Agent gateway is running on loopback:${port}.`,
      canRetry: false,
    });
    return this.getStatus();
  }

  private resolveRuntimeMetadata(): RuntimeMetadata {
    const home = os.homedir();
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    const userName = path.basename(home);
    const candidates = [
      this.resolveCommandFromShell('hermes'),
      path.join(home, '.local', 'bin', 'hermes'),
      '/opt/homebrew/bin/hermes',
      '/usr/local/bin/hermes',
      ...(process.platform === 'win32' ? [
        this.resolveWindowsCommand('hermes'),
        path.join(appData, 'npm', 'hermes.cmd'),
        path.join(appData, 'npm', 'hermes.exe'),
        path.join(appData, 'npm', 'hermes.bat'),
        path.join(home, '.local', 'bin', 'hermes.exe'),
        path.join(home, '.hermes', 'bin', 'hermes.exe'),
        path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
        'D:\\Program Files\\Hermes Studio\\resources\\python\\Scripts\\hermes.cmd',
        'C:\\Program Files\\Hermes Studio\\resources\\python\\Scripts\\hermes.cmd',
        `\\\\wsl$\\Ubuntu\\home\\${userName}\\.local\\bin\\hermes`,
        `\\\\wsl$\\Ubuntu\\home\\${userName}\\.hermes\\bin\\hermes`,
      ] : []),
    ].filter((value): value is string => Boolean(value));
    const commandPath = findPath(candidates);
    const expectedPathHint = [
      'PATH:hermes',
      path.join(home, '.local', 'bin', 'hermes'),
      '/opt/homebrew/bin/hermes',
      '/usr/local/bin/hermes',
      ...(process.platform === 'win32' ? [
        path.join(appData, 'npm', 'hermes.cmd'),
        path.join(home, '.hermes', 'bin', 'hermes.exe'),
        path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
      ] : []),
    ].join(', ');

    if (!commandPath) {
      return { commandPath: null, version: null, expectedPathHint };
    }
    return {
      commandPath,
      version: this.readCommandVersion(commandPath),
      expectedPathHint,
    };
  }

  private resolveCommandFromShell(command: string): string | null {
    if (process.platform === 'win32') {
      return this.resolveWindowsCommand(command);
    }

    const shell = process.env.SHELL || '/bin/zsh';
    const result = spawnSync(shell, ['-lc', `command -v ${command}`], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: buildHermesSearchPath(),
      },
    });
    if (result.status !== 0) return null;
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  }

  private resolveWindowsCommand(command: string): string | null {
    const result = spawnSync('where.exe', [command], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: buildHermesSearchPath(),
      },
    });
    if (result.status !== 0) return null;

    const candidates = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return candidates.find((candidate) => /\.(cmd|exe|bat)$/i.test(candidate))
      ?? candidates[0]
      ?? null;
  }

  private readCommandVersion(commandPath: string): string | null {
    const versionArgs = ['--version'];
    const spawnCommand = isWindowsCommandShim(commandPath) ? 'cmd.exe' : commandPath;
    const spawnArgs = isWindowsCommandShim(commandPath)
      ? buildWindowsCommandShimArgs(commandPath, versionArgs)
      : versionArgs;
    const result = spawnSync(spawnCommand, spawnArgs, {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: buildHermesSearchPath(),
      },
      windowsVerbatimArguments: isWindowsCommandShim(commandPath),
    });
    if (result.status !== 0) return null;
    return (result.stdout || result.stderr || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  }

  private ensureGatewayToken(): string {
    const existing = this.readGatewayToken();
    if (existing) return existing;
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(this.gatewayTokenPath, token, { encoding: 'utf8', mode: 0o600 });
    return token;
  }

  private readGatewayToken(): string | null {
    try {
      const raw = fs.readFileSync(this.gatewayTokenPath, 'utf8').trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  private async resolveGatewayPort(): Promise<number> {
    const saved = this.readGatewayPort();
    if (saved && await isPortAvailable(saved)) {
      return saved;
    }
    for (let offset = 0; offset < GATEWAY_PORT_SCAN_LIMIT; offset += 1) {
      const port = DEFAULT_GATEWAY_PORT + offset;
      if (await isPortAvailable(port)) {
        return port;
      }
    }
    throw new Error('No available loopback port found for Hermes Agent gateway.');
  }

  private readGatewayPort(): number | null {
    const parsed = parseJsonFile<{ port?: number }>(this.gatewayPortPath);
    return typeof parsed?.port === 'number' && Number.isFinite(parsed.port)
      ? parsed.port
      : null;
  }

  private writeGatewayPort(port: number): void {
    fs.writeFileSync(this.gatewayPortPath, `${JSON.stringify({ port }, null, 2)}\n`, 'utf8');
  }

  private ensureGatewayStateFiles(): void {
    ensureDir(path.dirname(this.configPath));
    if (!fs.existsSync(this.envPath)) {
      fs.writeFileSync(this.envPath, '', { encoding: 'utf8', mode: 0o600 });
    }
  }

  private async waitForGatewayHealthy(port: number, token: string): Promise<boolean> {
    const deadline = Date.now() + GATEWAY_BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!isProcessAlive(this.gatewayProcess)) {
        return false;
      }
      if (await this.isGatewayHealthy(port, token)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  private async isGatewayHealthy(port: number, token: string): Promise<boolean> {
    const urls = [
      `http://127.0.0.1:${port}/health`,
      `http://127.0.0.1:${port}/v1/models`,
    ];
    for (const url of urls) {
      try {
        const response = await fetchWithTimeout(url, token, 1500);
        if (response.ok || response.status === 401 || response.status === 403) {
          return true;
        }
      } catch {
        // Try the next known health endpoint.
      }
    }
    return false;
  }

  private attachGatewayLogs(child: ChildProcessWithoutNullStreams): void {
    const append = (source: string, text: string) => {
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) return;
      const payload = lines.map((line) => `[${new Date().toISOString()}] [${source}] ${line}`).join('\n') + '\n';
      fs.appendFile(this.gatewayLogPath, payload, () => {});
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk.toString('utf8')));
  }

  private attachGatewayExitHandlers(child: ChildProcessWithoutNullStreams): void {
    child.on('error', (error) => {
      this.setStatus({
        phase: 'error',
        version: this.desiredVersion,
        message: `Hermes Agent gateway failed to start: ${error.message}`,
        canRetry: true,
      });
    });

    child.on('exit', (code, signal) => {
      if (this.gatewayProcess === child) {
        this.gatewayProcess = null;
      }
      if (this.shutdownRequested) {
        return;
      }
      const message = `Hermes Agent gateway exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`;
      if (this.gatewayRestartAttempt >= GATEWAY_MAX_RESTART_ATTEMPTS) {
        this.setStatus({
          phase: 'error',
          version: this.desiredVersion,
          message,
          canRetry: true,
        });
        return;
      }
      const delay = GATEWAY_RESTART_DELAYS[Math.min(this.gatewayRestartAttempt, GATEWAY_RESTART_DELAYS.length - 1)];
      this.gatewayRestartAttempt += 1;
      this.setStatus({
        phase: 'starting',
        version: this.desiredVersion,
        message: `${message} Restarting in ${Math.round(delay / 1000)}s...`,
        canRetry: false,
      });
      this.gatewayRestartTimer = setTimeout(() => {
        this.gatewayRestartTimer = null;
        void this.startGateway();
      }, delay);
    });
  }

  private async stopGatewayProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (!isProcessAlive(child)) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore shutdown races.
        }
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  private setStatus(status: HermesEngineStatus): void {
    this.status = status;
    this.emit('status', this.getStatus());
  }
}
