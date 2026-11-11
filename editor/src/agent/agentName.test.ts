import { describe, expect, it } from 'vitest';
import { modelShortName } from './agentName';

describe('modelShortName', () => {
  it('uses the family from a display name', () => {
    expect(modelShortName('Claude Haiku 4.5')).toBe('Claude');
    expect(modelShortName('GPT-5 Codex')).toBe('GPT');
    expect(modelShortName('Gemini 2.5 Pro')).toBe('Gemini');
    expect(modelShortName('DeepSeek V3')).toBe('DeepSeek');
  });

  it('uses the family from a model id or selector', () => {
    expect(modelShortName('anthropic/claude-haiku-4-5')).toBe('Claude');
    expect(modelShortName('claude-fable-5-1')).toBe('Claude');
    expect(modelShortName('openai/gpt-5')).toBe('GPT');
    expect(modelShortName('google/gemini-2.5-pro')).toBe('Gemini');
    expect(modelShortName('o3-mini')).toBe('o3');
  });

  it('is empty when no model is known', () => {
    expect(modelShortName('')).toBe('');
  });
});
