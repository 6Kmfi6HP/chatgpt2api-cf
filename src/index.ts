import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, ChatCompletionRequest, ChatCompletionResponse } from './types';
import { UpstreamClient, StatusError } from './client';
import { deviceManager as defaultDeviceManager, DeviceManager } from './device';
import { flattenMessages, lastUserMessageText } from './translate';
import { buildAnonRequestBodyWithTools } from './toolcall_wire';
import { getModelCatalog } from './catalog';
import { pipeOpenAIStream, aggregateNonStream, StreamProcessor, STREAM_TAIL_GRACE_MS, READ_TIMEOUT } from './stream';
import { createParser } from 'eventsource-parser';
import {
  collectImageRefs,
  resolveImage,
  buildMultimodalContent,
  type ResolvedImage,
} from './image_parts';
import { uploadImage, sniffImageMime, defaultExtensionForMime } from './upload';

export interface AppOptions {
  client?: UpstreamClient;
  deviceManager?: DeviceManager;
  /**
   * Override the non-streaming commit deadline (ms) — test seam. Production
   * uses NONSTREAM_COMMIT_DEADLINE_MS.
   */
  nonStreamCommitDeadlineMs?: number;
  /**
   * Override the SSE keepalive / heartbeat interval (ms) — test seam.
   * Production uses SSE_PING_INTERVAL_MS.
   */
  keepAliveIntervalMs?: number;
}



/** Refusal patterns anonymous models emit instead of a tool call. */
const REFUSAL_PATTERNS = [
  /unable to (access|use|invoke|retrieve|determine)/i,
  /can'?t (access|use|invoke|determine|retrieve)/i,
  /cannot (access|use|invoke|determine|retrieve)/i,
  /don'?t have (access|the)/i,
  /tool .{0,24}(available|accessible)/i,
  /no access to/i,
  /can'?t determine that from/i,
  /from (public web|public) results/i,
];

/** True when a reply looks like a tool refusal rather than a real answer. */
export function looksLikeRefusal(text: string): boolean {
  if (!text) return false;
  return REFUSAL_PATTERNS.some((p) => p.test(text));
}

/**
 * True when the request demands a tool call: tool_choice "required" or a named
 * function. The upstream DTO has no native knob, so this only strengthens the
 * compiled protocol wording — these are strong hints, not guarantees, which is
 * exactly why a plain-text reply under them is retried below.
 */
export function requiresToolCall(req: ChatCompletionRequest): boolean {
  const choice = req?.tool_choice;
  if (choice === 'required') return true;
  if (choice && typeof choice === 'object') {
    const name = choice.function?.name;
    return typeof name === 'string' && name !== '';
  }
  return false;
}

/**
 * The tool name demanded by tool_choice, or null when the choice does not name
 * a specific function.
 */
export function requiredToolName(req: ChatCompletionRequest): string | null {
  const choice = req?.tool_choice;
  if (choice && typeof choice === 'object') {
    const name = choice.function?.name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return null;
}

/**
 * True when a completion breaks the request's tool contract: the model neither
 * called a tool nor produced an acceptable plain answer. A refusal-looking
 * reply always qualifies; under a mandatory tool_choice any tool-less reply
 * qualifies, even fluent prose — and a named tool_choice additionally requires
 * the model to have called THAT tool.
 */
export function violatesToolContract(
  req: ChatCompletionRequest,
  result: ChatCompletionResponse | null
): boolean {
  const choice = result?.choices?.[0];
  if (!choice) return false;
  const calls = choice.message?.tool_calls ?? [];
  if (calls.length > 0) {
    // A named tool_choice is enforced, not just suggested: calling some other
    // tool still breaks the contract the protocol frame demanded.
    const demanded = requiredToolName(req);
    if (demanded && !calls.some((c) => c.function?.name === demanded)) return true;
    return false;
  }
  if (looksLikeRefusal(choice.message?.content ?? '')) return true;
  return requiresToolCall(req);
}

/**
 * Non-streaming commit deadline. A non-stream response body is only complete
 * once upstream generation ends, which can take 20s+ — longer than the default
 * read-idle timeout of some clients (Cursor ships 10s). Deferring the HTTP
 * commit that long is what makes them give up. After this deadline the handler
 * commits an early 200 with a chunked body and keeps it warm with whitespace
 * heartbeats (leading whitespace is legal before a JSON value and the final
 * body is still a single JSON.parse-able document).
 */
const NONSTREAM_COMMIT_DEADLINE_MS = 8000;

/**
 * SSE keepalive interval. Long upstream waits (especially tool-request
 * buffering before any decision) leave the socket byte-idle; `: ping` comment
 * lines are SSE comments that every spec-compliant parser ignores, so they
 * reset client read-idle timers without appearing in the data stream.
 */
const SSE_PING_INTERVAL_MS = 5000;

/** Whitespace heartbeat payload written between the early 200 commit and the JSON body. */
const NONSTREAM_HEARTBEAT = '\n';

/**
 * Tool-request refusal decision window. A refusal ("I'm unable to access the
 * weather tool") is legible in its opening clause, so the attempt commits as
 * soon as either trigger fires on non-refusal text:
 *
 *  - TOOL_REFUSAL_DECISION_CHARS of text, or
 *  - TOOL_REFUSAL_DECISION_MS held since the first unsent chunk.
 *
 * Buffering the whole reply (the previous behavior) destroyed the typing effect
 * for every client that sends `tools` — which is most of them. The byte trigger
 * alone was still too coarse because upstream delivers its opening snapshots in
 * a burst, so the time trigger bounds how long the client waits for the first
 * frame when the model starts slowly.
 */
const TOOL_REFUSAL_DECISION_CHARS = 80;
const TOOL_REFUSAL_DECISION_MS = 600;

/** OpenAI-shaped error payload (mirrors the global onError handler's mapping). */
export function openAIErrorBody(err: unknown): {
  status: number;
  error: { message: string; type: string; param: string | null; code: string | null };
} {
  const e = err as { message?: string; status?: number; bodySniff?: string } | null;
  let status = 500;
  let type = 'api_error';
  let code: string | null = null;
  let message = e?.message || 'Internal server error';

  if (err instanceof StatusError && err.status >= 400 && err.status < 600) {
    status = err.status;
    message = err.bodySniff || err.message;
    // Strip internal debug prefixes like "chatgpt-anon conversation: HTTP 429: "
    message = message.replace(/^chatgpt-anon\s+\w+:\s*HTTP\s+\d+:\s*/i, '').trim() || err.message;

    if (status === 429) {
      type = 'rate_limit_error';
      code = 'rate_limit_exceeded';
    } else if (status === 403) {
      type = 'permission_error';
      code = 'insufficient_quota';
    } else if (status === 401) {
      type = 'invalid_request_error';
      code = 'invalid_api_key';
    } else if (status >= 500) {
      type = 'server_error';
      code = 'internal_server_error';
    }
  }

  return { status, error: { message, type, param: null, code } };
}

interface RetryArgs {
  model: string;
  prompt: string;
  imageRefs: ReturnType<typeof collectImageRefs>;
  req: ChatCompletionRequest;
  client: UpstreamClient;
  dm: DeviceManager;
  signal?: AbortSignal;
}

interface StreamRetryCtx {
  env: Env;
  prompt: string;
  imageRefs: ReturnType<typeof collectImageRefs>;
  client: UpstreamClient;
  dm: DeviceManager;
  hasTools: boolean;
}

type SSEWriter = Parameters<typeof pipeOpenAIStream>[1];

/** Emit one OpenAI chunk (or "[DONE]") to an SSE writer. */
async function emitSSE(
  writer: SSEWriter,
  chunk: import('./types').ChatCompletionChunk | string
): Promise<void> {
  const data = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
  if (typeof writer.writeSSE === 'function') {
    await writer.writeSSE({ data });
  } else if (typeof writer.write === 'function') {
    await writer.write(`data: ${data}\n\n`);
  }
}

/**
 * Outcome of streaming one upstream attempt.
 *
 * `committed` means chunks have already gone to the client, so the attempt can
 * no longer be retried. When false, `chunks` holds everything produced so far
 * (nothing was emitted) and the caller may still retry on a fresh device.
 */
interface AttemptOutcome {
  chunks: import('./types').ChatCompletionChunk[];
  sp: StreamProcessor;
  aborted: boolean;
  committed: boolean;
}

/**
 * Streams one upstream attempt with a BOUNDED decision window.
 *
 * Why not buffer everything (the previous behavior): for any client that sends
 * `tools` — which is most of them — the whole reply was held until the socket
 * closed, so the first byte arrived seconds late and every content frame then
 * landed in one burst. The typing effect was destroyed even for plain prose
 * that could never have been a tool call.
 *
 * A refusal ("I'm unable to access the weather tool") is legible in its opening
 * sentence, and the tool-call detector already decides "this cannot be tool-call
 * JSON" from the first character. So the window is tiny:
 *
 *  - tool_calls deltas appear (detector resolved the JSON) → commit immediately
 *  - plain prose of >= TOOL_REFUSAL_DECISION_CHARS that is not a refusal, when
 *    the request does NOT mandate a tool call → commit immediately
 *  - otherwise hold: a refusal (retryable) or a mandated-choice reply whose
 *    compliance is still unknown
 *
 * Holding is bounded by the reply itself (refusals and tool-call JSON are
 * short); once committed, every later chunk streams straight through.
 */
async function streamAttempt(
  resp: Response,
  writer: SSEWriter,
  sp: StreamProcessor,
  commitOnPlainText: boolean,
  signal?: AbortSignal
): Promise<AttemptOutcome> {
  const pending: import('./types').ChatCompletionChunk[] = [];
  let committed = false;
  let aborted = false;
  let sawToolCalls = false;
  /** When the first chunk that has not been sent yet appeared. */
  let firstUnsentAt = 0;

  const parser = createParser({
    onEvent: (event) => {
      if (event.data === '[DONE]') return;
      try {
        const parsed = JSON.parse(event.data);
        for (const c of sp.processEvent(parsed)) {
          if (c.choices?.[0]?.delta?.tool_calls) sawToolCalls = true;
          pending.push(c);
        }
      } catch {
        // Ignore non-JSON frames
      }
    },
  });

  const drainPending = async (): Promise<void> => {
    while (pending.length > 0) {
      if (signal?.aborted) return;
      await emitSSE(writer, pending.shift()!);
    }
    firstUnsentAt = 0;
  };

  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const onAbort = () => {
      aborted = true;
      try {
        reader.cancel();
      } catch {}
    };
    if (signal) {
      if (signal.aborted) {
        aborted = true;
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    try {
      let graceDeadline = 0;
      let tailTimedOut = false;
      while (!aborted) {
        let done = false;
        if (graceDeadline > 0) {
          const remaining = graceDeadline - Date.now();
          if (remaining <= 0) {
            tailTimedOut = true;
            break;
          }
          const timeout = Promise.withResolvers<typeof READ_TIMEOUT>();
          const tid = setTimeout(() => timeout.resolve(READ_TIMEOUT), remaining);
          const raced = await Promise.race([reader.read(), timeout.promise]);
          clearTimeout(tid);
          if (raced === READ_TIMEOUT) {
            tailTimedOut = true;
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

        // Commit as soon as the attempt is provably not a retry candidate.
        if (!committed) {
          if (pending.length > 0 && firstUnsentAt === 0) {
            firstUnsentAt = Date.now();
          }
          if (sawToolCalls) {
            // The detector resolved the reply as tool-call JSON.
            committed = true;
          } else if (commitOnPlainText && !looksLikeRefusal(sp.lastFullText)) {
            // Refusal text must stay held so it can be retried on a fresh
            // device; any other prose is a legitimate answer. Commit once the
            // byte or time trigger fires so the typing effect starts early.
            const byteTrigger = sp.lastFullText.length >= TOOL_REFUSAL_DECISION_CHARS;
            const timeTrigger =
              firstUnsentAt > 0 && Date.now() - firstUnsentAt >= TOOL_REFUSAL_DECISION_MS;
            if (byteTrigger || timeTrigger) {
              committed = true;
            }
          }
        }
        if (committed) {
          await drainPending();
        }

        if (done) break;
        // Idle-based window: reset after processing so drain time does not
        // consume it (mirrors pipeOpenAIStream; see STREAM_TAIL_GRACE_MS).
        if (sp.endedTurn) {
          graceDeadline = Date.now() + STREAM_TAIL_GRACE_MS;
        }
      }
      if (tailTimedOut) {
        // A read is still in flight; cancel it before releasing the lock.
        try {
          await reader.cancel();
        } catch {}
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }
  if (!aborted && typeof (parser as any).reset === 'function') {
    try {
      (parser as any).reset({ consume: true });
    } catch {
      // ignore
    }
  }
  if (committed) {
    await drainPending();
  }
  return { chunks: pending, sp, aborted, committed };
}

/**
 * Synthesize a stream from an aggregated completion by feeding its text
 * through a fresh StreamProcessor once. Used to deliver a retryToolTurn
 * result (a non-stream completion) through the streaming code path.
 */
async function emitAggregatedAsStream(
  writer: SSEWriter,
  result: ChatCompletionResponse,
  model: string,
  req: ChatCompletionRequest
): Promise<void> {
  const sp = new StreamProcessor(model, req);
  const text = result.choices?.[0]?.message?.content ?? '';
  if (result.choices?.[0]?.finish_reason === 'tool_calls') {
    const wire = JSON.stringify({
      tool_calls: (result.choices?.[0]?.message?.tool_calls ?? []).map((tc: any) => ({
        name: tc.function?.name,
        arguments:
          typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments || '{}')
            : (tc.function?.arguments ?? {}),
      })),
    });
    const synth = {
      type: 'message_stream',
      message: {
        id: 'synth-retry',
        author: { role: 'assistant' },
        status: 'in_progress',
        metadata: { message_type: 'next' },
        content: { content_type: 'text', parts: [wire] },
      },
    };
    for (const chunk of sp.processEvent(synth)) {
      await emitSSE(writer, chunk);
    }
  } else if (text) {
    const synth = {
      type: 'message_stream',
      message: {
        id: 'synth-retry',
        author: { role: 'assistant' },
        status: 'in_progress',
        metadata: { message_type: 'next' },
        content: { content_type: 'text', parts: [text] },
      },
    };
    for (const chunk of sp.processEvent(synth)) {
      await emitSSE(writer, chunk);
    }
  }
  for (const chunk of sp.flush()) {
    await emitSSE(writer, chunk);
  }
  await emitSSE(writer, '[DONE]');
}

/**
 * pipeOpenAIStreamRetrying is the streaming counterpart to the non-stream
 * retryToolTurn path: when tool calling is active and the upstream model
 * replies with a refusal text instead of a tool call, retry the turn on
 * fresh devices up to 3 attempts.
 *
 * Streaming-vs-buffering: retrying is only possible while NOTHING has been
 * emitted. The decision window is deliberately tiny (see streamAttempt): a
 * tool call commits on the first tool_calls delta, and plain prose commits as
 * soon as enough non-refusal text exists — so a normal answer streams
 * incrementally from ~200 characters in, instead of arriving in one burst
 * after the socket closes. Only a genuine refusal (or a mandated tool_choice
 * whose compliance is still unknown) is ever held back.
 *
 * hasTools=false: no ambiguity to resolve; falls through to pipeOpenAIStream.
 */
async function pipeOpenAIStreamRetrying(
  resp: Response,
  writer: SSEWriter,
  model: string,
  req: ChatCompletionRequest,
  signal: AbortSignal | undefined,
  ctx: StreamRetryCtx
): Promise<void> {
  if (!ctx.hasTools) {
    await pipeOpenAIStream(resp, writer, model, req, signal);
    return;
  }

  // Under a mandatory tool_choice the contract is only satisfiable by a tool
  // call, so a plain answer must not be committed early if it is still a
  // candidate for retry. Under "auto" a non-refusal plain answer is always
  // acceptable, so prose commits as soon as the decision window is filled.
  const commitOnPlainText = !requiresToolCall(req);

  const MAX_STREAM_ATTEMPTS = 3;
  let currentResp: Response = resp;

  for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
    const sp = new StreamProcessor(model, req);
    const outcome = await streamAttempt(currentResp, writer, sp, commitOnPlainText, signal);
    if (outcome.aborted) return;

    if (outcome.committed) {
      // Already mid-stream on the client: finish this attempt.
      for (const chunk of outcome.chunks) {
        await emitSSE(writer, chunk);
      }
      for (const chunk of sp.flush()) {
        await emitSSE(writer, chunk);
      }
      await emitSSE(writer, '[DONE]');
      return;
    }

    const chunks = outcome.chunks;
    const sawToolCalls = chunks.some((c) => c.choices?.[0]?.delta?.tool_calls);
    // Same contract as the non-stream path: a refusal, or any tool-less reply
    // under a mandatory tool_choice, warrants a retry on a fresh device.
    const bufferedCompletion: ChatCompletionResponse = {
      id: sp.messageId,
      object: 'chat.completion',
      created: sp.created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: sawToolCalls ? null : sp.lastFullText,
            tool_calls: sawToolCalls
              ? chunks
                  .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
                  .map((tc) => ({
                    id: tc.id ?? '',
                    type: 'function' as const,
                    function: {
                      name: tc.function?.name ?? '',
                      arguments: tc.function?.arguments ?? '',
                    },
                  }))
              : undefined,
          },
          finish_reason: sawToolCalls ? 'tool_calls' : sp.toolCallFinishReason(),
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const contractViolated = violatesToolContract(req, bufferedCompletion);

    if (contractViolated && attempt < MAX_STREAM_ATTEMPTS - 1) {
      try {
        await currentResp.body?.cancel();
      } catch {}
      const retryResp = await retryToolTurn(ctx.env, {
        model,
        prompt: ctx.prompt,
        imageRefs: ctx.imageRefs,
        req,
        client: ctx.client,
        dm: ctx.dm,
        signal,
      });
      if (retryResp) {
        if (!violatesToolContract(req, retryResp)) {
          // Got a usable answer — stream it out as a synthesized attempt and
          // finish, preserving the streaming contract.
          await emitAggregatedAsStream(writer, retryResp, model, req);
          return;
        }
      }
      // Still violating (or retry failed): fall through and emit the attempt we
      // already held — the client gets a proper reply instead of silence.
      // This mirrors the non-stream branch which keeps lastResult.
    }

    // Committed to this attempt: stream what was held, then the tail.
    for (const chunk of chunks) {
      await emitSSE(writer, chunk);
    }
    for (const chunk of sp.flush()) {
      await emitSSE(writer, chunk);
    }
    await emitSSE(writer, '[DONE]');
    return;
  }
}

/**
 * Re-runs a tool turn on fresh devices (up to 4 attempts). Returns the first
 * result that satisfies the tool contract (a tool call, or a non-refusal plain
 * answer when no tool_choice was mandatory), or the last result if every
 * attempt violated it.
 */
async function retryToolTurn(
  env: Env,
  args: RetryArgs
): Promise<ChatCompletionResponse | null> {
  const { model, prompt, imageRefs, req, client, dm, signal } = args;
  let lastResult: ChatCompletionResponse | null = null;
  for (let i = 0; i < 4; i++) {
    try {
      const device = await dm.getHealthyDevice(env, client);
      let messageContent: Record<string, any> | undefined;
      let mimeTypes: string[] | undefined;
      if (imageRefs.length > 0) {
        const resolved: ResolvedImage[] = [];
        const mimeSet = new Set<string>();
        for (const ref of imageRefs) {
          const img = await resolveImage(ref, (u, init) => fetch(u, { ...init, signal }));
          const sniffed = sniffImageMime(img.bytes);
          const mimeType = sniffed !== 'application/octet-stream' ? sniffed : img.mimeType;
          const { fileId } = await uploadImage({
            client,
            deviceId: device.id,
            imageBytes: img.bytes,
            mimeType,
            fileName: `image.${defaultExtensionForMime(mimeType)}`,
            signal,
          });
          mimeSet.add(mimeType);
          resolved.push({ fileId, sizeBytes: img.bytes.byteLength, width: img.width, height: img.height, mimeType });
        }
        messageContent = buildMultimodalContent(
          lastUserMessageText(req.messages),
          resolved
        );
        mimeTypes = [...mimeSet];
      }
      const anonBody = buildAnonRequestBodyWithTools(req as any, {
        prompt,
        messageContent,
        attachmentMimeTypes: mimeTypes,
      });
      const conduitToken = await client.prepare(device.id, device.sentinelToken!, anonBody, signal);
      const resp = await client.conversation(device.id, device.sentinelToken!, conduitToken, anonBody, signal);
      const result = await aggregateNonStream(resp, model, req);
      lastResult = result;
      // Accept when the tool contract is satisfied: a tool call, or (absent a
      // mandatory tool_choice) any non-refusal plain answer.
      if (!violatesToolContract(req, result)) {
        return result;
      }
    } catch {
      // keep trying
    }
  }
  return lastResult;
}

/**
 * Creates and configures the Hono application for chatgpt2api-cf.
 */
export function createApp(options?: AppOptions) {
  const app = new Hono<{ Bindings: Env }>();
  const commitDeadlineMs = options?.nonStreamCommitDeadlineMs ?? NONSTREAM_COMMIT_DEADLINE_MS;
  const keepAliveMs = options?.keepAliveIntervalMs ?? SSE_PING_INTERVAL_MS;

  // Enable CORS for all routes
  app.use('*', cors());

  // Bearer token authentication middleware for API routes
  app.use('/v1/*', async (c, next) => {
    const apiKeys = c.env?.API_KEYS?.trim();
    if (!apiKeys) {
      return next();
    }

    const allowed = apiKeys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (allowed.length === 0) {
      return next();
    }

    const authHeader = c.req.header('Authorization') || c.req.header('authorization');
    const xApiKey = c.req.header('x-api-key') || c.req.header('X-Api-Key');
    let token = '';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (xApiKey) {
      token = xApiKey.trim();
    }

    if (!token) {
      return c.json(
        {
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401
      );
    }

    if (!allowed.includes(token)) {
      return c.json(
        {
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401
      );
    }

    return next();
  });

  // Global error handler: converts exceptions into OpenAI-formatted JSON
  app.onError((err, c) => {
    const { status, error } = openAIErrorBody(err);
    // openAIErrorBody clamps to a concrete HTTP status (400-599); the cast
    // re-narrows the Hono generics that `number` widens.
    return c.json({ error }, status as ContentfulStatusCode);
  });

  // Root / Status endpoint
  app.get('/', async (c) => {
    const client = options?.client || new UpstreamClient();
    const models = await getModelCatalog(c.env, client);

    return c.json({
      status: 'ok',
      service: 'chatgpt2api-cf',
      models,
      docs: 'https://github.com/6Kmfi6HP/chatgpt2api',
    });
  });

  // Health check endpoints
  app.get('/health', async (c) => {
    const kvBound = Boolean(c.env?.CHATGPT_KV);
    let kvPool: any = null;
    if (kvBound) {
      try {
        kvPool = await c.env.CHATGPT_KV.get('chatgpt_device_pool', 'json');
      } catch (err: any) {
        kvPool = { error: err.message };
      }
    }
    return c.json({
      status: 'ok',
      kvBound,
      hasPool: Boolean(kvPool?.devices),
      poolDevicesCount: kvPool?.devices?.length || 0,
    });
  });
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Model list endpoint: live anonymous catalog, fallback ["auto"]
  app.get('/v1/models', async (c) => {
    const client = options?.client || new UpstreamClient();
    const models = await getModelCatalog(c.env, client);

    return c.json({
      object: 'list',
      data: models.map((id) => ({
        id,
        object: 'model',
        created: 1700000000,
        owned_by: 'openai',
      })),
    });
  });

  // Chat completions endpoint
  app.post('/v1/chat/completions', async (c) => {
    let req: ChatCompletionRequest;
    try {
      req = await c.req.json<ChatCompletionRequest>();
    } catch {
      return c.json(
        {
          error: {
            message: 'Invalid JSON request body',
            type: 'invalid_request_error',
          },
        },
        400
      );
    }

    if (!req.messages || !Array.isArray(req.messages) || req.messages.length === 0) {
      return c.json(
        {
          error: {
            message: 'Missing or invalid "messages" array',
            type: 'invalid_request_error',
          },
        },
        400
      );
    }

    // A "tool" message must answer a tool_calls id declared by a preceding
    // assistant message. OpenAI rejects orphans with 400; answering them with a
    // normal chat reply silently hides a client bug (the tool payload gets
    // treated as user intent, and the caller never learns its id was wrong).
    const declaredToolCallIds = new Set<string>();
    for (const m of req.messages) {
      if (m?.role === 'assistant') {
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            if (tc && typeof tc.id === 'string' && tc.id !== '') {
              declaredToolCallIds.add(tc.id);
            }
          }
        }
        continue;
      }
      if (m?.role === 'tool') {
        const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
        if (id === '' || !declaredToolCallIds.has(id)) {
          return c.json(
            {
              error: {
                message:
                  "Invalid parameter: messages with role 'tool' must be a response to a preceding message with 'tool_calls'.",
                type: 'invalid_request_error',
                param: 'messages',
                code: 'invalid_request_error',
              },
            },
            400
          );
        }
      }
    }

    // No name mapping: the requested model slug is passed through verbatim.
    const model = (typeof req.model === 'string' && req.model.trim()) || 'auto';
    const prompt = flattenMessages(req.messages);

    // Collect image references (order preserved). With tools enabled only
    // user messages carry images (tool/assistant frames never do).
    const hasToolsForRefs =
      Array.isArray(req.tools) && req.tools.length > 0 && req.tool_choice !== 'none';
    const refSource = hasToolsForRefs
      ? req.messages.filter((m) => m.role === 'user')
      : req.messages;
    const imageRefs = refSource.flatMap((m) => collectImageRefs(m.content as any));

    const client = options?.client || new UpstreamClient();
    const dm = options?.deviceManager || defaultDeviceManager;

    const MAX_ATTEMPTS = 3;
    let upstreamResp: Response | null = null;
    let lastError: any = null;
    let selectedDeviceId = '';
    /** Set when the non-stream refusal retry swapped to a fresh device. */
    let deviceRotated = false;
    const signal = c.req.raw?.signal;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) {
        throw new Error('Request aborted by client');
      }

      try {
        const device = await dm.getHealthyDevice(c.env, client);
        selectedDeviceId = device.id;

        // Image uploads are per-device quota'd upstream, so they happen inside
        // the retry loop with the same device that runs the conversation. A
        // 429/403 from the upload path cools this device down and the loop
        // retries with a fresh one.
        const hasTools =
          Array.isArray(req.tools) &&
          req.tools.length > 0 &&
          req.tool_choice !== 'none';

        // Resolve and upload image attachments (order preserved). All images
        // ride the last user frame, exactly like the pre-existing behavior.
        let messageContent: Record<string, any> | undefined;
        let attachmentMimeTypes: string[] | undefined;
        if (imageRefs.length > 0) {
          const resolved: ResolvedImage[] = [];
          const mimeTypes = new Set<string>();
          for (const ref of imageRefs) {
            const img = await resolveImage(ref, (u, init) =>
              fetch(u, { ...init, signal })
            );
            const sniffed = sniffImageMime(img.bytes);
            const mimeType =
              sniffed !== 'application/octet-stream' ? sniffed : img.mimeType;
            const { fileId } = await uploadImage({
              client,
              deviceId: device.id,
              imageBytes: img.bytes,
              mimeType,
              fileName: `image.${defaultExtensionForMime(mimeType)}`,
              signal,
            });
            mimeTypes.add(mimeType);
            resolved.push({ fileId, sizeBytes: img.bytes.byteLength, width: img.width, height: img.height, mimeType });
          }
          // The multimodal frame carries only the final user message's text:
          // the rest of the history is replayed as its own native frames.
          messageContent = buildMultimodalContent(
            lastUserMessageText(req.messages),
            resolved
          );
          attachmentMimeTypes = [...mimeTypes];
        }

        // Multi-turn continuity: every OpenAI message (system/user/assistant/
        // tool) maps to one native upstream frame in a fresh conversation.
        // The anonymous upstream model treats a pasted transcript prompt as
        // untrusted external content and disowns it ("I don't have access to
        // that memory"), but native frames are honored as its own history, so
        // follow-up turns keep recalling prior context. Tool requests
        // additionally get the compiled tool-protocol system frame prepended.
        //
        // Search defaults are unchanged: ON for plain chat unless
        // "search": false; OFF for tool requests unless "search": true (the
        // upstream web tool competes with tool-calling).
        const wireReq = {
          ...req,
          model,
          search: hasTools ? req.search ?? false : req.search !== false,
        } as any;
        const anonBody = buildAnonRequestBodyWithTools(wireReq, {
          prompt,
          messageContent,
          attachmentMimeTypes,
        });

        // Degenerate history without a single user message (e.g. system-only):
        // replay it as the pre-existing single user frame so the upstream
        // conversation still opens on a user turn.
        if (
          !hasTools &&
          !(anonBody.messages as any[]).some((m) => m?.author?.role === 'user')
        ) {
          anonBody.messages = [
            {
              author: { role: 'user' },
              content:
                messageContent ?? { content_type: 'text', parts: [prompt] },
            },
          ];
        }

        const conduitToken = await client.prepare(
          device.id,
          device.sentinelToken!,
          anonBody,
          signal
        );
        upstreamResp = await client.conversation(
          device.id,
          device.sentinelToken!,
          conduitToken,
          anonBody,
          signal
        );
        break;
      } catch (err: any) {
        lastError = err;
        if (err instanceof StatusError && (err.status === 429 || err.status === 403 || err.status === 401)) {
          if (selectedDeviceId) {
            await dm.reportCooldown(c.env, selectedDeviceId, err);
          }
          continue;
        }
        // Client-side image validation failures (undecodable data URLs,
        // unsupported formats, non-image responses) are the caller's fault:
        // surface them as 400 instead of 500.
        const msg: string = err?.message ?? '';
        if (
          msg.includes('Unsupported image format') ||
          msg.includes('Invalid data URL') ||
          msg.includes('did not return an image') ||
          msg.includes('Failed to fetch image') ||
          msg.includes('Cannot parse') ||
          msg.includes('Empty image payload')
        ) {
          err = new StatusError('upload', 400, msg);
          lastError = err;
          throw err;
        }
        throw err;
      }
    }

    if (!upstreamResp) {
      throw lastError || new Error('Failed to communicate with upstream after retries');
    }

    c.header('x-device-id', selectedDeviceId);

    if (req.stream) {
      return streamSSE(c, async (sseStream) => {
        // Client read-idle keepalive: a long upstream wait (notably the
        // tool-request buffering window, where nothing may be emitted yet)
        // otherwise leaves the socket byte-idle past client read timeouts.
        // `: ping` is an SSE comment and is ignored by every spec parser.
        const ping = setInterval(() => {
          void sseStream.write(': ping\n\n').catch(() => {});
        }, keepAliveMs);
        const stopPing = () => clearInterval(ping);
        sseStream.onAbort(stopPing);
        try {
          await pipeOpenAIStreamRetrying(upstreamResp!, sseStream, model, req, signal, {
            env: c.env,
            prompt,
            imageRefs,
            client,
            dm,
            hasTools: hasToolsForRefs,
          });
        } finally {
          stopPing();
        }
      });
    }

    // Transparent refusal retry for non-stream tool requests: anonymous
    // models sometimes answer "unable to access the tool" instead of calling
    // it. Give the request one more round on a fresh device when detected.
    //
    // Commit deadline: generation can outlast a client's read-idle timeout, so
    // once NONSTREAM_COMMIT_DEADLINE_MS elapses without a result we commit a
    // 200 early and stream whitespace heartbeats (legal before a JSON value)
    // until the real body is ready. Browsers and SDKs reset read timers on
    // those bytes; the final document is still one JSON.parse-able value.
    const resultPromise = (async (): Promise<ChatCompletionResponse> => {
      let result = await aggregateNonStream(upstreamResp!, model, req);
      if (hasToolsForRefs && violatesToolContract(req, result)) {
        try {
          await upstreamResp!.body?.cancel();
        } catch {}
        const retryResp = await retryToolTurn(c.env, {
          model, prompt, imageRefs, req, client, dm, signal,
        });
        if (retryResp) {
          result = retryResp;
          deviceRotated = true;
        }
      }
      return result;
    })();

    const deadlineTimer = Promise.withResolvers<'timeout'>();
    const deadlineId = setTimeout(() => deadlineTimer.resolve('timeout'), commitDeadlineMs);
    const deadline = await Promise.race([
      resultPromise.then((result) => ({ settled: true as const, result })),
      deadlineTimer.promise.then(() => ({ settled: false as const })),
    ]);
    if (deadline.settled) {
      clearTimeout(deadlineId);
    }

    // Header must be set before the body commits; the retry runs inside
    // resultPromise, so the rotation flag is only readable once it settles
    // (fast path) or once the awaited result is in hand (slow path).
    if (deviceRotated) {
      c.header('x-device-id', 'rotated');
    }

    if (deadline.settled) {
      return c.json(deadline.result);
    }

    // Slow path: commit now, keep the connection warm, then flush the body.
    c.header('Content-Type', 'application/json; charset=UTF-8');
    c.header('Transfer-Encoding', 'chunked');
    c.header('Cache-Control', 'no-cache');
    return c.body(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          let alive = true;
          const flush = () => {
            // A disconnected client makes enqueue throw; stop the timer and
            // let the final result resolution settle silently.
            if (!alive) return;
            try {
              controller.enqueue(encoder.encode(NONSTREAM_HEARTBEAT));
            } catch {
              alive = false;
              clearInterval(hb);
            }
          };
          const hb = setInterval(flush, keepAliveMs);
          flush();
          try {
            const result = await resultPromise;
            if (alive) controller.enqueue(encoder.encode(JSON.stringify(result)));
          } catch (err) {
            if (alive) {
              const { error } = openAIErrorBody(err);
              try {
                controller.enqueue(encoder.encode(JSON.stringify({ error })));
              } catch {
                alive = false;
              }
            }
          } finally {
            alive = false;
            clearInterval(hb);
            try {
              controller.close();
            } catch {
              // already closed by the client
            }
          }
        },
      })
    );
  });

  return app;
}

const app = createApp();
export default app;
export { app };
