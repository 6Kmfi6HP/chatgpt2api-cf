import { describe, it, expect } from 'vitest';
import {
  buildToolProtocolSystemMessage,
  tryParseToolCall,
  buildUpstreamMessages,
  buildToolResultMessage,
  toOpenAIToolCalls,
  stripGenuiMarkers,
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
  it('lists tool names, descriptions and parameter schemas', () => {
    const msg = buildToolProtocolSystemMessage([weatherTool, searchTool]);
    expect(msg).toContain('get_weather');
    expect(msg).toContain('Get current weather for a city');
    expect(msg).toContain('web_search');
    expect(msg).toContain('"unit":{"type":"string"');
  });

  it('states the single-line JSON reply convention', () => {
    const msg = buildToolProtocolSystemMessage([weatherTool]);
    expect(msg).toContain('"tool_calls"');
    expect(msg).toContain('{"tool_calls":[{"name":"<tool>","arguments":{}}]}');
    expect(msg).toContain('one line of raw JSON');
    expect(msg).toContain('No markdown code fences');
  });

  it('frames tools as real and mandates calling over guessing', () => {
    const msg = buildToolProtocolSystemMessage([weatherTool]);
    expect(msg).toContain('REAL, CALLABLE');
    expect(msg).toContain('MUST call the tools');
    expect(msg).toContain('Never guess');
  });

  it('says multiple calls are allowed and prose is preferred when possible', () => {
    const msg = buildToolProtocolSystemMessage([weatherTool]);
    expect(msg).toContain('Multiple entries');
    expect(msg).toContain('plain text');
  });

  it('handles tools without description or parameters', () => {
    const msg = buildToolProtocolSystemMessage([
      { type: 'function', function: { name: 'ping' } },
    ]);
    expect(msg).toContain('ping');
    expect(msg).toContain('no arguments');
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

  it('rejects plain prose', () => {
    expect(tryParseToolCall('Here is the weather in Paris: sunny, 22C.')).toBeNull();
  });

  it('rejects markdown text that merely mentions JSON', () => {
    expect(tryParseToolCall('```json\n{"answer": 42}\n```')).toBeNull();
    expect(tryParseToolCall('I will call {"tool_calls":[{"name":"f"}]} now.')).toBeNull();
  });

  it('rejects empty and empty tool_calls', () => {
    expect(tryParseToolCall('')).toBeNull();
    expect(tryParseToolCall('   ')).toBeNull();
    expect(tryParseToolCall('{"tool_calls":[]}')).toBeNull();
    expect(tryParseToolCall('{}')).toBeNull();
  });

  it('rejects invalid JSON', () => {
    expect(tryParseToolCall('{"tool_calls":[{"name":"f",}]}')).toBeNull();
    expect(tryParseToolCall('{tool_calls: [1]}')).toBeNull();
  });

  it('rejects entries without a name', () => {
    expect(tryParseToolCall('{"tool_calls":[{"arguments":{}}]}')).toBeNull();
    expect(tryParseToolCall('{"tool_calls":[null]}')).toBeNull();
  });

  it('rejects whitespace-only around a JSON block with trailing prose', () => {
    expect(tryParseToolCall('{"tool_calls":[{"name":"f"}]}\nThanks!')).toBeNull();
  });

  it('rejects replies over 8000 chars without trying', () => {
    const pad = 'x'.repeat(8100);
    expect(tryParseToolCall(`{"tool_calls":[{"name":"f"}]}${pad}`)).toBeNull();
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
