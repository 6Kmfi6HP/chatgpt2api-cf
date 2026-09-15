import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { Env, ChatCompletionRequest } from './types';
import { UpstreamClient, StatusError } from './client';
import { deviceManager as defaultDeviceManager, DeviceManager } from './device';
import { buildAnonRequest, flattenMessages } from './translate';
import { buildAnonRequestBodyWithTools } from './toolcall_wire';
import { getModelCatalog } from './catalog';
import { pipeOpenAIStream, aggregateNonStream } from './stream';
import {
  collectImageRefs,
  resolveImage,
  buildMultimodalContent,
  hasImageContent,
  type ResolvedImage,
} from './image_parts';
import { uploadImage, sniffImageMime, defaultExtensionForMime } from './upload';

export interface AppOptions {
  client?: UpstreamClient;
  deviceManager?: DeviceManager;
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
        let anonBody: Record<string, any>;
        if (hasTools) {
          // Tool protocol compiled into a system message; the whole OpenAI
          // messages[] (incl. role:"tool" results) maps to upstream frames.
          let toolMessageContent: Record<string, any> | undefined;
          let toolMimeTypes: string[] | undefined;
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
            toolMessageContent = buildMultimodalContent(prompt, resolved);
            toolMimeTypes = [...mimeTypes];
          }
          // When tools are active the upstream web tool can hijack the turn
          // and break the reply convention. Default search OFF for tool
          // requests unless the caller explicitly opts in.
          const toolReq = { ...req, search: req.search ?? false } as any;
          anonBody = buildAnonRequestBodyWithTools(toolReq, {
            prompt,
            messageContent: toolMessageContent,
            attachmentMimeTypes: toolMimeTypes,
          });
        } else if (imageRefs.length > 0) {
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
          const content = buildMultimodalContent(prompt, resolved);
          anonBody = buildAnonRequest(model, prompt, {
            search: req.search,
            thinkingEffort: req.reasoning_effort,
            serviceTier: req.service_tier,
            oneOffModelOverride: req.one_off_model_override,
            systemHints: req.system_hints,
            localFunctionNames: req.local_function_names,
            mapSearchParams: req.map_search_params,
            messageContent: content,
            attachmentMimeTypes: [...mimeTypes],
          });
        } else {
          anonBody = buildAnonRequest(model, prompt, {
            search: req.search,
            thinkingEffort: req.reasoning_effort,
            serviceTier: req.service_tier,
            oneOffModelOverride: req.one_off_model_override,
            systemHints: req.system_hints,
            localFunctionNames: req.local_function_names,
            mapSearchParams: req.map_search_params,
          });
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
        await pipeOpenAIStream(upstreamResp!, sseStream, model, req, signal);
      });
    }

    const result = await aggregateNonStream(upstreamResp, model, req);
    return c.json(result);
  });

  return app;
}

const app = createApp();
export default app;
export { app };
