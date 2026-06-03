import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { getExternalAgentEnvironmentSnapshot, summarizeCliAuthStatus } from './externalAgentEnvironment';

let tempDir = '';
let originalPath = '';
let originalOpenAiKey: string | undefined;

const writeExecutable = (name: string, script: string): void => {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, script, 'utf8');
  fs.chmodSync(filePath, 0o755);
};

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-agent-env-'));
  originalPath = process.env.PATH ?? '';
  originalOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath}`;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('probes CLI commands asynchronously and isolates version timeouts', async () => {
  writeExecutable('claude', '#!/bin/sh\necho "claude-test 1.0.0"\n');
  writeExecutable('grok', '#!/bin/sh\nif [ "$1" = "--version" ]; then sleep 3; fi\n');

  const { snapshot, report } = await getExternalAgentEnvironmentSnapshot();
  const claude = snapshot.engines.find(engine => engine.appType === 'claude');
  const grok = snapshot.engines.find(engine => engine.appType === 'grok');
  const grokMetric = report.metrics.find(metric => metric.command === 'grok');

  expect(claude).toMatchObject({
    found: true,
    path: path.join(tempDir, 'claude'),
    version: 'claude-test 1.0.0',
  });
  expect(claude?.checking).toBeUndefined();
  expect(grok).toMatchObject({
    found: true,
    version: null,
  });
  expect(grokMetric).toMatchObject({
    command: 'grok',
    found: true,
    timedOut: true,
  });
});

test('detects Codex local auth from auth.json', () => {
  const configDir = path.join(tempDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  const primaryConfigPath = path.join(configDir, 'config.toml');
  const authPath = path.join(configDir, 'auth.json');
  fs.writeFileSync(primaryConfigPath, 'model_provider = "openai"\nmodel = "gpt-5.5"\n', 'utf8');
  fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: 'sk-local-codex' }), 'utf8');

  const result = summarizeCliAuthStatus('codex', {
    configDir,
    primaryConfigPath,
    secondaryConfigPaths: [authPath],
    configExists: true,
    currentProviderId: 'openai',
    currentProviderName: 'openai',
    providerCount: 1,
  });

  expect(result).toMatchObject({
    authStatus: 'logged_in',
    authMessage: 'file',
  });
});

test('does not treat WeSight placeholders as local CLI credentials', () => {
  const configDir = path.join(tempDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  const primaryConfigPath = path.join(configDir, 'settings.json');
  fs.writeFileSync(primaryConfigPath, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: '${WESIGHT_APIKEY_ACTIVE_PROVIDER}',
    },
  }), 'utf8');

  const result = summarizeCliAuthStatus('claude', {
    configDir,
    primaryConfigPath,
    secondaryConfigPaths: [],
    configExists: true,
    currentProviderId: null,
    currentProviderName: null,
    providerCount: 0,
  });

  expect(result.authStatus).toBe('logged_out');
});
