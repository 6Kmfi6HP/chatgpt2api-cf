import { describe, it, expect } from 'vitest';
import {
  MAX_STOP_SEQUENCES,
  SamplingLimiter,
  resolveSampling,
  responseShapeParamError,
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

  // Guards [audit:surrogate-split-on-token-cap]: the longest fitting prefix can
  // end between the two UTF-16 code units of an astral character (emoji). A
  // lone high surrogate survives JSON serialisation as `\ud83d` but breaks any
  // strict UTF-8 consumer of the decoded string, so the cut must back off to
  // the pair boundary instead of emitting half a character.
  it('never cuts inside a surrogate pair', () => {
    const text = '😀'.repeat(4); // 8 code units, 4 code points
    const len = tokenBudgetPrefixLength(text, 1);
    expect(len).toBeLessThan(text.length);
    expect(countRoughTokens(text.slice(0, len))).toBeLessThanOrEqual(1);
    expect(/[\uD800-\uDBFF]$/.test(text.slice(0, len))).toBe(false);
    expect([...text.slice(0, len)].every((ch) => ch.length === 2 || ch.codePointAt(0)! < 0xd800)).toBe(
      true
    );
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

  it('cuts at the cap even when a stop sequence occurs after the cap position', () => {
    // max_tokens 1 admits 7 ASCII chars (floor(7/4)=1); the stop at offset
    // 100 must not rescue the 93 chars the budget already disallowed.
    const limiter = new SamplingLimiter({ stops: ['X'], maxTokens: 1 });
    expect(limiter.limit('a'.repeat(100) + 'X tail')).toBe('a'.repeat(7));
    expect(limiter.limitFinish()).toBe('length');
  });

  it('counts a stop and cap meeting at the same position as a stop', () => {
    const limiter = new SamplingLimiter({ stops: ['X'], maxTokens: 3 });
    expect(limiter.limit('a'.repeat(15) + 'X rest')).toBe('a'.repeat(15));
    expect(limiter.limitFinish()).toBe('stop');
  });

  it('reset() forgets a latched cut for the next live message', () => {
    const limiter = new SamplingLimiter({ stops: [], maxTokens: 3 });
    expect(limiter.limit('a'.repeat(100))).toBe('a'.repeat(15));
    expect(limiter.limitFinish()).toBe('length');
    limiter.reset();
    expect(limiter.limitFinish()).toBeNull();
    expect(limiter.limit('short text')).toBe('short text');
  });

  it('latchFinish() adopts a finish reason without latching a cut', () => {
    const limiter = new SamplingLimiter({ stops: [], maxTokens: null });
    limiter.latchFinish('length');
    expect(limiter.limitFinish()).toBe('length');
    // No cut was latched: the text passes through untouched.
    expect(limiter.limit('already truncated')).toBe('already truncated');
  });

  // Guards [audit:surrogate-split-on-token-cap] on the class the stream and
  // non-stream paths share: the latched cut must land on a code-point boundary
  // so neither the live snapshots nor the aggregated body carry half an emoji.
  it('latches a cap cut that does not split an emoji', () => {
    const limiter = new SamplingLimiter({ stops: [], maxTokens: 1 });
    const out = limiter.limit('😀 😀 😀 😀');
    expect(limiter.limitFinish()).toBe('length');
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(out).not.toMatch(/^[\uDC00-\uDFFF]/);
    expect(countRoughTokens(out)).toBeLessThanOrEqual(1);
    // Upstream keeps re-sending longer snapshots: the same cut still applies.
    expect(limiter.limit('😀 😀 😀 😀 and more')).toBe(out);
  });
});

// Guards [audit:silent-unsupported-params]: `n` and `logprobs` are rejected
// rather than silently dropped. They are structurally different from the
// "accepted but ignored" sampling knobs — a client that asks for 3 choices
// parses choices[0..2] and a client that asks for logprobs reads
// choices[0].logprobs.content; answering one plain choice breaks both at parse
// time instead of degrading the text.
describe('responseShapeParamError', () => {
  it('accepts a request without n or logprobs', () => {
    expect(responseShapeParamError(req({}))).toBeNull();
    expect(responseShapeParamError(undefined)).toBeNull();
  });

  it('accepts n equal to 1 and an explicit logprobs:false', () => {
    expect(responseShapeParamError(req({ n: 1 }))).toBeNull();
    expect(responseShapeParamError(req({ logprobs: false }))).toBeNull();
    expect(responseShapeParamError(req({ logprobs: false, top_logprobs: 2 }))).toBeNull();
  });

  it('rejects n greater than 1 as an unsupported parameter', () => {
    for (const value of [2, 3, 100]) {
      const err = responseShapeParamError(req({ n: value }));
      expect(err?.param).toBe('n');
      expect(err?.code).toBe('unsupported_parameter');
    }
  });

  it('rejects an illegal n as an invalid parameter, not as unsupported', () => {
    for (const value of [0, -1, 1.5, '2', true]) {
      const err = responseShapeParamError(req({ n: value }));
      expect(err?.param).toBe('n');
      expect(err?.code).toBeUndefined();
      expect(err?.message).toContain('positive integer');
    }
  });

  it('rejects logprobs:true as unsupported and a non-boolean logprobs as invalid', () => {
    expect(responseShapeParamError(req({ logprobs: true }))?.code).toBe('unsupported_parameter');
    expect(responseShapeParamError(req({ logprobs: 'yes' }))?.message).toContain('boolean');
  });

  it('rejects top_logprobs sent without logprobs:false', () => {
    const err = responseShapeParamError(req({ top_logprobs: 2 }));
    expect(err?.param).toBe('top_logprobs');
    expect(responseShapeParamError(req({ logprobs: true, top_logprobs: 2 }))?.param).toBe(
      'logprobs'
    );
  });
});

// Guards [audit:response-format-ignored]: `response_format` / `modalities` /
// `audio` change the SHAPE of the reply (a JSON document, an audio payload),
// not its wording. The anonymous upstream has no JSON mode and returns text
// only, so a 200 answer sends structured-output clients a string their
// JSON.parse rejects — the failure lands in the client, while the gateway log
// says 200. Rejected with 400 instead, matching n/logprobs above.
describe('responseShapeParamError — response_format / modalities / audio', () => {
  it('accepts an absent response_format and the explicit type "text"', () => {
    expect(responseShapeParamError(req({}))).toBeNull();
    expect(responseShapeParamError(req({ response_format: { type: 'text' } }))).toBeNull();
  });

  it('rejects json_object and json_schema as unsupported', () => {
    for (const format of [
      { type: 'json_object' },
      { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } },
    ]) {
      const err = responseShapeParamError(req({ response_format: format }));
      expect(err?.param).toBe('response_format');
      expect(err?.code).toBe('unsupported_parameter');
    }
  });

  it('rejects a malformed response_format as invalid, not as unsupported', () => {
    for (const value of ['json', 7, [], {}, { type: 'nonsense' }, { type: 5 }]) {
      const err = responseShapeParamError(req({ response_format: value }));
      expect(err?.param).toBe('response_format');
      expect(err?.code).toBeUndefined();
      expect(err?.message).toContain('response_format');
    }
  });

  it('accepts modalities ["text"] and rejects any list containing "audio"', () => {
    expect(responseShapeParamError(req({ modalities: ['text'] }))).toBeNull();
    for (const modalities of [['text', 'audio'], ['audio']]) {
      const err = responseShapeParamError(req({ modalities }));
      expect(err?.param).toBe('modalities');
      expect(err?.code).toBe('unsupported_parameter');
    }
  });

  it('rejects a malformed modalities list as invalid', () => {
    for (const value of ['text', [7], [], {}]) {
      const err = responseShapeParamError(req({ modalities: value }));
      expect(err?.param).toBe('modalities');
      expect(err?.code).toBeUndefined();
    }
  });

  it('rejects any audio request as unsupported and a malformed one as invalid', () => {
    const unsupported = responseShapeParamError(req({ audio: { voice: 'alloy', format: 'wav' } }));
    expect(unsupported?.param).toBe('audio');
    expect(unsupported?.code).toBe('unsupported_parameter');

    for (const value of ['wav', 7]) {
      const err = responseShapeParamError(req({ audio: value }));
      expect(err?.param).toBe('audio');
      expect(err?.code).toBeUndefined();
    }
  });
});
