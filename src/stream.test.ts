import { describe, it, expect } from 'vitest';
import {
  StreamProcessor,
  pipeOpenAIStream,
  aggregateNonStream,
} from './stream';
import type { ChatCompletionRequest } from './types';
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

  it('emits extra usage chunk when stream_options.include_usage is true', () => {
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

    // Penultimate chunk: finish_reason: 'stop' with usage
    const stopChunk = finalChunks[0];
    expect(stopChunk.choices[0].finish_reason).toBe('stop');
    expect(stopChunk.usage).toBeDefined();
    expect(stopChunk.usage!.total_tokens).toBeGreaterThan(0);

    // Last chunk: choices: [] with usage
    const usageChunk = finalChunks[1];
    expect(usageChunk.choices.length).toBe(0);
    expect(usageChunk.usage).toBeDefined();
    expect(usageChunk.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(usageChunk.usage!.completion_tokens).toBeGreaterThan(0);
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
