import { describe, expect, test } from 'vitest';
import {
  buildAnthropicMessagesUrl,
  buildGeminiGenerateContentUrl,
  buildOpenAIChatCompletionsUrl,
  extractApiErrorSnippet,
  extractTextFromAnthropicResponse,
  extractTextFromGeminiResponse,
  extractTextFromOpenAIChatCompletionResponse,
  normalizeGeminiBaseUrl,
} from './coworkModelApi';

describe('coworkModelApi', () => {
  test('builds anthropic messages url from base url', () => {
    expect(buildAnthropicMessagesUrl('https://example.com/v1')).toBe('https://example.com/v1/messages');
    expect(buildAnthropicMessagesUrl('https://example.com')).toBe('https://example.com/v1/messages');
    expect(buildAnthropicMessagesUrl('https://example.com/v1/messages')).toBe('https://example.com/v1/messages');
  });

  test('builds openai chat completions url from base url', () => {
    expect(buildOpenAIChatCompletionsUrl('https://example.com/v1')).toBe('https://example.com/v1/chat/completions');
    expect(buildOpenAIChatCompletionsUrl('https://example.com')).toBe('https://example.com/v1/chat/completions');
    expect(buildOpenAIChatCompletionsUrl('https://example.com/v1/chat/completions')).toBe(
      'https://example.com/v1/chat/completions'
    );
  });

  test('normalizes gemini base url variants', () => {
    expect(normalizeGeminiBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta'
    );
    expect(normalizeGeminiBaseUrl('https://generativelanguage.googleapis.com/v1')).toBe(
      'https://generativelanguage.googleapis.com/v1beta'
    );
  });

  test('builds gemini generate content url', () => {
    expect(
      buildGeminiGenerateContentUrl(
        'https://generativelanguage.googleapis.com/v1beta/openai',
        'gemini-3-pro-preview'
      )
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent');
  });

  test('extracts api error snippet from json payload', () => {
    expect(
      extractApiErrorSnippet(JSON.stringify({ error: { message: 'Invalid API key' } }))
    ).toBe('Invalid API key');
  });

  test('extracts anthropic text content', () => {
    expect(
      extractTextFromAnthropicResponse({
        content: [{ type: 'text', text: 'Generated title' }],
      })
    ).toBe('Generated title');
  });

  test('extracts gemini text from nested candidates and parts', () => {
    expect(
      extractTextFromGeminiResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Gemini title' },
                { inline_data: { mime_type: 'image/png', data: '...' } },
                { text: 'Second line' },
              ],
            },
          },
        ],
      })
    ).toBe('Gemini title\nSecond line');
  });

  test('extracts openai chat completion assistant content', () => {
    expect(
      extractTextFromOpenAIChatCompletionResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'OK',
              reasoning_content: 'Reasoning should not be treated as final text.',
            },
          },
        ],
      })
    ).toBe('OK');
  });

  test('does not treat openai reasoning content as assistant text', () => {
    expect(
      extractTextFromOpenAIChatCompletionResponse({
        choices: [
          {
            finish_reason: 'length',
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: 'The model only produced reasoning tokens.',
            },
          },
        ],
      })
    ).toBe('');
  });
});
