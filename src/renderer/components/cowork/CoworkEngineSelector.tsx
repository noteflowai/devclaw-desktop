import {
  CheckIcon,
  ChevronDownIcon,
  CpuChipIcon,
} from '@heroicons/react/24/outline';
import {
  CoworkAgentEngine,
  ExternalAgentConfigSource,
} from '@shared/cowork/constants';
import React from 'react';
import { useSelector } from 'react-redux';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import type {
  CoworkAgentEngine as CoworkAgentEngineType,
  ExternalAgentEnvironmentSnapshot,
  ExternalAgentProviderAppType,
  ExternalAgentProviderListResult,
} from '../../types/cowork';

interface CoworkEngineSelectorProps {
  dropdownDirection?: 'up' | 'down';
  value?: CoworkAgentEngineType;
  readOnly?: boolean;
  readOnlyTitle?: string;
}

const ENGINE_OPTIONS: Array<{
  engine: CoworkAgentEngineType;
  labelKey: string;
  hintKey: string;
}> = [
  {
    engine: CoworkAgentEngine.OpenClaw,
    labelKey: 'coworkAgentEngineOpenClaw',
    hintKey: 'coworkAgentEngineOpenClawHint',
  },
  {
    engine: CoworkAgentEngine.ClawAgent,
    labelKey: 'coworkAgentEngineClawAgent',
    hintKey: 'coworkAgentEngineClawAgentHint',
  },
  {
    engine: CoworkAgentEngine.Hermes,
    labelKey: 'coworkAgentEngineHermes',
    hintKey: 'coworkAgentEngineHermesHint',
  },
  {
    engine: CoworkAgentEngine.OpenSquilla,
    labelKey: 'coworkAgentEngineOpenSquilla',
    hintKey: 'coworkAgentEngineOpenSquillaHint',
  },
  {
    engine: CoworkAgentEngine.KimiCode,
    labelKey: 'coworkAgentEngineKimiCode',
    hintKey: 'coworkAgentEngineKimiCodeHint',
  },
  {
    engine: CoworkAgentEngine.YdCowork,
    labelKey: 'coworkAgentEngineClaudeLegacy',
    hintKey: 'coworkAgentEngineClaudeLegacyHint',
  },
  {
    engine: CoworkAgentEngine.ClaudeCode,
    labelKey: 'coworkAgentEngineClaudeCode',
    hintKey: 'coworkAgentEngineClaudeCodeHint',
  },
  {
    engine: CoworkAgentEngine.Codex,
    labelKey: 'coworkAgentEngineCodex',
    hintKey: 'coworkAgentEngineCodexHint',
  },
  {
    engine: CoworkAgentEngine.CodexApp,
    labelKey: 'coworkAgentEngineCodexApp',
    hintKey: 'coworkAgentEngineCodexAppHint',
  },
  {
    engine: CoworkAgentEngine.OpenCode,
    labelKey: 'coworkAgentEngineOpenCode',
    hintKey: 'coworkAgentEngineOpenCodeHint',
  },
  {
    engine: CoworkAgentEngine.GrokBuild,
    labelKey: 'coworkAgentEngineGrokBuild',
    hintKey: 'coworkAgentEngineGrokBuildHint',
  },
  {
    engine: CoworkAgentEngine.QwenCode,
    labelKey: 'coworkAgentEngineQwenCode',
    hintKey: 'coworkAgentEngineQwenCodeHint',
  },
  {
    engine: CoworkAgentEngine.DeepSeekTui,
    labelKey: 'coworkAgentEngineDeepSeekTui',
    hintKey: 'coworkAgentEngineDeepSeekTuiHint',
  },
];

const isCliEngine = (engine: CoworkAgentEngineType): boolean => {
  return engine === CoworkAgentEngine.ClaudeCode
    || engine === CoworkAgentEngine.OpenClaw
    || engine === CoworkAgentEngine.Codex
    || engine === CoworkAgentEngine.Hermes
    || engine === CoworkAgentEngine.OpenCode
    || engine === CoworkAgentEngine.GrokBuild
    || engine === CoworkAgentEngine.QwenCode
    || engine === CoworkAgentEngine.DeepSeekTui
    || engine === CoworkAgentEngine.OpenSquilla
    || engine === CoworkAgentEngine.KimiCode;
};

type CliEngineStatus = ExternalAgentEnvironmentSnapshot['engines'][number];

const resolveAuthMeta = (status: CliEngineStatus): { labelKey: string; dotClass: string; textClass: string } => {
  switch (status.authStatus) {
    case 'logged_in':
      return {
        labelKey: 'coworkAgentEngineAuthStatusLoggedIn',
        dotClass: 'bg-green-500',
        textClass: 'text-green-600 dark:text-green-400',
      };
    case 'expired':
      return {
        labelKey: 'coworkAgentEngineAuthStatusExpired',
        dotClass: 'bg-amber-500',
        textClass: 'text-amber-600 dark:text-amber-400',
      };
    case 'logged_out':
      return {
        labelKey: 'coworkAgentEngineAuthStatusLoggedOut',
        dotClass: 'bg-amber-500',
        textClass: 'text-amber-600 dark:text-amber-400',
      };
    case 'unconfigured':
      return {
        labelKey: 'coworkAgentEngineAuthStatusUnconfigured',
        dotClass: 'bg-red-500',
        textClass: 'text-red-600 dark:text-red-400',
      };
    case 'unknown':
    default:
      return {
        labelKey: 'coworkAgentEngineAuthStatusUnknown',
        dotClass: 'bg-primary animate-pulse',
        textClass: 'text-primary',
      };
  }
};

const getCliAppTypeForEngine = (engine: CoworkAgentEngineType): ExternalAgentProviderAppType | null => {
  if (engine === CoworkAgentEngine.ClaudeCode) return 'claude';
  if (engine === CoworkAgentEngine.Codex) return 'codex';
  if (engine === CoworkAgentEngine.OpenClaw) return 'openclaw';
  if (engine === CoworkAgentEngine.Hermes) return 'hermes';
  if (engine === CoworkAgentEngine.OpenCode) return 'opencode';
  if (engine === CoworkAgentEngine.GrokBuild) return 'grok';
  if (engine === CoworkAgentEngine.QwenCode) return 'qwen';
  if (engine === CoworkAgentEngine.DeepSeekTui) return 'deepseek_tui';
  if (engine === CoworkAgentEngine.OpenSquilla) return 'opensquilla';
  if (engine === CoworkAgentEngine.KimiCode) return 'kimi';
  return null;
};

const ALL_CLI_APP_TYPES: ExternalAgentProviderAppType[] = [
  'openclaw',
  'hermes',
  'claude',
  'codex',
  'opencode',
  'grok',
  'qwen',
  'deepseek_tui',
  'opensquilla',
  'kimi',
];

/**
 * Partial refreshes only include the requested app types. Keep previous engine
 * entries for omitted app types, and let next overwrite matching app types.
 */
const mergeSnapshots = (
  previous: ExternalAgentEnvironmentSnapshot | null,
  next: ExternalAgentEnvironmentSnapshot,
): ExternalAgentEnvironmentSnapshot => {
  if (!previous) return next;
  const enginesByAppType = new Map<ExternalAgentProviderAppType, ExternalAgentEnvironmentSnapshot['engines'][number]>();
  previous.engines.forEach((engine) => enginesByAppType.set(engine.appType, engine));
  next.engines.forEach((engine) => enginesByAppType.set(engine.appType, engine));
  return {
    ...previous,
    ...next,
    engines: ALL_CLI_APP_TYPES
      .map((appType) => enginesByAppType.get(appType))
      .filter((engine): engine is ExternalAgentEnvironmentSnapshot['engines'][number] => Boolean(engine)),
  };
};

const CoworkEngineSelector: React.FC<CoworkEngineSelectorProps> = ({
  dropdownDirection = 'down',
  value,
  readOnly = false,
  readOnlyTitle,
}) => {
  const selectedEngine = useSelector((state: RootState) => state.cowork.config.agentEngine);
  const coworkConfig = useSelector((state: RootState) => state.cowork.config);
  const effectiveEngine = value ?? selectedEngine;
  const [isOpen, setIsOpen] = React.useState(false);
  const [isUpdating, setIsUpdating] = React.useState(false);
  const [pendingEngine, setPendingEngine] = React.useState<CoworkAgentEngineType | null>(null);
  const [switchError, setSwitchError] = React.useState<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<ExternalAgentEnvironmentSnapshot | null>(null);
  const [providerLists, setProviderLists] = React.useState<Partial<Record<ExternalAgentProviderAppType, ExternalAgentProviderListResult>>>({});
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mountedRef = React.useRef(true);

  const selectedOption = ENGINE_OPTIONS.find((option) => option.engine === effectiveEngine)
    ?? ENGINE_OPTIONS[1];
  const effectiveAppType = React.useMemo(
    () => getCliAppTypeForEngine(effectiveEngine),
    [effectiveEngine],
  );

  const getConfigSourceForEngine = React.useCallback((engine: CoworkAgentEngineType) => {
    if (engine === CoworkAgentEngine.OpenClaw) return coworkConfig.openclawConfigSource;
    if (engine === CoworkAgentEngine.ClaudeCode) return coworkConfig.claudeCodeConfigSource;
    if (engine === CoworkAgentEngine.Codex) return coworkConfig.codexConfigSource;
    if (engine === CoworkAgentEngine.Hermes) return coworkConfig.hermesConfigSource;
    if (engine === CoworkAgentEngine.OpenCode) return coworkConfig.opencodeConfigSource;
    if (engine === CoworkAgentEngine.GrokBuild) return ExternalAgentConfigSource.LocalCli;
    if (engine === CoworkAgentEngine.QwenCode) return coworkConfig.qwenCodeConfigSource;
    if (engine === CoworkAgentEngine.DeepSeekTui) return coworkConfig.deepseekTuiConfigSource;
    if (engine === CoworkAgentEngine.OpenSquilla) return coworkConfig.opensquillaConfigSource;
    if (engine === CoworkAgentEngine.KimiCode) return coworkConfig.kimiCodeConfigSource;
    return ExternalAgentConfigSource.WesightModel;
  }, [coworkConfig]);

  const loadProviderList = React.useCallback(async (appType: ExternalAgentProviderAppType) => {
    const result = await coworkService.listAgentProviders(appType);
    if (!mountedRef.current || !result.success) return;
    setProviderLists((prev) => ({
      ...prev,
      [appType]: result,
    }));
  }, []);

  const refreshLocalProviderLists = React.useCallback(() => {
    const appTypes = ENGINE_OPTIONS
      .filter((option) => getConfigSourceForEngine(option.engine) === ExternalAgentConfigSource.LocalCli)
      .map((option) => getCliAppTypeForEngine(option.engine))
      .filter((appType): appType is ExternalAgentProviderAppType => Boolean(appType));
    Array.from(new Set(appTypes)).forEach((appType) => {
      void loadProviderList(appType);
    });
  }, [getConfigSourceForEngine, loadProviderList]);

  const refreshSnapshot = React.useCallback((options: { forceRefresh?: boolean; appTypes?: ExternalAgentProviderAppType[] } = {}) => {
    const appTypes = options.appTypes ?? (effectiveAppType ? [effectiveAppType] : []);
    if (appTypes.length === 0) {
      setSnapshot(null);
      return Promise.resolve();
    }
    return coworkService.getAgentEngineSnapshot({
      ...options,
      appTypes,
    })
      .then((nextSnapshot) => {
        if (mountedRef.current && nextSnapshot) {
          setSnapshot((previous) => mergeSnapshots(previous, nextSnapshot));
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setSnapshot(null);
        }
      });
  }, [effectiveAppType]);

  React.useEffect(() => {
    mountedRef.current = true;
    void refreshSnapshot();
    const unsubscribe = coworkService.onAgentEnginesChanged((nextSnapshot) => {
      if (mountedRef.current) {
        setSnapshot((previous) => mergeSnapshots(previous, nextSnapshot));
      }
    });

    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [refreshSnapshot]);

  React.useEffect(() => {
    if (!isOpen || readOnly) {
      return;
    }
    if (effectiveAppType) {
      void refreshSnapshot({ forceRefresh: true, appTypes: [effectiveAppType] });
    }
    refreshLocalProviderLists();
  }, [effectiveAppType, isOpen, readOnly, refreshLocalProviderLists, refreshSnapshot]);

  React.useEffect(() => {
    if (!effectiveAppType || readOnly) {
      return;
    }
    if (getConfigSourceForEngine(effectiveEngine) === ExternalAgentConfigSource.LocalCli) {
      void loadProviderList(effectiveAppType);
    }
  }, [effectiveAppType, effectiveEngine, getConfigSourceForEngine, loadProviderList, readOnly]);

  React.useEffect(() => {
    const handleProviderChanged = (event: Event) => {
      const appType = (event as CustomEvent<{ appType?: ExternalAgentProviderAppType }>).detail?.appType;
      if (appType) {
        void loadProviderList(appType);
        void refreshSnapshot({ forceRefresh: true, appTypes: [appType] });
      } else {
        refreshLocalProviderLists();
        void refreshSnapshot({ forceRefresh: true, appTypes: ALL_CLI_APP_TYPES });
      }
    };
    window.addEventListener('wesight-agent-provider-changed', handleProviderChanged);
    return () => {
      window.removeEventListener('wesight-agent-provider-changed', handleProviderChanged);
    };
  }, [loadProviderList, refreshLocalProviderLists, refreshSnapshot]);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const dropdownPositionClass = dropdownDirection === 'up'
    ? 'bottom-full mb-1'
    : 'top-full mt-1';

  const selectEngine = async (engine: CoworkAgentEngineType) => {
    if (readOnly || engine === selectedEngine || isUpdating) {
      setIsOpen(false);
      return;
    }
    setIsUpdating(true);
    setPendingEngine(engine);
    setSwitchError(null);
    try {
      const ok = await coworkService.updateConfig({ agentEngine: engine });
      if (ok) {
        const appType = getCliAppTypeForEngine(engine);
        if (appType) {
          const nextSnapshot = await coworkService.getAgentEngineSnapshot({
            appTypes: [appType],
          });
          if (nextSnapshot) {
            setSnapshot((previous) => mergeSnapshots(previous, nextSnapshot));
          } else {
            setSnapshot(null);
          }
          if (getConfigSourceForEngine(engine) === ExternalAgentConfigSource.LocalCli) {
            void loadProviderList(appType);
          }
        } else {
          setSnapshot(null);
        }
        setIsOpen(false);
      } else {
        setSwitchError(i18nService.t('coworkAgentEngineSwitchFailed'));
      }
    } finally {
      setIsUpdating(false);
      setPendingEngine(null);
    }
  };

  const getCliStatus = (engine: CoworkAgentEngineType) => {
    return snapshot?.engines.find((item) => item.engine === engine) ?? null;
  };

  const getCurrentProvider = (appType: ExternalAgentProviderAppType) => {
    const list = providerLists[appType];
    const providers = list?.providers ?? [];
    const currentProviderId = list?.currentProviderId;
    if (currentProviderId) {
      return providers.find((provider) => provider.id === currentProviderId) ?? null;
    }
    return providers.find((provider) => provider.isCurrent)
      ?? providers[0]
      ?? null;
  };

  const getConfigSummary = (engine: CoworkAgentEngineType, status: CliEngineStatus | null): string | null => {
    const configSource = getConfigSourceForEngine(engine);
    if (!isCliEngine(engine)) return null;
    if (configSource !== ExternalAgentConfigSource.LocalCli) {
      return i18nService.t('coworkAgentConfigSourceWesightModel');
    }
    const appType = getCliAppTypeForEngine(engine);
    const provider = appType ? getCurrentProvider(appType) : null;
    const providerLabel = provider
      ? [provider.name, provider.summary.model].filter(Boolean).join(' · ')
      : status?.config.currentProviderName
        || status?.config.currentProviderId
        || i18nService.t('coworkAgentLocalModelUnknown');
    return `${i18nService.t('coworkAgentConfigSourceLocalCli')} · ${providerLabel}`;
  };

  const renderCliStatus = (engine: CoworkAgentEngineType) => {
    if (engine === CoworkAgentEngine.CodexApp) {
      const status = snapshot?.codexApp;
      if (!status) return null;
      const ready = status.cliFound && status.appInstalled && status.appServerSupported;
      return (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-secondary">
          <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-green-500' : 'bg-amber-500'}`} />
          <span className="truncate">
            {i18nService.t(ready ? 'coworkAgentCodexAppReady' : 'coworkAgentCodexAppMissing')}
            {status.appRunning ? ` · ${i18nService.t('coworkAgentCodexAppRunning')}` : ''}
          </span>
        </div>
      );
    }
    const status = getCliStatus(engine);
    if (!isCliEngine(engine) || !status) return null;
    const configSummary = getConfigSummary(engine, status);
    if (!status.found) {
      return (
        <>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            <span className="truncate">
              {i18nService.t(status.checking ? 'coworkAgentEngineCliChecking' : 'coworkAgentEngineCliMissing')}
            </span>
          </div>
          {configSummary && (
            <div className="mt-0.5 truncate text-[11px] text-secondary" title={configSummary}>
              {configSummary}
            </div>
          )}
        </>
      );
    }
    const authMeta = resolveAuthMeta(status);
    return (
      <>
        <div className={`mt-1 flex items-center gap-1.5 text-[11px] ${authMeta.textClass}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${authMeta.dotClass}`} />
          <span className="truncate" title={status.authSource || status.version || undefined}>
            {i18nService.t(authMeta.labelKey)}
            {status.version ? ` · ${status.version}` : ''}
          </span>
        </div>
        {configSummary && (
          <div className="mt-0.5 truncate text-[11px] text-secondary" title={configSummary}>
            {configSummary}
          </div>
        )}
      </>
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (readOnly) return;
          setIsOpen((value) => !value);
        }}
        className={`flex h-8 items-center gap-2 rounded-lg px-2.5 text-sm text-foreground transition-colors hover:bg-surface-raised ${isOpen ? 'bg-surface-raised' : ''}`}
        title={readOnlyTitle || i18nService.t('coworkAgentEngineSelect')}
        aria-label={readOnlyTitle || i18nService.t('coworkAgentEngineSelect')}
        disabled={isUpdating || readOnly}
      >
        <CpuChipIcon className="h-4 w-4 text-secondary" />
        <span className="max-w-[120px] truncate font-medium">
          {i18nService.t(selectedOption.labelKey)}
        </span>
        {!readOnly && <ChevronDownIcon className="h-4 w-4 text-secondary" />}
      </button>

      {isOpen && !readOnly && (
        <div className={`absolute right-0 ${dropdownPositionClass} z-50 w-80 overflow-hidden rounded-xl border border-border bg-surface shadow-popover popover-enter`}>
          {isUpdating && (
            <div className="border-b border-border px-3.5 py-3">
              <div className="flex items-center justify-between gap-3 text-xs text-secondary">
                <span>{i18nService.t('coworkAgentEngineSwitching')}</span>
                <span className="truncate text-[11px]">
                  {pendingEngine
                    ? i18nService.t(ENGINE_OPTIONS.find((option) => option.engine === pendingEngine)?.labelKey || selectedOption.labelKey)
                    : ''}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/15">
                <div className="h-full w-2/3 animate-pulse rounded-full bg-primary" />
              </div>
            </div>
          )}
          {switchError && (
            <div className="border-b border-border px-3.5 py-2 text-xs text-red-600 dark:text-red-400">
              {switchError}
            </div>
          )}
          <div className="max-h-[360px] overflow-y-auto py-1">
            {ENGINE_OPTIONS.map((option) => {
              const active = option.engine === selectedEngine;
              const pending = option.engine === pendingEngine;
              return (
                <button
                  key={option.engine}
                  type="button"
                  onClick={() => void selectEngine(option.engine)}
                  disabled={isUpdating}
                  className={`w-full px-3.5 py-3 text-left transition-colors hover:bg-surface-raised disabled:cursor-wait disabled:opacity-60 ${active ? 'bg-surface-raised/70' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        {i18nService.t(option.labelKey)}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-secondary">
                        {i18nService.t(option.hintKey)}
                      </div>
                      {renderCliStatus(option.engine)}
                    </div>
                    {pending ? (
                      <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
                    ) : (
                      active && <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default CoworkEngineSelector;
