import { CoworkAgentEngine, type CoworkAgentEngine as CoworkAgentEngineType } from '@shared/cowork/constants';
import React from 'react';

import { i18nService } from '../../services/i18n';

const ENGINE_OPTIONS: CoworkAgentEngineType[] = [
  CoworkAgentEngine.YdCowork,
  CoworkAgentEngine.ClaudeCode,
  CoworkAgentEngine.Codex,
  CoworkAgentEngine.CodexApp,
  CoworkAgentEngine.OpenClaw,
  CoworkAgentEngine.ClawAgent,
  CoworkAgentEngine.Hermes,
  CoworkAgentEngine.OpenCode,
  CoworkAgentEngine.GrokBuild,
  CoworkAgentEngine.QwenCode,
  CoworkAgentEngine.DeepSeekTui,
];

export const getAgentEngineLabel = (engine: CoworkAgentEngineType): string => {
  switch (engine) {
    case CoworkAgentEngine.ClaudeCode:
      return i18nService.t('coworkAgentEngineClaudeCode');
    case CoworkAgentEngine.Codex:
      return i18nService.t('coworkAgentEngineCodex');
    case CoworkAgentEngine.CodexApp:
      return i18nService.t('coworkAgentEngineCodexApp');
    case CoworkAgentEngine.OpenClaw:
      return i18nService.t('coworkAgentEngineOpenClaw');
    case CoworkAgentEngine.ClawAgent:
      return i18nService.t('coworkAgentEngineClawAgent');
    case CoworkAgentEngine.Hermes:
      return i18nService.t('coworkAgentEngineHermes');
    case CoworkAgentEngine.OpenCode:
      return i18nService.t('coworkAgentEngineOpenCode');
    case CoworkAgentEngine.GrokBuild:
      return i18nService.t('coworkAgentEngineGrokBuild');
    case CoworkAgentEngine.QwenCode:
      return i18nService.t('coworkAgentEngineQwenCode');
    case CoworkAgentEngine.DeepSeekTui:
      return i18nService.t('coworkAgentEngineDeepSeekTui');
    case CoworkAgentEngine.YdCowork:
    default:
      return i18nService.t('coworkAgentEngineClaudeLegacy');
  }
};

interface AgentEngineSelectProps {
  value: CoworkAgentEngineType;
  onChange: (value: CoworkAgentEngineType) => void;
}

const AgentEngineSelect: React.FC<AgentEngineSelectProps> = ({ value, onChange }) => (
  <select
    value={value}
    onChange={(event) => onChange(event.target.value as CoworkAgentEngineType)}
    className="w-full px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm"
  >
    {ENGINE_OPTIONS.map((engine) => (
      <option key={engine} value={engine}>
        {getAgentEngineLabel(engine)}
      </option>
    ))}
  </select>
);

export default AgentEngineSelect;
