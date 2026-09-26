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
  splitGenuiContainerTail,
  stripGenuiContainers,
  resolveWithheld,
} from './citations';
import { ToolCallStreamState } from './toolcall_stream';
import { buildToolCallsChatMessage } from './toolcall_wire';
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
  /** Latest live-reply raw text (citations+citations cleaned), pre-flush. */
  public lastFullText = '';
  public withheld = '';
  /** Bare genui fence fragment withheld from emission (may still grow). */
  public withheldGenui = '';
  public toolCallState?: ToolCallStreamState;
  /**
   * Message id of the live assistant reply being streamed. Upstream
   * conversation streams re-emit replayed history frames (multi-frame
   * history) as already-complete messages before the fresh reply; only the
   * live message may be streamed back to the client. Empty until the first
   * live snapshot designates it.
   */
  public liveMessageId = '';
  /**
   * True once the live message reports its turn is over
   * (status "finished_successfully" + end_turn). Upstream then holds the
   * socket open for another 1-3s before closing; pipeOpenAIStream uses this
   * to stop waiting (see STREAM_TAIL_GRACE_MS) instead of idling.
   */
  public endedTurn = false;

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
    const anyReq = originalReq as any;
    if (anyReq && Array.isArray(anyReq.tools) && anyReq.tools.length > 0 && anyReq.tool_choice !== 'none') {
      this.toolCallState = new ToolCallStreamState();
    }
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

    // Multi-frame history replay: the upstream stream re-emits each replayed
    // assistant frame as an already-complete message before the fresh reply.
    // Echo frames arrive "finished_successfully" with no live markers, while
    // every snapshot of the live reply carries "in_progress" status or the
    // "next"/"final" turn markers. History echoes must not be streamed back —
    // only the live reply is new content.
    const msgId = typeof ev.message.id === 'string' ? ev.message.id : '';
    if (msgId !== this.liveMessageId) {
      const status = ev.message.status;
      const isHistoryEcho =
        (status === 'finished_successfully' || status === 'finished') &&
        ev.message?.metadata?.message_type !== 'next' &&
        ev.message.channel !== 'final';
      if (isHistoryEcho) {
        return [];
      }
      // The live reply (re)starts: reset the cumulative snapshot-diff state.
      this.liveMessageId = msgId;
      this.prevText = '';
      this.withheld = '';
      this.withheldGenui = '';
    }

    // The live message reached its terminal frame: the turn is over, so no
    // further content can arrive on this message. end_turn is only set by the
    // upstream when the model actually ended its turn, which makes it a safe
    // stop signal (a history echo already returned above).
    if (
      ev.message.status === 'finished_successfully' &&
      ev.message.end_turn === true
    ) {
      this.endedTurn = true;
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
    // Bare genui containers (":::writing{…}" fence lines around the body)
    // are stripped AFTER citations so a link inside a container survives,
    // while its fence lines are removed.
    const stripped = stripGenuiContainers(formatted);
    const { keep: citationClean, tail } = splitCitationTail(stripped);
    // A bare ":::" fence fragment at the very end may still grow into a full
    // opener/closer line on the next snapshot; withhold it like a citation
    // fragment so partial marker text never reaches the client.
    const { keep: fullClean, tail: genuiTail } = splitGenuiContainerTail(citationClean);
    this.withheldGenui = genuiTail;
    this.lastFullText = fullClean;

    // Tool-call stream detection: when enabled, the detector may decide to
    // buffer (JSON could still be a tool call), flush (plain text — emit the
    // pending delta), or emit tool_calls deltas instead of content.
    if (this.toolCallState) {
      const emits = this.toolCallState.feed(fullClean);
      const out: ChatCompletionChunk[] = [];
      for (const e of emits) {
        if (e.delta?.tool_calls) {
          if (!this.emittedRole) {
            this.emittedRole = true;
            out.push(
              buildOpenAIChunk(this.messageId, this.created, this.model, {
                role: 'assistant',
              })
            );
          }
          out.push(
            buildOpenAIChunk(this.messageId, this.created, this.model, e.delta as any)
          );
        } else if (e.delta?.content) {
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
              content: e.delta.content,
            })
          );
        }
      }
      this.prevText = fullClean;
      return out;
    }

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

  /** Finish reason the current run would end with ("tool_calls" if detected). */
  toolCallFinishReason(): 'tool_calls' | 'stop' {
    return this.toolCallState ? this.toolCallState.finishReason() : 'stop';
  }

  /**
   * Flushes stream tail and emits terminal chunks:
   * 1. Any resolved withheld citation fragment (if any)
   * 2. Final chunk with finish_reason ("stop"/"tool_calls"), never carrying usage
   * 3. When stream_options.include_usage was requested: exactly one usage chunk
   *    (choices: []) — the only usage-bearing frame of the stream
   */
  flush(): ChatCompletionChunk[] {
    const out: ChatCompletionChunk[] = [];
    if (this.withheld || this.withheldGenui) {
      const fragment = resolveWithheld(this.withheldGenui) + resolveWithheld(this.withheld);
      this.withheld = '';
      this.withheldGenui = '';
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
        this.toolCallState ? this.toolCallState.finishReason() : 'stop'
      )
    );

    // Spec-conformant usage delivery: only when stream_options.include_usage
    // was requested, and only in this dedicated `choices: []` chunk. The
    // finish chunk above never carries usage.
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
 * Upstream keeps the SSE socket open 1.3-3s AFTER the live message reports
 * end_turn. Waiting for that close only stalls the client, so once the
 * terminal frame is seen the reader waits at most this long for any trailing
 * frames (late metadata/history echoes) and then finalizes the stream.
 * Shared with the buffered retry reader in src/index.ts.
 */
export const STREAM_TAIL_GRACE_MS = 250;

/** Sentinel returned by the bounded tail read when the grace window expires. */
export const READ_TIMEOUT = Symbol('read-timeout');

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
    let readTimedOut = false;

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
      // Armed once the live turn ends; bounds how long we wait for the socket.
      let graceDeadline = 0;
      while (true) {
        if (signal?.aborted) {
          try {
            await reader.cancel();
          } catch {}
          return;
        }

        let done = false;
        if (graceDeadline > 0) {
          const remaining = graceDeadline - Date.now();
          if (remaining <= 0) {
            readTimedOut = true;
            break;
          }
          const timeout = Promise.withResolvers<typeof READ_TIMEOUT>();
          const tid = setTimeout(() => timeout.resolve(READ_TIMEOUT), remaining);
          const raced = await Promise.race([reader.read(), timeout.promise]);
          clearTimeout(tid);
          if (raced === READ_TIMEOUT) {
            readTimedOut = true;
            break;
          }
          done = raced.done;
          if (!done && raced.value) {
            parser.feed(decoder.decode(raced.value, { stream: true }));
          }
        } else {
          const { done: d, value } = await reader.read();
          done = d;
          if (!done && value) {
            parser.feed(decoder.decode(value, { stream: true }));
          }
        }

        while (pendingChunks.length > 0) {
          if (signal?.aborted) return;
          const chunk = pendingChunks.shift()!;
          await emitChunk(writer, chunk);
        }

        if (done) break;
        // Idle-based window: reset AFTER emission so a slow client sink (whose
        // drain can take longer than the grace period) never consumes the
        // window and causes an in-window trailing frame to be dropped. The
        // stream now ends after STREAM_TAIL_GRACE_MS of upstream silence
        // following the last emitted frame.
        if (sp.endedTurn) {
          graceDeadline = Date.now() + STREAM_TAIL_GRACE_MS;
        }
      }
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      if (readTimedOut) {
        // A read is still in flight on the abandoned socket; cancel before
        // releasing the lock.
        try {
          await reader.cancel();
        } catch {}
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
  let withheldGenui = '';

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
          // Multi-frame history replay: skip re-emitted assistant frames —
          // they are conversation history, not this turn's reply (mirrors the
          // StreamProcessor gate).
          if (parsed.message.status === 'finished_successfully') {
            const isHistoryEcho =
              parsed.message?.metadata?.message_type !== 'next' &&
              parsed.message.channel !== 'final';
            if (isHistoryEcho) {
              return;
            }
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
          // Bare genui containers: strip fence lines, keep the body.
          const stripped = stripGenuiContainers(formatted);
          if (!stripped) return;
          const citeSplit = splitCitationTail(stripped);
          const genuiSplit = splitGenuiContainerTail(citeSplit.keep);
          emitted = genuiSplit.keep;
          withheld = citeSplit.tail;
          withheldGenui = genuiSplit.tail;
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

  const finalText =
    emitted + resolveWithheld(withheldGenui) + resolveWithheld(withheld);
  const promptText = originalReq?.messages
    ? flattenMessages(originalReq.messages)
    : '';
  const promptTokens = countRoughTokens(promptText);
  const completionTokens = countRoughTokens(finalText);

  // Tool-call conversion: when the reply matches the tool-call convention,
  // return an assistant message carrying tool_calls (content=null) and
  // finish_reason "tool_calls".
  const toolMsg = buildToolCallsChatMessage(finalText);
  if (toolMsg) {
    return {
      id: genID('chatcmpl-'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: toolMsg,
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    } as any;
  }

  return buildOpenAICompletion(
    genID('chatcmpl-'),
    Math.floor(Date.now() / 1000),
    model,
    finalText,
    promptTokens,
    completionTokens
  );
}
