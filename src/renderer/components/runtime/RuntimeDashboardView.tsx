import {
  ArrowPathIcon,
  ChartBarIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  CoworkAgentEngine,
  ExternalAgentConfigSource,
  RuntimeCallSource,
  type RuntimeCallSource as RuntimeCallSourceType,
  RuntimeCallStatus,
  type RuntimeCallStatus as RuntimeCallStatusType,
} from '@shared/cowork/constants';
import {
  calculateModelTps,
  calculateRuntimeTps,
  type RuntimeMetricsBreakdownItem,
} from '@shared/cowork/runtimeMetrics';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import type {
  ExternalAgentProviderAppType,
  RuntimeCallRecord,
  RuntimeMetricsFilters,
  RuntimeMetricsSummary,
  RuntimeToolMetric,
} from '../../types/cowork';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface RuntimeDashboardViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  onShowCowork?: () => void;
  updateBadge?: React.ReactNode;
}

const RuntimeDashboardFilterValue = {
  All: 'all',
  Last24h: '24h',
  Last7d: '7d',
  Last30d: '30d',
} as const;

type RuntimeDashboardRange = typeof RuntimeDashboardFilterValue[keyof typeof RuntimeDashboardFilterValue];

const CHART_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#dc2626'];
const PAGE_SIZE = 30;

const formatNumber = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return new Intl.NumberFormat().format(Math.round(value));
};

const formatDuration = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
};

const formatPercent = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return `${Math.round(value * 100)}%`;
};

const formatCost = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return `$${value.toFixed(4)}`;
};

const formatTps = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return value.toFixed(1);
};

const formatDateTime = (value: number | null | undefined): string => {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
};

const formatTimelineDateTime = (
  value: number | null | undefined,
  baseTime?: number | null,
): string => {
  if (!value) return '-';
  const timestamp = new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
  if (!baseTime) return timestamp;
  return `${timestamp} (+${formatDuration(Math.max(0, value - baseTime))})`;
};

const formatTimeBucket = (value: number): string => {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).format(new Date(value));
};

const getRangeBounds = (range: RuntimeDashboardRange): Pick<RuntimeMetricsFilters, 'from' | 'to'> => {
  if (range === RuntimeDashboardFilterValue.All) return {};
  const now = Date.now();
  const duration = range === RuntimeDashboardFilterValue.Last24h
    ? 24 * 60 * 60 * 1000
    : range === RuntimeDashboardFilterValue.Last7d
      ? 7 * 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000;
  return { from: now - duration, to: now };
};

const getEngineLabel = (engine: string): string => {
  if (engine === CoworkAgentEngine.OpenClaw) return i18nService.t('coworkAgentEngineOpenClaw');
  if (engine === CoworkAgentEngine.Hermes) return i18nService.t('coworkAgentEngineHermes');
  if (engine === CoworkAgentEngine.ClaudeCode) return i18nService.t('coworkAgentEngineClaudeCode');
  if (engine === CoworkAgentEngine.Codex) return i18nService.t('coworkAgentEngineCodex');
  if (engine === CoworkAgentEngine.CodexApp) return i18nService.t('coworkAgentEngineCodexApp');
  if (engine === CoworkAgentEngine.OpenCode) return i18nService.t('coworkAgentEngineOpenCode');
  if (engine === CoworkAgentEngine.GrokBuild) return i18nService.t('coworkAgentEngineGrokBuild');
  if (engine === CoworkAgentEngine.QwenCode) return i18nService.t('coworkAgentEngineQwenCode');
  if (engine === CoworkAgentEngine.DeepSeekTui) return i18nService.t('coworkAgentEngineDeepSeekTui');
  if (engine === CoworkAgentEngine.OpenSquilla) return i18nService.t('coworkAgentEngineOpenSquilla');
  if (engine === CoworkAgentEngine.KimiCode) return i18nService.t('coworkAgentEngineKimiCode');
  return i18nService.t('coworkAgentEngineClaudeLegacy');
};

const getStatusLabel = (status: string): string => {
  if (status === RuntimeCallStatus.Completed) return i18nService.t('runtimeDashboardStatusCompleted');
  if (status === RuntimeCallStatus.Error) return i18nService.t('runtimeDashboardStatusError');
  if (status === RuntimeCallStatus.Stopped) return i18nService.t('runtimeDashboardStatusStopped');
  return i18nService.t('runtimeDashboardStatusRunning');
};

const getSourceLabel = (source: string): string => {
  if (source === RuntimeCallSource.Im) return i18nService.t('runtimeDashboardSourceIm');
  if (source === RuntimeCallSource.Scheduled) return i18nService.t('runtimeDashboardSourceScheduled');
  if (source === RuntimeCallSource.Unknown) return i18nService.t('runtimeDashboardSourceUnknown');
  return i18nService.t('runtimeDashboardSourceChat');
};

const resolveLocalCliAppType = (
  engine: string,
  config: RootState['cowork']['config'],
): ExternalAgentProviderAppType | null => {
  if (
    engine === CoworkAgentEngine.ClaudeCode
    && config.claudeCodeConfigSource === ExternalAgentConfigSource.LocalCli
  ) {
    return 'claude';
  }
  if (
    engine === CoworkAgentEngine.Codex
    && config.codexConfigSource === ExternalAgentConfigSource.LocalCli
  ) {
    return 'codex';
  }
  if (
    engine === CoworkAgentEngine.Hermes
    && config.hermesConfigSource === ExternalAgentConfigSource.LocalCli
  ) {
    return 'hermes';
  }
  if (
    engine === CoworkAgentEngine.OpenCode
    && config.opencodeConfigSource === ExternalAgentConfigSource.LocalCli
  ) {
    return 'opencode';
  }
  if (engine === CoworkAgentEngine.GrokBuild) {
    return 'grok';
  }
  if (
    engine === CoworkAgentEngine.QwenCode
    && config.qwenCodeConfigSource === ExternalAgentConfigSource.LocalCli
  ) {
    return 'qwen';
  }
  if (
    engine === CoworkAgentEngine.DeepSeekTui
    && config.deepseekTuiConfigSource === ExternalAgentConfigSource.LocalCli
  ) {
    return 'deepseek_tui';
  }
  if (
    engine === CoworkAgentEngine.OpenSquilla
    && config.opensquillaConfigSource === ExternalAgentConfigSource.LocalCli
  ) {
    return 'opensquilla';
  }
  if (
    engine === CoworkAgentEngine.KimiCode
    && config.kimiCodeConfigSource === ExternalAgentConfigSource.LocalCli
  ) {
    return 'kimi';
  }
  return null;
};

const RuntimeDashboardView: React.FC<RuntimeDashboardViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  onShowCowork,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const coworkConfig = useSelector((state: RootState) => state.cowork.config);
  const currentAgentEngine = coworkConfig.agentEngine;
  const currentModel = useSelector((state: RootState) => state.model.selectedModel);
  const [range, setRange] = useState<RuntimeDashboardRange>(RuntimeDashboardFilterValue.Last24h);
  const [engine, setEngine] = useState<string>(() => currentAgentEngine || RuntimeDashboardFilterValue.All);
  const [status, setStatus] = useState<string>(RuntimeDashboardFilterValue.All);
  const [source, setSource] = useState<string>(RuntimeDashboardFilterValue.All);
  const [modelId, setModelId] = useState<string>(RuntimeDashboardFilterValue.All);
  const [engineTouched, setEngineTouched] = useState(false);
  const [modelTouched, setModelTouched] = useState(false);
  const [localCliModel, setLocalCliModel] = useState<{ id: string; label: string } | null>(null);
  const [localCliReloadToken, setLocalCliReloadToken] = useState(0);
  const [summary, setSummary] = useState<RuntimeMetricsSummary | null>(null);
  const [modelOptionsSummary, setModelOptionsSummary] = useState<RuntimeMetricsSummary | null>(null);
  const [calls, setCalls] = useState<RuntimeCallRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedCall, setSelectedCall] = useState<RuntimeCallRecord | null>(null);
  const localCliAppType = useMemo(
    () => resolveLocalCliAppType(engine, coworkConfig),
    [coworkConfig, engine],
  );
  const engineModelId = engine === RuntimeDashboardFilterValue.All
    ? RuntimeDashboardFilterValue.All
    : localCliAppType
    ? localCliModel?.id ?? RuntimeDashboardFilterValue.All
    : currentModel?.id || RuntimeDashboardFilterValue.All;
  const engineModelLabel = engine === RuntimeDashboardFilterValue.All
    ? RuntimeDashboardFilterValue.All
    : localCliAppType
    ? localCliModel?.label ?? localCliModel?.id ?? RuntimeDashboardFilterValue.All
    : currentModel?.name || currentModel?.id || RuntimeDashboardFilterValue.All;

  useEffect(() => {
    if (engineTouched || !currentAgentEngine || engine === currentAgentEngine) return;
    setPage(0);
    setModelTouched(false);
    setEngine(currentAgentEngine);
  }, [currentAgentEngine, engine, engineTouched]);

  useEffect(() => {
    if (modelTouched || !engineModelId || modelId === engineModelId) return;
    setPage(0);
    setModelId(engineModelId);
  }, [engineModelId, modelId, modelTouched]);

  useEffect(() => {
    let cancelled = false;
    const loadLocalCliModel = async () => {
      if (!localCliAppType) {
        setLocalCliModel(null);
        return;
      }
      const result = await coworkService.listAgentProviders(localCliAppType);
      if (cancelled) return;
      const providers = result.providers ?? [];
      const currentProvider = providers.find((provider) => provider.id === result.currentProviderId)
        ?? providers.find((provider) => provider.isCurrent)
        ?? providers[0]
        ?? null;
      const model = currentProvider?.summary.model?.trim();
      setLocalCliModel(model
        ? {
          id: model,
          label: currentProvider?.name ? `${currentProvider.name} · ${model}` : model,
        }
        : null);
    };
    void loadLocalCliModel();
    return () => {
      cancelled = true;
    };
  }, [localCliAppType, localCliReloadToken]);

  useEffect(() => {
    const handleProviderChanged = () => {
      if (!localCliAppType) return;
      setLocalCliReloadToken((value) => value + 1);
    };
    window.addEventListener('wesight-agent-provider-changed', handleProviderChanged);
    return () => {
      window.removeEventListener('wesight-agent-provider-changed', handleProviderChanged);
    };
  }, [localCliAppType]);

  const filters = useMemo<RuntimeMetricsFilters>(() => {
    const next: RuntimeMetricsFilters = {
      ...getRangeBounds(range),
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (engine !== RuntimeDashboardFilterValue.All) {
      next.engine = engine as CoworkAgentEngine;
    }
    if (status !== RuntimeDashboardFilterValue.All) {
      next.status = status as RuntimeCallStatusType;
    }
    if (source !== RuntimeDashboardFilterValue.All) {
      next.source = source as RuntimeCallSourceType;
    }
    if (modelId !== RuntimeDashboardFilterValue.All) {
      next.modelId = modelId;
    }
    return next;
  }, [engine, modelId, page, range, source, status]);

  const modelOptionFilters = useMemo<RuntimeMetricsFilters>(() => {
    const next: RuntimeMetricsFilters = {
      ...getRangeBounds(range),
    };
    if (engine !== RuntimeDashboardFilterValue.All) {
      next.engine = engine as CoworkAgentEngine;
    }
    if (status !== RuntimeDashboardFilterValue.All) {
      next.status = status as RuntimeCallStatusType;
    }
    if (source !== RuntimeDashboardFilterValue.All) {
      next.source = source as RuntimeCallSourceType;
    }
    return next;
  }, [engine, range, source, status]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSummary, nextCalls, nextModelOptionsSummary] = await Promise.all([
        coworkService.getRuntimeMetricsSummary(filters),
        coworkService.listRuntimeCalls(filters),
        coworkService.getRuntimeMetricsSummary(modelOptionFilters),
      ]);
      setSummary(nextSummary);
      setModelOptionsSummary(nextModelOptionsSummary);
      setCalls(nextCalls.calls);
      setTotal(nextCalls.total);
    } finally {
      setLoading(false);
    }
  }, [filters, modelOptionFilters]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleOpenSession = useCallback(async (call: RuntimeCallRecord) => {
    await coworkService.loadSession(call.sessionId);
    onShowCowork?.();
  }, [onShowCowork]);

  const kpis = [
    {
      label: i18nService.t('runtimeDashboardTotalCalls'),
      value: formatNumber(summary?.totalCalls),
      hint: i18nService.t('runtimeDashboardCallsUnit'),
    },
    {
      label: i18nService.t('runtimeDashboardSuccessRate'),
      value: formatPercent(summary?.successRate),
      hint: `${formatNumber(summary?.completedCalls)} / ${formatNumber(summary?.totalCalls)}`,
    },
    {
      label: i18nService.t('runtimeDashboardAvgCompletion'),
      value: formatDuration(summary?.avgCompletionMs),
      hint: `${i18nService.t('runtimeDashboardP95')} ${formatDuration(summary?.p95CompletionMs)}`,
    },
    {
      label: i18nService.t('runtimeDashboardAvgTtft'),
      value: formatDuration(summary?.avgTtftMs),
      hint: i18nService.t('runtimeDashboardTtft'),
    },
    {
      label: i18nService.t('runtimeDashboardAvgRuntimeTps'),
      value: formatTps(summary?.avgRuntimeTps),
      hint: i18nService.t('runtimeDashboardRuntimeTps'),
    },
    {
      label: i18nService.t('runtimeDashboardAvgModelTps'),
      value: formatTps(summary?.avgModelTps ?? summary?.avgTps),
      hint: i18nService.t('runtimeDashboardModelTps'),
    },
    {
      label: i18nService.t('runtimeDashboardTotalTokens'),
      value: formatNumber((summary?.totalInputTokens ?? 0) + (summary?.totalOutputTokens ?? 0)),
      hint: `${i18nService.t('runtimeDashboardEstimatedCalls')} ${formatNumber(summary?.estimatedTokenCalls)}`,
    },
    {
      label: i18nService.t('runtimeDashboardContextTokens'),
      value: formatNumber(summary?.totalContextTokens),
      hint: i18nService.t('runtimeDashboardContextSize'),
    },
    {
      label: i18nService.t('runtimeDashboardEstimatedCost'),
      value: formatCost(summary?.estimatedCostUsd),
      hint: i18nService.t('runtimeDashboardCostHint'),
    },
  ];

  const timeSeries = (summary?.timeSeries ?? []).map((point) => ({
    ...point,
    label: formatTimeBucket(point.bucketStart),
  }));
  const engineSeries = (summary?.callsByEngine ?? []).map((item) => ({
    ...item,
    label: getEngineLabel(item.key),
  }));
  const modelOptions = useMemo<RuntimeMetricsBreakdownItem[]>(() => {
    const options = modelOptionsSummary?.callsByModel ?? [];
    if (
      modelId === RuntimeDashboardFilterValue.All
      || options.some((item) => item.key === modelId)
    ) {
      return options;
    }
    return [
      {
        key: modelId,
        label: modelId === engineModelId ? engineModelLabel : modelId,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        avgCompletionMs: null,
      },
      ...options,
    ];
  }, [engineModelId, engineModelLabel, modelId, modelOptionsSummary?.callsByModel]);
  const hasRows = calls.length > 0;

  return (
    <div className="relative flex-1 flex flex-col bg-background h-full">
      <div className="draggable flex h-12 items-center justify-between px-4 border-b border-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <ChartBarIcon className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold text-foreground">
            {i18nService.t('runtimeDashboardTitle')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-7xl px-4 py-5 space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={range}
              onChange={(event) => {
                setPage(0);
                setRange(event.target.value as RuntimeDashboardRange);
              }}
              className="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-foreground"
            >
              <option value={RuntimeDashboardFilterValue.Last24h}>{i18nService.t('runtimeDashboardRange24h')}</option>
              <option value={RuntimeDashboardFilterValue.Last7d}>{i18nService.t('runtimeDashboardRange7d')}</option>
              <option value={RuntimeDashboardFilterValue.Last30d}>{i18nService.t('runtimeDashboardRange30d')}</option>
              <option value={RuntimeDashboardFilterValue.All}>{i18nService.t('runtimeDashboardRangeAll')}</option>
            </select>
            <select
              value={engine}
              onChange={(event) => {
                setPage(0);
                setEngineTouched(true);
                setModelTouched(false);
                setEngine(event.target.value);
              }}
              className="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-foreground"
            >
              <option value={RuntimeDashboardFilterValue.All}>{i18nService.t('runtimeDashboardAllEngines')}</option>
              {Object.values(CoworkAgentEngine).map((value) => (
                <option key={value} value={value}>{getEngineLabel(value)}</option>
              ))}
            </select>
            <select
              value={modelId}
              onChange={(event) => {
                setPage(0);
                setModelTouched(true);
                setModelId(event.target.value);
              }}
              className="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-foreground"
            >
              <option value={RuntimeDashboardFilterValue.All}>{i18nService.t('runtimeDashboardAllModels')}</option>
              {modelOptions.map((item) => (
                <option key={item.key} value={item.key}>{item.label}</option>
              ))}
            </select>
            <select
              value={status}
              onChange={(event) => {
                setPage(0);
                setStatus(event.target.value);
              }}
              className="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-foreground"
            >
              <option value={RuntimeDashboardFilterValue.All}>{i18nService.t('runtimeDashboardAllStatuses')}</option>
              {Object.values(RuntimeCallStatus).map((value) => (
                <option key={value} value={value}>{getStatusLabel(value)}</option>
              ))}
            </select>
            <select
              value={source}
              onChange={(event) => {
                setPage(0);
                setSource(event.target.value);
              }}
              className="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-foreground"
            >
              <option value={RuntimeDashboardFilterValue.All}>{i18nService.t('runtimeDashboardAllSources')}</option>
              {Object.values(RuntimeCallSource).map((value) => (
                <option key={value} value={value}>{getSourceLabel(value)}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadData()}
              className="h-9 inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-secondary hover:text-foreground hover:bg-surface-raised transition-colors"
            >
              <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {i18nService.t('runtimeDashboardRefresh')}
            </button>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {kpis.map((item) => (
              <div key={item.label} className="rounded-lg border border-border bg-surface p-4">
                <div className="text-xs font-medium text-secondary">{item.label}</div>
                <div className="mt-2 text-2xl font-semibold text-foreground tabular-nums">{item.value}</div>
                <div className="mt-1 text-xs text-tertiary truncate">{item.hint}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
            <div className="xl:col-span-2 rounded-lg border border-border bg-surface p-4 min-h-[280px]">
              <div className="mb-3 text-sm font-semibold text-foreground">{i18nService.t('runtimeDashboardCallsTrend')}</div>
              <ResponsiveContainer width="100%" height={230}>
                <AreaChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="currentColor" />
                  <YAxis tick={{ fontSize: 11 }} stroke="currentColor" />
                  <Tooltip />
                  <Area type="monotone" dataKey="calls" stroke="#2563eb" fill="#2563eb" fillOpacity={0.16} name={i18nService.t('runtimeDashboardTotalCalls')} />
                  <Area type="monotone" dataKey="errorCalls" stroke="#dc2626" fill="#dc2626" fillOpacity={0.12} name={i18nService.t('runtimeDashboardStatusError')} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 min-h-[280px]">
              <div className="mb-3 text-sm font-semibold text-foreground">{i18nService.t('runtimeDashboardEngineShare')}</div>
              <ResponsiveContainer width="100%" height={230}>
                <PieChart>
                  <Pie data={engineSeries} dataKey="calls" nameKey="label" innerRadius={50} outerRadius={82} paddingAngle={2}>
                    {engineSeries.map((item, index) => (
                      <Cell key={item.key} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-surface p-4 min-h-[260px]">
              <div className="mb-3 text-sm font-semibold text-foreground">{i18nService.t('runtimeDashboardTokenTrend')}</div>
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="currentColor" />
                  <YAxis tick={{ fontSize: 11 }} stroke="currentColor" />
                  <Tooltip />
                  <Bar dataKey="inputTokens" stackId="tokens" fill="#0891b2" name={i18nService.t('runtimeDashboardInputTokens')} />
                  <Bar dataKey="outputTokens" stackId="tokens" fill="#16a34a" name={i18nService.t('runtimeDashboardOutputTokens')} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="rounded-lg border border-border bg-surface p-4 min-h-[260px]">
              <div className="mb-3 text-sm font-semibold text-foreground">{i18nService.t('runtimeDashboardLatencyTrend')}</div>
              <ResponsiveContainer width="100%" height={210}>
                <AreaChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="currentColor" />
                  <YAxis tickFormatter={(value) => formatDuration(Number(value))} tick={{ fontSize: 11 }} stroke="currentColor" />
                  <Tooltip formatter={(value) => formatDuration(Number(value))} />
                  <Area type="monotone" dataKey="avgCompletionMs" stroke="#7c3aed" fill="#7c3aed" fillOpacity={0.14} name={i18nService.t('runtimeDashboardAvgCompletion')} />
                  <Area type="monotone" dataKey="avgTtftMs" stroke="#ea580c" fill="#ea580c" fillOpacity={0.12} name={i18nService.t('runtimeDashboardAvgTtft')} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="text-sm font-semibold text-foreground">{i18nService.t('runtimeDashboardCallDetails')}</div>
              <div className="text-xs text-secondary">
                {i18nService.t('runtimeDashboardTotalRows').replace('{count}', formatNumber(total))}
              </div>
            </div>
            {hasRows ? (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-surface-raised text-xs text-secondary">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">{i18nService.t('runtimeDashboardStartedAt')}</th>
                      <th className="px-4 py-2 text-left font-medium">{i18nService.t('runtimeDashboardSession')}</th>
                      <th className="px-4 py-2 text-left font-medium">{i18nService.t('runtimeDashboardEngine')}</th>
                      <th className="px-4 py-2 text-left font-medium">{i18nService.t('runtimeDashboardModel')}</th>
                      <th className="px-4 py-2 text-left font-medium">{i18nService.t('runtimeDashboardStatus')}</th>
                      <th className="px-4 py-2 text-right font-medium">{i18nService.t('runtimeDashboardInputTokens')}</th>
                      <th className="px-4 py-2 text-right font-medium">{i18nService.t('runtimeDashboardOutputTokens')}</th>
                      <th className="px-4 py-2 text-right font-medium">{i18nService.t('runtimeDashboardTtft')}</th>
                      <th className="px-4 py-2 text-right font-medium">{i18nService.t('runtimeDashboardRuntimeTps')}</th>
                      <th className="px-4 py-2 text-right font-medium">{i18nService.t('runtimeDashboardModelTps')}</th>
                      <th className="px-4 py-2 text-right font-medium">{i18nService.t('runtimeDashboardToolLatency')}</th>
                      <th className="px-4 py-2 text-right font-medium">{i18nService.t('runtimeDashboardAgentSteps')}</th>
                      <th className="px-4 py-2 text-right font-medium">{i18nService.t('runtimeDashboardCompletionTime')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map((call) => (
                      <tr
                        key={call.id}
                        className="border-t border-border hover:bg-surface-raised cursor-pointer"
                        onClick={() => setSelectedCall(call)}
                      >
                        <td className="px-4 py-3 text-secondary whitespace-nowrap">{formatDateTime(call.startedAt)}</td>
                        <td className="px-4 py-3 text-foreground max-w-[220px] truncate">{call.sessionTitle || call.sessionId}</td>
                        <td className="px-4 py-3 text-secondary whitespace-nowrap">{getEngineLabel(call.engine)}</td>
                        <td className="px-4 py-3 text-secondary max-w-[180px] truncate">{call.modelName || call.modelId || '-'}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className="rounded-full bg-surface-raised px-2 py-1 text-xs text-secondary">
                            {getStatusLabel(call.status)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-secondary">
                          {formatNumber(call.inputTokens)}{call.tokensEstimated ? '*' : ''}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-secondary">
                          {formatNumber(call.outputTokens)}{call.tokensEstimated ? '*' : ''}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-secondary">{formatDuration(call.ttftMs)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-secondary">{formatTps(calculateRuntimeTps(call))}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-secondary">{formatTps(calculateModelTps(call))}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-secondary">{formatDuration(call.toolLatencyMs)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-secondary">{formatNumber(call.agentSteps)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-secondary">{formatDuration(call.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-4 py-14 text-center">
                <ChartBarIcon className="mx-auto h-10 w-10 text-tertiary" />
                <div className="mt-3 text-sm font-medium text-foreground">{i18nService.t('runtimeDashboardEmptyTitle')}</div>
                <div className="mt-1 text-sm text-secondary">{i18nService.t('runtimeDashboardEmptyHint')}</div>
              </div>
            )}
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-secondary disabled:opacity-40"
              >
                {i18nService.t('runtimeDashboardPrevious')}
              </button>
              <div className="text-xs text-secondary">
                {i18nService.t('runtimeDashboardPage').replace('{page}', String(page + 1))}
              </div>
              <button
                type="button"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage((value) => value + 1)}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-secondary disabled:opacity-40"
              >
                {i18nService.t('runtimeDashboardNext')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {selectedCall && (
        <RuntimeCallDrawer
          call={selectedCall}
          onClose={() => setSelectedCall(null)}
          onOpenSession={handleOpenSession}
        />
      )}
    </div>
  );
};

const RuntimeCallDrawer: React.FC<{
  call: RuntimeCallRecord;
  onClose: () => void;
  onOpenSession: (call: RuntimeCallRecord) => void;
}> = ({ call, onClose, onOpenSession }) => {
  const tools = Array.isArray(call.metadata.tools)
    ? call.metadata.tools as RuntimeToolMetric[]
    : [];
  return (
    <div className="non-draggable absolute top-12 bottom-0 right-0 z-30 flex">
      <div className="w-[420px] max-w-[calc(100vw-24px)] bg-surface border-l border-border shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <div className="text-sm font-semibold text-foreground">{i18nService.t('runtimeDashboardCallDetail')}</div>
            <div className="text-xs text-secondary truncate max-w-[320px]">{call.sessionTitle || call.sessionId}</div>
          </div>
          <button
            type="button"
            aria-label={i18nService.t('close')}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <MetricLine label={i18nService.t('runtimeDashboardEngine')} value={getEngineLabel(call.engine)} />
            <MetricLine label={i18nService.t('runtimeDashboardModel')} value={call.modelName || call.modelId || '-'} />
            <MetricLine label={i18nService.t('runtimeDashboardSource')} value={getSourceLabel(call.source)} />
            <MetricLine label={i18nService.t('runtimeDashboardStatus')} value={getStatusLabel(call.status)} />
            <MetricLine label={i18nService.t('runtimeDashboardCompletionTime')} value={formatDuration(call.durationMs)} />
            <MetricLine label={i18nService.t('runtimeDashboardTtft')} value={formatDuration(call.ttftMs)} />
            <MetricLine label={i18nService.t('runtimeDashboardRuntimeTps')} value={formatTps(calculateRuntimeTps(call))} />
            <MetricLine label={i18nService.t('runtimeDashboardModelTps')} value={formatTps(calculateModelTps(call))} />
            <MetricLine label={i18nService.t('runtimeDashboardToolLatency')} value={formatDuration(call.toolLatencyMs)} />
            <MetricLine label={i18nService.t('runtimeDashboardAgentSteps')} value={formatNumber(call.agentSteps)} />
            <MetricLine label={i18nService.t('runtimeDashboardTokenCost')} value={formatCost(call.estimatedCostUsd)} />
            <MetricLine label={i18nService.t('runtimeDashboardContextSize')} value={formatNumber(call.contextTokens)} />
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold text-foreground">{i18nService.t('runtimeDashboardTimeline')}</div>
            <div className="space-y-2">
              <TimelineRow label={i18nService.t('runtimeDashboardStartedAt')} value={formatTimelineDateTime(call.startedAt, call.startedAt)} />
              <TimelineRow label={i18nService.t('runtimeDashboardFirstOutput')} value={formatTimelineDateTime(call.firstOutputAt, call.startedAt)} />
              {tools.map((tool, index) => (
                <TimelineRow
                  key={`${tool.toolName}-${tool.startedAt}-${index}`}
                  label={tool.toolName}
                  value={`${formatTimelineDateTime(tool.startedAt, call.startedAt)} / ${
                    tool.durationMs === null
                      ? i18nService.t('runtimeDashboardStatusRunning')
                      : formatDuration(tool.durationMs)
                  }`}
                />
              ))}
              <TimelineRow label={i18nService.t('runtimeDashboardCompletedAt')} value={formatTimelineDateTime(call.completedAt, call.startedAt)} />
            </div>
          </div>

          {call.error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 p-3">
              <div className="text-xs font-semibold text-red-700 dark:text-red-300">{i18nService.t('runtimeDashboardError')}</div>
              <div className="mt-1 text-xs text-red-700 dark:text-red-200 whitespace-pre-wrap break-words">{call.error}</div>
            </div>
          )}
        </div>
        <div className="p-4 border-t border-border">
          <button
            type="button"
            onClick={() => onOpenSession(call)}
            className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
          >
            {i18nService.t('runtimeDashboardOpenSession')}
          </button>
        </div>
      </div>
    </div>
  );
};

const MetricLine: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg bg-surface-raised px-3 py-2">
    <div className="text-xs text-secondary">{label}</div>
    <div className="mt-1 text-sm font-medium text-foreground truncate">{value}</div>
  </div>
);

const TimelineRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-raised px-3 py-2 text-sm">
    <span className="text-secondary truncate">{label}</span>
    <span className="text-foreground tabular-nums whitespace-nowrap">{value}</span>
  </div>
);

export default RuntimeDashboardView;
