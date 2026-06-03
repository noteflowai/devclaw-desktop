import { expect, test } from 'vitest';

import { buildEnvForConfig } from './claudeSettings';
import {
  mergeClaudeSettingsForWesightModel,
  mergeCodexConfigForWesightModel,
} from './externalAgentConfigSync';

const apiConfig = {
  apiKey: 'sk-wesight-secret',
  baseURL: 'https://api.example.com/v1',
  model: 'glm-5.1-highspeed',
  apiType: 'openai' as const,
};

test('mergeCodexConfigForWesightModel preserves user TOML content', () => {
  const existing = [
    '# user comment',
    '[features]',
    'web_search_request = true',
    '',
    '[model_providers.local]',
    'name = "local"',
    'base_url = "https://local.example/v1"',
    '',
  ].join('\n');

  const merged = mergeCodexConfigForWesightModel(
    existing,
    'Zhipu GLM',
    apiConfig.baseURL,
    apiConfig.model,
  );

  expect(merged).toContain('# user comment');
  expect(merged).toContain('[features]');
  expect(merged).toContain('web_search_request = true');
  expect(merged).toContain('[model_providers.local]');
  expect(merged).toContain('model_provider = "zhipu_glm"');
  expect(merged).toContain('model = "glm-5.1-highspeed"');
  expect(merged).toContain('[model_providers.zhipu_glm]');
  expect(merged).toContain('base_url = "https://api.example.com/v1"');
  expect(merged).not.toContain('sk-wesight-secret');
});

test('mergeClaudeSettingsForWesightModel preserves user credentials', () => {
  const merged = mergeClaudeSettingsForWesightModel({
    env: {
      ANTHROPIC_API_KEY: 'sk-user-secret',
      FOO_TOKEN: 'keep-me',
    },
    theme: 'dark',
  }, apiConfig);

  expect(merged.theme).toBe('dark');
  const env = merged.env as Record<string, unknown>;
  expect(env.ANTHROPIC_API_KEY).toBe('sk-user-secret');
  expect(env.FOO_TOKEN).toBe('keep-me');
  expect(env.ANTHROPIC_BASE_URL).toBe(apiConfig.baseURL);
  expect(env.ANTHROPIC_MODEL).toBe(apiConfig.model);
});

test('mergeClaudeSettingsForWesightModel replaces old WeSight credentials with placeholder', () => {
  const merged = mergeClaudeSettingsForWesightModel({
    env: {
      ANTHROPIC_API_KEY: apiConfig.apiKey,
      ANTHROPIC_AUTH_TOKEN: apiConfig.apiKey,
    },
  }, apiConfig);

  const env = merged.env as Record<string, unknown>;
  expect(env.ANTHROPIC_API_KEY).toBe('${WESIGHT_APIKEY_ACTIVE_PROVIDER}');
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('${WESIGHT_APIKEY_ACTIVE_PROVIDER}');
  expect(JSON.stringify(merged)).not.toContain(apiConfig.apiKey);
});

test('buildEnvForConfig injects real secrets only into process env', () => {
  const env = buildEnvForConfig(apiConfig);

  expect(env.WESIGHT_APIKEY_ACTIVE_PROVIDER).toBe(apiConfig.apiKey);
  expect(env.ANTHROPIC_API_KEY).toBe(apiConfig.apiKey);
  expect(env.OPENAI_API_KEY).toBe(apiConfig.apiKey);
  expect(env.OPENAI_BASE_URL).toBe(apiConfig.baseURL);
  expect(env.OPENAI_MODEL).toBe(apiConfig.model);
});
