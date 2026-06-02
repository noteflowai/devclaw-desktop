import { expect, test } from 'vitest';
import { formatApiFetchLogPayload, sanitizeApiFetchLogValue } from './apiFetchLogSanitizer';

test('sanitizeApiFetchLogValue redacts authorization headers', () => {
  expect(sanitizeApiFetchLogValue({
    Authorization: 'Bearer sk-secret-value-1234567890',
    accept: 'application/json',
  })).toEqual({
    Authorization: '[REDACTED]',
    accept: 'application/json',
  });
});

test('formatApiFetchLogPayload redacts secrets inside JSON request bodies', () => {
  const payload = formatApiFetchLogPayload(JSON.stringify({
    model: 'gpt-5.5',
    apiKey: 'sk-test-secret-1234567890',
    nested: {
      access_token: 'token-secret-1234567890',
    },
  }));

  expect(payload).toContain('"apiKey":"[REDACTED]"');
  expect(payload).toContain('"access_token":"[REDACTED]"');
  expect(payload).not.toContain('sk-test-secret');
  expect(payload).not.toContain('token-secret');
});

test('formatApiFetchLogPayload truncates large response bodies', () => {
  const payload = formatApiFetchLogPayload({ text: 'x'.repeat(1200) }, 80);

  expect(payload).toContain('[truncated]');
  expect(payload.length).toBeLessThan(120);
});
