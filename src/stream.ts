import { createParser } from 'eventsource-parser';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  SearchSource,
} from './types';
import {
  ingestMetadata,
  formatCitations,
  splitCitationTail,
  resolveWithheld,
} from './citations';
import {
  buildOpenAIChunk,
  buildFinalChunk,
  buildUsageChunk,
  buildOpenAICompletion,
  flattenMessages,
  countRoughTokens,
  genID,
  wantsStreamUsage,
} from './translate';

/**
 * StreamProcessor manages the state of cumulative snapshots from ChatGPT upstream SSE,
 * diffing deltas, formatting citations, and generating OpenAI streaming chunks.
 */
export class StreamProcessor {
  readonly model: string;
  readonly originalReq?: ChatCompletionRequest;
  readonly messageId: string;
  readonly created: number;

  public sources = new Map<string, SearchSource>();
  public emittedRole = false;
  public prevText = '';
  public withheld = '';

  constructor(
    model: string,
    originalReq?: ChatCompletionRequest,
    messageId?: string,
    created?: number
  ) {
    this.model = model;
    this.originalReq = originalReq;
    this.messageId = messageId || genID('chatcmpl-');
    this.created = created || Math.floor(Date.now() / 1000);
  }

  /**
   * Processes one parsed JSON event from upstream SSE.
   * Returns zero or more OpenAI ChatCompletionChunk payloads.
   */
  processEvent(rawJSON: any): ChatCompletionChunk[] {
    if (!rawJSON || typeof rawJSON !== 'object') {
      return [];
    }

    ingestMetadata(this.sources, rawJSON);

    const ev = rawJSON;
    if (!ev.message || ev.message.author?.role !== 'assistant') {
      return [];
    }

    const parts: string[] = [];
    if (Array.isArray(ev.message.content?.parts)) {
      for (const p of ev.message.content.parts) {
        if (typeof p === 'string') {
          parts.push(p);
        } else if (p && typeof p.text === 'string') {
          parts.push(p.text);
        }
      }
    }
    const full = parts.join('');
    const formatted = formatCitations(full, this.sources);
    const { keep: fullClean, tail } = splitCitationTail(formatted);

    let delta = '';
    if (fullClean.startsWith(this.prevText)) {
      delta = fullClean.slice(this.prevText.length);
    }
    this.prevText = fullClean;
    this.withheld = tail;

    const out: ChatCompletionChunk[] = [];
    if (!this.emittedRole) {
      this.emittedRole = true;
      out.push(
        buildOpenAIChunk(this.messageId, this.created, this.model, {
          role: 'assistant',
        })
      );
    }
    if (delta.length > 0) {
      out.push(
        buildOpenAIChunk(this.messageId, this.created, this.model, {
          content: delta,
        })
      );
    }
    return out;
  }

  /**
   * Flushes stream tail and emits terminal chunks:
   * 1. Any resolved withheld citation fragment (if any)
   * 2. Final chunk with finish_reason: "stop" and token usage
   * 3. Usage chunk if stream_options.include_usage was requested
   */
  flush(): ChatCompletionChunk[] {
    const out: ChatCompletionChunk[] = [];
    if (this.withheld) {
      const fragment = resolveWithheld(this.withheld);
      this.withheld = '';
      if (fragment) {
        if (!this.emittedRole) {
          this.emittedRole = true;
          out.push(
            buildOpenAIChunk(this.messageId, this.created, this.model, {
              role: 'assistant',
            })
          );
        }
        out.push(
          buildOpenAIChunk(this.messageId, this.created, this.model, {
            content: fragment,
          })
        );
        this.prevText += fragment;
      }
    }

    const promptText = this.originalReq?.messages
      ? flattenMessages(this.originalReq.messages)
      : '';
    const promptTokens = countRoughTokens(promptText);
    const completionTokens = countRoughTokens(this.prevText);

    out.push(
      buildFinalChunk(
        this.messageId,
        this.created,
        this.model,
        promptTokens,
        completionTokens
      )
    );

    if (wantsStreamUsage(this.originalReq)) {
      out.push(
        buildUsageChunk(
          this.messageId,
          this.created,
          this.model,
          promptTokens,
          completionTokens
        )
      );
    }

    return out;
  }
}

export type SSEWriter = {
  writeSSE?: (msg: { data: string }) => Promise<void>;
  write?: (data: string | Uint8Array) => Promise<any>;
};

async function emitChunk(
  writer: SSEWriter,
  chunk: ChatCompletionChunk | string
): Promise<void> {
  const data = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
  if (typeof writer.writeSSE === 'function') {
    await writer.writeSSE({ data });
  } else if (typeof writer.write === 'function') {
    await writer.write(`data: ${data}\n\n`);
  }
}

/**
 * pipeOpenAIStream streams upstream SSE response body to the SSEWriter,
 * converting cumulative assistant snapshots into OpenAI chat completion chunks.
 */
export async function pipeOpenAIStream(
  resp: Response,
  writer: SSEWriter,
  model: string,
  originalReq?: ChatCompletionRequest,
  signal?: AbortSignal
): Promise<void> {
  const sp = new StreamProcessor(model, originalReq);
  const pendingChunks: ChatCompletionChunk[] = [];

  const parser = createParser({
    onEvent: (event) => {
      if (event.data === '[DONE]') return;
      try {
        const parsed = JSON.parse(event.data);
        const chunks = sp.processEvent(parsed);
        for (const c of chunks) {
          pendingChunks.push(c);
        }
      } catch {
        // Ignore non-JSON frames
      }
    },
  });

  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    const onAbort = () => {
      try {
        reader.cancel();
      } catch {}
    };

    if (signal) {
      if (signal.aborted) {
        try {
          await reader.cancel();
        } catch {}
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      while (true) {
        if (signal?.aborted) {
          try {
            await reader.cancel();
          } catch {}
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
        while (pendingChunks.length > 0) {
          if (signal?.aborted) return;
          const chunk = pendingChunks.shift()!;
          await emitChunk(writer, chunk);
        }
      }
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      reader.releaseLock();
    }
  }

  if (signal?.aborted) {
    return;
  }

  // Consume any remaining buffered data in the parser
  if (typeof (parser as any).reset === 'function') {
    try {
      (parser as any).reset({ consume: true });
    } catch {
      // ignore
    }
    while (pendingChunks.length > 0) {
      const chunk = pendingChunks.shift()!;
      await emitChunk(writer, chunk);
    }
  }

  // Flush stream tail and final chunks
  const tailChunks = sp.flush();
  for (const chunk of tailChunks) {
    await emitChunk(writer, chunk);
  }

  // Final [DONE] message
  await emitChunk(writer, '[DONE]');
}

/**
 * aggregateNonStream consumes the entire upstream SSE response, accumulates
 * full assistant text, computes token usage, and returns a ChatCompletionResponse.
 */
export async function aggregateNonStream(
  resp: Response,
  model: string,
  originalReq: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  const sources = new Map<string, SearchSource>();
  let emitted = '';
  let withheld = '';

  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    const parser = createParser({
      onEvent: (event) => {
        if (event.data === '[DONE]') return;
        try {
          const parsed = JSON.parse(event.data);
          ingestMetadata(sources, parsed);
          if (!parsed.message || parsed.message.author?.role !== 'assistant') {
            return;
          }
          const parts: string[] = [];
          if (Array.isArray(parsed.message.content?.parts)) {
            for (const p of parsed.message.content.parts) {
              if (typeof p === 'string') {
                parts.push(p);
              } else if (p && typeof p.text === 'string') {
                parts.push(p.text);
              }
            }
          }
          const full = parts.join('');
          const formatted = formatCitations(full, sources);
          if (!formatted) return;
          const split = splitCitationTail(formatted);
          emitted = split.keep;
          withheld = split.tail;
        } catch {
          // ignore
        }
      },
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }

    if (typeof (parser as any).reset === 'function') {
      try {
        (parser as any).reset({ consume: true });
      } catch {
        // ignore
      }
    }
  }

  const finalText = emitted + resolveWithheld(withheld);
  const promptText = originalReq?.messages
    ? flattenMessages(originalReq.messages)
    : '';
  const promptTokens = countRoughTokens(promptText);
  const completionTokens = countRoughTokens(finalText);

  return buildOpenAICompletion(
    genID('chatcmpl-'),
    Math.floor(Date.now() / 1000),
    model,
    finalText,
    promptTokens,
    completionTokens
  );
}
