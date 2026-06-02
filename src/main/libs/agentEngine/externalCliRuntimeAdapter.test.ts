import fs from 'fs';
import path from 'path';

import { describe, expect, test } from 'vitest';

import {
  CoworkAgentEngine,
  ExternalAgentConfigSource,
} from '../../../shared/cowork/constants';
import type { CoworkStore } from '../../coworkStore';
import type { ExternalAgentProvider } from '../externalAgentProviderStore';
import { ExternalCliRuntimeAdapter } from './externalCliRuntimeAdapter';

describe('ExternalCliRuntimeAdapter Codex provider config', () => {
  test('writes an isolated CODEX_HOME from the selected local provider', () => {
    const store = {
      getConfig: () => ({
        codexConfigSource: ExternalAgentConfigSource.LocalCli,
      }),
    } as unknown as CoworkStore;
    const adapter = new ExternalCliRuntimeAdapter({
      engine: CoworkAgentEngine.Codex,
      store,
    });
    const provider: ExternalAgentProvider = {
      id: 'ccswitch-tokln',
      appType: 'codex',
      name: 'tokln.com',
      settingsConfig: {
        auth: {
          OPENAI_API_KEY: 'sk-test-provider-key',
        },
        config: [
          'model_provider = "custom"',
          'model = "gpt-5.4"',
          '',
          '[model_providers.custom]',
          'name = "custom"',
          'base_url = "https://api.tokln.com/v1"',
          'wire_api = "responses"',
          'requires_openai_auth = true',
          '',
        ].join('\n'),
      },
      category: 'cc-switch',
      isCurrent: true,
      createdAt: 1,
      updatedAt: 2,
      summary: {
        apiKey: 'sk-test-provider-key',
        baseUrl: 'https://api.tokln.com/v1',
        model: 'gpt-5.5',
      },
    };
    const env: Record<string, string | undefined> = {};
    const internals = adapter as unknown as {
      prepareCodexProviderHomeForExecMode: (
        env: Record<string, string | undefined>,
        provider: ExternalAgentProvider | null,
      ) => string | null;
      cleanupCodexHomeDir: (codexHomeDir: string | null) => void;
    };

    const codexHomeDir = internals.prepareCodexProviderHomeForExecMode(env, provider);

    expect(codexHomeDir).toBeTruthy();
    expect(env.CODEX_HOME).toBe(codexHomeDir);
    const auth = JSON.parse(fs.readFileSync(path.join(codexHomeDir as string, 'auth.json'), 'utf8')) as Record<string, string>;
    const config = fs.readFileSync(path.join(codexHomeDir as string, 'config.toml'), 'utf8');
    expect(auth.OPENAI_API_KEY).toBe('sk-test-provider-key');
    expect(config).toContain('model = "gpt-5.5"');
    expect(config).toContain('base_url = "https://api.tokln.com/v1"');

    internals.cleanupCodexHomeDir(codexHomeDir);
    expect(fs.existsSync(codexHomeDir as string)).toBe(false);
  });
});
