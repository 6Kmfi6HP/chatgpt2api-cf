import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApp } from './index';
import { UpstreamClient, StatusError } from './client';
import { DeviceManager } from './device';
import type { Env, ChatCompletionRequest } from './types';

class MockKVNamespace {
  public store = new Map<string, string>();
  async get(key: string, type?: string): Promise<any> {
    const val = this.store.get(key);
    if (val === undefined) return null;
    if (type === 'json') {
      try {
        return JSON.parse(val);
      } catch {
        return null;
      }
    }
    return val;
  }
  async put(key: string, value: any): Promise<void> {
    this.store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

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
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function mkAssistantEvent(text: string) {
  return {
    type: 'message_stream',
    conversation_id: 'conv-test',
    message: {
      id: 'msg-test',
      author: { role: 'assistant' },
      content: {
        content_type: 'text',
        parts: [text],
      },
    },
  };
}

class MockUpstreamClient extends UpstreamClient {
  public sentinelCalls: string[] = [];
  public prepareCalls: any[] = [];
  public conversationCalls: any[] = [];
  public conversationHandler?: () => Promise<Response>;

  constructor() {
    super('https://mock.chatgpt.local');
  }

  async sentinel(deviceId: string): Promise<{ token: string; expiry: number }> {
    this.sentinelCalls.push(deviceId);
    return {
      token: `sentinel-token-${deviceId}`,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  async prepare(deviceId: string, sentinelToken: string, anonBody: any): Promise<string> {
    this.prepareCalls.push({ deviceId, sentinelToken, anonBody });
    return `conduit-token-${deviceId}`;
  }

  async conversation(
    deviceId: string,
    sentinelToken: string,
    conduitToken: string,
    anonBody: any
  ): Promise<Response> {
    this.conversationCalls.push({ deviceId, sentinelToken, conduitToken, anonBody });
    if (this.conversationHandler) {
      return await this.conversationHandler();
    }
    return createSseResponse([
      `data: ${JSON.stringify(mkAssistantEvent('Hello there!'))}\n\n`,
    ]);
  }
}

describe('Hono Application (src/index.ts)', () => {
  let mockClient: MockUpstreamClient;
  let mockDeviceManager: DeviceManager;
  let mockEnv: Env;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    mockClient = new MockUpstreamClient();
    mockDeviceManager = new DeviceManager(100);
    app = createApp({ client: mockClient, deviceManager: mockDeviceManager });
    mockEnv = {
      CHATGPT_KV: new MockKVNamespace() as any,
      API_KEYS: '',
      MODELS: 'auto,gpt-4o,gpt-4o-mini',
      DEVICE_POOL_SIZE: '3',
    };
  });

  describe('Root and Health routes', () => {
    it('GET / returns status, models and docs link', async () => {
      const res = await app.request('/', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.status).toBe('ok');
      expect(data.service).toBe('chatgpt2api-cf');
      expect(data.models).toEqual(['auto', 'gpt-4o', 'gpt-4o-mini']);
      expect(data.docs).toBeDefined();
    });

    it('GET /health returns { status: "ok" }', async () => {
      const res = await app.request('/health', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.status).toBe('ok');
    });

    it('GET /healthz returns { status: "ok" }', async () => {
      const res = await app.request('/healthz', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data).toEqual({ status: 'ok' });
    });
  });

  describe('GET /v1/models', () => {
    it('returns default model list in OpenAI format', async () => {
      const res = await app.request('/v1/models', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.object).toBe('list');
      expect(data.data.length).toBe(3);
      expect(data.data[0]).toEqual({
        id: 'auto',
        object: 'model',
        created: 1700000000,
        owned_by: 'openai',
      });
      expect(data.data[1].id).toBe('gpt-4o');
      expect(data.data[2].id).toBe('gpt-4o-mini');
    });

    it('splits custom MODELS environment variable', async () => {
      const customEnv = { ...mockEnv, MODELS: 'gpt-4.1, gpt-4o-custom ' };
      const res = await app.request('/v1/models', { method: 'GET' }, customEnv);
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.data.map((m: any) => m.id)).toEqual(['gpt-4.1', 'gpt-4o-custom']);
    });
  });

  describe('Bearer Token Authentication', () => {
    it('allows requests when API_KEYS is empty (public mode)', async () => {
      const res = await app.request('/v1/models', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
    });

    it('rejects requests when API_KEYS is set but header is missing', async () => {
      const authEnv = { ...mockEnv, API_KEYS: 'secret-token-1,secret-token-2' };
      const res = await app.request('/v1/models', { method: 'GET' }, authEnv);
      expect(res.status).toBe(401);
      const data: any = await res.json();
      expect(data).toEqual({
        error: {
          message: 'Incorrect API key provided',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    });

    it('rejects requests with incorrect token', async () => {
      const authEnv = { ...mockEnv, API_KEYS: 'secret-token-1,secret-token-2' };
      const res = await app.request(
        '/v1/models',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer wrong-token' },
        },
        authEnv
      );
      expect(res.status).toBe(401);
      const data: any = await res.json();
      expect(data.error.code).toBe('invalid_api_key');
    });

    it('allows requests with valid token in API_KEYS list', async () => {
      const authEnv = { ...mockEnv, API_KEYS: 'secret-token-1,secret-token-2' };
      const res = await app.request(
        '/v1/models',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer secret-token-2' },
        },
        authEnv
      );
      expect(res.status).toBe(200);
    });

    it('allows requests with valid token via x-api-key header', async () => {
      const authEnv = { ...mockEnv, API_KEYS: 'secret-token-1,secret-token-2' };
      const res = await app.request(
        '/v1/models',
        {
          method: 'GET',
          headers: { 'x-api-key': 'secret-token-1' },
        },
        authEnv
      );
      expect(res.status).toBe(200);
    });

    it('allows /health even when API_KEYS is set', async () => {
      const authEnv = { ...mockEnv, API_KEYS: 'secret-token-1' };
      const res = await app.request('/health', { method: 'GET' }, authEnv);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /v1/chat/completions - Request Validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      const res = await app.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not a json',
        },
        mockEnv
      );
      expect(res.status).toBe(400);
      const data: any = await res.json();
      expect(data.error.type).toBe('invalid_request_error');
    });

    it('returns 400 when messages array is missing or empty', async () => {
      const res = await app.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
        },
        mockEnv
      );
      expect(res.status).toBe(400);
      const data: any = await res.json();
      expect(data.error.message).toContain('messages');
    });
  });

  describe('POST /v1/chat/completions - Non-Streaming (stream: false)', () => {
    it('aggregates upstream SSE stream and returns ChatCompletionResponse', async () => {
      const reqPayload = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Say hello' }],
        stream: false,
      };

      const res = await app.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqPayload),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.object).toBe('chat.completion');
      expect(data.model).toBe('gpt-4o');
      expect(data.choices.length).toBe(1);
      expect(data.choices[0].message.role).toBe('assistant');
      expect(data.choices[0].message.content).toBe('Hello there!');
      expect(data.choices[0].finish_reason).toBe('stop');
      expect(data.usage.total_tokens).toBeGreaterThan(0);
    });
  });

  describe('POST /v1/chat/completions - Streaming (stream: true)', () => {
    it('pipes SSE chunks with OpenAI format and emits [DONE]', async () => {
      mockClient.conversationHandler = async () => {
        return createSseResponse([
          `data: ${JSON.stringify(mkAssistantEvent('Part 1'))}\n\n`,
          `data: ${JSON.stringify(mkAssistantEvent('Part 1, Part 2'))}\n\n`,
        ]);
      };

      const reqPayload = {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Stream test' }],
        stream: true,
      };

      const res = await app.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqPayload),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const bodyText = await res.text();
      expect(bodyText).toContain('data: ');
      expect(bodyText).toContain('"role":"assistant"');
      expect(bodyText).toContain('"content":"Part 1"');
      expect(bodyText).toContain('"content":", Part 2"');
      expect(bodyText).toContain('"finish_reason":"stop"');
      expect(bodyText).toContain('data: [DONE]');
    });
  });

  describe('429 StatusError Auto-Rotation Retry', () => {
    it('retries with next device on 429 and succeeds', async () => {
      let callCount = 0;
      mockClient.conversationHandler = async () => {
        callCount++;
        if (callCount === 1) {
          // First device encounters 429 rate limit
          throw new StatusError('conversation', 429, 'Rate limit exceeded', 60_000);
        }
        // Second device succeeds
        return createSseResponse([
          `data: ${JSON.stringify(mkAssistantEvent('Recovered after 429!'))}\n\n`,
        ]);
      };

      const reportCooldownSpy = vi.spyOn(mockDeviceManager, 'reportCooldown');

      const reqPayload = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Retry test' }],
        stream: false,
      };

      const res = await app.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqPayload),
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.choices[0].message.content).toBe('Recovered after 429!');
      expect(callCount).toBe(2);
      expect(reportCooldownSpy).toHaveBeenCalledTimes(1);
    });

    it('returns error when all retries are exhausted on 429', async () => {
      mockClient.conversationHandler = async () => {
        throw new StatusError('conversation', 429, 'Rate limit exceeded', 60_000);
      };

      const reqPayload = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Exhaust retries' }],
        stream: false,
      };

      const res = await app.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqPayload),
        },
        mockEnv
      );

      expect(res.status).toBe(429);
      const data: any = await res.json();
      expect(data.error.type).toBe('rate_limit_error');
      expect(data.error.code).toBe('rate_limit_exceeded');
      expect(data.error.message).toBeDefined();
    });
  });
});
