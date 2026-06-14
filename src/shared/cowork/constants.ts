export const DefaultAgent = {
  Id: 'main',
} as const;

export type DefaultAgentId = typeof DefaultAgent.Id;

export const CoworkAgentEngine = {
  YdCowork: 'yd_cowork',
  OpenClaw: 'openclaw',
  ClawAgent: 'claw-agent',
  Hermes: 'hermes',
  ClaudeCode: 'claude_code',
  Codex: 'codex',
  CodexApp: 'codex_app',
  OpenCode: 'opencode',
  GrokBuild: 'grok_build',
  QwenCode: 'qwen_code',
  DeepSeekTui: 'deepseek_tui',
  OpenSquilla: 'opensquilla',
  KimiCode: 'kimi_code',
} as const;

export type CoworkAgentEngine = typeof CoworkAgentEngine[keyof typeof CoworkAgentEngine];

export const DefaultCoworkAgentEngine = CoworkAgentEngine.ClaudeCode;

export const CoworkAgentEngineValues = [
  CoworkAgentEngine.YdCowork,
  CoworkAgentEngine.OpenClaw,
  CoworkAgentEngine.ClawAgent,
  CoworkAgentEngine.Hermes,
  CoworkAgentEngine.ClaudeCode,
  CoworkAgentEngine.Codex,
  CoworkAgentEngine.CodexApp,
  CoworkAgentEngine.OpenCode,
  CoworkAgentEngine.GrokBuild,
  CoworkAgentEngine.QwenCode,
  CoworkAgentEngine.DeepSeekTui,
  CoworkAgentEngine.OpenSquilla,
  CoworkAgentEngine.KimiCode,
] as const;

export const CliCoworkAgentEngines = [
  CoworkAgentEngine.OpenClaw,
  CoworkAgentEngine.ClaudeCode,
  CoworkAgentEngine.Codex,
  CoworkAgentEngine.Hermes,
  CoworkAgentEngine.OpenCode,
  CoworkAgentEngine.GrokBuild,
  CoworkAgentEngine.QwenCode,
  CoworkAgentEngine.DeepSeekTui,
  CoworkAgentEngine.OpenSquilla,
  CoworkAgentEngine.KimiCode,
] as const;

export type CliCoworkAgentEngine = typeof CliCoworkAgentEngines[number];

export const ExternalAgentConfigSource = {
  WesightModel: 'wesight_model',
  LocalCli: 'local_cli',
} as const;

export type ExternalAgentConfigSource = typeof ExternalAgentConfigSource[keyof typeof ExternalAgentConfigSource];

export const ExternalAgentConfigSourceValues = [
  ExternalAgentConfigSource.WesightModel,
  ExternalAgentConfigSource.LocalCli,
] as const;

export const ClaudeCodePermissionMode = {
  BypassPermissions: 'bypassPermissions',
  Default: 'default',
  Plan: 'plan',
  AcceptEdits: 'acceptEdits',
} as const;

export type ClaudeCodePermissionMode = typeof ClaudeCodePermissionMode[keyof typeof ClaudeCodePermissionMode];

export const ClaudeCodePermissionModeValues = [
  ClaudeCodePermissionMode.BypassPermissions,
  ClaudeCodePermissionMode.Default,
  ClaudeCodePermissionMode.Plan,
  ClaudeCodePermissionMode.AcceptEdits,
] as const;

export const OpenCodePermissionMode = {
  Auto: 'auto',
  Conservative: 'conservative',
} as const;

export type OpenCodePermissionMode = typeof OpenCodePermissionMode[keyof typeof OpenCodePermissionMode];

export const OpenCodePermissionModeValues = [
  OpenCodePermissionMode.Auto,
  OpenCodePermissionMode.Conservative,
] as const;

export const QwenCodePermissionMode = {
  Auto: 'auto',
  Conservative: 'conservative',
} as const;

export type QwenCodePermissionMode = typeof QwenCodePermissionMode[keyof typeof QwenCodePermissionMode];

export const QwenCodePermissionModeValues = [
  QwenCodePermissionMode.Auto,
  QwenCodePermissionMode.Conservative,
] as const;

export const DeepSeekTuiPermissionMode = {
  Auto: 'auto',
  Conservative: 'conservative',
} as const;

export type DeepSeekTuiPermissionMode = typeof DeepSeekTuiPermissionMode[keyof typeof DeepSeekTuiPermissionMode];

export const DeepSeekTuiPermissionModeValues = [
  DeepSeekTuiPermissionMode.Auto,
  DeepSeekTuiPermissionMode.Conservative,
] as const;

export const OpenSquillaPermissionMode = {
  Restricted: 'restricted',
  On: 'on',
  Bypass: 'bypass',
  Full: 'full',
} as const;

export type OpenSquillaPermissionMode = typeof OpenSquillaPermissionMode[keyof typeof OpenSquillaPermissionMode];

export const OpenSquillaPermissionModeValues = [
  OpenSquillaPermissionMode.Restricted,
  OpenSquillaPermissionMode.On,
  OpenSquillaPermissionMode.Bypass,
  OpenSquillaPermissionMode.Full,
] as const;

export const KimiCodePermissionMode = {
  Auto: 'auto',
  Yolo: 'yolo',
  Plan: 'plan',
} as const;

export type KimiCodePermissionMode = typeof KimiCodePermissionMode[keyof typeof KimiCodePermissionMode];

export const KimiCodePermissionModeValues = [
  KimiCodePermissionMode.Auto,
  KimiCodePermissionMode.Yolo,
  KimiCodePermissionMode.Plan,
] as const;

export function isCoworkAgentEngine(value: unknown): value is CoworkAgentEngine {
  return typeof value === 'string'
    && CoworkAgentEngineValues.includes(value as CoworkAgentEngine);
}

export function isExternalAgentConfigSource(value: unknown): value is ExternalAgentConfigSource {
  return typeof value === 'string'
    && ExternalAgentConfigSourceValues.includes(value as ExternalAgentConfigSource);
}

export function isClaudeCodePermissionMode(value: unknown): value is ClaudeCodePermissionMode {
  return typeof value === 'string'
    && ClaudeCodePermissionModeValues.includes(value as ClaudeCodePermissionMode);
}

export function isOpenCodePermissionMode(value: unknown): value is OpenCodePermissionMode {
  return typeof value === 'string'
    && OpenCodePermissionModeValues.includes(value as OpenCodePermissionMode);
}

export function isQwenCodePermissionMode(value: unknown): value is QwenCodePermissionMode {
  return typeof value === 'string'
    && QwenCodePermissionModeValues.includes(value as QwenCodePermissionMode);
}

export function isDeepSeekTuiPermissionMode(value: unknown): value is DeepSeekTuiPermissionMode {
  return typeof value === 'string'
    && DeepSeekTuiPermissionModeValues.includes(value as DeepSeekTuiPermissionMode);
}

export function isOpenSquillaPermissionMode(value: unknown): value is OpenSquillaPermissionMode {
  return typeof value === 'string'
    && OpenSquillaPermissionModeValues.includes(value as OpenSquillaPermissionMode);
}

export function isKimiCodePermissionMode(value: unknown): value is KimiCodePermissionMode {
  return typeof value === 'string'
    && KimiCodePermissionModeValues.includes(value as KimiCodePermissionMode);
}

export function isCliCoworkAgentEngine(value: unknown): value is CliCoworkAgentEngine {
  return typeof value === 'string'
    && CliCoworkAgentEngines.includes(value as CliCoworkAgentEngine);
}

export function isOpenClawCoworkAgentEngine(value: unknown): boolean {
  return value === CoworkAgentEngine.OpenClaw;
}

export const RuntimeCallStatus = {
  Running: 'running',
  Completed: 'completed',
  Error: 'error',
  Stopped: 'stopped',
} as const;

export type RuntimeCallStatus = typeof RuntimeCallStatus[keyof typeof RuntimeCallStatus];

export const RuntimeCallStatusValues = [
  RuntimeCallStatus.Running,
  RuntimeCallStatus.Completed,
  RuntimeCallStatus.Error,
  RuntimeCallStatus.Stopped,
] as const;

export const RuntimeCallSource = {
  Chat: 'chat',
  Im: 'im',
  Scheduled: 'scheduled',
  Unknown: 'unknown',
} as const;

export type RuntimeCallSource = typeof RuntimeCallSource[keyof typeof RuntimeCallSource];

export const RuntimeCallSourceValues = [
  RuntimeCallSource.Chat,
  RuntimeCallSource.Im,
  RuntimeCallSource.Scheduled,
  RuntimeCallSource.Unknown,
] as const;

export function isRuntimeCallStatus(value: unknown): value is RuntimeCallStatus {
  return typeof value === 'string'
    && RuntimeCallStatusValues.includes(value as RuntimeCallStatus);
}

export function isRuntimeCallSource(value: unknown): value is RuntimeCallSource {
  return typeof value === 'string'
    && RuntimeCallSourceValues.includes(value as RuntimeCallSource);
}

export const CoworkSessionKind = {
  Single: 'single',
  TeamParent: 'team_parent',
  TeamChild: 'team_child',
} as const;

export type CoworkSessionKind = typeof CoworkSessionKind[keyof typeof CoworkSessionKind];

export const CoworkSessionKindValues = [
  CoworkSessionKind.Single,
  CoworkSessionKind.TeamParent,
  CoworkSessionKind.TeamChild,
] as const;

export function isCoworkSessionKind(value: unknown): value is CoworkSessionKind {
  return typeof value === 'string'
    && CoworkSessionKindValues.includes(value as CoworkSessionKind);
}

export const AgentTeamWorkflow = {
  LeadSequential: 'lead_sequential',
} as const;

export type AgentTeamWorkflow = typeof AgentTeamWorkflow[keyof typeof AgentTeamWorkflow];

export const AgentTeamWorkflowValues = [
  AgentTeamWorkflow.LeadSequential,
] as const;

export function isAgentTeamWorkflow(value: unknown): value is AgentTeamWorkflow {
  return typeof value === 'string'
    && AgentTeamWorkflowValues.includes(value as AgentTeamWorkflow);
}

export const AgentRunTargetType = {
  Agent: 'agent',
  Team: 'team',
} as const;

export type AgentRunTargetType = typeof AgentRunTargetType[keyof typeof AgentRunTargetType];

export const AgentRunTargetTypeValues = [
  AgentRunTargetType.Agent,
  AgentRunTargetType.Team,
] as const;

export function isAgentRunTargetType(value: unknown): value is AgentRunTargetType {
  return typeof value === 'string'
    && AgentRunTargetTypeValues.includes(value as AgentRunTargetType);
}

export const CoworkIpcChannel = {
  AgentProvidersList: 'cowork:agentProviders:list',
  AgentProvidersSave: 'cowork:agentProviders:save',
  AgentProvidersDelete: 'cowork:agentProviders:delete',
  AgentProvidersSetCurrent: 'cowork:agentProviders:setCurrent',
  AgentProvidersImportLive: 'cowork:agentProviders:importLive',
  AgentConfigImportLocalToModelSettings: 'cowork:agentConfig:importLocalToModelSettings',
  AgentConfigSyncOpenClawGlobal: 'cowork:agentConfig:syncOpenClawGlobal',
  AgentConfigSyncOpenCodeGlobal: 'cowork:agentConfig:syncOpenCodeGlobal',
  AgentConfigSyncQwenCodeGlobal: 'cowork:agentConfig:syncQwenCodeGlobal',
  AgentConfigSyncDeepSeekTuiGlobal: 'cowork:agentConfig:syncDeepSeekTuiGlobal',
  AgentCliInstall: 'cowork:agentCli:install',
  AgentCliInstallProgress: 'cowork:agentCli:installProgress',
  AgentEnginesChanged: 'cowork:agentEngines:changed',
  StudioAssetsEnsure: 'cowork:studioAssets:ensure',
  SessionStart: 'cowork:session:start',
  SessionContinue: 'cowork:session:continue',
  SessionStop: 'cowork:session:stop',
  SessionGet: 'cowork:session:get',
  SessionGetMeta: 'cowork:session:getMeta',
  SessionGetRecentMessages: 'cowork:session:getRecentMessages',
  SessionGetMessagesAfter: 'cowork:session:getMessagesAfter',
  SessionGetMessagesBefore: 'cowork:session:getMessagesBefore',
  SessionGetRuntimeSnapshot: 'cowork:session:getRuntimeSnapshot',
  SessionList: 'cowork:session:list',
  SessionSubscribe: 'cowork:session:subscribe',
  SessionUnsubscribe: 'cowork:session:unsubscribe',
  SessionSubscriptionsDebug: 'cowork:session:subscriptionsDebug',
  StreamMessage: 'cowork:stream:message',
  StreamMessageUpdate: 'cowork:stream:messageUpdate',
  StreamPermission: 'cowork:stream:permission',
  StreamPermissionDismiss: 'cowork:stream:permissionDismiss',
  StreamComplete: 'cowork:stream:complete',
  StreamError: 'cowork:stream:error',
  StreamFileActivity: 'cowork:stream:fileActivity',
  PerformanceRendererReady: 'cowork:performance:rendererReady',
  PerformanceSettingsMetric: 'cowork:performance:settingsMetric',
  StartupServicesStatus: 'cowork:startupServices:status',
  StartupServicesChanged: 'cowork:startupServices:changed',
  RuntimeMetricsSummary: 'cowork:runtimeMetrics:summary',
  RuntimeMetricsCalls: 'cowork:runtimeMetrics:calls',
  RuntimeMetricsDetail: 'cowork:runtimeMetrics:detail',
  CodexAppTasksSync: 'codexApp:tasks:sync',
  CodexAppTaskOpen: 'codexApp:tasks:open',
} as const;
export type CoworkIpcChannel = typeof CoworkIpcChannel[keyof typeof CoworkIpcChannel];
