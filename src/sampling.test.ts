import { describe, it, expect } from 'vitest';
import {
  MAX_STOP_SEQUENCES,
  SamplingLimiter,
  resolveSampling,
  samplingParamError,
  stopPrefixSuffix,
  tokenBudgetPrefixLength,
} from './sampling';
import { countRoughTokens } from './translate';
import type { ChatCompletionRequest } from './types';

function req(extra: Record<string, unknown>): ChatCompletionRequest {
  return { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], ...extra };
}

describe('samplingParamError', () => {
  it('accepts a request without sampling parameters', () => {
    expect(samplingParamError(req({}))).toBeNull();
  });

  it('accepts a string stop and a string-array stop', () => {
    expect(samplingParamError(req({ stop: 'STOP' }))).toBeNull();
    expect(samplingParamError(req({ stop: ['a', 'b'] }))).toBeNull();
  });

  it('rejects non-positive, fractional and non-numeric max_tokens', () => {
    for (const value of [0, -1, 1.5, '10', true]) {
      const err = samplingParamError(req({ max_tokens: value }));
      expect(err?.param).toBe('max_tokens');
    }
  });

  it('rejects an invalid max_completion_tokens and names that param', () => {
    const err = samplingParamError(req({ max_completion_tokens: 0 }));
    expect(err?.param).toBe('max_completion_tokens');
    expect(err?.message).toContain('positive integer');
  });

  it('rejects a stop that is neither a string nor a string array', () => {
    expect(samplingParamError(req({ stop: 123 }))?.param).toBe('stop');
    expect(samplingParamError(req({ stop: ['ok', 7] }))?.param).toBe('stop');
  });

  it(`rejects more than ${MAX_STOP_SEQUENCES} stop sequences`, () => {
    expect(samplingParamError(req({ stop: ['a', 'b', 'c', 'd', 'e'] }))?.param).toBe('stop');
  });
});

describe('resolveSampling', () => {
  it('returns no limits for a bare request', () => {
    expect(resolveSampling(req({}))).toEqual({ stops: [], maxTokens: null });
    expect(resolveSampling(undefined)).toEqual({ stops: [], maxTokens: null });
  });

  it('normalises a single stop string into a list and drops empty strings', () => {
    expect(resolveSampling(req({ stop: 'END' })).stops).toEqual(['END']);
    expect(resolveSampling(req({ stop: ['END', ''] })).stops).toEqual(['END']);
  });

  it('prefers max_completion_tokens over max_tokens', () => {
    expect(resolveSampling(req({ max_tokens: 10, max_completion_tokens: 3 })).maxTokens).toBe(3);
    expect(resolveSampling(req({ max_tokens: 10 })).maxTokens).toBe(10);
  });

  it('ignores values that failed validation', () => {
    expect(resolveSampling(req({ max_tokens: 0 })).maxTokens).toBeNull();
    expect(resolveSampling(req({ max_tokens: '4' })).maxTokens).toBeNull();
  });
});

describe('stopPrefixSuffix', () => {
  it('returns the longest suffix that could still become a stop', () => {
    expect(stopPrefixSuffix('count 1, 2, ST', ['STOP'])).toBe('ST');
    expect(stopPrefixSuffix('count 1, 2, S', ['STOP'])).toBe('S');
    expect(stopPrefixSuffix('count 1, 2, S', ['STOP', 'XYZ'])).toBe('S');
  });

  it('never returns the whole stop sequence', () => {
    // A complete stop ("STOP") is not a *proper* prefix: nothing to hold.
    expect(stopPrefixSuffix('STOP', ['STOP'])).toBe('');
    expect(stopPrefixSuffix('running STO', ['STOP'])).toBe('STO');
  });

  it('returns empty when nothing matches', () => {
    expect(stopPrefixSuffix('plain text', ['STOP'])).toBe('');
    expect(stopPrefixSuffix('', ['STOP'])).toBe('');
    expect(stopPrefixSuffix('STOP', [])).toBe('');
  });
});

describe('tokenBudgetPrefixLength', () => {
  it('keeps ASCII text within the rough token budget', () => {
    const text = 'a'.repeat(100);
    const len = tokenBudgetPrefixLength(text, 5);
    expect(countRoughTokens(text.slice(0, len))).toBeLessThanOrEqual(5);
    expect(countRoughTokens(text.slice(0, len + 1))).toBeGreaterThan(5);
  });

  it('returns the whole text when it already fits', () => {
    expect(tokenBudgetPrefixLength('short', 100)).toBe(5);
  });

  it('accounts for CJK characters costing more than one token each', () => {
    const text = '人工智能'.repeat(10);
    const len = tokenBudgetPrefixLength(text, 6);
    expect(countRoughTokens(text.slice(0, len))).toBeLessThanOrEqual(6);
    expect(len).toBeLessThan(text.length);
  });
});

describe('SamplingLimiter', () => {
  it('cuts at the earliest stop sequence and latches the cut', () => {
    const limiter = new SamplingLimiter({ stops: ['STOP', 'END'], maxTokens: null });
    expect(limiter.limit('a STOP b END c')).toBe('a ');
    expect(limiter.limitFinish()).toBe('stop');
    // Upstream keeps sending longer snapshots after the cut: still sliced.
    expect(limiter.limit('a STOP b END c and more')).toBe('a ');
  });

  it('leaves the text alone while no stop is present', () => {
    const limiter = new SamplingLimiter({ stops: ['STOP'], maxTokens: null });
    expect(limiter.limit('still going')).toBe('still going');
    expect(limiter.limitFinish()).toBeNull();
  });

  it('caps the text at maxTokens and reports length', () => {
    const limiter = new SamplingLimiter({ stops: [], maxTokens: 4 });
    const out = limiter.limit('a'.repeat(200));
    expect(countRoughTokens(out)).toBeLessThanOrEqual(4);
    expect(limiter.limitFinish()).toBe('length');
    expect(limiter.limit('a'.repeat(400))).toBe(out);
  });

  it('reports stop, not length, when a stop fires before the cap', () => {
    const limiter = new SamplingLimiter({ stops: ['X'], maxTokens: 1 });
    expect(limiter.limit('abX' + 'c'.repeat(100))).toBe('ab');
    expect(limiter.limitFinish()).toBe('stop');
  });
});
