import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import {
  CoworkAgentEngine,
  type CoworkAgentEngine as CoworkAgentEngineType,
  DefaultCoworkAgentEngine,
} from '@shared/cowork/constants';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type {
  ExternalAgentCliInstallProgress,
  ExternalAgentEnvironmentSnapshot,
  ExternalAgentProviderAppType,
} from '../../types/cowork';

type InstallPhase = ExternalAgentCliInstallProgress['phase'];

interface AgentSetupTarget {
  engine: CoworkAgentEngineType;
  appType: ExternalAgentProviderAppType;
  labelKey: string;
  hintKey: string;
  primary: boolean;
  recommended: boolean;
}

interface AgentEnvironmentSetupProps {
  selectedEngine?: CoworkAgentEngineType;
  onEngineChange?: (engine: CoworkAgentEngineType) => void | Promise<void>;
  onSnapshotChange?: (snapshot: ExternalAgentEnvironmentSnapshot | null) => void;
  onComplete?: () => void | Promise<void>;
  showCompleteButton?: boolean;
  compact?: boolean;
  className?: string;
}

const AGENT_SETUP_TARGETS: AgentSetupTarget[] = [
  {
    engine: CoworkAgentEngine.ClaudeCode,
    appType: 'claude',
    labelKey: 'coworkAgentEngineClaudeCode',
    hintKey: 'coworkAgentEngineClaudeCodeHint',
    primary: true,
    recommended: true,
  },
  {
    engine: CoworkAgentEngine.Codex,
    appType: 'codex',
    labelKey: 'coworkAgentEngineCodex',
    hintKey: 'coworkAgentEngineCodexHint',
    primary: true,
    recommended: true,
  },
  {
    engine: CoworkAgentEngine.OpenClaw,
    appType: 'openclaw',
    labelKey: 'coworkAgentEngineOpenClaw',
    hintKey: 'coworkAgentEngineOpenClawHint',
    primary: true,
    recommended: false,
  },
  {
    engine: CoworkAgentEngine.Hermes,
    appType: 'hermes',
    labelKey: 'coworkAgentEngineHermes',
    hintKey: 'coworkAgentEngineHermesHint',
    primary: true,
    recommended: false,
  },
  {
    engine: CoworkAgentEngine.OpenCode,
    appType: 'opencode',
    labelKey: 'coworkAgentEngineOpenCode',
    hintKey: 'coworkAgentEngineOpenCodeHint',
    primary: false,
    recommended: false,
  },
  {
    engine: CoworkAgentEngine.GrokBuild,
    appType: 'grok',
    labelKey: 'coworkAgentEngineGrokBuild',
    hintKey: 'coworkAgentEngineGrokBuildHint',
    primary: false,
    recommended: false,
  },
  {
    engine: CoworkAgentEngine.QwenCode,
    appType: 'qwen',
    labelKey: 'coworkAgentEngineQwenCode',
    hintKey: 'coworkAgentEngineQwenCodeHint',
    primary: false,
    recommended: false,
  },
  {
    engine: CoworkAgentEngine.DeepSeekTui,
    appType: 'deepseek_tui',
    labelKey: 'coworkAgentEngineDeepSeekTui',
    hintKey: 'coworkAgentEngineDeepSeekTuiHint',
    primary: false,
    recommended: false,
  },
];

const RECOMMENDED_APP_TYPES = AGENT_SETUP_TARGETS
  .filter((target) => target.recommended)
  .map((target) => target.appType);

const phaseOrder: Record<InstallPhase, number> = {
  starting: 10,
  installing: 35,
  verifying: 75,
  success: 100,
  error: 100,
  unsupported: 100,
};

const getProgressPercent = (phase?: InstallPhase, batchCompleted = 0, batchTotal = 0): number => {
  if (batchTotal > 0) {
    const currentPhase = phase ? phaseOrder[phase] : 0;
    return Math.round(((batchCompleted + currentPhase / 100) / batchTotal) * 100);
  }
  return phase ? phaseOrder[phase] : 0;
};

const findTargetByEngine = (engine: CoworkAgentEngineType): AgentSetupTarget | null => {
  return AGENT_SETUP_TARGETS.find((target) => target.engine === engine) ?? null;
};

const AgentEnvironmentSetup: React.FC<AgentEnvironmentSetupProps> = ({
  selectedEngine = DefaultCoworkAgentEngine,
  onEngineChange,
  onSnapshotChange,
  onComplete,
  showCompleteButton = false,
  compact = false,
  className = '',
}) => {
  const [snapshot, setSnapshot] = useState<ExternalAgentEnvironmentSnapshot | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [expandedMore, setExpandedMore] = useState(false);
  const [installingAppType, setInstallingAppType] = useState<ExternalAgentProviderAppType | null>(null);
  const [installProgress, setInstallProgress] = useState<Partial<Record<ExternalAgentProviderAppType, ExternalAgentCliInstallProgress>>>({});
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchCompleted, setBatchCompleted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);

  const isSupportedInstallPlatform = window.electron?.platform === 'darwin' || window.electron?.platform === 'win32';
  const effectiveSelectedEngine = findTargetByEngine(selectedEngine)
    ? selectedEngine
    : DefaultCoworkAgentEngine;
  const selectedTarget = findTargetByEngine(effectiveSelectedEngine);
  const primaryTargets = AGENT_SETUP_TARGETS.filter((target) => target.primary);
  const moreTargets = AGENT_SETUP_TARGETS.filter((target) => !target.primary);

  const publishSnapshot = useCallback((nextSnapshot: ExternalAgentEnvironmentSnapshot | null) => {
    setSnapshot(nextSnapshot);
    onSnapshotChange?.(nextSnapshot);
  }, [onSnapshotChange]);

  const refreshSnapshot = useCallback(async () => {
    setIsScanning(true);
    try {
      const nextSnapshot = await coworkService.getAgentEngineSnapshot();
      publishSnapshot(nextSnapshot);
      return nextSnapshot;
    } finally {
      setIsScanning(false);
    }
  }, [publishSnapshot]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    return coworkService.onAgentCliInstallProgress((progress) => {
      setInstallProgress((prev) => ({
        ...prev,
        [progress.appType]: progress,
      }));
      if (progress.phase === 'starting' || progress.phase === 'installing' || progress.phase === 'verifying') {
        setInstallingAppType(progress.appType);
      }
      if (progress.phase === 'success' || progress.phase === 'error' || progress.phase === 'unsupported') {
        setInstallingAppType((current) => (current === progress.appType ? null : current));
      }
    });
  }, []);

  const getCliStatus = useCallback((target: AgentSetupTarget) => {
    return snapshot?.engines.find((item) => item.appType === target.appType) ?? null;
  }, [snapshot]);

  const getRepairHintKey = useCallback((target: AgentSetupTarget): string | null => {
    const status = getCliStatus(target);
    if (!status || status.checking) {
      return null;
    }
    if (!status.found) {
      return isSupportedInstallPlatform
        ? 'agentSetupRepairCliMissingInstall'
        : 'agentSetupRepairCliMissingManual';
    }
    if (!status.config.configExists) {
      return 'agentSetupRepairConfigMissing';
    }
    if (!status.config.currentProviderId && status.config.providerCount === 0) {
      return 'agentSetupRepairAuthMissing';
    }
    if (status.error) {
      return 'agentSetupRepairCliError';
    }
    return null;
  }, [getCliStatus, isSupportedInstallPlatform]);

  const missingRecommendedAppTypes = useMemo(() => {
    return RECOMMENDED_APP_TYPES.filter((appType) => {
      const target = AGENT_SETUP_TARGETS.find((item) => item.appType === appType);
      return target ? !getCliStatus(target)?.found : false;
    });
  }, [getCliStatus]);

  const handleSelectEngine = async (target: AgentSetupTarget) => {
    setError(null);
    setNotice(null);
    await onEngineChange?.(target.engine);
  };

  const installOne = async (appType: ExternalAgentProviderAppType): Promise<boolean> => {
    if (!isSupportedInstallPlatform) {
      setError(i18nService.t('coworkAgentEngineInstallCliUnsupported'));
      return false;
    }
    setError(null);
    setNotice(null);
    setInstallingAppType(appType);
    setInstallProgress((prev) => ({
      ...prev,
      [appType]: {
        appType,
        phase: 'starting',
        message: i18nService.t('coworkAgentEngineInstallCliStarting'),
      },
    }));
    try {
      const result = await coworkService.installAgentCli(appType);
      if (result.snapshot) {
        publishSnapshot(result.snapshot);
      } else {
        await refreshSnapshot();
      }
      if (!result.success) {
        setError(result.error || i18nService.t('coworkAgentEngineInstallCliFailed'));
        return false;
      }
      setNotice(i18nService.t('agentSetupInstallSuccess'));
      setInstallProgress((prev) => ({
        ...prev,
        [appType]: {
          appType,
          phase: 'success',
          message: result.version || result.binaryPath || i18nService.t('coworkAgentEngineInstallCliSuccess'),
          detail: result.binaryPath ?? undefined,
        },
      }));
      return true;
    } finally {
      setInstallingAppType((current) => (current === appType ? null : current));
    }
  };

  const handleInstallRecommended = async () => {
    const queue = missingRecommendedAppTypes;
    if (queue.length === 0) {
      setNotice(i18nService.t('agentSetupRecommendedReady'));
      return;
    }
    setBatchTotal(queue.length);
    setBatchCompleted(0);
    setError(null);
    setNotice(null);
    for (const appType of queue) {
      await installOne(appType);
      setBatchCompleted((value) => value + 1);
    }
    setBatchTotal(0);
    setBatchCompleted(0);
    await refreshSnapshot();
  };

  const handleComplete = async () => {
    setIsCompleting(true);
    setError(null);
    try {
      if (!selectedTarget) {
        await onEngineChange?.(DefaultCoworkAgentEngine);
      }
      await onComplete?.();
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : i18nService.t('agentSetupCompleteFailed'));
    } finally {
      setIsCompleting(false);
    }
  };

  const renderTargetCard = (target: AgentSetupTarget) => {
    const status = getCliStatus(target);
    const progress = installProgress[target.appType];
    const isSelected = target.engine === effectiveSelectedEngine;
    const isInstalling = installingAppType === target.appType;
    const found = Boolean(status?.found);
    const percent = getProgressPercent(progress?.phase);
    const progressMessage = progress?.detail
      ? `${progress.message} ${progress.detail}`
      : progress?.message;
    const repairHintKey = getRepairHintKey(target);

    return (
      <button
        key={target.engine}
        type="button"
        onClick={() => void handleSelectEngine(target)}
        className={`group rounded-2xl border p-4 text-left transition-all ${
          isSelected
            ? 'border-primary bg-primary/5 shadow-subtle'
            : 'border-border bg-surface hover:border-primary/40 hover:bg-surface-raised'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CpuChipIcon className={`h-4 w-4 ${isSelected ? 'text-primary' : 'text-secondary'}`} />
              <span className="truncate text-sm font-semibold text-foreground">
                {i18nService.t(target.labelKey)}
              </span>
              {target.engine === DefaultCoworkAgentEngine && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                  {i18nService.t('agentSetupDefaultBadge')}
                </span>
              )}
            </div>
            <div className="mt-1 line-clamp-2 text-xs leading-5 text-secondary">
              {i18nService.t(target.hintKey)}
            </div>
          </div>
          {isSelected && <CheckCircleIcon className="h-5 w-5 shrink-0 text-primary" />}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 ${
            found
              ? 'bg-green-500/10 text-green-600 dark:text-green-400'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${found ? 'bg-green-500' : 'bg-amber-500'}`} />
            {i18nService.t(found ? 'coworkAgentEngineCliInstalled' : 'coworkAgentEngineCliMissing')}
          </span>
          {status?.version && (
            <span className="max-w-[180px] truncate rounded-full bg-background px-2 py-1 font-mono text-[11px] text-secondary">
              {status.version}
            </span>
          )}
        </div>

        {(status?.path || status?.config.primaryConfigPath) && (
          <div className="mt-3 space-y-1 rounded-xl bg-background/70 px-3 py-2 text-[11px] leading-5">
            {status.path && (
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                <span className="text-secondary">{i18nService.t('coworkAgentEngineCommandPath')}</span>
                <span className="truncate font-mono text-foreground/80">{status.path}</span>
              </div>
            )}
            {status.config.primaryConfigPath && (
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
                <span className="text-secondary">{i18nService.t('coworkAgentEngineConfigPath')}</span>
                <span className="truncate font-mono text-foreground/80">{status.config.primaryConfigPath}</span>
              </div>
            )}
          </div>
        )}

        {!found && (
          <div className="mt-3" onClick={(event) => event.stopPropagation()}>
            {isSupportedInstallPlatform ? (
              <button
                type="button"
                onClick={() => void installOne(target.appType)}
                disabled={Boolean(installingAppType)}
                className="inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-raised disabled:cursor-wait disabled:opacity-60"
              >
                {isInstalling && <span className="mr-2 h-3 w-3 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />}
                {i18nService.t(isInstalling ? 'coworkAgentEngineInstallCliInstalling' : 'agentSetupInstallSingle')}
              </button>
            ) : (
              <div className="text-xs text-secondary">
                {i18nService.t('coworkAgentEngineInstallCliUnsupported')}
              </div>
            )}
          </div>
        )}

        {repairHintKey && (
          <div className="mt-3 flex gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
            <ExclamationTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{i18nService.t(repairHintKey)}</span>
          </div>
        )}

        {isInstalling && (
          <div className="mt-3 space-y-1.5">
            <div className="h-1.5 overflow-hidden rounded-full bg-primary/15">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
            {progressMessage && (
              <div className="truncate text-[11px] text-secondary" title={progressMessage}>
                {progressMessage}
              </div>
            )}
          </div>
        )}
      </button>
    );
  };

  const activeBatchProgress = batchTotal > 0
    ? getProgressPercent(installProgress[installingAppType ?? 'claude']?.phase, batchCompleted, batchTotal)
    : 0;

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="rounded-2xl border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CpuChipIcon className="h-5 w-5 text-primary" />
              {i18nService.t('agentSetupScanTitle')}
            </div>
            <div className="mt-1 text-xs leading-5 text-secondary">
              {i18nService.t('agentSetupScanHint')}
            </div>
            {selectedTarget && (
              <div className="mt-2 text-xs text-secondary">
                {i18nService.t('agentSetupSelectedEngine')}: <span className="font-medium text-foreground">{i18nService.t(selectedTarget.labelKey)}</span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshSnapshot()}
              disabled={isScanning || Boolean(installingAppType)}
              className="inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-surface-raised disabled:cursor-wait disabled:opacity-60"
            >
              <ArrowPathIcon className={`mr-1.5 h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
              {i18nService.t('agentSetupRefresh')}
            </button>
            <button
              type="button"
              onClick={() => void handleInstallRecommended()}
              disabled={!isSupportedInstallPlatform || Boolean(installingAppType) || missingRecommendedAppTypes.length === 0}
              className="inline-flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {i18nService.t(missingRecommendedAppTypes.length === 0 ? 'agentSetupRecommendedReady' : 'agentSetupInstallRecommended')}
            </button>
          </div>
        </div>

        {batchTotal > 0 && (
          <div className="mt-4 rounded-xl bg-primary/5 px-3 py-3">
            <div className="flex items-center justify-between gap-3 text-xs text-secondary">
              <span>{i18nService.t('agentSetupBatchInstalling')}</span>
              <span>{batchCompleted}/{batchTotal}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-primary/15">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${activeBatchProgress}%` }}
              />
            </div>
          </div>
        )}

        {notice && (
          <div className="mt-3 rounded-xl border border-green-500/20 bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300">
            {notice}
          </div>
        )}
        {error && (
          <div className="mt-3 flex gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className={`grid gap-3 ${compact ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 md:grid-cols-2'}`}>
        {primaryTargets.map(renderTargetCard)}
      </div>

      <div className="rounded-2xl border border-border bg-surface">
        <button
          type="button"
          onClick={() => setExpandedMore((value) => !value)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium text-foreground"
        >
          <span>{i18nService.t('agentSetupMoreEngines')}</span>
          <ChevronDownIcon className={`h-4 w-4 text-secondary transition-transform ${expandedMore ? 'rotate-180' : ''}`} />
        </button>
        {expandedMore && (
          <div className={`grid gap-3 border-t border-border p-3 ${compact ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 md:grid-cols-2'}`}>
            {moreTargets.map(renderTargetCard)}
          </div>
        )}
      </div>

      {showCompleteButton && (
        <div className="flex items-center justify-between gap-3 pt-2">
          <div className="text-xs leading-5 text-secondary">
            {i18nService.t('agentSetupCompleteHint')}
          </div>
          <button
            type="button"
            onClick={() => void handleComplete()}
            disabled={isCompleting || Boolean(installingAppType)}
            className="inline-flex min-w-[132px] items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60"
          >
            {isCompleting && <span className="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
            {i18nService.t('agentSetupContinue')}
          </button>
        </div>
      )}
    </div>
  );
};

export default AgentEnvironmentSetup;
