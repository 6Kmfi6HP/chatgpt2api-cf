import { describe, it, expect } from 'vitest';
import { ToolCallStreamDetector, ToolCallStreamState, DEFAULT_MAX_TOOLCALL_BUFFER } from './toolcall_stream';

const singleToolCall = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Tokyo"}}]}';
const fenced = '```json\n' + singleToolCall + '\n```';
const twoCalls =
  '{"tool_calls":[{"name":"a","arguments":{"x":1}},{"name":"b","arguments":{"y":"z"}}]}';

describe('ToolCallStreamDetector', () => {
  it('buffers empty and whitespace input', () => {
    const d = new ToolCallStreamDetector();
    expect(d.feed('')).toEqual({ decision: 'buffer' });
    expect(d.feed('   ')).toEqual({ decision: 'buffer' });
  });

  it('flushes plain text immediately', () => {
    const d = new ToolCallStreamDetector();
    const r = d.feed('Hello, world!');
    expect(r.decision).toBe('flush');
    expect(r.text).toBe('Hello, world!');
  });

  it('flushes text that merely mentions tool_calls', () => {
    const d = new ToolCallStreamDetector();
    const r = d.feed('I will not call tools today.');
    expect(r.decision).toBe('flush');
  });

  it('buffers a growing tool-call JSON and emits once complete', () => {
    const d = new ToolCallStreamDetector();
    expect(d.feed('{"tool_calls":[{"na')).toEqual({ decision: 'buffer' });
    const full = singleToolCall;
    const r = d.feed(full);
    expect(r.decision).toBe('emit_tool_calls');
    expect(r.toolCalls).toEqual([{ name: 'get_weather', arguments: '{"city":"Tokyo"}' }]);
  });

  it('handles fenced code block tool calls', () => {
    const d = new ToolCallStreamDetector();
    expect(d.feed('```json\n{"tool_c')).toEqual({ decision: 'buffer' });
    const r = d.feed(fenced);
    expect(r.decision).toBe('emit_tool_calls');
    expect(r.toolCalls![0].name).toBe('get_weather');
  });

  it('converts an oversize buffer to flush (sticky)', () => {
    const big = '{' + 'x'.repeat(DEFAULT_MAX_TOOLCALL_BUFFER + 10);
    const d = new ToolCallStreamDetector();
    const r = d.feed(big);
    expect(r.decision).toBe('flush');
    // Sticky flush afterwards.
    expect(d.feed(singleToolCall)).toEqual({ decision: 'flush', text: '' });
  });

  it('respects a custom maxBuffer boundary', () => {
    const d = new ToolCallStreamDetector({ maxBuffer: 20 });
    const at = '{"tool_calls":[{"nam'; // 20 chars
    expect(d.feed(at)).toEqual({ decision: 'buffer' });
    const over = at + 'e';
    expect(d.feed(over).decision).toBe('flush');
  });

  it('is sticky after emit_tool_calls', () => {
    const d = new ToolCallStreamDetector();
    expect(d.feed(singleToolCall).decision).toBe('emit_tool_calls');
    expect(d.feed('anything')).toEqual({ decision: 'flush', text: '' });
  });
});

describe('ToolCallStreamState', () => {
  it('returns no chunks while buffering', () => {
    const st = new ToolCallStreamState();
    expect(st.feed('{"tool_calls":[{"na')).toEqual([]);
    expect(st.finishReason()).toBe('stop');
  });

  it('flushes full text for plain replies with a single content delta', () => {
    const st = new ToolCallStreamState();
    expect(st.feed('Hi')).toEqual([{ delta: { content: 'Hi' } }]);
    expect(st.feed('Hi there!')).toEqual([{ delta: { content: ' there!' } }]);
    expect(st.lastEmittedLen).toBe(9);
  });

  it('emits tool_calls delta with call ids once complete', () => {
    const st = new ToolCallStreamState();
    st.feed('{"tool_calls":[{"na');
    const chunks = st.feed(singleToolCall);
    expect(chunks.length).toBe(1);
    const tc = chunks[0].delta!.tool_calls![0];
    expect(tc.index).toBe(0);
    expect(tc.type).toBe('function');
    expect(tc.function.name).toBe('get_weather');
    expect(tc.function.arguments).toBe('{"city":"Tokyo"}');
    expect(tc.id).toMatch(/^call_[A-Za-z0-9]{22}$/);
    expect(st.emittedToolCalls).toBe(true);
    expect(st.finishReason()).toBe('tool_calls');
  });

  it('emits multiple tool calls with incrementing indexes', () => {
    const st = new ToolCallStreamState();
    const chunks = st.feed(twoCalls);
    expect(chunks.length).toBe(2);
    expect(chunks[0].delta!.tool_calls![0].index).toBe(0);
    expect(chunks[1].delta!.tool_calls![0].index).toBe(1);
    expect(chunks[1].delta!.tool_calls![0].function.name).toBe('b');
  });

  it('is sticky after emitting tool calls', () => {
    const st = new ToolCallStreamState();
    st.feed(singleToolCall);
    expect(st.feed(singleToolCall)).toEqual([]);
  });

  it('handles fenced tool calls end to end', () => {
    const st = new ToolCallStreamState();
    expect(st.feed('```json\n{"tool_calls":[{"na')).toEqual([]);
    const chunks = st.feed(fenced);
    expect(chunks.length).toBe(1);
    expect(chunks[0].delta!.tool_calls![0].function.name).toBe('get_weather');
  });
});

describe('ToolCallStreamDetector.finalize', () => {
  it('releases a buffer that never resolved into a tool call', () => {
    const d = new ToolCallStreamDetector();
    expect(d.feed('{"answer": 42}').decision).toBe('buffer');
    expect(d.finalize()).toEqual({ decision: 'flush', text: '{"answer": 42}' });
  });

  it('returns nothing after a tool call was emitted', () => {
    const d = new ToolCallStreamDetector();
    expect(d.feed(singleToolCall).decision).toBe('emit_tool_calls');
    expect(d.finalize()).toEqual({ decision: 'flush', text: '' });
  });

  it('returns nothing after the detector already flushed plain text', () => {
    const d = new ToolCallStreamDetector();
    expect(d.feed('Hello there').decision).toBe('flush');
    expect(d.finalize()).toEqual({ decision: 'flush', text: '' });
  });

  it('keeps only the latest snapshot when the buffer grew', () => {
    const d = new ToolCallStreamDetector();
    d.feed('{"a":');
    d.feed('{"a": 1}');
    expect(d.finalize().text).toBe('{"a": 1}');
  });
});

describe('ToolCallStreamState.finalize', () => {
  it('emits the withheld plain JSON reply as content', () => {
    const st = new ToolCallStreamState();
    expect(st.feed('{"answer": 42}')).toEqual([]);
    const drained = st.finalize();
    expect(drained).toEqual([{ delta: { content: '{"answer": 42}' } }]);
    expect(st.finishReason()).toBe('stop');
  });

  it('has nothing left to drain after plain text already streamed', () => {
    const st = new ToolCallStreamState();
    st.feed('Plain prose answer');
    st.feed('Plain prose answer, longer');
    // Plain text flushes on the first snapshot; nothing is left withheld.
    expect(st.finalize()).toEqual([]);
  });

  it('never leaks the tool-call JSON through finalize', () => {
    const st = new ToolCallStreamState();
    st.feed(singleToolCall);
    expect(st.finalize()).toEqual([]);
    expect(st.finishReason()).toBe('tool_calls');
  });
});

describe('ToolCallStreamState single-call mode', () => {
  const threeCalls =
    '{"tool_calls":[{"name":"a","arguments":{"x":1}},{"name":"b","arguments":{"y":2}},{"name":"c","arguments":{"z":3}}]}';

  it('emits every call when singleCall is off (default)', () => {
    const st = new ToolCallStreamState();
    expect(st.feed(threeCalls).length).toBe(3);
  });

  it('emits exactly one delta in single-call mode', () => {
    const st = new ToolCallStreamState({ singleCall: true });
    const chunks = st.feed(threeCalls);
    expect(chunks.length).toBe(1);
    expect(chunks[0].delta!.tool_calls!.length).toBe(1);
    expect(chunks[0].delta!.tool_calls![0].index).toBe(0);
    expect(chunks[0].delta!.tool_calls![0].function.name).toBe('a');
    expect(st.finishReason()).toBe('tool_calls');
  });

  it('keeps the preferred call in single-call mode', () => {
    const st = new ToolCallStreamState({ singleCall: true, preferredName: 'c' });
    const chunks = st.feed(threeCalls);
    expect(chunks.length).toBe(1);
    expect(chunks[0].delta!.tool_calls![0].function.name).toBe('c');
    // Index stays 0: one call means one index on the wire.
    expect(chunks[0].delta!.tool_calls![0].index).toBe(0);
  });

  it('falls back to the first call when the preferred name is absent', () => {
    const st = new ToolCallStreamState({ singleCall: true, preferredName: 'ghost' });
    expect(st.feed(threeCalls)[0].delta!.tool_calls![0].function.name).toBe('a');
  });

  it('leaves single-call replies untouched', () => {
    const st = new ToolCallStreamState({ singleCall: true, preferredName: 'get_weather' });
    const chunks = st.feed(singleToolCall);
    expect(chunks.length).toBe(1);
    expect(chunks[0].delta!.tool_calls![0].function.name).toBe('get_weather');
  });
});

// [audit:stream-large-toolcall-flushed] The stream detector's hold window must
// match the non-stream parser's limit (MAX_PARSE_LENGTH), otherwise a tool call
// whose arguments exceed the small window is flushed as plain content and the
// client never executes it.
describe('ToolCallStreamDetector large tool calls', () => {
  const largeCall = (n: number) =>
    JSON.stringify({ tool_calls: [{ name: 'write_file', arguments: { path: '/tmp/a', content: 'x'.repeat(n) } }] });

  it('emits a complete tool call larger than the old 1200-char window', () => {
    const call = largeCall(3000);
    expect(call.length).toBeGreaterThan(1200);
    expect(call.length).toBeLessThanOrEqual(8000);
    const d = new ToolCallStreamDetector();
    const r = d.feed(call);
    expect(r.decision).toBe('emit_tool_calls');
    expect(r.toolCalls![0].name).toBe('write_file');
  });

  it('keeps buffering an incomplete large tool-call prefix instead of flushing it', () => {
    const call = largeCall(3000);
    const d = new ToolCallStreamDetector();
    const prefix = call.slice(0, 1300);
    expect(prefix.length).toBeGreaterThan(1200);
    expect(d.feed(prefix)).toEqual({ decision: 'buffer' });
    expect(d.feed(call).decision).toBe('emit_tool_calls');
  });

  it('still flushes a payload beyond the parser limit', () => {
    const call = largeCall(8100);
    expect(call.length).toBeGreaterThan(8000);
    const d = new ToolCallStreamDetector();
    expect(d.feed(call).decision).toBe('flush');
  });
});

describe('ToolCallStreamState large tool calls', () => {
  it('streams a large call as tool_calls, never as content', () => {
    const call = JSON.stringify({
      tool_calls: [{ name: 'write_file', arguments: { path: '/tmp/a', content: 'y'.repeat(3000) } }],
    });
    const st = new ToolCallStreamState();
    expect(st.feed(call.slice(0, 1300))).toEqual([]);
    const chunks = st.feed(call);
    expect(chunks).toHaveLength(1);
    const tc = chunks[0].delta!.tool_calls![0];
    expect(tc.function.name).toBe('write_file');
    expect(tc.function.arguments.length).toBeGreaterThan(3000);
    expect(st.finishReason()).toBe('tool_calls');
    expect(st.finalize()).toEqual([]);
  });
});
