import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeToolDefinitions,
  buildAnonRequestBodyWithTools,
  isToolCallResponseText,
  buildToolCallsChatMessage,
  extractToolNameFromUpstreamMessage,
} from './toolcall_wire';
import type { WireToolCallRequest } from './toolcall_wire';
import { buildAnonRequest } from './translate';
import { TOOL_CALL_REPLY_FORMAT } from './toolcall';

// buildAnonRequest is the network-facing boundary (it only builds the DTO, but
// we still mock it where the test must not depend on its internals).
vi.mock('./translate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./translate')>();
  return { ...actual, buildAnonRequest: vi.fn(actual.buildAnonRequest) };
});

function baseReq(partial: Partial<WireToolCallRequest>): WireToolCallRequest {
  return { model: 'gpt-5.6', messages: [{ role: 'user', content: 'hi' }], ...partial };
}

describe('normalizeToolDefinitions', () => {
  it('passes the standard OpenAI form through', () => {
    const req = baseReq({
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
        },
      ],
    });
    expect(normalizeToolDefinitions(req)).toEqual([
      {
        type: 'function',
        function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
      },
    ]);
  });

  it('normalizes the shorthand top-level form', () => {
    const req = baseReq({
      tools: [{ type: 'function', name: 'calc', description: 'Do math', parameters: { type: 'object' } }],
    });
    expect(normalizeToolDefinitions(req)).toEqual([
      {
        type: 'function',
        function: { name: 'calc', description: 'Do math', parameters: { type: 'object' } },
      },
    ]);
  });

  it('handles a mixed array and drops unnamed entries', () => {
    const req = baseReq({
      tools: [
        { type: 'function', function: { name: 'a' } },
        { type: 'function', name: 'b' },
        { type: 'function', function: { name: '', description: 'no name' } },
        { type: 'function', function: { description: 'also no name' } },
        null,
        'nope',
      ] as any,
    });
    expect(normalizeToolDefinitions(req)).toEqual([
      { type: 'function', function: { name: 'a' } },
      { type: 'function', function: { name: 'b' } },
    ]);
  });

  it('returns [] for missing/empty tools', () => {
    expect(normalizeToolDefinitions(baseReq({}))).toEqual([]);
    expect(normalizeToolDefinitions(baseReq({ tools: [] }))).toEqual([]);
    expect(normalizeToolDefinitions({} as WireToolCallRequest)).toEqual([]);
  });
});

describe('buildAnonRequestBodyWithTools', () => {
  beforeEach(() => {
    vi.mocked(buildAnonRequest).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts the tool protocol system message at messages[0] and names the tools', () => {
    const req = baseReq({
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
        },
      ],
    });
    const dto = buildAnonRequestBodyWithTools(req, { prompt: 'placeholder' });

    const first = dto.messages[0];
    expect(first.author.role).toBe('system');
    expect(first.content.content_type).toBe('text');
    const proto = first.content.parts.join('\n');
    expect(proto).toContain('get_weather');
    expect(proto).toContain(TOOL_CALL_REPLY_FORMAT);
    // The user message follows the protocol message.
    expect(dto.messages[1].author.role).toBe('user');
    expect(dto.messages[1].content.parts).toEqual(['weather in Paris?']);
  });

  it('preserves caller system messages after the protocol message', () => {
    const req = baseReq({
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', name: 'calc' }],
    });
    const dto = buildAnonRequestBodyWithTools(req, { prompt: 'p' });

    expect(dto.messages.map((m: any) => m.author.role)).toEqual(['system', 'system', 'user']);
    expect(dto.messages[0].content.parts.join('')).toContain('Tool call rules');
    expect(dto.messages[1].content.parts).toEqual(['You are terse.']);
  });

  it('maps tool result messages with author.name, and assistant tool_calls frames', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'weather in Paris?' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
        },
        { role: 'tool', name: 'get_weather', content: '18C sunny' },
        { role: 'tool', tool_call_id: 'call_get_weather', content: '19C clear' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
    const dto = buildAnonRequestBodyWithTools(req, { prompt: 'p' });

    const [, assistant, toolNamed, toolViaId] = dto.messages.slice(1);
    expect(assistant.author.role).toBe('assistant');
    expect(JSON.parse(assistant.content.parts[0])).toEqual({
      tool_calls: [{ name: 'get_weather', arguments: { city: 'Paris' } }],
    });
    expect(toolNamed.author.role).toBe('tool');
    expect(toolNamed.author.name).toBe('get_weather');
    expect(toolNamed.content.parts).toEqual(['18C sunny']);
    expect(toolViaId.author.role).toBe('tool');
    expect(toolViaId.author.name).toBe('get_weather');
  });

  it('merges messageContent into the last user message', () => {
    const multimodal = {
      content_type: 'text',
      parts: [
        { content_type: 'text', text: 'What is in this image?' },
        { content_type: 'image_asset_pointer', asset_pointer: 'file-service://x', size_width: 100, size_height: 100 },
      ],
    };
    const req = baseReq({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'What is in this image?' },
        { role: 'assistant', content: 'An image, surely.' },
        { role: 'user', content: 'and this one?' },
      ],
      tools: [{ type: 'function', name: 'describe_image' }],
    });
    const dto = buildAnonRequestBodyWithTools(req, { prompt: 'p', messageContent: multimodal });

    const users = dto.messages.filter((m: any) => m.author.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[0].content).toEqual({ content_type: 'text', parts: ['What is in this image?'] });
    expect(users[1].content).toEqual(multimodal);
    // Other frames untouched.
    expect(dto.messages[0].author.role).toBe('system'); // tool protocol
    expect(dto.messages[1].content.parts).toEqual(['sys']);
    expect(dto.messages[3].content.parts).toEqual(['An image, surely.']);
  });

  it('falls back to the placeholder user message when no caller messages exist', () => {
    const multimodal = { content_type: 'text', parts: [{ content_type: 'text', text: 'look' }] };
    const req = baseReq({ messages: [], tools: [{ type: 'function', name: 'describe_image' }] });
    const dto = buildAnonRequestBodyWithTools(req, { prompt: 'look', messageContent: multimodal });
    expect(dto.messages).toHaveLength(2); // protocol + user placeholder
    expect(dto.messages[1].author.role).toBe('user');
    expect(dto.messages[1].content).toEqual(multimodal);
  });

  it('does not insert a system message when there are no tools', () => {
    const req = baseReq({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    });
    const dto = buildAnonRequestBodyWithTools(req, { prompt: 'p' });
    expect(dto.messages.map((m: any) => m.author.role)).toEqual(['system', 'user']);
    expect(dto.messages[0].content.parts).toEqual(['sys']);
  });

  it('keeps the rest of the DTO identical to buildAnonRequest', () => {
    const req = baseReq({
      search: false,
      reasoning_effort: 'high',
      service_tier: 'priority',
      one_off_model_override: 'gpt-5.6-sol',
      system_hints: ['search_hints'],
      local_function_names: ['search'],
      map_search_params: { latitude: 48.85, longitude: 2.35 },
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });
    const dto = buildAnonRequestBodyWithTools(req, { prompt: 'p', attachmentMimeTypes: ['image/png'] });
    const reference = buildAnonRequest('gpt-5.6', 'p', {
      search: false,
      thinkingEffort: 'high',
      serviceTier: 'priority',
      oneOffModelOverride: 'gpt-5.6-sol',
      systemHints: ['search_hints'],
      localFunctionNames: ['search'],
      mapSearchParams: { latitude: 48.85, longitude: 2.35 },
      attachmentMimeTypes: ['image/png'],
    });

    for (const key of Object.keys(reference)) {
      if (key === 'messages') continue;
      expect(dto[key]).toEqual(reference[key]);
    }
    expect(dto.forceUseSearch).toBe(false);
    expect(dto.thinkingEffort).toBe('high');
    expect(dto.attachmentMimeTypes).toEqual(['image/png']);
  });

  it('passes through opts to buildAnonRequest and overrides the prompt placeholder with messages', () => {
    const req = baseReq({ messages: [{ role: 'user', content: 'real question' }] });
    const dto = buildAnonRequestBodyWithTools(req, { prompt: 'PLACEHOLDER' });

    expect(vi.mocked(buildAnonRequest)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(buildAnonRequest).mock.calls[0];
    expect(call[0]).toBe('gpt-5.6');
    expect(call[1]).toBe('PLACEHOLDER'); // placeholder only; messages override it below
    expect(call[2]?.messageContent).toBeUndefined();
    expect(dto.messages).toHaveLength(1);
    expect(dto.messages[0].content.parts).toEqual(['real question']);
  });
});

describe('isToolCallResponseText', () => {
  it('detects the single-line JSON convention', () => {
    expect(isToolCallResponseText('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}')).toBe(true);
    expect(isToolCallResponseText('  {"tool_calls":[{"name":"x","arguments":{}}]}  ')).toBe(true);
  });

  it('rejects prose and malformed payloads', () => {
    expect(isToolCallResponseText('The weather in Paris is 18C.')).toBe(false);
    expect(isToolCallResponseText('{"tool_calls":[]}')).toBe(false);
    expect(isToolCallResponseText('')).toBe(false);
  });
});

describe('buildToolCallsChatMessage', () => {
  it('converts a tool-call reply into an OpenAI assistant message', () => {
    const msg = buildToolCallsChatMessage('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}');
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('assistant');
    expect(msg!.content).toBeNull();
    expect(msg!.tool_calls).toHaveLength(1);
    const tc = msg!.tool_calls[0];
    expect(tc.type).toBe('function');
    expect(tc.function.name).toBe('get_weather');
    expect(JSON.parse(tc.function.arguments)).toEqual({ city: 'Paris' });
    expect(tc.id).toMatch(/^call_[A-Za-z0-9]{22}$/);
  });

  it('supports multiple tool calls', () => {
    const msg = buildToolCallsChatMessage(
      '{"tool_calls":[{"name":"a","arguments":{}},{"name":"b","arguments":{"x":1}}]}'
    );
    expect(msg!.tool_calls.map((t) => t.function.name)).toEqual(['a', 'b']);
    expect(new Set(msg!.tool_calls.map((t) => t.id)).size).toBe(2);
  });

  it('returns null for plain text replies', () => {
    expect(buildToolCallsChatMessage('Just a normal answer.')).toBeNull();
    expect(buildToolCallsChatMessage('{"nope":true}')).toBeNull();
    expect(buildToolCallsChatMessage('')).toBeNull();
  });
});

describe('extractToolNameFromUpstreamMessage', () => {
  it('reads author.name on role=tool frames', () => {
    expect(extractToolNameFromUpstreamMessage({ author: { role: 'tool', name: 'get_weather' } })).toBe('get_weather');
  });

  it('returns null for other roles, missing name, and junk input', () => {
    expect(extractToolNameFromUpstreamMessage({ author: { role: 'tool' } })).toBeNull();
    expect(extractToolNameFromUpstreamMessage({ author: { role: 'user', name: 'x' } })).toBeNull();
    expect(extractToolNameFromUpstreamMessage({ author: { role: 'tool', name: '' } })).toBeNull();
    expect(extractToolNameFromUpstreamMessage(null)).toBeNull();
    expect(extractToolNameFromUpstreamMessage(undefined)).toBeNull();
    expect(extractToolNameFromUpstreamMessage({})).toBeNull();
    expect(extractToolNameFromUpstreamMessage({ author: 'not-an-object' })).toBeNull();
  });
});
