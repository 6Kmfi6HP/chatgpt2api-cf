import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { Env, ChatCompletionRequest, ChatCompletionResponse } from './types';
import { UpstreamClient, StatusError } from './client';
import { deviceManager as defaultDeviceManager, DeviceManager } from './device';
import { flattenMessages, lastUserMessageText } from './translate';
import { buildAnonRequestBodyWithTools } from './toolcall_wire';
import { getModelCatalog } from './catalog';
import { pipeOpenAIStream, aggregateNonStream, StreamProcessor } from './stream';
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
 * BufferedAttempt reads one upstream SSE response completely into a
 * StreamProcessor, WITHOUT emitting anything. Retrying-before-anything-emits
 * is safe because nothing has left the gateway yet; once a single chunk
 * goes out we must stay on this attempt.
 */
interface BufferedAttempt {
  chunks: import('./types').ChatCompletionChunk[];
  sp: StreamProcessor;
  aborted: boolean;
}

async function readBufferedAttempt(
  resp: Response,
  sp: StreamProcessor,
  signal?: AbortSignal
): Promise<BufferedAttempt> {
  const chunks: import('./types').ChatCompletionChunk[] = [];
  let aborted = false;
  const parser = createParser({
    onEvent: (event) => {
      if (event.data === '[DONE]') return;
      try {
        const parsed = JSON.parse(event.data);
        for (const c of sp.processEvent(parsed)) {
          chunks.push(c);
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
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
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
  return { chunks, sp, aborted };
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
 * fresh devices up to 3 attempts before streaming what remains.
 *
 * Streaming-vs-buffering: because the tool-call detector itself buffers
 * while a reply could still resolve into the tool-call JSON convention,
 * NOTHING reaches the client in that window. As long as nothing has been
 * emitted, switching attempts is transparent. Once any content or tool_calls
 * chunk is emitted we stay on the attempt and stream it to the end.
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

  const MAX_STREAM_ATTEMPTS = 3;
  let currentResp: Response = resp;

  for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
    const sp = new StreamProcessor(model, req);
    // NOTE: readBufferedAttempt holds every chunk until the upstream closes,
    // so "the detector flushed the refusal as plain text" is recoverable —
    // nothing has been written to the client yet. This is the entire reason
    // transparent streaming retry is even possible.
    const buffered = await readBufferedAttempt(currentResp, sp, signal);
    if (buffered.aborted) return;

    const sawToolCalls = buffered.chunks.some((c) => c.choices?.[0]?.delta?.tool_calls);
    const refusal =
      !sawToolCalls && sp.toolCallFinishReason() !== 'tool_calls' && looksLikeRefusal(sp.lastFullText);

    if (refusal && attempt < MAX_STREAM_ATTEMPTS - 1) {
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
        const txt = retryResp.choices?.[0]?.message?.content ?? '';
        const stillRefused =
          retryResp.choices?.[0]?.finish_reason !== 'tool_calls' && looksLikeRefusal(txt);
        if (!stillRefused) {
          // Got a usable answer — stream it out as a synthesized attempt and
          // finish, preserving the streaming contract.
          await emitAggregatedAsStream(writer, retryResp, model, req);
          return;
        }
      }
      // Still refused (or retry failed): fall through and emit the attempt we
      // already buffered — the client gets a proper refusal reply instead of
      // silence. This mirrors the non-stream branch which keeps lastResult.
    }

    // Committed to this attempt: stream whatever we buffered, then the tail.
    for (const chunk of buffered.chunks) {
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
 * Re-runs a tool turn on fresh devices (up to 3 attempts). Returns the first
 * non-refusal aggregated completion, or the last one if all refused.
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
      const content = result.choices?.[0]?.message?.content ?? '';
      if (result.choices?.[0]?.finish_reason === 'tool_calls' || !looksLikeRefusal(content)) {
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
    let status = 500;
    let type = 'api_error';
    let code: string | null = null;
    let message = err.message || 'Internal server error';

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

    return c.json(
      {
        error: {
          message,
          type,
          param: null,
          code,
        },
      },
      status as any
    );
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
        await pipeOpenAIStreamRetrying(upstreamResp!, sseStream, model, req, signal, {
          env: c.env,
          prompt,
          imageRefs,
          client,
          dm,
          hasTools: hasToolsForRefs,
        });
      });
    }

    // Transparent refusal retry for non-stream tool requests: anonymous
    // models sometimes answer "unable to access the tool" instead of calling
    // it. Give the request one more round on a fresh device when detected.
    let result = await aggregateNonStream(upstreamResp, model, req);
    if (
      hasToolsForRefs &&
      result.choices?.[0]?.finish_reason === 'stop' &&
      looksLikeRefusal(result.choices[0].message?.content ?? '')
    ) {
      try {
        await upstreamResp.body?.cancel();
      } catch {}
      const retryResp = await retryToolTurn(c.env, {
        model, prompt, imageRefs, req, client, dm, signal,
      });
      if (retryResp) {
        result = retryResp;
        c.header('x-device-id', 'rotated');
      }
    }
    return c.json(result);
  });

  return app;
}

const app = createApp();
export default app;
export { app };
