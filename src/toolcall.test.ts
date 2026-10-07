import { describe, it, expect } from 'vitest';
import {
  buildToolProtocolSystemMessage,
  tryParseToolCall,
  buildUpstreamMessages,
  buildToolResultMessage,
  toOpenAIToolCalls,
  stripGenuiMarkers,
  TOOL_CALL_REPLY_FORMAT,
  type ToolDefinition,
} from './toolcall';

const weatherTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['c', 'f'] } },
      required: ['city'],
    },
  },
};

const searchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
};

describe('buildToolProtocolSystemMessage', () => {
  it('describes tools and the JSON reply convention', () => {
    const msg = buildToolProtocolSystemMessage([weatherTool, searchTool]);
    expect(msg).toContain('get_weather');
    expect(msg).toContain('web_search');
    expect(msg).toContain('"tool_calls"');
    expect(msg).toContain(TOOL_CALL_REPLY_FORMAT);
  });

  it('leaves the wording unchanged for auto and undefined', () => {
    const plain = buildToolProtocolSystemMessage([weatherTool, searchTool]);
    expect(buildToolProtocolSystemMessage([weatherTool, searchTool], 'auto')).toBe(plain);
    expect(buildToolProtocolSystemMessage([weatherTool, searchTool], undefined)).toBe(plain);
    expect(plain).not.toContain('MANDATORY TOOL USE (this request)');
  });

  it('appends the mandatory clause for tool_choice "required"', () => {
    const plain = buildToolProtocolSystemMessage([weatherTool]);
    const msg = buildToolProtocolSystemMessage([weatherTool], 'required');
    expect(msg).toBe(
      `${plain}\n\nMANDATORY TOOL USE (this request):\n` +
        'You MUST reply with a tool call. A plain-text answer is INVALID and will be rejected.'
    );
  });

  it('appends the named-tool clause for a named tool_choice', () => {
    const plain = buildToolProtocolSystemMessage([weatherTool]);
    const msg = buildToolProtocolSystemMessage([weatherTool], {
      type: 'function',
      function: { name: 'get_weather' },
    });
    expect(msg).toBe(
      `${plain}\n\nMANDATORY TOOL USE (this request):\n` +
        'You MUST call the tool "get_weather". No other tool and no plain-text answer is acceptable.'
    );
  });

  it('emits the named directive even when the name is absent from tools', () => {
    const msg = buildToolProtocolSystemMessage([weatherTool], {
      type: 'function',
      function: { name: 'ghost_tool' },
    });
    expect(msg).toContain('You MUST call the tool "ghost_tool".');
  });

  it('keeps the full tool list in both mandatory cases', () => {
    const tools = [weatherTool, searchTool];
    const choices: Array<'required' | { type: 'function'; function: { name: string } }> = [
      'required',
      { type: 'function', function: { name: 'get_weather' } },
    ];
    for (const choice of choices) {
      const msg = buildToolProtocolSystemMessage(tools, choice);
      expect(msg).toContain('- get_weather(');
      expect(msg).toContain('- web_search(');
    }
  });
});

describe('tryParseToolCall', () => {
  it('parses a bare single-line tool call', () => {
    const r = tryParseToolCall('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}');
    expect(r).toEqual([{ name: 'get_weather', arguments: '{"city":"Paris"}' }]);
  });

  it('parses multiple tool calls', () => {
    const r = tryParseToolCall(
      '{"tool_calls":[{"name":"a","arguments":{"x":1}},{"name":"b","arguments":{"y":[2,3]}}]}',
    );
    expect(r).toEqual([
      { name: 'a', arguments: '{"x":1}' },
      { name: 'b', arguments: '{"y":[2,3]}' },
    ]);
  });

  it('parses nested argument objects', () => {
    const r = tryParseToolCall(
      '{"tool_calls":[{"name":"do","arguments":{"opts":{"deep":{"n":1}},"arr":[{"k":"v"}]}}]}',
    );
    expect(r).toEqual([
      { name: 'do', arguments: '{"opts":{"deep":{"n":1}},"arr":[{"k":"v"}]}' },
    ]);
  });

  it('accepts the function.name form', () => {
    const r = tryParseToolCall(
      '{"tool_calls":[{"function":{"name":"get_weather","arguments":"{\\"city\\":\\"Oslo\\"}"}}]}',
    );
    expect(r).toEqual([{ name: 'get_weather', arguments: '{"city":"Oslo"}' }]);
  });

  it('parses inside a ```json fenced block', () => {
    const r = tryParseToolCall(
      '```json\n{"tool_calls":[{"name":"get_weather","arguments":{"city":"Tokyo"}}]}\n```',
    );
    expect(r).toEqual([{ name: 'get_weather', arguments: '{"city":"Tokyo"}' }]);
  });

  it('parses inside a bare ``` fenced block', () => {
    const r = tryParseToolCall(
      '```\n{"tool_calls":[{"name":"f","arguments":{}}]}\n```',
    );
    expect(r).toEqual([{ name: 'f', arguments: '{}' }]);
  });

  it('accepts surrounding whitespace and no arguments', () => {
    expect(tryParseToolCall('\n\n  {"tool_calls":[{"name":"f"}]}  \n')).toEqual([
      { name: 'f', arguments: '{}' },
    ]);
    expect(tryParseToolCall('\t{"tool_calls":[{"name":"f","arguments":""}]} \n')).toEqual([
      { name: 'f', arguments: '{}' },
    ]);
  });

  it('parses string arguments that are valid JSON and keeps raw strings otherwise', () => {
    expect(
      tryParseToolCall('{"tool_calls":[{"name":"f","arguments":"{\\"a\\":1}"}]}'),
    ).toEqual([{ name: 'f', arguments: '{"a":1}' }]);
    expect(tryParseToolCall('{"tool_calls":[{"name":"f","arguments":"raw text"}]}')).toEqual([
      { name: 'f', arguments: 'raw text' },
    ]);
  });

  it.each([
    ['plain prose', 'Here is the weather in Paris: sunny, 22C.'],
    ['markdown mentioning JSON without tool_calls', '```json\n{"answer": 42}\n```'],
    ['prose wrapping a tool call', 'I will call {"tool_calls":[{"name":"f"}]} now.'],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['empty tool_calls array', '{"tool_calls":[]}'],
    ['missing tool_calls key', '{}'],
    ['trailing comma', '{"tool_calls":[{"name":"f",}]}'],
    ['unquoted key', '{tool_calls: [1]}'],
    ['entry without a name', '{"tool_calls":[{"arguments":{}}]}'],
    ['null entry', '{"tool_calls":[null]}'],
    ['trailing prose after JSON', '{"tool_calls":[{"name":"f"}]}\nThanks!'],
    ['over 8000 chars', `{"tool_calls":[{"name":"f"}]}${'x'.repeat(8100)}`],
  ])('rejects %s', (_label, text) => {
    expect(tryParseToolCall(text)).toBeNull();
  });
});

describe('buildUpstreamMessages', () => {
  it('maps system messages', () => {
    const out = buildUpstreamMessages([
      { role: 'system', content: 'You are helpful.' },
    ]);
    expect(out).toEqual([
      {
        author: { role: 'system' },
        content: { content_type: 'text', parts: ['You are helpful.'] },
      },
    ]);
  });

  it('maps user text and joins text parts', () => {
    const out = buildUpstreamMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at' },
          { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          { type: 'input_text', text: ' this' },
        ] as any,
      },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'u' } }] as any },
      { role: 'user', content: [] as any },
    ]);
    expect(out[0]).toEqual({
      author: { role: 'user' },
      content: { content_type: 'text', parts: ['hi'] },
    });
    expect(out[1]).toEqual({
      author: { role: 'user' },
      content: { content_type: 'text', parts: ['look at\n this'] },
    });
    expect(out[2]).toEqual({
      author: { role: 'user' },
      content: { content_type: 'text', parts: [''] },
    });
    expect(out[3]).toEqual({
      author: { role: 'user' },
      content: { content_type: 'text', parts: [''] },
    });
  });

  it('maps assistant with tool_calls to the single-line JSON convention', () => {
    const out = buildUpstreamMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ name: 'get_weather', arguments: '{"city":"Paris"}' }],
      },
    ]);
    expect(out[0].author.role).toBe('assistant');
    expect(out[0].content.parts[0]).toBe(
      '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}',
    );
  });

  it('keeps invalid tool_call argument strings as raw strings in the JSON payload', () => {
    const out = buildUpstreamMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ name: 'f', arguments: 'raw text' }],
      },
    ]);
    expect(out[0].content.parts[0]).toBe('{"tool_calls":[{"name":"f","arguments":"raw text"}]}');
  });

  it('maps plain assistant text', () => {
    const out = buildUpstreamMessages([
      { role: 'assistant', content: 'All done.' },
    ]);
    expect(out).toEqual([
      {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['All done.'] },
      },
    ]);
  });

  it('maps tool results to author.name from name or tool_call_id', () => {
    const out = buildUpstreamMessages([
      { role: 'tool', content: 'Sunny 22C', name: 'get_weather' },
      { role: 'tool', content: 'result', tool_call_id: 'call_ABC123xyz' },
      { role: 'tool', content: 'fallback' },
    ]);
    expect(out[0]).toEqual({
      author: { role: 'tool', name: 'get_weather' },
      content: { content_type: 'text', parts: ['Sunny 22C'] },
    });
    expect(out[1].author.name).toBe('ABC123xyz');
    expect(out[2].author.name).toBe('tool');
  });

  it('round-trips a full tool loop', () => {
    const msgs = [
      { role: 'system', content: 'proto' } as const,
      { role: 'user', content: 'weather in Paris?' } as const,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ name: 'get_weather', arguments: '{"city":"Paris"}' }],
      } as const,
      { role: 'tool', name: 'get_weather', content: 'Sunny 22C' } as const,
    ];
    const out = buildUpstreamMessages(msgs as any);
    expect(out.map((m) => m.author.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(out[2].content.parts[0]).toContain('"tool_calls"');
    expect(out[3].author.name).toBe('get_weather');
  });
});

describe('buildToolResultMessage', () => {
  it('builds a tool-role upstream message', () => {
    expect(buildToolResultMessage('get_weather', 'Sunny 22C')).toEqual({
      author: { role: 'tool', name: 'get_weather' },
      content: { content_type: 'text', parts: ['Sunny 22C'] },
    });
  });
});

describe('toOpenAIToolCalls', () => {
  it('converts parsed calls to wire format with call_ ids', () => {
    const out = toOpenAIToolCalls([
      { name: 'get_weather', arguments: '{"city":"Paris"}' },
      { name: 'f', arguments: '{}' },
    ]);
    expect(out).toHaveLength(2);
    for (const tc of out) {
      expect(tc.type).toBe('function');
      expect(tc.id).toMatch(/^call_[a-zA-Z0-9]{22}$/);
      expect(typeof tc.function.name).toBe('string');
      expect(typeof tc.function.arguments).toBe('string');
    }
    expect(out[0].function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' });
  });

  it('generates unique ids', () => {
    const out = toOpenAIToolCalls(
      Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, arguments: '{}' })),
    );
    expect(new Set(out.map((t) => t.id)).size).toBe(20);
  });
});

describe('stripGenuiMarkers', () => {
  it('removes wrapped fragments including the markers', () => {
    expect(stripGenuiMarkers('a\ue200b\ue201c')).toBe('ac');
    expect(stripGenuiMarkers('\ue200{"ui":true}\ue201text')).toBe('text');
    expect(stripGenuiMarkers('x \ue200 \n y \ue201 z')).toBe('x  z');
  });

  it('removes stray markers without a pair', () => {
    expect(stripGenuiMarkers('orphan \ue200 marker')).toBe('orphan  marker');
    expect(stripGenuiMarkers('\ue201tail')).toBe('tail');
    expect(stripGenuiMarkers('no markers here')).toBe('no markers here');
  });

  it('handles multiple fragments in one string', () => {
    expect(stripGenuiMarkers('\ue200a\ue201mid\ue200b\ue201end')).toBe('midend');
  });
});
