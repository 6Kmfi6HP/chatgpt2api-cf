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
