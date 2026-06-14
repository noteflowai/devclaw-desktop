import { CoworkAgentEngine, ExternalAgentConfigSource } from '@shared/cowork/constants';
import { type CoworkFileActivity,CoworkFileActivityStatus } from '@shared/cowork/fileActivity';

import { CoworkStudioState, type CoworkStudioState as CoworkStudioStateType } from '../components/cowork/studioConstants';
import type { Model } from '../store/slices/modelSlice';
import type { CoworkConfig, CoworkSession, RuntimeCallRecord } from '../types/cowork';
import {
  ActivityItemStatus,
  type CoworkActivitySnapshot,
  type CoworkActivityToolItem,
} from './coworkActivity';

export interface CoworkStudioAvatar {
  id: string;
  nameTag: string;
  primaryColor: number;
  secondaryColor: number;
  accentColor: number;
  faceColor: number;
  prop: 'claw' | 'scribe' | 'terminal' | 'messenger' | 'console' | 'book' | 'tui' | 'default';
}

export interface CoworkStudioSnapshot {
  state: CoworkStudioStateType;
  detail: string;
  engine: CoworkAgentEngine;
  engineLabel: string;
  modelLabel: string;
  configSourceLabel: string;
  avatar: CoworkStudioAvatar;
  activeToolLabel: string | null;
  todoCount: number;
  fileChangeCount: number;
  artifactCount: number;
  elapsedMs: number | null;
  error: string | null;
}

const engineAvatarManifest: Record<CoworkAgentEngine, CoworkStudioAvatar> = {
  [CoworkAgentEngine.OpenClaw]: {
    id: 'openclaw',
    nameTag: 'OpenClaw',
    primaryColor: 0xd95745,
    secondaryColor: 0x8f2f2a,
    accentColor: 0xffd37a,
    faceColor: 0xffc2a6,
    prop: 'claw',
  },
  [CoworkAgentEngine.ClawAgent]: {
    id: 'claw_agent',
    nameTag: 'Claw Agent',
    primaryColor: 0x6d5ae6,
    secondaryColor: 0x3f3494,
    accentColor: 0xc4b5fd,
    faceColor: 0xddd6fe,
    prop: 'claw',
  },
  [CoworkAgentEngine.ClaudeCode]: {
    id: 'claude_code',
    nameTag: 'Claude Code',
    primaryColor: 0xd28a45,
    secondaryColor: 0x8d5a2f,
    accentColor: 0xffe1b7,
    faceColor: 0xffd5b2,
    prop: 'scribe',
  },
  [CoworkAgentEngine.Codex]: {
    id: 'codex',
    nameTag: 'Codex CLI',
    primaryColor: 0x24a7a5,
    secondaryColor: 0x155f67,
    accentColor: 0x99f6e4,
    faceColor: 0xb6f1ea,
    prop: 'terminal',
  },
  [CoworkAgentEngine.CodexApp]: {
    id: 'codex_app',
    nameTag: 'Codex App',
    primaryColor: 0x3454d1,
    secondaryColor: 0x172554,
    accentColor: 0xa7c7ff,
    faceColor: 0xdbeafe,
    prop: 'terminal',
  },
  [CoworkAgentEngine.Hermes]: {
    id: 'hermes',
    nameTag: 'Hermes',
    primaryColor: 0xd6a72d,
    secondaryColor: 0x7a4b16,
    accentColor: 0xfff2a8,
    faceColor: 0xffd9a3,
    prop: 'messenger',
  },
  [CoworkAgentEngine.OpenCode]: {
    id: 'opencode',
    nameTag: 'OpenCode',
    primaryColor: 0x18261f,
    secondaryColor: 0x0d1511,
    accentColor: 0x5eea87,
    faceColor: 0xb6f7c6,
    prop: 'console',
  },
  [CoworkAgentEngine.GrokBuild]: {
    id: 'grok_build',
    nameTag: 'Grok Build',
    primaryColor: 0x111827,
    secondaryColor: 0x020617,
    accentColor: 0x34d399,
    faceColor: 0xd1fae5,
    prop: 'console',
  },
  [CoworkAgentEngine.QwenCode]: {
    id: 'qwen_code',
    nameTag: 'Qwen Code',
    primaryColor: 0x2f9ccf,
    secondaryColor: 0x17527a,
    accentColor: 0xa7e8ff,
    faceColor: 0xc9f0ff,
    prop: 'book',
  },
  [CoworkAgentEngine.DeepSeekTui]: {
    id: 'deepseek_tui',
    nameTag: 'DeepSeek',
    primaryColor: 0x1e3a8a,
    secondaryColor: 0x111827,
    accentColor: 0x93c5fd,
    faceColor: 0xbfdbfe,
    prop: 'tui',
  },
  [CoworkAgentEngine.OpenSquilla]: {
    id: 'opensquilla',
    nameTag: 'OpenSquilla',
    primaryColor: 0x1f9d7a,
    secondaryColor: 0x114b3d,
    accentColor: 0xb7f7d0,
    faceColor: 0xd6ffe9,
    prop: 'claw',
  },
  [CoworkAgentEngine.KimiCode]: {
    id: 'kimi_code',
    nameTag: 'Kimi Code',
    primaryColor: 0x111827,
    secondaryColor: 0x020617,
    accentColor: 0xffd166,
    faceColor: 0xfef3c7,
    prop: 'terminal',
  },
  [CoworkAgentEngine.YdCowork]: {
    id: 'yd_cowork',
    nameTag: 'DevClaw',
    primaryColor: 0x6c63ff,
    secondaryColor: 0x34306d,
    accentColor: 0x9ef7ff,
    faceColor: 0xd7d9ff,
    prop: 'default',
  },
};

const normalizeToolName = (value: string | null | undefined): string => (
  value ? value.toLowerCase().replace(/[\s_-]+/g, '') : ''
);

const getRuntimeElapsedMs = (runtimeCall: RuntimeCallRecord | null | undefined): number | null => {
  if (!runtimeCall) return null;
  if (typeof runtimeCall.durationMs === 'number') return runtimeCall.durationMs;
  if (typeof runtimeCall.startedAt === 'number' && runtimeCall.status === 'running') {
    return Math.max(0, Date.now() - runtimeCall.startedAt);
  }
  return null;
};

const getConfigSource = (config: CoworkConfig): ExternalAgentConfigSource | null => {
  if (config.agentEngine === CoworkAgentEngine.ClaudeCode) return config.claudeCodeConfigSource;
  if (config.agentEngine === CoworkAgentEngine.Codex) return config.codexConfigSource;
  if (config.agentEngine === CoworkAgentEngine.CodexApp) return ExternalAgentConfigSource.LocalCli;
  if (config.agentEngine === CoworkAgentEngine.Hermes) return config.hermesConfigSource;
  if (config.agentEngine === CoworkAgentEngine.OpenCode) return config.opencodeConfigSource;
  if (config.agentEngine === CoworkAgentEngine.GrokBuild) return ExternalAgentConfigSource.LocalCli;
  if (config.agentEngine === CoworkAgentEngine.QwenCode) return config.qwenCodeConfigSource;
  if (config.agentEngine === CoworkAgentEngine.DeepSeekTui) return config.deepseekTuiConfigSource;
  if (config.agentEngine === CoworkAgentEngine.OpenSquilla) return config.opensquillaConfigSource;
  if (config.agentEngine === CoworkAgentEngine.KimiCode) return config.kimiCodeConfigSource;
  if (config.agentEngine === CoworkAgentEngine.OpenClaw) return config.openclawConfigSource;
  return null;
};

const hasFreshLiveFileActivity = (session: CoworkSession, liveFileActivities: CoworkFileActivity[]): boolean => {
  const lastUserMessage = [...session.messages].reverse().find((message) => message.type === 'user');
  const lastUserTimestamp = lastUserMessage?.timestamp ?? session.updatedAt;
  return liveFileActivities.some((activity) => (
    activity.status !== CoworkFileActivityStatus.Deleted
    && activity.timestamp >= lastUserTimestamp
  ));
};

const resolveStateFromTool = (tool: CoworkActivityToolItem | null): CoworkStudioStateType | null => {
  if (!tool || tool.status !== ActivityItemStatus.Running) return null;
  const normalized = normalizeToolName(tool.toolName);
  if (normalized.includes('write') || normalized.includes('edit') || normalized.includes('multiedit')) {
    return CoworkStudioState.Writing;
  }
  if (normalized.includes('bash') || normalized.includes('exec') || normalized.includes('shell') || normalized.includes('process')) {
    const command = `${tool.summary ?? ''}`.toLowerCase();
    if (/\b(git\s+(push|pull|fetch)|rsync|sync|upload|deploy)\b/.test(command)) {
      return CoworkStudioState.Syncing;
    }
    return CoworkStudioState.Executing;
  }
  if (normalized.includes('read') || normalized.includes('grep') || normalized.includes('glob') || normalized.includes('search')) {
    return CoworkStudioState.Researching;
  }
  return CoworkStudioState.Executing;
};

export const getCoworkStudioAvatar = (engine: CoworkAgentEngine): CoworkStudioAvatar => (
  engineAvatarManifest[engine] ?? engineAvatarManifest[CoworkAgentEngine.YdCowork]
);

export const buildCoworkStudioSnapshot = (input: {
  session: CoworkSession;
  activitySnapshot: CoworkActivitySnapshot;
  liveFileActivities: CoworkFileActivity[];
  runtimeCall: RuntimeCallRecord | null;
  config: CoworkConfig;
  selectedModel: Model | null;
  engineLabel: string;
  configSourceLocalCliLabel: string;
  configSourceWesightLabel: string;
  idleDetail: string;
  runningDetail: string;
  writingDetail: string;
  researchingDetail: string;
  executingDetail: string;
  syncingDetail: string;
  errorDetail: string;
}): CoworkStudioSnapshot => {
  const {
    session,
    activitySnapshot,
    liveFileActivities,
    runtimeCall,
    config,
    selectedModel,
    engineLabel,
  } = input;
  const source = getConfigSource(config);
  const configSourceLabel = source === ExternalAgentConfigSource.LocalCli
    ? input.configSourceLocalCliLabel
    : source === ExternalAgentConfigSource.WesightModel
      ? input.configSourceWesightLabel
      : '-';
  const modelLabel = runtimeCall?.modelName
    || runtimeCall?.modelId
    || selectedModel?.name
    || selectedModel?.id
    || '-';
  const error = runtimeCall?.error || (session.status === 'error' ? input.errorDetail : null);
  let state: CoworkStudioStateType = CoworkStudioState.Idle;
  if (error || session.status === 'error') {
    state = CoworkStudioState.Error;
  } else if (session.status === 'running') {
    state = hasFreshLiveFileActivity(session, liveFileActivities)
      ? CoworkStudioState.Writing
      : resolveStateFromTool(activitySnapshot.activeTool) ?? CoworkStudioState.Researching;
  }

  const detailByState: Record<CoworkStudioStateType, string> = {
    [CoworkStudioState.Idle]: input.idleDetail,
    [CoworkStudioState.Writing]: input.writingDetail,
    [CoworkStudioState.Researching]: input.researchingDetail,
    [CoworkStudioState.Executing]: input.executingDetail,
    [CoworkStudioState.Syncing]: input.syncingDetail,
    [CoworkStudioState.Error]: error ?? input.errorDetail,
  };

  return {
    state,
    detail: state === CoworkStudioState.Idle && session.status === 'running'
      ? input.runningDetail
      : detailByState[state],
    engine: config.agentEngine,
    engineLabel,
    modelLabel,
    configSourceLabel,
    avatar: getCoworkStudioAvatar(config.agentEngine),
    activeToolLabel: activitySnapshot.activeTool?.toolName ?? null,
    todoCount: activitySnapshot.todos.length,
    fileChangeCount: activitySnapshot.fileChanges.length,
    artifactCount: activitySnapshot.artifacts.length,
    elapsedMs: getRuntimeElapsedMs(runtimeCall),
    error,
  };
};
