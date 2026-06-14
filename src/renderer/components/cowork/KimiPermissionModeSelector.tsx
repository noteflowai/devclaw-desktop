import {
  CheckIcon,
  ChevronDownIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import {
  KimiCodePermissionMode,
  type KimiCodePermissionMode as KimiCodePermissionModeType,
} from '@shared/cowork/constants';
import React from 'react';
import { useSelector } from 'react-redux';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';

interface KimiPermissionModeSelectorProps {
  dropdownDirection?: 'up' | 'down';
  disabled?: boolean;
}

const OPTIONS: Array<{
  value: KimiCodePermissionModeType;
  labelKey: string;
  hintKey: string;
}> = [
  {
    value: KimiCodePermissionMode.Auto,
    labelKey: 'coworkAgentKimiCodePermissionAuto',
    hintKey: 'coworkAgentKimiCodePermissionAutoHint',
  },
  {
    value: KimiCodePermissionMode.Yolo,
    labelKey: 'coworkAgentKimiCodePermissionYolo',
    hintKey: 'coworkAgentKimiCodePermissionYoloHint',
  },
  {
    value: KimiCodePermissionMode.Plan,
    labelKey: 'coworkAgentKimiCodePermissionPlan',
    hintKey: 'coworkAgentKimiCodePermissionPlanHint',
  },
];

const KimiPermissionModeSelector: React.FC<KimiPermissionModeSelectorProps> = ({
  dropdownDirection = 'up',
  disabled = false,
}) => {
  const selectedMode = useSelector((state: RootState) => state.cowork.config.kimiCodePermissionMode)
    ?? KimiCodePermissionMode.Auto;
  const [isOpen, setIsOpen] = React.useState(false);
  const [isUpdating, setIsUpdating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const selectedOption = OPTIONS.find((option) => option.value === selectedMode) ?? OPTIONS[0];
  const dropdownPositionClass = dropdownDirection === 'up'
    ? 'bottom-full mb-1'
    : 'top-full mt-1';

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

  const selectMode = async (mode: KimiCodePermissionModeType) => {
    if (disabled || isUpdating || mode === selectedMode) {
      setIsOpen(false);
      return;
    }
    setIsUpdating(true);
    setError(null);
    try {
      const ok = await coworkService.updateConfig({ kimiCodePermissionMode: mode });
      if (ok) {
        setIsOpen(false);
      } else {
        setError(i18nService.t('coworkAgentKimiCodePermissionUpdateFailed'));
      }
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        disabled={disabled || isUpdating}
        className={`flex h-8 items-center gap-2 rounded-lg px-2.5 text-sm text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 ${isOpen ? 'bg-surface-raised' : ''}`}
        title={i18nService.t('coworkAgentKimiCodePermissionTitle')}
        aria-label={i18nService.t('coworkAgentKimiCodePermissionTitle')}
      >
        <ShieldCheckIcon className="h-4 w-4 text-secondary" />
        <span className="max-w-[64px] truncate font-medium">
          {i18nService.t(selectedOption.labelKey)}
        </span>
        <ChevronDownIcon className="h-4 w-4 text-secondary" />
      </button>

      {isOpen && (
        <div className={`absolute right-0 ${dropdownPositionClass} z-50 w-72 overflow-hidden rounded-xl border border-border bg-surface shadow-popover popover-enter`}>
          <div className="border-b border-border px-3.5 py-2.5">
            <div className="text-xs font-medium text-foreground">
              {i18nService.t('coworkAgentKimiCodePermissionTitle')}
            </div>
            <div className="mt-1 text-[11px] leading-5 text-secondary">
              {i18nService.t('coworkAgentKimiCodePermissionHint')}
            </div>
          </div>
          {error && (
            <div className="border-b border-border px-3.5 py-2 text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          <div className="py-1">
            {OPTIONS.map((option) => {
              const active = option.value === selectedMode;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => void selectMode(option.value)}
                  disabled={isUpdating}
                  className={`w-full px-3.5 py-2.5 text-left transition-colors hover:bg-surface-raised disabled:cursor-wait disabled:opacity-60 ${active ? 'bg-surface-raised/70' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        {i18nService.t(option.labelKey)}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-secondary">
                        {i18nService.t(option.hintKey)}
                      </div>
                    </div>
                    {active && <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
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

export default KimiPermissionModeSelector;
