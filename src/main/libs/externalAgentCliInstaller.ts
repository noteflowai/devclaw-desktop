import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import os from 'os';

import type { CliAppType, ExternalAgentEnvironmentSnapshot } from './externalAgentEnvironment';
import {
  getExternalAgentEnvironmentSnapshot,
  getPlaceholderExternalAgentEnvironmentSnapshot,
} from './externalAgentEnvironment';

export type ExternalAgentCliInstallPhase =
  | 'starting'
  | 'installing'
  | 'verifying'
  | 'success'
  | 'error'
  | 'unsupported';

export interface ExternalAgentCliInstallProgress {
  appType: CliAppType;
  phase: ExternalAgentCliInstallPhase;
  message: string;
  detail?: string;
}

export interface ExternalAgentCliInstallResult {
  success: boolean;
  appType: CliAppType;
  installMethod?: string;
  command?: string;
  binaryPath?: string | null;
  version?: string | null;
  snapshot?: ExternalAgentEnvironmentSnapshot;
  error?: string;
  unsupported?: boolean;
}

interface InstallMethod {
  id: string;
  packageName?: string;
  scriptUrl?: string;
  scriptArgs?: string[];
}

interface InstallTarget {
  appType: CliAppType;
  displayName: string;
  command: string;
  methods: InstallMethod[];
}

const MAX_OUTPUT_CHARS = 20_000;
const MAX_PROGRESS_LINE_CHARS = 300;

const INSTALL_TARGETS: Record<CliAppType, InstallTarget> = {
  claude: {
    appType: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    methods: [
      {
        id: 'npm',
        packageName: '@anthropic-ai/claude-code',
      },
    ],
  },
  codex: {
    appType: 'codex',
    displayName: 'Codex',
    command: 'codex',
    methods: [
      {
        id: 'npm',
        packageName: '@openai/codex',
      },
    ],
  },
  hermes: {
    appType: 'hermes',
    displayName: 'Hermes Agent',
    command: 'hermes',
    methods: [
      {
        id: 'official-installer',
        scriptUrl: 'https://hermes-agent.nousresearch.com/install.sh',
      },
    ],
  },
  openclaw: {
    appType: 'openclaw',
    displayName: 'OpenClaw',
    command: 'openclaw',
    methods: [
      {
        id: 'npm',
        packageName: 'openclaw',
      },
    ],
  },
  opencode: {
    appType: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    methods: [
      {
        id: 'npm',
        packageName: 'opencode-ai',
      },
    ],
  },
  grok: {
    appType: 'grok',
    displayName: 'Grok Build',
    command: 'grok',
    methods: [
      {
        id: 'official-installer',
        scriptUrl: 'https://x.ai/cli/install.sh',
      },
    ],
  },
  qwen: {
    appType: 'qwen',
    displayName: 'Qwen Code',
    command: 'qwen',
    methods: [
      {
        id: 'npm',
        packageName: '@qwen-code/qwen-code',
      },
    ],
  },
  deepseek_tui: {
    appType: 'deepseek_tui',
    displayName: 'DeepSeek-TUI',
    command: 'deepseek-tui',
    methods: [
      {
        id: 'npm',
        packageName: 'deepseek-tui',
      },
    ],
  },
  opensquilla: {
    appType: 'opensquilla',
    displayName: 'OpenSquilla',
    command: 'opensquilla',
    methods: [
      {
        id: 'uv-wheel',
        packageName: 'opensquilla[recommended] @ https://github.com/opensquilla/opensquilla/releases/download/v0.3.1/opensquilla-0.3.1-py3-none-any.whl',
      },
    ],
  },
  kimi: {
    appType: 'kimi',
    displayName: 'Kimi Code',
    command: 'kimi',
    methods: [
      {
        id: 'official-installer',
        scriptUrl: 'https://code.kimi.com/kimi-code/install.sh',
      },
      {
        id: 'npm',
        packageName: '@moonshot-ai/kimi-code',
      },
    ],
  },
};

const readInstallSnapshot = async (): Promise<ExternalAgentEnvironmentSnapshot> => {
  try {
    return (await getExternalAgentEnvironmentSnapshot()).snapshot;
  } catch {
    return getPlaceholderExternalAgentEnvironmentSnapshot();
  }
};

const quoteForShell = (value: string): string => {
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

const truncateOutput = (value: string): string => {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return value.slice(value.length - MAX_OUTPUT_CHARS);
};

const truncateProgressLine = (value: string): string => {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= MAX_PROGRESS_LINE_CHARS) return singleLine;
  return `${singleLine.slice(0, MAX_PROGRESS_LINE_CHARS)}...`;
};

const buildInstallScript = (target: InstallTarget): string => {
  const method = target.methods[0];
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    if (method.id === 'npm') {
      return [
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$npmPath = (Get-Command npm -ErrorAction SilentlyContinue).Source',
        'if (-not $npmPath) {',
        '  Write-Host "npm not found, please install Node.js first"',
        '  exit 1',
        '}',
        `Write-Host "__WESIGHT_INSTALL_METHOD__=${method.id}"`,
        `npm install -g ${method.packageName ?? ''}`,
        `$cmdPath = (Get-Command ${target.command} -ErrorAction SilentlyContinue).Source`,
        'if (-not $cmdPath) {',
        `  Write-Host "${target.command} command was not found after installation."`,
        '  exit 127',
        '}',
        'Write-Host "__WESIGHT_BINARY_PATH__=$cmdPath"',
        '$version = & $cmdPath --version 2>&1 | Select-Object -First 1',
        'Write-Host "__WESIGHT_VERSION__=$version"',
      ].join('\r\n');
    }

    if (target.appType === 'hermes' && method.id === 'official-installer') {
      return [
        '$installDir = "$env:USERPROFILE\\.hermes"',
        'if (-not (Test-Path $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }',
        '$zipUrl = "https://github.com/NousResearch/hermes-agent/releases/latest/download/hermes-agent-windows-x64.zip"',
        '$zipPath = "$installDir\\hermes.zip"',
        'Write-Host "Downloading Hermes Agent..."',
        'Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing',
        'Write-Host "Extracting..."',
        'Expand-Archive -Path $zipPath -DestinationPath $installDir -Force',
        'Remove-Item $zipPath -Force -ErrorAction SilentlyContinue',
        '$hermesExe = "$installDir\\hermes.exe"',
        'if (-not (Test-Path $hermesExe)) {',
        '  Write-Host "Hermes installation failed"',
        '  exit 1',
        '}',
        `Write-Host "__WESIGHT_INSTALL_METHOD__=${method.id}"`,
        'Write-Host "__WESIGHT_BINARY_PATH__=$hermesExe"',
        '$version = & $hermesExe --version 2>&1 | Select-Object -First 1',
        'Write-Host "__WESIGHT_VERSION__=$version"',
      ].join('\r\n');
    }

    throw new Error(`Automatic installation is not available for ${target.displayName} on Windows.`);
  }

  if (method.id === 'official-installer') {
    const scriptUrl = method.scriptUrl;
    if (!scriptUrl) {
      throw new Error(`Installer script URL is missing for ${target.displayName}.`);
    }
    const scriptArgs = (method.scriptArgs ?? []).map(quoteForShell).join(' ');
    const installCommand = scriptArgs
      ? `curl -fsSL ${quoteForShell(scriptUrl)} | bash -s -- ${scriptArgs}`
      : `curl -fsSL ${quoteForShell(scriptUrl)} | bash`;
    const fallbackMethod = target.methods.find((item) => item.id === 'npm' && item.packageName);
    const fallbackLines = fallbackMethod
      ? [
        `if ! command -v ${target.command} >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/${target.command}" ]; then`,
        '  if command -v npm >/dev/null 2>&1; then',
        `    echo "__WESIGHT_INSTALL_METHOD__=${fallbackMethod.id}"`,
        `    npm install -g ${quoteForShell(fallbackMethod.packageName ?? '')}`,
        '  fi',
        'fi',
      ]
      : [];
    return [
      'set -e',
      'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
      `echo "__WESIGHT_INSTALL_METHOD__=${method.id}"`,
      installCommand,
      ...fallbackLines,
      `if command -v ${target.command} >/dev/null 2>&1; then`,
      `  BINARY_PATH="$(command -v ${target.command})"`,
      `elif [ -x "$HOME/.local/bin/${target.command}" ]; then`,
      `  BINARY_PATH="$HOME/.local/bin/${target.command}"`,
      'else',
      `  echo "${target.command} command was not found after installation." >&2`,
      '  exit 127',
      'fi',
      'echo "__WESIGHT_BINARY_PATH__=${BINARY_PATH}"',
      'VERSION_OUTPUT=$({ "$BINARY_PATH" --version 2>&1 || true; } | head -n 1)',
      'echo "__WESIGHT_VERSION__=${VERSION_OUTPUT}"',
    ].join('\n');
  }

  if (method.id === 'uv-wheel') {
    if (process.platform === 'win32') {
      throw new Error(`Automatic installation is not available for ${target.displayName} on Windows.`);
    }
    const packageSpec = method.packageName;
    if (!packageSpec) {
      throw new Error(`Package spec is missing for ${target.displayName}.`);
    }
    return [
      'set -e',
      'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
      'if ! command -v uv >/dev/null 2>&1; then',
      '  echo "__WESIGHT_INSTALL_METHOD__=uv-bootstrap"',
      '  curl -LsSf https://astral.sh/uv/install.sh | sh',
      '  . "$HOME/.local/bin/env" 2>/dev/null || true',
      '  export PATH="$HOME/.local/bin:$PATH"',
      'fi',
      'if ! command -v uv >/dev/null 2>&1; then',
      '  echo "uv was not found after installation." >&2',
      '  exit 127',
      'fi',
      `echo "__WESIGHT_INSTALL_METHOD__=${method.id}"`,
      `uv tool install --python 3.12 ${quoteForShell(packageSpec)}`,
      'BINARY_PATH=""',
      `if [ -x "$HOME/.local/bin/${target.command}" ]; then`,
      `  BINARY_PATH="$HOME/.local/bin/${target.command}"`,
      `elif command -v ${target.command} >/dev/null 2>&1; then`,
      `  BINARY_PATH="$(command -v ${target.command})"`,
      'else',
      `  echo "${target.command} command was not found after installation." >&2`,
      '  exit 127',
      'fi',
      'echo "__WESIGHT_BINARY_PATH__=${BINARY_PATH}"',
      'VERSION_OUTPUT=$({ "$BINARY_PATH" --version 2>&1 || "$BINARY_PATH" --help 2>&1 || true; } | head -n 1)',
      'echo "__WESIGHT_VERSION__=${VERSION_OUTPUT}"',
    ].join('\n');
  }

  return [
    'set -e',
    'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
    'if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi',
    'if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi',
    'if ! command -v npm >/dev/null 2>&1; then',
    `  echo "Preparing npm for ${target.displayName}."`,
    '  if ! command -v brew >/dev/null 2>&1; then',
    '    echo "__WESIGHT_INSTALL_METHOD__=homebrew-bootstrap"',
    '    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    '    if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi',
    '    if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi',
    '  fi',
    '  if ! command -v npm >/dev/null 2>&1; then',
    '    echo "__WESIGHT_INSTALL_METHOD__=homebrew-node"',
    '    brew install node',
    '  fi',
    'fi',
    'if ! command -v npm >/dev/null 2>&1; then',
    '  echo "npm was not found after preparing Node.js." >&2',
    '  exit 127',
    'fi',
    `echo "__WESIGHT_INSTALL_METHOD__=${method.id}"`,
    `npm install -g ${quoteForShell(method.packageName ?? '')}`,
    'GLOBAL_PREFIX="$(npm prefix -g 2>/dev/null || true)"',
    'BINARY_PATH=""',
    `if [ -n "$GLOBAL_PREFIX" ] && [ -x "$GLOBAL_PREFIX/bin/${target.command}" ]; then`,
    `  BINARY_PATH="$GLOBAL_PREFIX/bin/${target.command}"`,
    `elif command -v ${target.command} >/dev/null 2>&1; then`,
    `  BINARY_PATH="$(command -v ${target.command})"`,
    'else',
    `  echo "${target.command} command was not found after installation." >&2`,
    '  exit 127',
    'fi',
    'echo "__WESIGHT_BINARY_PATH__=${BINARY_PATH}"',
    'VERSION_OUTPUT=$({ "$BINARY_PATH" --version 2>&1 || true; } | head -n 1)',
    'echo "__WESIGHT_VERSION__=${VERSION_OUTPUT}"',
  ].join('\n');
};

export class ExternalAgentCliInstaller extends EventEmitter {
  private readonly activeInstalls = new Map<CliAppType, Promise<ExternalAgentCliInstallResult>>();

  install(appType: CliAppType): Promise<ExternalAgentCliInstallResult> {
    const activeInstall = this.activeInstalls.get(appType);
    if (activeInstall) {
      return activeInstall;
    }

    const task = this.runInstall(appType).finally(() => {
      this.activeInstalls.delete(appType);
    });
    this.activeInstalls.set(appType, task);
    return task;
  }

  onProgress(listener: (progress: ExternalAgentCliInstallProgress) => void): () => void {
    this.on('progress', listener);
    return () => this.off('progress', listener);
  }

  private emitProgress(progress: ExternalAgentCliInstallProgress): void {
    this.emit('progress', progress);
  }

  private async runInstall(appType: CliAppType): Promise<ExternalAgentCliInstallResult> {
    const target = INSTALL_TARGETS[appType];
    const isWindows = process.platform === 'win32';
    const isMacOS = process.platform === 'darwin';
    if (!isWindows && !isMacOS) {
      const message = 'Automatic CLI installation currently supports macOS and Windows only.';
      this.emitProgress({
        appType,
        phase: 'unsupported',
        message,
      });
      return {
        success: false,
        appType,
        unsupported: true,
        error: message,
        snapshot: await readInstallSnapshot(),
      };
    }

    const shell = isWindows ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
    const shellArgs = isWindows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'] : ['-lc'];
    let script: string;
    try {
      script = buildInstallScript(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitProgress({
        appType,
        phase: 'unsupported',
        message,
      });
      return {
        success: false,
        appType,
        unsupported: true,
        error: message,
        snapshot: await readInstallSnapshot(),
      };
    }
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let installMethod: string | undefined;
    let binaryPath: string | null = null;
    let version: string | null = null;

    this.emitProgress({
      appType,
      phase: 'starting',
      message: `Starting ${target.displayName} CLI installation.`,
    });

    return new Promise<ExternalAgentCliInstallResult>((resolve) => {
      const child = spawn(shell, [...shellArgs, script], {
        cwd: os.homedir(),
        env: {
          ...process.env,
          HOMEBREW_NO_ENV_HINTS: '1',
          PATH: isWindows
            ? (process.env.PATH ?? '')
            : `${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const handleOutput = (chunk: Buffer, source: 'stdout' | 'stderr') => {
        const text = chunk.toString('utf8');
        if (source === 'stdout') {
          stdout = truncateOutput(stdout + text);
        } else {
          stderr = truncateOutput(stderr + text);
        }

        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith('__WESIGHT_INSTALL_METHOD__=')) {
            installMethod = line.slice('__WESIGHT_INSTALL_METHOD__='.length).trim() || undefined;
            this.emitProgress({
              appType,
              phase: 'installing',
              message: `Installing with ${installMethod}.`,
            });
            continue;
          }
          if (line.startsWith('__WESIGHT_BINARY_PATH__=')) {
            binaryPath = line.slice('__WESIGHT_BINARY_PATH__='.length).trim() || null;
            this.emitProgress({
              appType,
              phase: 'verifying',
              message: `Verifying ${target.command}.`,
              detail: binaryPath ?? undefined,
            });
            continue;
          }
          if (line.startsWith('__WESIGHT_VERSION__=')) {
            version = line.slice('__WESIGHT_VERSION__='.length).trim() || null;
            continue;
          }
          this.emitProgress({
            appType,
            phase: 'installing',
            message: truncateProgressLine(line),
          });
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => handleOutput(chunk, 'stdout'));
      child.stderr?.on('data', (chunk: Buffer) => handleOutput(chunk, 'stderr'));

      child.on('error', async (error) => {
        const message = `Failed to start ${target.displayName} installer: ${error.message}`;
        this.emitProgress({
          appType,
          phase: 'error',
          message,
        });
        resolve({
          success: false,
          appType,
          installMethod,
          command: target.command,
          binaryPath,
          version,
          error: message,
          snapshot: await readInstallSnapshot(),
        });
      });

      child.on('close', async (code, signal) => {
        if (code === 0) {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
          this.emitProgress({
            appType,
            phase: 'success',
            message: `${target.displayName} CLI installed in ${elapsedSeconds}s.`,
            detail: version ?? binaryPath ?? undefined,
          });
          resolve({
            success: true,
            appType,
            installMethod,
            command: target.command,
            binaryPath,
            version,
            snapshot: await readInstallSnapshot(),
          });
          return;
        }

        const output = truncateProgressLine(stderr || stdout || `Installer exited with code ${code ?? 'unknown'}.`);
        const message = signal
          ? `${target.displayName} installer stopped by ${signal}.`
          : output;
        this.emitProgress({
          appType,
          phase: 'error',
          message,
        });
        resolve({
          success: false,
          appType,
          installMethod,
          command: target.command,
          binaryPath,
          version,
          error: message,
          snapshot: await readInstallSnapshot(),
        });
      });
    });
  }
}
