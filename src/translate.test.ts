import { describe, it, expect } from 'vitest';
import {
  flattenMessages,
  buildAnonRequest,
  buildOpenAIChunk,
  buildFinalChunk,
  buildUsageChunk,
  buildOpenAICompletion,
  countRoughTokens,
  genID,
  wantsStreamUsage,
  extractMessageText,
  lastUserMessageText,
} from './translate';
import type { OpenAIMessage } from './types';

describe('lastUserMessageText', () => {
  it('extracts the text of the final user message', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'another answer' },
    ];
    expect(lastUserMessageText(messages)).toBe('second question');
  });

  it('joins multimodal text parts of the final user message', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'older' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe ' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
          { type: 'text', text: 'this image' },
        ] as any,
      },
    ];
    expect(lastUserMessageText(messages)).toBe('describe this image');
  });

  it('returns empty string when there is no user message', () => {
    expect(lastUserMessageText([{ role: 'system', content: 'sys' }])).toBe('');
    expect(lastUserMessageText([{ role: 'assistant', content: 'hi' }])).toBe('');
    expect(lastUserMessageText([])).toBe('');
  });
});

describe('extractMessageText', () => {
  it('extracts text from string content', () => {
    expect(extractMessageText('hello world')).toBe('hello world');
  });

  it('extracts text from content part array and ignores non-text', () => {
    const parts = [
      { type: 'text', text: 'hello ' },
      { type: 'image_url', text: 'ignored' },
      { type: 'text', text: 'world' },
    ];
    expect(extractMessageText(parts)).toBe('hello world');
  });

  it('handles empty or malformed inputs', () => {
    expect(extractMessageText('')).toBe('');
    expect(extractMessageText([])).toBe('');
    expect(extractMessageText(undefined as any)).toBe('');
  });
});

describe('flattenMessages', () => {
  it('passes single user message through verbatim', () => {
    const messages: OpenAIMessage[] = [{ role: 'user', content: 'just chat' }];
    expect(flattenMessages(messages)).toBe('just chat');
  });

  it('formats multi-turn conversation with role labels and ignores non-text parts', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'Hi!' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'continue' },
          { type: 'image_url', text: 'should not appear' },
        ],
      },
    ];

    const result = flattenMessages(messages);
    const expected =
      'System:\nYou are terse.\n\nUser:\nhello there\n\nAssistant:\nHi!\n\nUser:\ncontinue';
    expect(result).toBe(expected);
    expect(result).not.toContain('image_url');
    expect(result).not.toContain('should not appear');
  });

  it('labels lone system or assistant messages', () => {
    expect(flattenMessages([{ role: 'system', content: 'Act as Linux terminal' }])).toBe(
      'System:\nAct as Linux terminal'
    );
    expect(flattenMessages([{ role: 'assistant', content: 'Previous reply' }])).toBe(
      'Assistant:\nPrevious reply'
    );
  });

  it('skips empty messages', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: '' },
      { role: 'user', content: 'hello' },
    ];
    expect(flattenMessages(messages)).toBe('User:\nhello');
    expect(flattenMessages([])).toBe('');
  });
});

describe('buildAnonRequest', () => {
  it('constructs correct upstream payload', () => {
    const prompt = 'Tell me a joke';
    const req = buildAnonRequest('gpt-4o', prompt);

    expect(req.action).toBe('next');
    expect(req.parentMessageId).toBeNull();
    expect(req.conversationId).toBeNull();
    expect(req.model).toBe('gpt-4o');
    expect(req.forceUseSearch).toBe(true);
    expect(req.historyAndTrainingDisabled).toBe(false);
    expect(req.conversationMode).toEqual({ kind: 'primary_assistant' });
    expect(req.forceUseSse).toBe(true);
    expect(req.supportedEncodings).toEqual(['text/plain']);
    expect(req.timezone).toBe('UTC');
    expect(req.timezoneOffsetMin).toBe(0);
    expect(req.noAuthAdPreferences).toBe(true);

    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]).toEqual({
      author: { role: 'user' },
      content: {
        content_type: 'text',
        parts: [prompt],
      },
    });
  });

  it('falls back to auto for empty model', () => {
    expect(buildAnonRequest('', 'hi').model).toBe('auto');
  });

  it('defaults forceUseSearch to true and honors search=false', () => {
    expect(buildAnonRequest('auto', 'hi').forceUseSearch).toBe(true);
    expect(buildAnonRequest('auto', 'hi', { search: true }).forceUseSearch).toBe(true);
    expect(buildAnonRequest('auto', 'hi', { search: false }).forceUseSearch).toBe(false);
  });

  it('omits optional upstream passthrough fields when not provided', () => {
    const req = buildAnonRequest('auto', 'hi');
    for (const key of [
      'thinkingEffort',
      'serviceTier',
      'oneOffModelOverride',
      'systemHints',
      'localFunctionNames',
      'mapSearchParams',
    ]) {
      expect(req).not.toHaveProperty(key);
    }
  });

  it('includes provided optional upstream passthrough fields verbatim', () => {
    const req = buildAnonRequest('auto', 'hi', {
      thinkingEffort: 'high',
      serviceTier: 'priority',
      oneOffModelOverride: 'gpt-5-6',
      systemHints: ['cfg-tool-1'],
      localFunctionNames: ['search'],
      mapSearchParams: { latitude: 13.75, longitude: 100.5, latitudeSpan: 0.01, longitudeSpan: 0.01 },
    });
    expect(req.thinkingEffort).toBe('high');
    expect(req.serviceTier).toBe('priority');
    expect(req.oneOffModelOverride).toBe('gpt-5-6');
    expect(req.systemHints).toEqual(['cfg-tool-1']);
    expect(req.localFunctionNames).toEqual(['search']);
    expect(req.mapSearchParams).toEqual({
      latitude: 13.75,
      longitude: 100.5,
      latitudeSpan: 0.01,
      longitudeSpan: 0.01,
    });
  });

  it('ignores blank scalars and empty arrays for passthrough fields', () => {
    const req = buildAnonRequest('auto', 'hi', {
      thinkingEffort: '   ',
      serviceTier: '',
      oneOffModelOverride: '',
      systemHints: [],
      localFunctionNames: [],
    });
    expect(req).not.toHaveProperty('thinkingEffort');
    expect(req).not.toHaveProperty('serviceTier');
    expect(req).not.toHaveProperty('oneOffModelOverride');
    expect(req).not.toHaveProperty('systemHints');
    expect(req).not.toHaveProperty('localFunctionNames');
  });
});

describe('buildOpenAIChunk', () => {
  it('builds standard streaming chunk with delta and finish_reason', () => {
    const chunk1 = buildOpenAIChunk('chatcmpl-123', 1234567890, 'auto', { role: 'assistant' });
    expect(chunk1.id).toBe('chatcmpl-123');
    expect(chunk1.object).toBe('chat.completion.chunk');
    expect(chunk1.created).toBe(1234567890);
    expect(chunk1.model).toBe('auto');
    expect(chunk1.choices).toHaveLength(1);
    expect(chunk1.choices[0].delta).toEqual({ role: 'assistant' });
    expect(chunk1.choices[0].finish_reason).toBeNull();

    const chunk2 = buildOpenAIChunk(
      'chatcmpl-123',
      1234567890,
      'auto',
      { content: 'Hello' },
      'stop'
    );
    expect(chunk2.choices[0].delta).toEqual({ content: 'Hello' });
    expect(chunk2.choices[0].finish_reason).toBe('stop');
  });
});

describe('buildFinalChunk', () => {
  it('builds final chunk with finish_reason: "stop" and usage when provided', () => {
    const chunk = buildFinalChunk('chatcmpl-test', 1234567890, 'auto', 15, 25);
    expect(chunk.id).toBe('chatcmpl-test');
    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.choices).toHaveLength(1);
    expect(chunk.choices[0].delta).toEqual({});
    expect(chunk.choices[0].finish_reason).toBe('stop');
    expect(chunk.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 25,
      total_tokens: 40,
    });
  });

  it('omits usage when promptTokens and completionTokens are 0 or omitted', () => {
    const chunkZero = buildFinalChunk('chatcmpl-zero', 1234567890, 'auto', 0, 0);
    expect(chunkZero.usage).toBeUndefined();

    const chunkOmitted = buildFinalChunk('chatcmpl-omitted', 1234567890, 'auto');
    expect(chunkOmitted.usage).toBeUndefined();
  });
});

describe('buildUsageChunk', () => {
  it('builds stream usage chunk with choices: [] and usage metrics', () => {
    const chunk = buildUsageChunk('chatcmpl-stream', 1234567890, 'auto', 10, 20);
    expect(chunk.id).toBe('chatcmpl-stream');
    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.choices).toEqual([]);
    expect(chunk.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
  });
});

describe('buildOpenAICompletion', () => {
  it('builds standard non-streaming completion response', () => {
    const resp = buildOpenAICompletion(
      'chatcmpl-comp',
      1234567890,
      'auto',
      'Hello there!',
      10,
      20
    );
    expect(resp.id).toBe('chatcmpl-comp');
    expect(resp.object).toBe('chat.completion');
    expect(resp.created).toBe(1234567890);
    expect(resp.model).toBe('auto');
    expect(resp.choices).toHaveLength(1);
    expect(resp.choices[0].index).toBe(0);
    expect(resp.choices[0].message).toEqual({
      role: 'assistant',
      content: 'Hello there!',
    });
    expect(resp.choices[0].finish_reason).toBe('stop');
    expect(resp.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
  });
});

describe('countRoughTokens', () => {
  it('estimates tokens as floor(chars / 4)', () => {
    expect(countRoughTokens('')).toBe(0);
    expect(countRoughTokens('hi')).toBe(0);
    expect(countRoughTokens('1234')).toBe(1);
    expect(countRoughTokens('12345678')).toBe(2);
    expect(countRoughTokens('a'.repeat(100))).toBe(25);
  });

  it('accurately estimates CJK characters at ~1.5 tokens per character', () => {
    // 11 Chinese characters -> Math.ceil(11 * 1.5) = 17 tokens
    expect(countRoughTokens('这是一个用于测试的句子')).toBe(17);
  });
});

describe('genID', () => {
  it('generates ID with specified prefix and hex randomness', () => {
    const id1 = genID('chatcmpl-');
    const id2 = genID('chatcmpl-');
    expect(id1.startsWith('chatcmpl-')).toBe(true);
    expect(id2.startsWith('chatcmpl-')).toBe(true);
    expect(id1).not.toBe(id2);
    expect(id1.length).toBe('chatcmpl-'.length + 24);

    const msgId = genID('msg-');
    expect(msgId.startsWith('msg-')).toBe(true);
  });
});

describe('wantsStreamUsage', () => {
  it('detects include_usage in request object or JSON', () => {
    expect(wantsStreamUsage({ model: 'auto', messages: [], stream_options: { include_usage: true } })).toBe(true);
    expect(wantsStreamUsage({ model: 'auto', messages: [], stream_options: { include_usage: false } })).toBe(false);
    expect(wantsStreamUsage({ model: 'auto', messages: [] })).toBe(false);
    expect(wantsStreamUsage(null)).toBe(false);
    expect(wantsStreamUsage(undefined)).toBe(false);
    expect(wantsStreamUsage('{"stream_options":{"include_usage":true}}')).toBe(true);
    expect(wantsStreamUsage('{"stream_options":{"include_usage":false}}')).toBe(false);
    expect(wantsStreamUsage('invalid json')).toBe(false);
  });
});
