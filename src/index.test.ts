import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApp } from './index';
import { clearCatalogCache } from './catalog';
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
  public modelsCalls: number = 0;
  public modelsHandler?: () => Promise<string[]>;

  constructor() {
    super('https://mock.chatgpt.local');
  }

  async models(deviceId: string): Promise<string[]> {
    this.modelsCalls++;
    if (this.modelsHandler) {
      return this.modelsHandler();
    }
    return ['gpt-5-5', 'gpt-5-6', 'auto'];
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
    clearCatalogCache();
    mockClient = new MockUpstreamClient();
    mockDeviceManager = new DeviceManager(100);
    app = createApp({ client: mockClient, deviceManager: mockDeviceManager });
    mockEnv = {
      CHATGPT_KV: new MockKVNamespace() as any,
      API_KEYS: '',
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
      expect(data.models).toEqual(['gpt-5-5', 'gpt-5-6', 'auto']);
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
    it('returns the live upstream catalog in OpenAI format', async () => {
      const res = await app.request('/v1/models', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.object).toBe('list');
      expect(data.data.length).toBe(3);
      expect(data.data[0]).toEqual({
        id: 'gpt-5-5',
        object: 'model',
        created: 1700000000,
        owned_by: 'openai',
      });
      expect(data.data[1].id).toBe('gpt-5-6');
      expect(data.data[2].id).toBe('auto');
    });

    it('falls back to ["auto"] when upstream catalog fetch fails', async () => {
      mockClient.modelsHandler = async () => {
        throw new Error('upstream down');
      };
      const res = await app.request('/v1/models', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.data.map((m: any) => m.id)).toEqual(['auto']);
    });

    it('serves the catalog from KV cache without hitting upstream twice', async () => {
      mockClient.modelsHandler = async () => ['gpt-5-6', 'auto'];
      await app.request('/v1/models', { method: 'GET' }, mockEnv);
      mockClient.modelsHandler = async () => {
        throw new Error('should not be called');
      };
      const res = await app.request('/v1/models', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.data.map((m: any) => m.id)).toEqual(['gpt-5-6', 'auto']);
      expect(mockClient.modelsCalls).toBe(1);
    });
  });

  describe('POST /v1/chat/completions - upstream DTO options', () => {
    const chatBody = (extra: any = {}) =>
      JSON.stringify({ model: 'gpt-5-6', messages: [{ role: 'user', content: 'hi' }], ...extra });

    const postChat = async (body: string) =>
      app.request(
        '/v1/chat/completions',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
        mockEnv
      );

    it('passes the requested model through with no mapping', async () => {
      const res = await postChat(chatBody());
      expect(res.status).toBe(200);
      expect(mockClient.prepareCalls[0].anonBody.model).toBe('gpt-5-6');
    });

    it('defaults model to auto when absent', async () => {
      const res = await postChat(
        JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
      );
      expect(res.status).toBe(200);
      expect(mockClient.prepareCalls[0].anonBody.model).toBe('auto');
    });

    it('enables forceUseSearch by default', async () => {
      const res = await postChat(chatBody());
      expect(res.status).toBe(200);
      expect(mockClient.prepareCalls[0].anonBody.forceUseSearch).toBe(true);
    });

    it('disables upstream search when search=false', async () => {
      const res = await postChat(chatBody({ search: false }));
      expect(res.status).toBe(200);
      expect(mockClient.prepareCalls[0].anonBody.forceUseSearch).toBe(false);
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

describe('Tool calling (OpenAI tools API)', () => {
  it('compiles tools into a system protocol message and maps role:"tool" results upstream', async () => {
    const { app } = await import('./index');
    const client = new MockUpstreamClient();
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({ client, deviceManager: dm });

    const payload = {
      model: 'auto',
      stream: false,
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo? Use the tool.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc123',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_abc123', name: 'get_weather', content: '{"temp_c":26}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, mockEnv);

    expect(res.status).toBe(200);
    // Inspect what was sent upstream
    const convCall = client.conversationCalls[0];
    expect(convCall).toBeDefined();
    const dto = convCall.anonBody;
    const msgs = dto.messages;
    // First message = tool protocol system
    expect(msgs[0].author.role).toBe('system');
    expect(msgs[0].content.parts[0]).toContain('get_weather');
    // User message preserved
    expect(msgs.some((m: any) => m.author.role === 'user')).toBe(true);
    // Tool result frame with author.name
    const toolFrame = msgs.find((m: any) => m.author.role === 'tool');
    expect(toolFrame).toBeDefined();
    expect(toolFrame.author.name).toBe('get_weather');
    expect(toolFrame.content.parts[0]).toContain('26');
    // Assistant tool_calls trajectory frame contains the JSON convention
    const asstFrame = msgs.find((m: any) => m.author.role === 'assistant');
    expect(asstFrame).toBeDefined();
    expect(asstFrame.content.parts[0]).toContain('tool_calls');
  });

  it('returns finish_reason "tool_calls" with assistant tool_calls when the model emits the JSON convention', async () => {
    const { app } = await import('./index');
    const client = new MockUpstreamClient();
    const toolReply = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Tokyo"}}]}';
    client.conversationHandler = async () =>
      createSseResponse([`data: ${JSON.stringify(mkAssistantEvent(toolReply))}\n\n`]);
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({ client, deviceManager: dm });

    const payload = {
      model: 'auto',
      stream: false,
      messages: [{ role: 'user', content: 'weather in Tokyo?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, mockEnv);

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.choices[0].finish_reason).toBe('tool_calls');
    expect(data.choices[0].message.content).toBeNull();
    expect(data.choices[0].message.tool_calls).toHaveLength(1);
    const tc = data.choices[0].message.tool_calls[0];
    expect(tc.id).toMatch(/^call_[A-Za-z0-9]{22}$/);
    expect(tc.type).toBe('function');
    expect(tc.function.name).toBe('get_weather');
    expect(tc.function.arguments).toBe('{"city":"Tokyo"}');
  });

  it('streams tool_calls delta frames without leaking the JSON', async () => {
    const { app } = await import('./index');
    const client = new MockUpstreamClient();
    const toolReply = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Tokyo"}}]}';
    client.conversationHandler = async () =>
      createSseResponse([`data: ${JSON.stringify(mkAssistantEvent(toolReply))}\n\n`]);
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({ client, deviceManager: dm });

    const payload = {
      model: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'weather in Tokyo?' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: {} } },
        },
      ],
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, mockEnv);

    expect(res.status).toBe(200);
    const raw = await res.text();
    // The raw JSON convention must NOT appear as streamed content
    expect(raw).not.toContain('"tool_calls":[{"name"');
    // A tool_calls delta frame must appear
    expect(raw).toContain('tool_calls');
    expect(raw).toContain('get_weather');
    // finish_reason tool_calls in the final chunk
    expect(raw).toContain('finish_reason":"tool_calls"');
  });

  it('plain text replies keep finish_reason "stop" and content even with tools present', async () => {
    const { app } = await import('./index');
    const client = new MockUpstreamClient();
    client.conversationHandler = async () =>
      createSseResponse([`data: ${JSON.stringify(mkAssistantEvent('The weather is sunny.'))}\n\n`]);
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({ client, deviceManager: dm });

    const payload = {
      model: 'auto',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        { type: 'function', function: { name: 'get_weather', description: 'x', parameters: { type: 'object', properties: {} } } },
      ],
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, mockEnv);

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.choices[0].finish_reason).toBe('stop');
    expect(data.choices[0].message.content).toBe('The weather is sunny.');
    expect(data.choices[0].message.tool_calls).toBeUndefined();
  });

  it('tool_choice "none" disables the tool protocol entirely', async () => {
    const { app } = await import('./index');
    const client = new MockUpstreamClient();
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({ client, deviceManager: dm });

    const payload = {
      model: 'auto',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: 'none',
      tools: [
        { type: 'function', function: { name: 'get_weather', description: 'x', parameters: { type: 'object', properties: {} } } },
      ],
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, mockEnv);

    expect(res.status).toBe(200);
    const convCall = client.conversationCalls[0];
    const msgs = convCall.anonBody.messages;
    // No tool protocol system message inserted
    expect(msgs[0].author.role).not.toBe('system');
  });
});
