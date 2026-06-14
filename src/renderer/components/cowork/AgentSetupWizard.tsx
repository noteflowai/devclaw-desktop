import React from 'react';
import { useSelector } from 'react-redux';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import type { CoworkAgentEngine } from '../../types/cowork';
import AgentEnvironmentSetup from './AgentEnvironmentSetup';

interface AgentSetupWizardProps {
  onComplete: () => void | Promise<void>;
}

const AgentSetupWizard: React.FC<AgentSetupWizardProps> = ({ onComplete }) => {
  const selectedEngine = useSelector((state: RootState) => state.cowork.config.agentEngine);

  const handleEngineChange = async (engine: CoworkAgentEngine) => {
    await coworkService.updateConfig({ agentEngine: engine });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/90 px-4 py-8 backdrop-blur-xl">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-2xl">
        <div className="border-b border-border bg-surface px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                {i18nService.t('agentSetupEyebrow')}
              </div>
              <h2 className="mt-2 text-2xl font-bold text-foreground">
                {i18nService.t('agentSetupTitle')}
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-secondary">
                {i18nService.t('agentSetupSubtitle')}
              </p>
            </div>
            <img src="logo.png" alt="DevClaw Desktop" className="h-14 w-14 shrink-0" />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <AgentEnvironmentSetup
            selectedEngine={selectedEngine}
            onEngineChange={handleEngineChange}
            onComplete={onComplete}
            showCompleteButton
          />
        </div>
      </div>
    </div>
  );
};

export default AgentSetupWizard;
