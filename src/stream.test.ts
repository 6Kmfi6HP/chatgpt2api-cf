import { describe, it, expect } from 'vitest';
import {
  StreamProcessor,
  pipeOpenAIStream,
  aggregateNonStream,
  aggregateNonStreamWithSignals,
  isModelDegraded,
 } from './stream';
import type { ChatCompletionRequest, ChatCompletionChunk } from './types';
import {
  PUA_ANNOTATION_START,
  PUA_ANNOTATION_SEP,
  PUA_ANNOTATION_END,
} from './citations';

function pua(kind: string, payload: string): string {
  return PUA_ANNOTATION_START + kind + PUA_ANNOTATION_SEP + payload + PUA_ANNOTATION_END;
}

function mkAssistantEvent(text: string, metadata?: any) {
  return {
    type: 'message_stream',
    conversation_id: 'conv-123',
    message: {
      id: 'msg-456',
      author: { role: 'assistant' },
      content: {
        content_type: 'text',
        parts: [text],
      },
      metadata,
    },
  };
}

describe('StreamProcessor', () => {
  it('strips bare :::writing{…} fences when they arrive whole in one snapshot', () => {
    const sp = new StreamProcessor('gpt-4o');
    const text =
      '当然，给你一版简洁、正式的：\n' +
      ':::writing{variant="document" id="58321" title="请假条"}\n' +
      '**请假条**\n尊敬的老师：……\n' +
      ':::';
    const chunks = sp.processEvent(mkAssistantEvent(text));
    const streamed = chunks.map((c) => (c.choices[0].delta as any)?.content ?? '').join('');
    expect(streamed).toBe('当然，给你一版简洁、正式的：\n**请假条**\n尊敬的老师：……');
    const flushed = sp
      .flush()
      .map((c) => (c.choices[0].delta as any)?.content ?? '')
      .join('');
    expect(flushed).toBe('');
  });

  it('withholds a partial :::writing fence split across snapshots', () => {
    const sp = new StreamProcessor('gpt-4o');
    // Snapshot 1 ends mid-fence.
    const c1 = sp.processEvent(mkAssistantEvent('如下：\n:::writing{variant="doc'));
    const s1 = c1.map((c) => (c.choices[0].delta as any)?.content ?? '').join('');
    expect(s1).toBe('如下：\n');
    // Snapshot 2 completes the fence and adds body.
    const c2 = sp.processEvent(
      mkAssistantEvent('如下：\n:::writing{variant="document"}\n正文内容\n:::')
    );
    const s2 = c2.map((c) => (c.choices[0].delta as any)?.content ?? '').join('');
    expect(s2).toBe('正文内容');
  });

  it('keeps ::: inside a fenced code block instead of stripping it', () => {
    const sp = new StreamProcessor('gpt-4o');
    const text = '示例：\n```markdown\n:::writing{variant="document"}\n正文\n:::\n```\n结束';
    const chunks = sp.processEvent(mkAssistantEvent(text));
    const streamed = chunks.map((c) => (c.choices[0].delta as any)?.content ?? '').join('');
    expect(streamed).toBe(text);
  });

  it('emits role chunk on first assistant event and calculates deltas', () => {
    const sp = new StreamProcessor('gpt-4o');

    const c1 = sp.processEvent(mkAssistantEvent('Hel'));
    expect(c1.length).toBe(2);
    expect(c1[0].choices[0].delta).toEqual({ role: 'assistant' });
    expect(c1[1].choices[0].delta).toEqual({ content: 'Hel' });

    const c2 = sp.processEvent(mkAssistantEvent('Hello world'));
    expect(c2.length).toBe(1);
    expect(c2[0].choices[0].delta).toEqual({ content: 'lo world' });

    // Duplicate snapshot produces no new content
    const c3 = sp.processEvent(mkAssistantEvent('Hello world'));
    expect(c3.length).toBe(0);

    // Non-assistant event produces no chunks
    const cUser = sp.processEvent({
      type: 'message_stream',
      message: {
        author: { role: 'user' },
        content: { parts: ['Hello'] },
      },
    });
    expect(cUser.length).toBe(0);

    // Stream end flush
    const finalChunks = sp.flush();
    expect(finalChunks.length).toBe(1);
    expect(finalChunks[0].choices[0].finish_reason).toBe('stop');
  });

  it('skips re-emitted history frames (multi-frame replay) and streams only the live reply', () => {
    const sp = new StreamProcessor('gpt-4o');

    // History echo #1: replayed assistant frame arrives already finished,
    // without live markers.
    const echo1 = {
      type: 'message_stream',
      conversation_id: 'conv-123',
      message: {
        id: 'hist-1',
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['Three apple trees — nice! What variety?'] },
        status: 'finished_successfully',
        end_turn: null,
        metadata: { request_id: 'req-1' },
        channel: null,
      },
    };
    expect(sp.processEvent(echo1)).toEqual([]);

    // History echo #2 (second replayed assistant frame, also finished).
    const echo2 = {
      type: 'message_stream',
      conversation_id: 'conv-123',
      message: {
        id: 'hist-2',
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['Earlier answer.'] },
        status: 'finished_successfully',
        channel: null,
      },
    };
    expect(sp.processEvent(echo2)).toEqual([]);

    // Live reply: starts in_progress with empty text, then grows.
    const liveStart = {
      type: 'message_stream',
      conversation_id: 'conv-123',
      message: {
        id: 'live-1',
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: [''] },
        status: 'in_progress',
        metadata: { message_type: 'next' },
        channel: 'final',
      },
    };
    // The first live snapshot carries the OpenAI role delta (text is empty).
    const startChunks = sp.processEvent(liveStart);
    expect(startChunks.length).toBe(1);
    expect(startChunks[0].choices[0].delta).toEqual({ role: 'assistant' });

    const liveGrow = {
      type: 'message_stream',
      conversation_id: 'conv-123',
      message: {
        id: 'live-1',
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['3'] },
        status: 'finished_successfully',
        end_turn: true,
        metadata: { message_type: 'next', finish_details: { type: 'stop' } },
        channel: 'final',
      },
    };
    const chunks = sp.processEvent(liveGrow);
    expect(chunks.length).toBe(1);
    expect(chunks[0].choices[0].delta).toEqual({ content: '3' });

    const finalChunks = sp.flush();
    expect(finalChunks[0].choices[0].finish_reason).toBe('stop');
  });

  it('streams a reply that arrives only as a finished snapshot with live markers', () => {
    const sp = new StreamProcessor('gpt-4o');
    const fastReply = {
      type: 'message_stream',
      message: {
        id: 'fast-1',
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['Instant answer.'] },
        status: 'finished_successfully',
        end_turn: true,
        metadata: { message_type: 'next', finish_details: { type: 'stop' } },
        channel: 'final',
      },
    };
    const chunks = sp.processEvent(fastReply);
    expect(chunks.length).toBe(2);
    expect(chunks[1].choices[0].delta).toEqual({ content: 'Instant answer.' });
  });

  it('handles multi-part assistant content', () => {
    const sp = new StreamProcessor('auto');
    const ev = {
      type: 'message_stream',
      message: {
        author: { role: 'assistant' },
        content: {
          parts: ['Part 1, ', 'Part 2.'],
        },
      },
    };
    const chunks = sp.processEvent(ev);
    expect(chunks.length).toBe(2);
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' });
    expect(chunks[1].choices[0].delta).toEqual({ content: 'Part 1, Part 2.' });
  });

  it('ingests citation metadata and formats citations into markdown links', () => {
    const sp = new StreamProcessor('gpt-4o');
    const meta = {
      content_references: [
        {
          matched_text: pua('cite', 'turn0news75'),
          items: [
            {
              url: 'https://example.com/news',
              title: 'Example News',
              attribution: 'example.com',
            },
          ],
        },
      ],
    };

    const textWithCite = `Here is info ${pua('cite', 'turn0news75')}.`;
    const chunks = sp.processEvent(mkAssistantEvent(textWithCite, meta));

    // Role + content
    expect(chunks.length).toBe(2);
    expect(chunks[1].choices[0].delta.content).toBe(
      'Here is info [example.com](https://example.com/news).'
    );
  });

  it('withholds trailing citation partial and resolves valid word tail on flush', () => {
    const sp = new StreamProcessor('gpt-4o');

    // "Wait in turn" ends with " turn" which looks like citation partial
    const chunks = sp.processEvent(mkAssistantEvent('Wait in turn'));
    expect(chunks.length).toBe(2);
    expect(chunks[1].choices[0].delta.content).toBe('Wait in');
    expect(sp.withheld).toBe(' turn');

    // Flush restores real word " turn"
    const finalChunks = sp.flush();
    expect(finalChunks.length).toBe(2);
    expect(finalChunks[0].choices[0].delta.content).toBe(' turn');
    expect(finalChunks[1].choices[0].finish_reason).toBe('stop');
  });

  it('flush keeps a real word tail when an open annotation follows it', () => {
    const sp = new StreamProcessor('gpt-4o');
    const open = PUA_ANNOTATION_START + 'entity' + PUA_ANNOTATION_SEP + '["ci';
    const chunks = sp.processEvent(mkAssistantEvent('Wait in turn ' + open));
    const streamed = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
    expect(streamed).toBe('Wait in');
    expect(sp.withheld).toBe(' turn');
    const flushed = sp.flush().map((c) => c.choices[0]?.delta.content ?? '').join('');
    expect(flushed).toBe(' turn');
    expect(streamed + flushed).not.toContain('entity');
  });

  it('ignores a replayed web.run frame and latches a live one', () => {
    const sp = new StreamProcessor('gpt-4o');
    sp.processEvent({
      message: {
        id: 'hist-web',
        author: { role: 'tool', name: 'web.run' },
        status: 'finished_successfully',
        content: { content_type: 'text', parts: [''] },
      },
    });
    expect(sp.usedWebSearch).toBe(false);
    sp.processEvent({
      message: {
        id: 'hist-assistant-web',
        author: { role: 'assistant' },
        recipient: 'web.run',
        status: 'finished_successfully',
        content: { content_type: 'text', parts: ['old search'] },
      },
    });
    expect(sp.usedWebSearch).toBe(false);
    sp.processEvent({
      message: {
        id: 'live-web',
        author: { role: 'tool', name: 'web.run' },
        content: { content_type: 'text', parts: [''] },
      },
    });
    expect(sp.usedWebSearch).toBe(true);
  });

  it('streams an entity annotation split across snapshots as its display name', () => {
    const sp = new StreamProcessor('gpt-4o');
    const entity = pua('entity', '["city","Huế","Thừa Thiên Huế, Việt Nam"]');
    const snapshots = [
      'Tháng 11, ' + entity.slice(0, 12),
      'Tháng 11, ' + entity,
      'Tháng 11, ' + entity + ' thường mưa nhiều.',
    ];
    const streamed = snapshots
      .flatMap((s) => sp.processEvent(mkAssistantEvent(s)))
      .concat(sp.flush())
      .map((c) => (c.choices[0].delta as any)?.content ?? '')
      .join('');
    expect(streamed).toBe('Tháng 11, Huế thường mưa nhiều.');
  });

  it('drops trailing partial citation marker containing digits on flush', () => {
    const sp = new StreamProcessor('gpt-4o');

    // "According to turn0" ends with " turn0" which is a citation marker
    const chunks = sp.processEvent(mkAssistantEvent('According to turn0'));
    expect(chunks.length).toBe(2);
    expect(chunks[1].choices[0].delta.content).toBe('According to');
    expect(sp.withheld).toBe(' turn0');

    // Flush drops citation marker with digits
    const finalChunks = sp.flush();
    expect(finalChunks.length).toBe(1);
    expect(finalChunks[0].choices[0].finish_reason).toBe('stop');
  });

  it('emits exactly one usage chunk (choices: []) when stream_options.include_usage is true', () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'What is 2+2? Please give a detailed explanation.' }],
      stream: true,
      stream_options: { include_usage: true },
    };
    const sp = new StreamProcessor('gpt-4o', req);
    sp.processEvent(mkAssistantEvent('The answer to two plus two is four.'));

    const finalChunks = sp.flush();
    expect(finalChunks.length).toBe(2);

    // Finish chunk: finish_reason present, NO usage (spec: usage only in the
    // dedicated choices:[] chunk, so clients never see it twice).
    const stopChunk = finalChunks[0];
    expect(stopChunk.choices[0].finish_reason).toBe('stop');
    expect(stopChunk.usage).toBeUndefined();

    // Last chunk: choices: [] with the single usage payload
    const usageChunk = finalChunks[1];
    expect(usageChunk.choices.length).toBe(0);
    expect(usageChunk.usage).toBeDefined();
    expect(usageChunk.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(usageChunk.usage!.completion_tokens).toBeGreaterThan(0);
    expect(usageChunk.usage!.total_tokens).toBe(
      usageChunk.usage!.prompt_tokens + usageChunk.usage!.completion_tokens
    );
  });

  it('emits no usage anywhere when stream_options.include_usage is absent', () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Say hi.' }],
      stream: true,
    };
    const sp = new StreamProcessor('gpt-4o', req);
    const chunks = sp.processEvent(mkAssistantEvent('Hi there.'));
    const finalChunks = sp.flush();
    for (const c of [...chunks, ...finalChunks]) {
      expect(c.usage).toBeUndefined();
    }
    expect(finalChunks).toHaveLength(1);
    expect(finalChunks[0].choices[0].finish_reason).toBe('stop');
  });

  // A tools request turns the tool-call detector on for every snapshot. The
  // detector must buffer while the text could still resolve into the tool-call
  // JSON convention — but a plain JSON reply (leading "{", no tool_calls) never
  // resolves, and the old code never drained the buffer, so the whole reply was
  // dropped while still answering 200 + finish_reason "stop".
  describe('tools request whose reply is plain JSON text', () => {
    const toolsReq = (): ChatCompletionRequest => ({
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly {"answer": 42}' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
        },
      ],
    });

    const joinContent = (chunks: ChatCompletionChunk[]): string =>
      chunks
        .map((c) => c.choices?.[0]?.delta?.content ?? '')
        .join('');

    it('flushes a whole JSON object reply as content instead of dropping it', () => {
      const sp = new StreamProcessor('gpt-4o', toolsReq());
      sp.processEvent(mkAssistantEvent('{"answer": 42, "unit": "apple"}'));
      const finalChunks = sp.flush();
      expect(joinContent(finalChunks)).toBe('{"answer": 42, "unit": "apple"}');
      expect(finalChunks.some((c) => c.choices[0]?.finish_reason === 'stop')).toBe(true);
    });

    it('flushes a JSON object that arrived in cumulative snapshots', () => {
      const sp = new StreamProcessor('gpt-4o', toolsReq());
      const first = sp.processEvent(mkAssistantEvent('{"answer"'));
      expect(joinContent(first)).toBe('');
      const second = sp.processEvent(mkAssistantEvent('{"answer": 42}'));
      expect(joinContent(second)).toBe('');
      expect(joinContent(sp.flush())).toBe('{"answer": 42}');
    });

    it('flushes a ```json fenced reply that parses as no tool call', () => {
      const sp = new StreamProcessor('gpt-4o', toolsReq());
      sp.processEvent(mkAssistantEvent('```json\n{"x":1}\n```'));
      expect(joinContent(sp.flush())).toBe('```json\n{"x":1}\n```');
    });

    it('still converts a real tool-call reply and never leaks the JSON', () => {
      const sp = new StreamProcessor('gpt-4o', toolsReq());
      const chunks = sp.processEvent(
        mkAssistantEvent('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}')
      );
      expect(chunks.some((c) => c.choices?.[0]?.delta?.tool_calls)).toBe(true);
      const tail = sp.flush();
      expect(joinContent(tail)).toBe('');
      expect(tail.some((c) => c.choices[0]?.finish_reason === 'tool_calls')).toBe(true);
    });

    it('does not duplicate text that already streamed once the detector flushed', () => {
      const sp = new StreamProcessor('gpt-4o', toolsReq());
      const first = sp.processEvent(mkAssistantEvent('Sure, here is the JSON: '));
      // Plain prose flushes immediately; later snapshots keep streaming deltas.
      expect(joinContent(first)).toBe('Sure, here is the JSON: ');
      const second = sp.processEvent(mkAssistantEvent('Sure, here is the JSON: {"a":1}'));
      expect(joinContent(second)).toBe('{"a":1}');
      expect(joinContent(sp.flush())).toBe('');
    });
  });

  // Guards [audit:truncated-tool-json-leak] on the streaming path: a limit
  // ends the turn while the detector is still holding the protocol JSON, so
  // upstream sends no snapshot that could resolve it. The held text must
  // become tool_calls (recoverable) or nothing — never `content`.
  describe('tools request truncated mid tool-call JSON', () => {
    const toolsReq = (extra?: Partial<ChatCompletionRequest>): ChatCompletionRequest => ({
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: 'search the docs' }],
      tools: [
        {
          type: 'function',
          function: { name: 'search_docs', description: 'Search docs', parameters: { type: 'object' } },
        },
      ],
      ...extra,
    });

    const joinContent = (chunks: ChatCompletionChunk[]): string =>
      chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');

    const toolDeltas = (
      chunks: ChatCompletionChunk[]
    ): Array<{ function: { name: string; arguments: string } }> =>
      chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);

    it('reports the truncated payload as tool_calls instead of content at max_tokens', () => {
      // 83-char payload, cap 16 tokens => the cut lands inside the query value:
      // the name survives, the argument text does not parse.
      const sp = new StreamProcessor('gpt-4o', toolsReq({ max_tokens: 16 }));
      const first = sp.processEvent(
        mkAssistantEvent(
          '{"tool_calls":[{"name":"search_docs","arguments":{"query":"streaming sse usage","limit":5}}]}'
        )
      );
      const tail = sp.flush();
      const all = [...first, ...tail];
      expect(joinContent(all)).toBe('');
      const calls = toolDeltas(all);
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe('search_docs');
      expect(calls[0].function.arguments).toBe('{"query":"streamin');
      expect(tail.some((c) => c.choices[0]?.finish_reason === 'length')).toBe(true);
    });

    it('suppresses an unrecoverable protocol prefix instead of leaking it as content', () => {
      // The cut lands inside the carrier header, before any call name exists.
      const sp = new StreamProcessor('gpt-4o', toolsReq({ max_tokens: 3 }));
      const first = sp.processEvent(
        mkAssistantEvent('{"tool_calls":[{"name":"search_docs","arguments":{"query":"q"}}]}')
      );
      const tail = sp.flush();
      const all = [...first, ...tail];
      expect(joinContent(all)).toBe('');
      expect(toolDeltas(all)).toEqual([]);
      expect(tail.some((c) => c.choices[0]?.finish_reason === 'length')).toBe(true);
    });

    it('reports a stop-cut payload as tool_calls with finish_reason "stop"', () => {
      const sp = new StreamProcessor('gpt-4o', toolsReq({ stop: ['usage'] }));
      const first = sp.processEvent(
        mkAssistantEvent(
          '{"tool_calls":[{"name":"search_docs","arguments":{"query":"streaming sse usage","limit":5}}]}'
        )
      );
      const all = [...first, ...sp.flush()];
      expect(joinContent(all)).toBe('');
      const calls = toolDeltas(all);
      expect(calls[0].function.name).toBe('search_docs');
      expect(calls[0].function.arguments).toBe('{"query":"streaming sse');
      expect(all.some((c) => c.choices[0]?.finish_reason === 'stop')).toBe(true);
    });
  });

  it('flushes the held stop-prefix before the citation and genui tails', () => {
    const sp = new StreamProcessor('gpt-4o');
    sp.withheldStop = 'ST';
    sp.withheldGenui = 'GEN';
    sp.withheld = ' tur';
    const flushed = sp.flush();
    const content = flushed.map((c) => c.choices[0].delta.content ?? '').join('');
    // Source order: the stop-prefix sat before the genui and citation tails.
    expect(content).toBe('STGEN tur');
  });

  it('clears a latched sampling cut when a new live message starts', () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 3,
    };
    const sp = new StreamProcessor('gpt-4o', req);
    const first = sp.processEvent(mkAssistantEvent('a'.repeat(100)));
    expect(first.map((c) => c.choices[0].delta.content ?? '').join('')).toBe('a'.repeat(15));

    // A NEW live message id: the previous message's cut must not bind here.
    const ev = mkAssistantEvent('b'.repeat(4));
    ev.message.id = 'msg-live-2';
    const second = sp.processEvent(ev);
    expect(second.map((c) => c.choices[0].delta.content ?? '').join('')).toBe('bbbb');

    // The new reply fits the budget, so the stale "length" must be gone.
    const flushed = sp.flush();
    expect(flushed.map((c) => c.choices[0].finish_reason).filter((r) => r !== null)).toEqual([
      'stop',
    ]);
  });
});

describe('pipeOpenAIStream', () => {
  function createSseResponse(events: string[]): Response {
    const stream = new ReadableStream({
      start(controller) {
        for (const ev of events) {
          controller.enqueue(new TextEncoder().encode(ev));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('streams a plain JSON reply as content when the request carries tools', async () => {
    const ssePayloads = [
      `data: ${JSON.stringify(mkAssistantEvent('{"answer": 42, "unit": "apple"}'))}\n\n`,
      'data: [DONE]\n\n',
    ];

    const resp = createSseResponse(ssePayloads);
    const written: string[] = [];
    const writer = {
      writeSSE: async (msg: { data: string }) => {
        written.push(msg.data);
      },
    };

    const toolsReq: ChatCompletionRequest = {
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly {"answer": 42}' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
        },
      ],
    };
    await pipeOpenAIStream(resp, writer, 'gpt-4o', toolsReq);

    const content = written
      .filter((d) => d !== '[DONE]')
      .map((d) => JSON.parse(d) as ChatCompletionChunk)
      .map((c) => c.choices?.[0]?.delta?.content ?? '')
      .join('');
    // Without the fix the whole reply is swallowed by the tool-call buffer.
    expect(content).toBe('{"answer": 42, "unit": "apple"}');
    const stopChunk = JSON.parse(written[written.length - 2]) as ChatCompletionChunk;
    expect(stopChunk.choices[0].finish_reason).toBe('stop');
  });

  it('pipes OpenAI chunks and writes [DONE] at stream end', async () => {
    const ssePayloads = [
      ': ping\n\n',
      `data: ${JSON.stringify(mkAssistantEvent('Hello'))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent('Hello world!'))}\n\n`,
      'data: [DONE]\n\n',
    ];
    const resp = createSseResponse(ssePayloads);
    const written: string[] = [];
    const writer = {
      writeSSE: async (msg: { data: string }) => {
        written.push(msg.data);
      },
    };

    await pipeOpenAIStream(resp, writer, 'gpt-4o');

    expect(written.length).toBeGreaterThanOrEqual(4);
    // 1: role assistant
    const chunk0 = JSON.parse(written[0]);
    expect(chunk0.choices[0].delta.role).toBe('assistant');
    // 2: content 'Hello'
    const chunk1 = JSON.parse(written[1]);
    expect(chunk1.choices[0].delta.content).toBe('Hello');
    // 3: content ' world!'
    const chunk2 = JSON.parse(written[2]);
    expect(chunk2.choices[0].delta.content).toBe(' world!');
    // finish_reason stop
    const stopChunk = JSON.parse(written[written.length - 2]);
    expect(stopChunk.choices[0].finish_reason).toBe('stop');
    // [DONE]
    expect(written[written.length - 1]).toBe('[DONE]');
  });

  it('works with a writer that exposes write() instead of writeSSE()', async () => {
    const ssePayloads = [
      `data: ${JSON.stringify(mkAssistantEvent('Hi'))}\n\n`,
    ];

    const resp = createSseResponse(ssePayloads);
    const rawWritten: string[] = [];
    const writer = {
      write: async (str: string | Uint8Array) => {
        rawWritten.push(typeof str === 'string' ? str : new TextDecoder().decode(str));
      },
    };

    await pipeOpenAIStream(resp, writer, 'gpt-4o');

    expect(rawWritten.some((line) => line.includes('"role":"assistant"'))).toBe(true);
    expect(rawWritten.some((line) => line.includes('"content":"Hi"'))).toBe(true);
    expect(rawWritten.some((line) => line.includes('"finish_reason":"stop"'))).toBe(true);
    expect(rawWritten[rawWritten.length - 1]).toBe('data: [DONE]\n\n');
  });

  it('cancels stream reading immediately when AbortSignal is triggered', async () => {
    const controller = new AbortController();
    const ssePayloads = [
      `data: ${JSON.stringify(mkAssistantEvent('Part 1'))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent('Part 2'))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent('Part 3'))}\n\n`,
    ];

    const resp = createSseResponse(ssePayloads);
    const written: string[] = [];
    const writer = {
      writeSSE: async (msg: { data: string }) => {
        written.push(msg.data);
        controller.abort();
      },
    };

    await pipeOpenAIStream(resp, writer, 'gpt-4o', undefined, controller.signal);
    expect(written).not.toContain('[DONE]');
  });

  it('finalizes promptly after end_turn instead of waiting for the socket close', async () => {
    // Real-timer test by necessity: the behavior under test IS the grace
    // window (an upstream socket that never closes), so there is no
    // deterministic clock to stand in for it.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'message_stream',
              message: {
                id: 'live-1',
                author: { role: 'assistant' },
                content: { content_type: 'text', parts: ['Instant answer.'] },
                status: 'in_progress',
                metadata: { message_type: 'next' },
              },
            })}\n\n`
          )
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: 'message_stream',
              message: {
                id: 'live-1',
                author: { role: 'assistant' },
                content: { content_type: 'text', parts: ['Instant answer.'] },
                status: 'finished_successfully',
                end_turn: true,
                channel: 'final',
                metadata: { message_type: 'next', finish_details: { type: 'stop' } },
              },
            })}\n\n`
          )
        );
        // Intentionally never closed: mimics upstream holding the socket open.
      },
    });

    const resp = new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const written: string[] = [];
    const writer = {
      writeSSE: async (msg: { data: string }) => {
        written.push(msg.data);
      },
    };

    await pipeOpenAIStream(resp, writer, 'gpt-4o');

    // Without the fix this never returns (the socket never closes).
    expect(written[written.length - 1]).toBe('[DONE]');
    const stopChunk = JSON.parse(written[written.length - 2]);
    expect(stopChunk.choices[0].finish_reason).toBe('stop');
  });

  it('keeps reading trailing frames that arrive inside the grace window', async () => {
    const encoder = new TextEncoder();
    const snap = (text: string, finished: boolean) =>
      encoder.encode(
        `data: ${JSON.stringify({
          type: 'message_stream',
          message: {
            id: 'live-1',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: [text] },
            status: finished ? 'finished_successfully' : 'in_progress',
            end_turn: finished ? true : undefined,
            metadata: { message_type: 'next' },
            channel: finished ? 'final' : undefined,
          },
        })}\n\n`
      );

    // Pull-driven: each read() hands over the next frame, so ordering is
    // deterministic (no wall-clock guessing). The 4th pull never resolves,
    // which forces the grace window to end the stream.
    const frames = [
      snap('Part 1', false),
      snap('Part 1, Part 2', true),
      snap('Part 1, Part 2, Part 3', true),
    ];
    let pullIndex = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullIndex < frames.length) {
          controller.enqueue(frames[pullIndex++]);
        }
        // Beyond the last frame: stay open without enqueuing (upstream idle).
      },
    });

    const resp = new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const written: string[] = [];
    const writer = {
      writeSSE: async (msg: { data: string }) => {
        written.push(msg.data);
      },
    };

    await pipeOpenAIStream(resp, writer, 'gpt-4o');
    const contents = written
      .filter((d) => d !== '[DONE]')
      .map((d) => JSON.parse(d) as { choices?: Array<{ delta?: { content?: string } }> })
      .map((c) => c.choices?.[0]?.delta?.content)
      .filter((c): c is string => typeof c === 'string');
    // The frame that arrived after end_turn (inside the grace window) is kept.
    expect(contents.join('')).toContain('Part 3');
  });

  it('does not drop an in-window frame when the client sink is slow', async () => {
    // Regression guard: the grace window is IDLE-based (reset after each
    // emission), so a client whose writes are slower than the window can no
    // longer consume the window and lose a trailing frame.
    const encoder = new TextEncoder();
    const snap = (text: string, finished: boolean) =>
      encoder.encode(
        `data: ${JSON.stringify({
          type: 'message_stream',
          message: {
            id: 'live-1',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: [text] },
            status: finished ? 'finished_successfully' : 'in_progress',
            end_turn: finished ? true : undefined,
            metadata: { message_type: 'next' },
            channel: finished ? 'final' : undefined,
          },
        })}\n\n`
      );

    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (step === 0) {
          controller.enqueue(snap('A', false));
          step++;
          return;
        }
        if (step === 1) {
          controller.enqueue(snap('AB', true));
          step++;
          return;
        }
        if (step === 2) {
          step++;
          await new Promise((r) => setTimeout(r, 120));
          controller.enqueue(snap('ABC', true));
          return;
        }
        // Stay open: only the idle window may end the stream.
      },
    });

    const resp = new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const written: string[] = [];
    const writer = {
      // Emitting each frame outlasts STREAM_TAIL_GRACE_MS, which is exactly
      // the condition that used to drop the in-window trailer.
      writeSSE: async (msg: { data: string }) => {
        await new Promise((r) => setTimeout(r, 300));
        written.push(msg.data);
      },
    };

    await pipeOpenAIStream(resp, writer, 'gpt-4o');
    const content = written
      .filter((d) => d !== '[DONE]')
      .map((d) => JSON.parse(d) as { choices?: Array<{ delta?: { content?: string } }> })
      .map((c) => c.choices?.[0]?.delta?.content)
      .filter((c): c is string => typeof c === 'string')
      .join('');
    expect(content).toBe('ABC');
    expect(written[written.length - 1]).toBe('[DONE]');
  });
});

describe('aggregateNonStream', () => {
  function createSseResponse(events: string[]): Response {
    const stream = new ReadableStream({
      start(controller) {
        for (const ev of events) {
          controller.enqueue(new TextEncoder().encode(ev));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('aggregates cumulative assistant text into ChatCompletionResponse', async () => {
    const meta = {
      content_references: [
        {
          matched_text: pua('cite', 'turn0news75'),
          items: [
            {
              url: 'https://openai.com/about',
              title: 'OpenAI About',
              attribution: 'openai.com',
            },
          ],
        },
      ],
    };

    const ssePayloads = [
      `data: ${JSON.stringify(mkAssistantEvent('First partial'))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent(`Cumulative answer ${pua('cite', 'turn0news75')}`, meta))}\n\n`,
    ];

    const resp = createSseResponse(ssePayloads);
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Tell me about OpenAI in detail please' }],
    };

    const result = await aggregateNonStream(resp, 'gpt-4o', req);

    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('gpt-4o');
    expect(result.choices.length).toBe(1);
    expect(result.choices[0].message.role).toBe('assistant');
    expect(result.choices[0].message.content).toBe(
      'Cumulative answer [openai.com](https://openai.com/about)'
    );
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage.completion_tokens).toBeGreaterThan(0);
    expect(result.usage.total_tokens).toBe(
      result.usage.prompt_tokens + result.usage.completion_tokens
    );
  });

  it('keeps an entity display name and drops an annotation cut off at stream end', async () => {
    const entity = pua('entity', '["city","Huế","Thừa Thiên Huế, Việt Nam"]');
    const resp = createSseResponse([
      `data: ${JSON.stringify(mkAssistantEvent('Tháng 11, ' + entity + ' mưa.'))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent('Tháng 11, ' + entity + ' mưa. ' + entity.slice(0, 12)))}\n\n`,
    ]);
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Huế tháng 11?' }],
    };

    const result = await aggregateNonStream(resp, 'gpt-4o', req);
    expect(result.choices[0].message.content).toBe('Tháng 11, Huế mưa.');
  });

  it('keeps a word tail when the stream ends on an open annotation', async () => {
    const open = PUA_ANNOTATION_START + 'entity' + PUA_ANNOTATION_SEP + '["ci';
    const resp = createSseResponse([
      `data: ${JSON.stringify(mkAssistantEvent('Wait in turn ' + open))}\n\n`,
    ]);
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Wait?' }],
    };
    const result = await aggregateNonStream(resp, 'gpt-4o', req);
    expect(result.choices[0].message.content).toBe('Wait in turn');
  });

  it('does not count a replayed web.run frame as this turn searching', async () => {
    const resp = createSseResponse([
      `data: ${JSON.stringify({
        message: {
          id: 'hist-web',
          author: { role: 'tool', name: 'web.run' },
          status: 'finished_successfully',
          content: { content_type: 'text', parts: [''] },
        },
      })}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent('Hà Nội hiện 17°C.'))}\n\n`,
    ]);
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'weather' }],
    };
    const { result, usedWebSearch } = await aggregateNonStreamWithSignals(resp, 'gpt-4o', req);
    expect(usedWebSearch).toBe(false);
    expect(result.choices[0].message.content).toBe('Hà Nội hiện 17°C.');
  });

  it('handles empty response stream gracefully', async () => {
    const resp = createSseResponse([]);
    const req: ChatCompletionRequest = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Ping' }],
    };

    const result = await aggregateNonStream(resp, 'gpt-4o-mini', req);
    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('');
    expect(result.choices[0].finish_reason).toBe('stop');
  });
});

describe('reply text ending in a colon is preserved', () => {
  function createSseResponse(events: string[]): Response {
    const stream = new ReadableStream({
      start(controller) {
        for (const ev of events) {
          controller.enqueue(new TextEncoder().encode(ev));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  // A colon run only opens a genui fence at the start of a line, so a colon
  // that ends ordinary prose must reach the client verbatim. Withholding it
  // as a possible fence prefix deleted the reply's last character.
  it.each([
    { name: 'single colon', text: 'Summary:' },
    { name: 'double colon', text: 'Example::' },
    { name: 'colon after a URL', text: 'see http://a.b/c:' },
    { name: 'colon in the middle of a reply, last line', text: 'Steps:\n1. one\n2. two\nKey details:' },
    { name: 'CJK fullwidth colon', text: '普通一句话：' },
  ])('streams "$name" verbatim', async ({ text }) => {
    // Cumulative snapshots: the second one extends the first.
    const resp = createSseResponse([
      `data: ${JSON.stringify(mkAssistantEvent(text.slice(0, -1)))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent(text))}\n\n`,
      'data: [DONE]\n\n',
    ]);
    const written: string[] = [];
    const writer = {
      writeSSE: async (msg: { data: string }) => {
        written.push(msg.data);
      },
    };

    await pipeOpenAIStream(resp, writer, 'gpt-4o');

    const streamed = written
      .filter((d) => d !== '[DONE]')
      .map((d) => JSON.parse(d))
      .flatMap((d) => d.choices ?? [])
      .map((c: any) => c.delta?.content ?? '')
      .join('');
    expect(streamed).toBe(text);
  });

  it.each([
    { name: 'single colon', text: 'Summary:' },
    { name: 'double colon', text: 'Example::' },
    { name: 'colon after a URL', text: 'see http://a.b/c:' },
  ])('aggregates "$name" verbatim', async ({ text }) => {
    const resp = createSseResponse([
      `data: ${JSON.stringify(mkAssistantEvent(text.slice(0, -1)))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent(text))}\n\n`,
      'data: [DONE]\n\n',
    ]);
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Reply with exactly that text' }],
    };

    const result = await aggregateNonStream(resp, 'gpt-4o', req);
    expect(result.choices[0].message.content).toBe(text);
  });

  it('still withholds a colon run that starts a line and could become a fence', () => {
    const sp = new StreamProcessor('gpt-4o');
    const chunks = sp.processEvent(mkAssistantEvent('正文\n::'));
    const streamed = chunks
      .map((c) => (c.choices[0].delta as any)?.content ?? '')
      .join('');
    expect(streamed).toBe('正文\n');
    // The fragment never grows into a fence, so flush resolves it to nothing.
    const flushed = sp
      .flush()
      .map((c) => (c.choices[0].delta as any)?.content ?? '')
      .join('');
    expect(flushed).toBe('');
  });
});

describe('sampling limits (stop / max_tokens)', () => {
  function createSseResponse(events: string[]): Response {
    const stream = new ReadableStream({
      start(controller) {
        for (const ev of events) {
          controller.enqueue(new TextEncoder().encode(ev));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  function collect(written: string[]) {
    const chunks = written
      .filter((w) => w !== '[DONE]')
      .map((w) => JSON.parse(w) as any);
    return {
      chunks,
      content: chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join(''),
      finishes: chunks
        .filter((c) => c.choices?.[0]?.finish_reason)
        .map((c) => c.choices[0].finish_reason),
    };
  }

  it('cuts the stream at the first stop sequence without leaking it', async () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'count' }],
      stop: 'STOP',
    };
    const resp = createSseResponse([
      `data: ${JSON.stringify(mkAssistantEvent('1, 2, ST'))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent('1, 2, STOP and after'))}\n\n`,
    ]);
    const written: string[] = [];
    await pipeOpenAIStream(
      resp,
      { writeSSE: async (msg: { data: string }) => void written.push(msg.data) },
      'gpt-4o',
      req
    );

    const { content, finishes } = collect(written);
    expect(content).toBe('1, 2, ');
    expect(content).not.toContain('STOP');
    expect(finishes).toEqual(['stop']);
    expect(written[written.length - 1]).toBe('[DONE]');
  });

  it('releases a held stop prefix when the reply ends before it completes', async () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'count' }],
      stop: ['STOP'],
    };
    const resp = createSseResponse([`data: ${JSON.stringify(mkAssistantEvent('1, 2, ST'))}\n\n`]);
    const written: string[] = [];
    await pipeOpenAIStream(
      resp,
      { writeSSE: async (msg: { data: string }) => void written.push(msg.data) },
      'gpt-4o',
      req
    );

    const { content, finishes } = collect(written);
    expect(content).toBe('1, 2, ST');
    expect(finishes).toEqual(['stop']);
  });

  it('caps a streamed reply at max_tokens and reports finish_reason length', async () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'go' }],
      max_tokens: 4,
    };
    const resp = createSseResponse([
      `data: ${JSON.stringify(mkAssistantEvent('a'.repeat(40)))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent('a'.repeat(200)))}\n\n`,
    ]);
    const written: string[] = [];
    await pipeOpenAIStream(
      resp,
      { writeSSE: async (msg: { data: string }) => void written.push(msg.data) },
      'gpt-4o',
      req
    );

    const { content, finishes } = collect(written);
    expect(content.length).toBe(19);
    expect(finishes).toEqual(['length']);
  });

  it('releases buffered tool-call text instead of dropping the reply at a cap', async () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
      max_tokens: 2,
    };
    const resp = createSseResponse([
      `data: ${JSON.stringify(
        mkAssistantEvent('{"name":"get_weather","arguments":{"city":"Hanoi"}}')
      )}\n\n`,
    ]);
    const written: string[] = [];
    await pipeOpenAIStream(
      resp,
      { writeSSE: async (msg: { data: string }) => void written.push(msg.data) },
      'gpt-4o',
      req
    );

    const { content, finishes } = collect(written);
    expect(content.length).toBeGreaterThan(0);
    expect(finishes).toEqual(['length']);
  });

  it('truncates an aggregated reply at the stop sequence', async () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'greet' }],
      stop: ['STOP'],
    };
    const resp = createSseResponse([
      `data: ${JSON.stringify(mkAssistantEvent('Hello '))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent('Hello world STOP tail'))}\n\n`,
    ]);

    const result = await aggregateNonStream(resp, 'gpt-4o', req);
    expect(result.choices[0].message.content).toBe('Hello world ');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage?.completion_tokens).toBe(3);
  });

  it('leaves a never-completed stop prefix in the aggregated text', async () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'count' }],
      stop: ['STOP'],
    };
    const resp = createSseResponse([`data: ${JSON.stringify(mkAssistantEvent('1, 2, ST'))}\n\n`]);

    const result = await aggregateNonStream(resp, 'gpt-4o', req);
    expect(result.choices[0].message.content).toBe('1, 2, ST');
    expect(result.choices[0].finish_reason).toBe('stop');
  });

  // Guards [audit:truncated-tool-json-leak] on the aggregated (non-stream)
  // path: the limiter cuts the reply before the tool-call parser runs, so the
  // unparseable protocol prefix used to become message.content verbatim.
  describe('tools request truncated mid tool-call JSON', () => {
    const req = (extra?: Partial<ChatCompletionRequest>): ChatCompletionRequest => ({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'search the docs' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_docs',
            description: 'Search docs',
            parameters: { type: 'object' },
          },
        },
      ],
      ...extra,
    });

    it('returns recovered tool_calls with finish_reason length at max_tokens', async () => {
      const resp = createSseResponse([
        `data: ${JSON.stringify(
          mkAssistantEvent(
            '{"tool_calls":[{"name":"search_docs","arguments":{"query":"streaming sse usage","limit":5}}]}'
          )
        )}\n\n`,
      ]);

      const result = await aggregateNonStream(resp, 'gpt-4o', req({ max_tokens: 16 }));
      const choice = result.choices[0];
      expect(choice.finish_reason).toBe('length');
      expect(choice.message.content).toBeNull();
      expect(choice.message.tool_calls?.length).toBe(1);
      expect(choice.message.tool_calls?.[0].function.name).toBe('search_docs');
      expect(choice.message.tool_calls?.[0].function.arguments).toBe('{"query":"streamin');
    });

    it('never ships an unrecoverable protocol prefix as content', async () => {
      const resp = createSseResponse([
        `data: ${JSON.stringify(
          mkAssistantEvent('{"tool_calls":[{"name":"search_docs","arguments":{"query":"q"}}]}')
        )}\n\n`,
      ]);

      const result = await aggregateNonStream(resp, 'gpt-4o', req({ max_tokens: 3 }));
      const choice = result.choices[0];
      expect(choice.finish_reason).toBe('length');
      expect(choice.message.tool_calls ?? []).toEqual([]);
      expect(choice.message.content).toBe('');
    });

    it('returns recovered tool_calls with finish_reason stop when a stop sequence cuts the JSON', async () => {
      const resp = createSseResponse([
        `data: ${JSON.stringify(
          mkAssistantEvent(
            '{"tool_calls":[{"name":"search_docs","arguments":{"query":"streaming sse usage","limit":5}}]}'
          )
        )}\n\n`,
      ]);

      const result = await aggregateNonStream(resp, 'gpt-4o', req({ stop: ['usage'] }));
      const choice = result.choices[0];
      expect(choice.finish_reason).toBe('stop');
      expect(choice.message.content).toBeNull();
      expect(choice.message.tool_calls?.[0].function.name).toBe('search_docs');
      expect(choice.message.tool_calls?.[0].function.arguments).toBe('{"query":"streaming sse');
    });

    it('leaves a complete tool-call reply as finish_reason tool_calls', async () => {
      const resp = createSseResponse([
        `data: ${JSON.stringify(
          mkAssistantEvent('{"tool_calls":[{"name":"search_docs","arguments":{"query":"q"}}]}')
        )}\n\n`,
      ]);

      const result = await aggregateNonStream(resp, 'gpt-4o', req({ max_tokens: 20 }));
      const choice = result.choices[0];
      expect(choice.finish_reason).toBe('tool_calls');
      expect(choice.message.content).toBeNull();
      expect(choice.message.tool_calls?.[0].function.arguments).toBe('{"query":"q"}');
    });
  });

  it('caps an aggregated reply at max_tokens and reports finish_reason length', async () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'go' }],
      max_tokens: 3,
    };
    const resp = createSseResponse([`data: ${JSON.stringify(mkAssistantEvent('a'.repeat(40)))}\n\n`]);

    const result = await aggregateNonStream(resp, 'gpt-4o', req);
    expect(result.choices[0].message.content).toBe('a'.repeat(15));
    expect(result.choices[0].finish_reason).toBe('length');
    expect(result.usage?.completion_tokens).toBe(3);
  });

  // Guards [audit:surrogate-split-on-token-cap] on the live path: the cap cut
  // is applied to every cumulative snapshot, so a split pair would ship a lone
  // high surrogate in a content delta. Concatenated deltas must decode as
  // whole code points.
  it('caps a streamed emoji reply without splitting a surrogate pair', async () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'emoji' }],
      max_tokens: 1,
    };
    const resp = createSseResponse([
      `data: ${JSON.stringify(mkAssistantEvent('😀 😀 😀 😀'))}\n\n`,
      `data: ${JSON.stringify(mkAssistantEvent('😀 😀 😀 😀 😀 😀'))}\n\n`,
    ]);
    const written: string[] = [];
    await pipeOpenAIStream(
      resp,
      { writeSSE: async (msg: { data: string }) => void written.push(msg.data) },
      'gpt-4o',
      req
    );

    const { content, finishes } = collect(written);
    expect(finishes).toEqual(['length']);
    // Well-formedness oracle: a lone surrogate is replaced by U+FFFD when the
    // string is UTF-8 encoded, so an identity round-trip proves every astral
    // character survived as an intact pair.
    expect(new TextDecoder().decode(new TextEncoder().encode(content))).toBe(content);
    expect(() => encodeURIComponent(content)).not.toThrow();
  });

  // Guards [audit:surrogate-split-on-token-cap] on the aggregated path used by
  // non-streaming requests: the returned JSON body must not carry an unpaired
  // surrogate, which strict UTF-8 consumers reject even though JSON escapes it.
  it('caps an aggregated emoji reply without splitting a surrogate pair', async () => {
    const req: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'emoji' }],
      max_tokens: 1,
    };
    const resp = createSseResponse([
      `data: ${JSON.stringify(mkAssistantEvent('😀 😀 😀 😀'))}\n\n`,
    ]);

    const result = await aggregateNonStream(resp, 'gpt-4o', req);
    const content = result.choices[0].message.content ?? '';
    expect(result.choices[0].finish_reason).toBe('length');
    // Same well-formedness oracle as the streaming case: the JSON body must
    // decode to a string that a strict UTF-8 encoder can re-encode losslessly.
    expect(new TextDecoder().decode(new TextEncoder().encode(content))).toBe(content);
    expect(() => encodeURIComponent(content)).not.toThrow();
  });
});

describe('UpstreamTurnSignals & silent downgrade detection', () => {
  function createSseResponse(events: string[]): Response {
    const stream = new ReadableStream({
      start(controller) {
        for (const ev of events) {
          controller.enqueue(new TextEncoder().encode(ev));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  it('detects silent -mini downgrade and model_limits without false positives on explicit -mini', () => {
    expect(isModelDegraded('gpt-6', 'gpt-6-mini', false)).toBe(true);
    expect(isModelDegraded('auto', 'gpt-6-mini', false)).toBe(true);
    expect(isModelDegraded('gpt-6', 'gpt-6', true)).toBe(true);
    expect(isModelDegraded('gpt-6-mini', 'gpt-6-mini', false)).toBe(false);
    expect(isModelDegraded('gpt-6', 'gpt-6', false)).toBe(false);
  });

  it('extracts upstreamModel, sourcesCount, modelLimitReached, and modelDegraded in StreamProcessor & pipeOpenAIStream', async () => {
    const events = [
      `data: ${JSON.stringify({
        type: 'message_stream',
        message: {
          id: 'hist-echo',
          author: { role: 'assistant' },
          status: 'finished_successfully',
          metadata: { model_slug: 'gpt-5-old' },
          content: { content_type: 'text', parts: ['old'] },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'message_stream',
        message: {
          id: 'live-web',
          author: { role: 'tool', name: 'web.run' },
          metadata: {
            search_result_groups: [
              { domain: 'example.com', entries: [{ url: 'https://example.com/a', title: 'A', ref_id: { turn_index: 0, ref_type: 'search', ref_index: 0 } }] },
            ],
          },
          content: { content_type: 'text', parts: [''] },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'message_stream',
        message: {
          id: 'live-1',
          author: { role: 'assistant' },
          status: 'finished_successfully',
          end_turn: true,
          channel: 'final',
          metadata: { message_type: 'next', model_slug: 'gpt-6-mini' },
          content: { content_type: 'text', parts: ['Answer'] },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'server_ste_metadata',
        metadata: { model_slug: 'gpt-6-mini' },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'conversation_detail_metadata',
        model_limits: [{ model_slug: 'gpt-6', resets_after: '2026-11-24T08:00:00Z' }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ];

    let capturedSignals: any = null;
    const written: string[] = [];
    await pipeOpenAIStream(
      createSseResponse(events),
      { writeSSE: async (m) => void written.push(m.data) },
      'gpt-6',
      { model: 'gpt-6', messages: [{ role: 'user', content: 'hi' }], stream: true },
      undefined,
      (sig) => {
        capturedSignals = sig;
      }
    );

    expect(written[written.length - 1]).toBe('[DONE]');
    expect(capturedSignals).toEqual({
      usedWebSearch: true,
      upstreamModel: 'gpt-6-mini',
      sourcesCount: 1,
      modelLimitReached: true,
      modelDegraded: true,
    });
  });

  it('waits for post-turn conversation_detail_metadata past the typing-tail grace', async () => {
    const enc = new TextEncoder();
    const live = `data: ${JSON.stringify({
      type: 'message_stream',
      message: {
        id: 'live-1',
        author: { role: 'assistant' },
        status: 'finished_successfully',
        end_turn: true,
        channel: 'final',
        metadata: { message_type: 'next', model_slug: 'gpt-6' },
        content: { content_type: 'text', parts: ['Done.'] },
      },
    })}\n\n`;
    const limits = `data: ${JSON.stringify({
      type: 'conversation_detail_metadata',
      model_limits: [{ model_slug: 'gpt-6' }],
    })}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(live));
        // The upstream metadata trailer lands after the live turn has been
        // quiet for longer than the client typing-tail grace.
        setTimeout(() => {
          try {
            controller.enqueue(enc.encode(limits));
            controller.close();
          } catch {
            // The reader was cancelled by the old 250ms cutoff.
          }
        }, 400);
      },
    });
    let capturedSignals: any = null;
    const written: string[] = [];
    await pipeOpenAIStream(
      new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
      { writeSSE: async (m) => void written.push(m.data) },
      'gpt-6',
      { model: 'gpt-6', messages: [{ role: 'user', content: 'hi' }], stream: true },
      undefined,
      (sig) => {
        capturedSignals = sig;
      }
    );
    expect(written[written.length - 1]).toBe('[DONE]');
    expect(capturedSignals.modelLimitReached).toBe(true);
    expect(capturedSignals.modelDegraded).toBe(true);
  });

  it('extracts observability signals and populates liveSignals in aggregateNonStreamWithSignals', async () => {
    const resp = createSseResponse([
      `data: ${JSON.stringify({
        type: 'message_stream',
        message: {
          id: 'live-1',
          author: { role: 'assistant' },
          status: 'finished_successfully',
          end_turn: true,
          channel: 'final',
          metadata: { message_type: 'next', model_slug: 'gpt-6' },
          content: { content_type: 'text', parts: ['Done.'] },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'conversation_detail_metadata',
        model_limits: [],
      })}\n\n`,
    ]);
    const liveSignals = {
      usedWebSearch: false,
      upstreamModel: '',
      sourcesCount: 0,
      modelLimitReached: false,
      modelDegraded: false,
    };
    const out = await aggregateNonStreamWithSignals(
      resp,
      'auto',
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      liveSignals
    );
    expect(out.upstreamModel).toBe('gpt-6');
    expect(out.modelDegraded).toBe(false);
    expect(liveSignals.upstreamModel).toBe('gpt-6');
    expect(liveSignals.modelDegraded).toBe(false);
  });
});
