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
  splitOpenAnnotation,
  splitGenuiContainerTail,
  stripGenuiContainers,
  resolveWithheld,
} from './citations';
import { ToolCallStreamState, type StreamEmit } from './toolcall_stream';
import { buildToolCallsChatMessage } from './toolcall_wire';
import { isTruncatedToolCallPrefix, toolChoiceName } from './toolcall';
import { SamplingLimiter, resolveSampling, stopPrefixSuffix } from './sampling';
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
 * Upstream signals collected during a turn for observability and pool health.
 */
export interface UpstreamTurnSignals {
  usedWebSearch: boolean;
  upstreamModel: string;
  sourcesCount: number;
  modelLimitReached: boolean;
  modelDegraded: boolean;
}

/**
 * True when upstream silently downgraded the turn or reported a model quota
 * limit (e.g. guest device exhausted its 10-message `gpt-6` budget and fell
 * back to `gpt-6-mini`). Requests that explicitly asked for a `-mini` slug
 * are not marked degraded unless upstream also emitted `model_limits`.
 */
export function isModelDegraded(
  requestedModel: string,
  upstreamModel: string,
  modelLimitReached: boolean
): boolean {
  if (modelLimitReached) return true;
  if (upstreamModel.endsWith('-mini') && requestedModel !== '' && !requestedModel.endsWith('-mini')) {
    return true;
  }
  return false;
}

function isHistoryEchoAssistantFrame(msg: any): boolean {
  if (!msg || msg.author?.role !== 'assistant') return false;
  const status = msg.status;
  return (
    (status === 'finished_successfully' || status === 'finished') &&
    msg.metadata?.message_type !== 'next' &&
    msg.channel !== 'final'
  );
}

function extractUpstreamModel(ev: any): string {
  if (ev?.type === 'server_ste_metadata' && typeof ev.metadata?.model_slug === 'string' && ev.metadata.model_slug) {
    return ev.metadata.model_slug;
  }
  const msg = ev?.message;
  if (!msg || isHistoryEchoAssistantFrame(msg)) return '';
  if (typeof msg.metadata?.model_slug === 'string' && msg.metadata.model_slug) {
    return msg.metadata.model_slug;
  }
  if (typeof msg.metadata?.resolved_model_slug === 'string' && msg.metadata.resolved_model_slug) {
    return msg.metadata.resolved_model_slug;
  }
  return '';
}

function hasModelLimits(ev: any): boolean {
  return (
    ev?.type === 'conversation_detail_metadata' &&
    Array.isArray(ev.model_limits) &&
    ev.model_limits.length > 0
  );
}

/**
 * True when an upstream message frame belongs to the model's own web search:
 * the assistant addressing the web tool (recipient "web.run") or that tool's
 * reply. Callers never send such frames, so they cannot be history echoes.
 */
export function isWebSearchFrame(message: any): boolean {
  const isWebTool = (name: unknown) => typeof name === 'string' && (name === 'web' || name.startsWith('web.'));
  return isWebTool(message?.recipient) || (message?.author?.role === 'tool' && isWebTool(message.author.name));
}

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
  /**
   * Trailing fragment that could still complete into a stop sequence. Emitted
   * by flush() when the reply ends before the sequence completes.
   */
  public withheldStop = '';
  /**
   * Stop-sequence / completion-token cap enforcement. Upstream honours
   * neither, so the gateway cuts the text it replays (see src/sampling.ts).
   */
  readonly sampling: SamplingLimiter;
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
  /** True once the upstream model ran its own web search during this reply. */
  public usedWebSearch = false;
  /** Actual upstream model slug observed on live frames or server_ste_metadata. */
  public upstreamModel = '';
  /** True when upstream reported `conversation_detail_metadata.model_limits`. */
  public modelLimitReached = false;
  /** True once the post-turn `conversation_detail_metadata` frame was parsed. */
  public sawTurnMetadata = false;

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
    this.sampling = new SamplingLimiter(resolveSampling(originalReq));
    const anyReq = originalReq as any;
    if (anyReq && Array.isArray(anyReq.tools) && anyReq.tools.length > 0 && anyReq.tool_choice !== 'none') {
      this.toolCallState = new ToolCallStreamState({
        singleCall: originalReq?.parallel_tool_calls === false,
        preferredName: toolChoiceName(originalReq?.tool_choice),
      });
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
    if (ev?.type === 'conversation_detail_metadata') {
      this.sawTurnMetadata = true;
    }
    if (hasModelLimits(ev)) {
      this.modelLimitReached = true;
    }
    const detectedModel = extractUpstreamModel(ev);
    if (detectedModel) {
      this.upstreamModel = detectedModel;
    }
    // A replayed web.run frame is history, not this turn's search. Latch only
    // a live frame: finished echoes have no "next"/"final" marker.
    const searchMsg = ev.message;
    const searchStatus = searchMsg?.status;
    const replayedSearch =
      !!searchMsg &&
      (searchStatus === 'finished_successfully' || searchStatus === 'finished') &&
      searchMsg.metadata?.message_type !== 'next' &&
      searchMsg.channel !== 'final';
    if (searchMsg && isWebSearchFrame(searchMsg) && !replayedSearch) {
      this.usedWebSearch = true;
    }
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
      this.withheldStop = '';
      // A latched cut belonged to the previous live message; slicing the new
      // reply at the old position would drop its start and misreport finish.
      this.sampling.reset();
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
    // Cut an unclosed annotation off before formatting so its payload cannot
    // leak. Do not append that tail to the cite withhold: resolveWithheld
    // drops any fragment that still contains a START rune, which would also
    // delete a keepable ASCII tail such as " turn".
    const { keep: closedText } = splitOpenAnnotation(full);
    const formatted = formatCitations(closedText, this.sources);
    // Bare genui containers (":::writing{…}" fence lines around the body)
    // are stripped AFTER citations so a link inside a container survives,
    // while its fence lines are removed.
    const stripped = stripGenuiContainers(formatted);
    // Enforce stop sequences and the completion-token cap on the full cleaned
    // text, before it is split into emittable text and withheld fragments: a
    // stop sequence must not survive inside a buffered tail and then leak.
    const limited = this.sampling.limit(stripped);
    const { keep: citationClean, tail } = splitCitationTail(limited);
    // A bare ":::" fence fragment at the very end may still grow into a full
    // opener/closer line on the next snapshot; withhold it like a citation
    // fragment so partial marker text never reaches the client.
    const { keep: genuiKeep, tail: genuiTail } = splitGenuiContainerTail(citationClean);
    // A trailing fragment that is only a prefix of a stop sequence could still
    // become one on the next snapshot; hold it back (flush releases it if the
    // reply ends first). No hold once a limit already ended the reply.
    const stopHold =
      this.sampling.limitFinish() === null
        ? stopPrefixSuffix(genuiKeep, this.sampling.stops)
        : '';
    const fullClean = stopHold
      ? genuiKeep.slice(0, genuiKeep.length - stopHold.length)
      : genuiKeep;
    this.withheldStop = stopHold;
    this.withheldGenui = genuiTail;
    this.withheld = tail;
    this.lastFullText = fullClean;

    // Tool-call stream detection: when enabled, the detector may decide to
    // buffer (JSON could still be a tool call), flush (plain text — emit the
    // pending delta), or emit tool_calls deltas instead of content.
    if (this.toolCallState) {
      const out = this.chunksFromEmits(this.toolCallState.feed(fullClean));
      // A fired limit ends the reply while the detector may still be holding
      // text that could have become a tool-call payload: upstream sends no
      // further snapshot to resolve it, so decide those bytes here — recover
      // the calls it carried, drop our own carrier, or release a JSON answer
      // the limit merely cut short.
      if (this.sampling.limitFinish() !== null) {
        out.push(...this.chunksFromEmits(this.toolCallState.releaseHeld(fullClean)));
      }
      this.prevText = fullClean;
      return out;
    }

    let delta = '';
    if (fullClean.startsWith(this.prevText)) {
      delta = fullClean.slice(this.prevText.length);
    }
    this.prevText = fullClean;

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

  /** Observability and pool-health signals collected for this upstream turn. */
  signals(): UpstreamTurnSignals {
    return {
      usedWebSearch: this.usedWebSearch,
      upstreamModel: this.upstreamModel,
      sourcesCount: this.sources.size,
      modelLimitReached: this.modelLimitReached,
      modelDegraded: isModelDegraded(this.model, this.upstreamModel, this.modelLimitReached),
    };
  }

  /**
   * Convert detection emits into OpenAI chunks. The assistant role frame is
   * emitted once, before the first delta of any kind, so a reply that turns
   * out to be tool calls still opens with a well-formed role chunk.
   */
  private chunksFromEmits(emits: StreamEmit[]): ChatCompletionChunk[] {
    const out: ChatCompletionChunk[] = [];
    for (const e of emits) {
      if (!e.delta) continue;
      if (!this.emittedRole) {
        this.emittedRole = true;
        out.push(
          buildOpenAIChunk(this.messageId, this.created, this.model, {
            role: 'assistant',
          })
        );
      }
      out.push(buildOpenAIChunk(this.messageId, this.created, this.model, e.delta));
    }
    return out;
  }

  /**
   * Flushes stream tail and emits terminal chunks:
   * 1. Any resolved withheld citation fragment and the held stop-prefix (if any)
   * 2. Final chunk with finish_reason ("stop"/"length"/"tool_calls"), never
   *    carrying usage
   * 3. When stream_options.include_usage was requested: exactly one usage chunk
   *    (choices: []) — the only usage-bearing frame of the stream
   */
  flush(): ChatCompletionChunk[] {
    const out: ChatCompletionChunk[] = [];
    // Tool-call detection may still be holding the whole reply: a plain JSON
    // answer (leading "{", no tool_calls) never resolves as a tool call, so the
    // detector buffers it for the entire turn. Release it here — the turn is
    // over, so held text is content, not a pending tool call.
    if (this.toolCallState) {
      // The detector may still be holding the whole reply: a plain JSON answer
      // (leading "{", no tool_calls) never resolves, and a limit-truncated
      // payload is decided the same way (see ToolCallStreamState.releaseHeld).
      out.push(...this.chunksFromEmits(this.toolCallState.finalize()));
    }
    const emittedToolCalls = this.toolCallState?.emittedToolCalls === true;
    if (this.withheld || this.withheldGenui || this.withheldStop) {
      // After tool calls the accumulated text is the call JSON; a withheld
      // text fragment would leak it as content.
      const fragment = emittedToolCalls
        ? ''
        : // Source order: the held stop-prefix sat at the end of genuiKeep,
          // BEFORE the genui and citation tails — reassemble it that way.
          this.withheldStop +
          resolveWithheld(this.withheldGenui) +
          resolveWithheld(this.withheld);
      this.withheld = '';
      this.withheldGenui = '';
      this.withheldStop = '';
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
        // A fired limit is the reason the reply stopped producing: OpenAI
        // reports "length" with the partial arguments when max_tokens cuts a
        // tool call, and "stop" when a stop sequence does.
        this.sampling.limitFinish() ?? (emittedToolCalls ? 'tool_calls' : 'stop')
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
/**
 * After the live assistant message reports `end_turn`, the upstream still
 * sends `conversation_detail_metadata` (which carries `model_limits`) and
 * closes the socket. That trailer lands ~0.4-0.8s after the last content
 * frame, i.e. after the 250ms typing tail. Keep reading for it so the device
 * retirement and `model_degraded` signals are not silently dropped for
 * streaming clients; stop as soon as the event is parsed.
 */
export const TURN_METADATA_GRACE_MS = 1500;

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
  signal?: AbortSignal,
  onFinish?: (signals: UpstreamTurnSignals) => void | Promise<void>
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
        // The turn's live content is complete, but the upstream still emits
        // its metadata trailer (including model_limits). Stop as soon as that
        // frame is parsed; otherwise keep the read window open long enough to
        // receive it. Reset AFTER emission so a slow client sink never
        // consumes the window.
        if (sp.endedTurn) {
          if (sp.sawTurnMetadata) {
            try {
              await reader.cancel();
            } catch {}
            break;
          }
          graceDeadline = Date.now() + TURN_METADATA_GRACE_MS;
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

  if (onFinish) {
    await onFinish(sp.signals());
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
  return (await aggregateNonStreamWithSignals(resp, model, originalReq)).result;
}

/**
 * aggregateNonStreamWithSignals is aggregateNonStream plus upstream signals
 * that are not part of the OpenAI response body (whether the model ran its
 * own web search, actual upstream model, source count, and silent downgrade
 * detection), for observability headers and pool retirement.
 */
export async function aggregateNonStreamWithSignals(
  resp: Response,
  model: string,
  originalReq: ChatCompletionRequest,
  liveSignals?: UpstreamTurnSignals
): Promise<{ result: ChatCompletionResponse } & UpstreamTurnSignals> {
  const sources = new Map<string, SearchSource>();
  let usedWebSearch = false;
  let upstreamModel = '';
  let modelLimitReached = false;
  let emitted = '';
  let withheld = '';
  let withheldGenui = '';

  const syncLive = () => {
    if (!liveSignals) return;
    liveSignals.usedWebSearch = usedWebSearch;
    liveSignals.upstreamModel = upstreamModel;
    liveSignals.sourcesCount = sources.size;
    liveSignals.modelLimitReached = modelLimitReached;
    liveSignals.modelDegraded = isModelDegraded(model, upstreamModel, modelLimitReached);
  };

  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    const parser = createParser({
      onEvent: (event) => {
        if (event.data === '[DONE]') return;
        try {
          const parsed = JSON.parse(event.data);
          ingestMetadata(sources, parsed);
          if (hasModelLimits(parsed)) {
            modelLimitReached = true;
          }
          const detectedModel = extractUpstreamModel(parsed);
          if (detectedModel) {
            upstreamModel = detectedModel;
          }
          const searchMsg = parsed.message;
          const searchStatus = searchMsg?.status;
          const replayedSearch =
            !!searchMsg &&
            (searchStatus === 'finished_successfully' || searchStatus === 'finished') &&
            searchMsg.metadata?.message_type !== 'next' &&
            searchMsg.channel !== 'final';
          if (searchMsg && isWebSearchFrame(searchMsg) && !replayedSearch) {
            usedWebSearch = true;
          }
          syncLive();
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
          // See processEvent: the open annotation stays out of `withheld`.
          const { keep: closedText } = splitOpenAnnotation(full);
          const formatted = formatCitations(closedText, sources);
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

  syncLive();
  const sourcesCount = sources.size;
  const modelDegraded = isModelDegraded(model, upstreamModel, modelLimitReached);

  // Stop sequences and the completion-token cap are enforced on the assembled
  // reply: upstream honours neither parameter, so the gateway cuts the text and
  // reports the matching finish_reason.
  const limiter = new SamplingLimiter(resolveSampling(originalReq));
  const finalText = limiter.limit(
    emitted + resolveWithheld(withheldGenui) + resolveWithheld(withheld)
  );
  const promptText = originalReq.messages
    ? flattenMessages(originalReq.messages)
    : '';
  const promptTokens = countRoughTokens(promptText);
  const completionTokens = countRoughTokens(finalText);

  // Tool-call conversion: when the reply matches the tool-call convention,
  // return an assistant message carrying tool_calls (content=null) and
  // finish_reason "tool_calls". A limit-cut payload is salvaged the same way;
  // the fired limit stays the reported reason (OpenAI reports "length" when
  // max_tokens cuts a call, "stop" when a stop sequence does).
  const limitReason = limiter.limitFinish();
  const toolMsg = buildToolCallsChatMessage(finalText, {
    singleCall: originalReq?.parallel_tool_calls === false,
    preferredName: toolChoiceName(originalReq?.tool_choice),
  });
  if (toolMsg) {
    const result = {
      id: genID('chatcmpl-'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: toolMsg,
          finish_reason: limitReason ?? 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    } as any;
    return { result, usedWebSearch, upstreamModel, sourcesCount, modelLimitReached, modelDegraded };
  }

  // A cut left nothing but the tail of our own protocol carrier (no call name
  // survived). That text is the gateway's encoding, not an answer, so report
  // an empty completion instead of shipping it as assistant content.
  const leakedCarrier = limitReason !== null && isTruncatedToolCallPrefix(finalText);
  const answer = leakedCarrier ? '' : finalText;
  const answerTokens = leakedCarrier ? 0 : completionTokens;

  const result = buildOpenAICompletion(
    genID('chatcmpl-'),
    Math.floor(Date.now() / 1000),
    model,
    answer,
    promptTokens,
    answerTokens,
    limitReason ?? 'stop'
  );
  return { result, usedWebSearch, upstreamModel, sourcesCount, modelLimitReached, modelDegraded };
}
