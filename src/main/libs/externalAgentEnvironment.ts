import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type CliCoworkAgentEngine,
  CoworkAgentEngine,
} from '../../shared/cowork/constants';
import { resolveUserShellPath } from './coworkUtil';
import {
  listDeepSeekTuiModelProviders,
  parseDeepSeekTuiConfigText,
} from './deepSeekTuiConfig';
import {
  parseGrokBuildConfigText,
  summarizeGrokBuildConfig,
} from './grokBuildConfig';
import {
  listHermesModelProviders,
  parseHermesConfigText,
  parseHermesDotenvText,
} from './hermesConfig';
import { readOpenClawGlobalConfig, summarizeOpenClawConfig } from './openclawSystemRuntime';

export type CliAppType = 'claude' | 'codex' | 'hermes' | 'openclaw' | 'opencode' | 'grok' | 'qwen' | 'deepseek_tui';

export interface CliAppConfigSnapshot {
  appType: CliAppType;
  configDir: string;
  primaryConfigPath: string;
  secondaryConfigPaths: string[];
  configExists: boolean;
  currentProviderId: string | null;
  currentProviderName: string | null;
  providerCount: number;
}

export interface CliCommandStatus {
  engine: CliCoworkAgentEngine;
  appType: CliAppType;
  command: string;
  found: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
  config: CliAppConfigSnapshot;
}

export interface CcSwitchSnapshot {
  installed: boolean;
  appDir: string;
  dbPath: string;
  settingsPath: string;
  settingsExists: boolean;
  databaseExists: boolean;
  claudeConfigDirOverride: string | null;
  codexConfigDirOverride: string | null;
}

export interface ExternalAgentEnvironmentSnapshot {
  ccSwitch: CcSwitchSnapshot;
  engines: CliCommandStatus[];
}

type CcSwitchSettings = {
  claude_config_dir?: unknown;
  codex_config_dir?: unknown;
  current_provider_claude?: unknown;
  current_provider_codex?: unknown;
  claudeConfigDir?: unknown;
  codexConfigDir?: unknown;
  currentProviderClaude?: unknown;
  currentProviderCodex?: unknown;
};

type ProviderRow = {
  id: string;
  name: string;
};

const homeDir = (): string => os.homedir();

const ccSwitchAppDir = (): string => path.join(homeDir(), '.cc-switch');

const readJsonObject = (filePath: string): Record<string, unknown> | null => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const readCcSwitchSettings = (settingsPath: string): CcSwitchSettings => {
  return readJsonObject(settingsPath) ?? {};
};

const normalizedPathSetting = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed.replace(/^~(?=$|\/|\\)/, homeDir())) : null;
};

const getConfigDirSetting = (settings: CcSwitchSettings, appType: CliAppType): string | null => {
  if (appType === 'claude') {
    return normalizedPathSetting(settings.claudeConfigDir)
      ?? normalizedPathSetting(settings.claude_config_dir);
  }
  if (appType === 'codex') {
    return normalizedPathSetting(settings.codexConfigDir)
      ?? normalizedPathSetting(settings.codex_config_dir);
  }
  return null;
};

const getCurrentProviderSetting = (settings: CcSwitchSettings, appType: CliAppType): string | null => {
  if (appType !== 'claude' && appType !== 'codex') {
    return null;
  }
  const value = appType === 'claude'
    ? settings.currentProviderClaude ?? settings.current_provider_claude
    : settings.currentProviderCodex ?? settings.current_provider_codex;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const resolveClaudeMcpPath = (configDir: string, hasOverride: boolean): string => {
  if (!hasOverride) {
    return path.join(homeDir(), '.claude.json');
  }
  const parent = path.dirname(configDir);
  const basename = path.basename(configDir);
  return path.join(parent, `${basename}.json`);
};

const resolveClaudeSettingsPath = (configDir: string): string => {
  const settingsPath = path.join(configDir, 'settings.json');
  if (fs.existsSync(settingsPath)) return settingsPath;
  const legacyPath = path.join(configDir, 'claude.json');
  if (fs.existsSync(legacyPath)) return legacyPath;
  return settingsPath;
};

const getOpenCodeDataDir = (): string => path.join(homeDir(), '.local', 'share', 'opencode');

const getHermesConfigDir = (): string => path.join(homeDir(), '.hermes');

const getOpenClawConfigDir = (): string => path.join(homeDir(), '.openclaw');

const getGrokBuildConfigDir = (): string => path.join(homeDir(), '.grok');

const getQwenCodeConfigDir = (): string => path.join(homeDir(), '.qwen');

const getDeepSeekTuiConfigDir = (): string => path.join(homeDir(), '.deepseek');

const readOpenCodeConfigSummary = (
  configPath: string,
): { providerId: string | null; providerName: string | null; count: number } => {
  const config = readJsonObject(configPath);
  if (!config) {
    return { providerId: null, providerName: null, count: 0 };
  }
  const model = typeof config.model === 'string' ? config.model.trim() : '';
  const providerId = model.includes('/') ? model.split('/')[0] : model || null;
  const provider = config.provider && typeof config.provider === 'object' && !Array.isArray(config.provider)
    ? config.provider as Record<string, unknown>
    : {};
  const count = Object.keys(provider).length;
  const providerConfig = providerId ? provider[providerId] : null;
  const providerName = providerConfig && typeof providerConfig === 'object' && !Array.isArray(providerConfig)
    ? typeof (providerConfig as Record<string, unknown>).name === 'string'
      ? ((providerConfig as Record<string, unknown>).name as string)
      : providerId
    : providerId;
  return { providerId, providerName, count };
};

const readQwenCodeConfigSummary = (
  configPath: string,
): { providerId: string | null; providerName: string | null; count: number } => {
  const config = readJsonObject(configPath);
  if (!config) {
    return { providerId: null, providerName: null, count: 0 };
  }
  const model = config.model && typeof config.model === 'object' && !Array.isArray(config.model)
    ? typeof (config.model as Record<string, unknown>).name === 'string'
      ? ((config.model as Record<string, unknown>).name as string)
      : ''
    : '';
  const security = config.security && typeof config.security === 'object' && !Array.isArray(config.security)
    ? config.security as Record<string, unknown>
    : {};
  const auth = security.auth && typeof security.auth === 'object' && !Array.isArray(security.auth)
    ? security.auth as Record<string, unknown>
    : {};
  const providerId = typeof auth.selectedType === 'string' && auth.selectedType.trim()
    ? auth.selectedType.trim()
    : model || null;
  const providers = config.modelProviders && typeof config.modelProviders === 'object' && !Array.isArray(config.modelProviders)
    ? config.modelProviders as Record<string, unknown>
    : {};
  const count = Object.values(providers).reduce<number>((total, entries) => (
    total + (Array.isArray(entries) ? entries.length : 0)
  ), 0);
  return { providerId, providerName: model || providerId, count };
};

const readDeepSeekTuiConfigSummary = (
  configPath: string,
): { providerId: string | null; providerName: string | null; count: number } => {
  if (!fs.existsSync(configPath)) {
    return { providerId: null, providerName: null, count: 0 };
  }
  const config = parseDeepSeekTuiConfigText(fs.readFileSync(configPath, 'utf8'));
  const records = listDeepSeekTuiModelProviders(config);
  const current = records.find((record) => record.isCurrent) ?? records[0] ?? null;
  return {
    providerId: current?.provider ?? config.provider ?? null,
    providerName: current?.name ?? current?.provider ?? null,
    count: records.length,
  };
};

const readGrokBuildConfigSummary = (
  configPath: string,
): { providerId: string | null; providerName: string | null; count: number } => {
  if (!fs.existsSync(configPath)) {
    return { providerId: null, providerName: null, count: 0 };
  }
  const summary = summarizeGrokBuildConfig(parseGrokBuildConfigText(fs.readFileSync(configPath, 'utf8')));
  return {
    providerId: summary.providerId,
    providerName: summary.providerName,
    count: summary.count,
  };
};

const readHermesConfigSummary = (
  configPath: string,
  envPath: string,
): { providerId: string | null; providerName: string | null; count: number } => {
  if (!fs.existsSync(configPath)) {
    return { providerId: null, providerName: null, count: 0 };
  }
  const config = parseHermesConfigText(fs.readFileSync(configPath, 'utf8'));
  const env = fs.existsSync(envPath)
    ? parseHermesDotenvText(fs.readFileSync(envPath, 'utf8'))
    : {};
  const records = listHermesModelProviders(config, env);
  const current = records[0] ?? null;
  return {
    providerId: current ? `${current.provider}/${current.model}` : null,
    providerName: current?.name ?? current?.provider ?? null,
    count: records.length,
  };
};

const readOpenClawConfigSummary = (
  configPath: string,
): { providerId: string | null; providerName: string | null; count: number } => {
  const summary = summarizeOpenClawConfig(readOpenClawGlobalConfig(configPath));
  const model = summary.currentModel;
  return {
    providerId: model?.includes('/') ? model.split('/')[0] : model,
    providerName: model,
    count: model ? 1 : 0,
  };
};

const countProviders = (db: Database.Database, appType: CliAppType): number => {
  try {
    const row = db
      .prepare('SELECT COUNT(*) as total FROM providers WHERE app_type = ?')
      .get(appType) as { total?: number } | undefined;
    return Number(row?.total ?? 0);
  } catch {
    return 0;
  }
};

const readCurrentProviderFromDb = (
  dbPath: string,
  appType: CliAppType,
  settingsCurrentProviderId: string | null,
): { provider: ProviderRow | null; count: number } => {
  if (appType === 'openclaw' || appType === 'opencode' || appType === 'grok' || appType === 'qwen' || appType === 'deepseek_tui') {
    return { provider: null, count: 0 };
  }
  if (!fs.existsSync(dbPath)) {
    return { provider: null, count: 0 };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const count = countProviders(db, appType);
    const provider = settingsCurrentProviderId
      ? db
        .prepare('SELECT id, name FROM providers WHERE app_type = ? AND id = ? LIMIT 1')
        .get(appType, settingsCurrentProviderId) as ProviderRow | undefined
      : db
        .prepare('SELECT id, name FROM providers WHERE app_type = ? AND is_current = 1 LIMIT 1')
        .get(appType) as ProviderRow | undefined;
    return { provider: provider ?? null, count };
  } catch {
    return { provider: null, count: 0 };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors from a read-only snapshot.
    }
  }
};

const quoteForShell = (value: string): string => {
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

const getWindowsSearchPaths = (command: string): string[] => {
  const home = homeDir();
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userName = path.basename(home);

  if (command === 'hermes') {
    return [
      path.join(appData, 'npm', 'hermes.cmd'),
      path.join(appData, 'npm', 'hermes.exe'),
      path.join(home, '.local', 'bin', 'hermes.exe'),
      path.join(home, '.hermes', 'bin', 'hermes.exe'),
      path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
      `\\\\wsl$\\Ubuntu\\home\\${userName}\\.local\\bin\\hermes`,
      `\\\\wsl$\\Ubuntu\\home\\${userName}\\.hermes\\bin\\hermes`,
      'D:\\Program Files\\Hermes Studio\\resources\\python\\Scripts\\hermes.cmd',
      'C:\\Program Files\\Hermes Studio\\resources\\python\\Scripts\\hermes.cmd',
    ];
  }
  if (command === 'claude') {
    return [
      path.join(appData, 'npm', 'claude.cmd'),
      path.join(home, '.local', 'bin', 'claude.exe'),
    ];
  }
  if (command === 'codex') {
    return [
      path.join(appData, 'npm', 'codex.cmd'),
    ];
  }
  if (command === 'openclaw') {
    return [
      path.join(appData, 'npm', 'openclaw.cmd'),
      'C:\\Program Files (x86)\\ClawX\\resources\\cli\\openclaw',
      'C:\\Program Files\\ClawX\\resources\\cli\\openclaw',
      path.join(localAppData, 'Programs', 'ClawX', 'resources', 'cli', 'openclaw'),
      path.join(home, '.openclaw', 'bin', 'openclaw'),
    ];
  }
  if (command === 'opencode') {
    return [
      path.join(appData, 'npm', 'opencode.cmd'),
    ];
  }
  if (command === 'qwen') {
    return [
      path.join(appData, 'npm', 'qwen.cmd'),
    ];
  }
  if (command === 'deepseek-tui') {
    return [
      path.join(appData, 'npm', 'deepseek-tui.cmd'),
    ];
  }

  return [];
};

const preferWindowsExecutable = (candidates: string[]): string | null => {
  if (candidates.length === 0) return null;
  return candidates.find((candidate) => /\.(cmd|exe|bat)$/i.test(candidate))
    ?? candidates[0]
    ?? null;
};

const isWindowsCommandShim = (commandPath: string): boolean => {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandPath);
};

const buildWindowsCommandShimArgs = (commandPath: string, args: string[]): string[] => {
  return ['/d', '/s', '/c', `call "${commandPath}" ${args.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(' ')}`];
};

const resolveCommand = (command: string): { found: boolean; path: string | null; error: string | null } => {
  if (process.platform === 'win32') {
    for (const candidate of getWindowsSearchPaths(command)) {
      if (candidate && fs.existsSync(candidate)) {
        return { found: true, path: candidate, error: null };
      }
    }
  }

  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status === 0) {
    const candidates = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const commandPath = process.platform === 'win32'
      ? preferWindowsExecutable(candidates)
      : candidates[0] ?? null;
    return { found: Boolean(commandPath), path: commandPath, error: null };
  }

  if (process.platform !== 'win32') {
    const shellPath = process.env.SHELL || '/bin/zsh';
    const userPath = resolveUserShellPath() ?? process.env.PATH;
    const shellResult = spawnSync(shellPath, ['-lc', `command -v ${quoteForShell(command)}`], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: userPath,
      },
    });
    if (shellResult.status === 0) {
      const commandPath = shellResult.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
      return { found: Boolean(commandPath), path: commandPath, error: null };
    }
    const error = (shellResult.stderr || shellResult.stdout || result.stderr || result.stdout || '').trim();
    return { found: false, path: null, error: error || `${command} was not found in PATH.` };
  }

  if (result.status !== 0) {
    const error = (result.stderr || result.stdout || '').trim();
    return { found: false, path: null, error: error || `${command} was not found in PATH.` };
  }
  return { found: false, path: null, error: `${command} was not found in PATH.` };
};

const readCommandVersion = (command: string): string | null => {
  const versionArgs = ['--version'];
  const executable = isWindowsCommandShim(command) ? 'cmd.exe' : command;
  const args = isWindowsCommandShim(command)
    ? buildWindowsCommandShimArgs(command, versionArgs)
    : versionArgs;
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    windowsVerbatimArguments: isWindowsCommandShim(command),
  });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim() || null;
};

const buildCliConfigSnapshot = (
  appType: CliAppType,
  settings: CcSwitchSettings,
  dbPath: string,
): CliAppConfigSnapshot => {
  const claudeOverride = getConfigDirSetting(settings, 'claude');
  const codexOverride = getConfigDirSetting(settings, 'codex');
  const configDir = appType === 'claude'
    ? claudeOverride ?? path.join(homeDir(), '.claude')
    : appType === 'codex'
      ? codexOverride ?? path.join(homeDir(), '.codex')
      : appType === 'hermes'
        ? getHermesConfigDir()
      : appType === 'openclaw'
        ? getOpenClawConfigDir()
      : appType === 'opencode'
        ? path.join(homeDir(), '.config', 'opencode')
      : appType === 'grok'
        ? getGrokBuildConfigDir()
        : appType === 'qwen'
          ? getQwenCodeConfigDir()
          : getDeepSeekTuiConfigDir();
  const primaryConfigPath = appType === 'claude'
    ? resolveClaudeSettingsPath(configDir)
    : appType === 'codex'
      ? path.join(configDir, 'config.toml')
    : appType === 'hermes'
      ? path.join(configDir, 'config.yaml')
    : appType === 'openclaw'
      ? path.join(configDir, 'openclaw.json')
    : appType === 'opencode'
      ? path.join(configDir, 'opencode.json')
      : appType === 'grok'
        ? path.join(configDir, 'config.toml')
        : appType === 'qwen'
          ? path.join(configDir, 'settings.json')
          : path.join(configDir, 'config.toml');
  const secondaryConfigPaths = appType === 'claude'
    ? [resolveClaudeMcpPath(configDir, Boolean(claudeOverride))]
    : appType === 'codex'
      ? [path.join(configDir, 'auth.json')]
    : appType === 'hermes'
      ? [path.join(configDir, '.env')]
    : appType === 'openclaw'
      ? [path.join(configDir, '.env')]
    : appType === 'opencode'
      ? [path.join(getOpenCodeDataDir(), 'auth.json')]
      : appType === 'grok'
        ? [path.join(configDir, 'auth.json')]
        : appType === 'qwen'
          ? [path.join(configDir, 'oauth_creds.json')]
          : [path.join(configDir, 'sessions')];
  const settingsCurrentProviderId = getCurrentProviderSetting(settings, appType);
  if (appType === 'opencode') {
    const summary = readOpenCodeConfigSummary(primaryConfigPath);
    return {
      appType,
      configDir,
      primaryConfigPath,
      secondaryConfigPaths,
      configExists: fs.existsSync(primaryConfigPath),
      currentProviderId: summary.providerId ?? settingsCurrentProviderId,
      currentProviderName: summary.providerName,
      providerCount: summary.count,
    };
  }
  if (appType === 'hermes') {
    const summary = readHermesConfigSummary(primaryConfigPath, secondaryConfigPaths[0] || path.join(configDir, '.env'));
    return {
      appType,
      configDir,
      primaryConfigPath,
      secondaryConfigPaths,
      configExists: fs.existsSync(primaryConfigPath),
      currentProviderId: summary.providerId,
      currentProviderName: summary.providerName,
      providerCount: summary.count,
    };
  }
  if (appType === 'openclaw') {
    const summary = readOpenClawConfigSummary(primaryConfigPath);
    return {
      appType,
      configDir,
      primaryConfigPath,
      secondaryConfigPaths,
      configExists: fs.existsSync(primaryConfigPath),
      currentProviderId: summary.providerId,
      currentProviderName: summary.providerName,
      providerCount: summary.count,
    };
  }
  if (appType === 'qwen') {
    const summary = readQwenCodeConfigSummary(primaryConfigPath);
    return {
      appType,
      configDir,
      primaryConfigPath,
      secondaryConfigPaths,
      configExists: fs.existsSync(primaryConfigPath),
      currentProviderId: summary.providerId,
      currentProviderName: summary.providerName,
      providerCount: summary.count,
    };
  }
  if (appType === 'grok') {
    const summary = readGrokBuildConfigSummary(primaryConfigPath);
    return {
      appType,
      configDir,
      primaryConfigPath,
      secondaryConfigPaths,
      configExists: fs.existsSync(primaryConfigPath),
      currentProviderId: summary.providerId,
      currentProviderName: summary.providerName,
      providerCount: summary.count,
    };
  }
  if (appType === 'deepseek_tui') {
    const summary = readDeepSeekTuiConfigSummary(primaryConfigPath);
    return {
      appType,
      configDir,
      primaryConfigPath,
      secondaryConfigPaths,
      configExists: fs.existsSync(primaryConfigPath),
      currentProviderId: summary.providerId,
      currentProviderName: summary.providerName,
      providerCount: summary.count,
    };
  }
  const { provider, count } = readCurrentProviderFromDb(dbPath, appType, settingsCurrentProviderId);

  return {
    appType,
    configDir,
    primaryConfigPath,
    secondaryConfigPaths,
    configExists: fs.existsSync(primaryConfigPath),
    currentProviderId: provider?.id ?? settingsCurrentProviderId,
    currentProviderName: provider?.name ?? null,
    providerCount: count,
  };
};

const buildCommandStatus = (
  engine: CliCoworkAgentEngine,
  appType: CliAppType,
  command: string,
  settings: CcSwitchSettings,
  dbPath: string,
): CliCommandStatus => {
  const resolution = resolveCommand(command);
  return {
    engine,
    appType,
    command,
    found: resolution.found,
    path: resolution.path,
    version: resolution.found ? readCommandVersion(resolution.path ?? command) : null,
    error: resolution.error,
    config: buildCliConfigSnapshot(appType, settings, dbPath),
  };
};

export function getExternalAgentEnvironmentSnapshot(): ExternalAgentEnvironmentSnapshot {
  const appDir = ccSwitchAppDir();
  const settingsPath = path.join(appDir, 'settings.json');
  const dbPath = path.join(appDir, 'cc-switch.db');
  const settings = readCcSwitchSettings(settingsPath);
  const claudeOverride = getConfigDirSetting(settings, 'claude');
  const codexOverride = getConfigDirSetting(settings, 'codex');

  return {
    ccSwitch: {
      installed: fs.existsSync(appDir),
      appDir,
      dbPath,
      settingsPath,
      settingsExists: fs.existsSync(settingsPath),
      databaseExists: fs.existsSync(dbPath),
      claudeConfigDirOverride: claudeOverride,
      codexConfigDirOverride: codexOverride,
    },
    engines: [
      buildCommandStatus(CoworkAgentEngine.ClaudeCode, 'claude', 'claude', settings, dbPath),
      buildCommandStatus(CoworkAgentEngine.Codex, 'codex', 'codex', settings, dbPath),
      buildCommandStatus(CoworkAgentEngine.OpenClaw, 'openclaw', 'openclaw', settings, dbPath),
      buildCommandStatus(CoworkAgentEngine.Hermes, 'hermes', 'hermes', settings, dbPath),
      buildCommandStatus(CoworkAgentEngine.OpenCode, 'opencode', 'opencode', settings, dbPath),
      buildCommandStatus(CoworkAgentEngine.GrokBuild, 'grok', 'grok', settings, dbPath),
      buildCommandStatus(CoworkAgentEngine.QwenCode, 'qwen', 'qwen', settings, dbPath),
      buildCommandStatus(CoworkAgentEngine.DeepSeekTui, 'deepseek_tui', 'deepseek-tui', settings, dbPath),
    ],
  };
}
