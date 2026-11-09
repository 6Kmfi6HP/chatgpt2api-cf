import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApp, toolChoiceError } from './index';
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
  public prepareHandler?: () => Promise<string>;
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
    if (this.prepareHandler) {
      return await this.prepareHandler();
    }
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

  describe('POST /v1/chat/completions - unknown model maps to 400', () => {
    const postChat = async (body: string) =>
      app.request(
        '/v1/chat/completions',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
        mockEnv
      );

    it('returns 400 when every device reports an empty conduit_token', async () => {
      mockClient.prepareHandler = async () => {
        throw new Error('chatgpt-anon prepare: empty conduit_token (status="ok")');
      };
      const res = await postChat(
        JSON.stringify({ model: 'no-such-model-xyz', messages: [{ role: 'user', content: 'hi' }] })
      );
      expect(res.status).toBe(400);
      const data: any = await res.json();
      expect(data.error.type).toBe('invalid_request_error');
      expect(data.error.param).toBe('model');
    });

    it('keeps 500 for an empty conduit_token with a non-ok upstream status', async () => {
      mockClient.prepareHandler = async () => {
        throw new Error('chatgpt-anon prepare: empty conduit_token (status="error")');
      };
      const res = await postChat(
        JSON.stringify({ model: 'gpt-5-6', messages: [{ role: 'user', content: 'hi' }] })
      );
      expect(res.status).toBe(500);
    });

    it('still returns 500 for a transient non-empty-conduit error', async () => {
      mockClient.prepareHandler = async () => {
        throw new Error('chatgpt-anon prepare: network exploded');
      };
      const res = await postChat(
        JSON.stringify({ model: 'gpt-5-6', messages: [{ role: 'user', content: 'hi' }] })
      );
      expect(res.status).toBe(500);
    });

    it('propagates a non-empty conduit_token normally (control)', async () => {
      const res = await postChat(
        JSON.stringify({ model: 'gpt-5-6', messages: [{ role: 'user', content: 'hi' }] })
      );
      expect(res.status).toBe(200);
    });
  });

  describe('POST /v1/chat/completions - multi-turn history replay', () => {
    const postChat = async (body: any) =>
      app.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        mockEnv
      );

    it('maps each message of a multi-turn conversation to a native upstream frame', async () => {
      const res = await postChat({
        model: 'auto',
        messages: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: 'remember the codeword alpha1' },
          { role: 'assistant', content: 'ok1' },
          { role: 'user', content: 'What was the codeword?' },
        ],
      });
      expect(res.status).toBe(200);
      const dto = mockClient.prepareCalls[0].anonBody;
      expect(dto.messages.map((m: any) => m.author.role)).toEqual([
        'system',
        'user',
        'assistant',
        'user',
      ]);
      expect(dto.messages.map((m: any) => m.content.parts[0])).toEqual([
        'You are concise.',
        'remember the codeword alpha1',
        'ok1',
        'What was the codeword?',
      ]);
      // Stateless OpenAI semantics stay: a fresh upstream conversation per
      // request, with the whole history replayed as native frames.
      expect(dto.conversationId).toBeNull();
      expect(dto.parentMessageId).toBeNull();
      // No labeled-transcript blob pasted into a single frame anymore.
      expect(JSON.stringify(dto.messages)).not.toContain('Assistant:');
    });

    it('keeps the single-message wire shape: one verbatim user frame', async () => {
      const res = await postChat({
        model: 'auto',
        messages: [{ role: 'user', content: 'Say hello' }],
      });
      expect(res.status).toBe(200);
      const dto = mockClient.prepareCalls[0].anonBody;
      expect(dto.messages).toHaveLength(1);
      expect(dto.messages[0].author.role).toBe('user');
      expect(dto.messages[0].content.parts[0]).toBe('Say hello');
    });

    it('falls back to a single user frame when history has no user message', async () => {
      const res = await postChat({
        model: 'auto',
        messages: [{ role: 'system', content: 'You are terse.' }],
      });
      expect(res.status).toBe(200);
      const dto = mockClient.prepareCalls[0].anonBody;
      expect(dto.messages).toHaveLength(1);
      expect(dto.messages[0].author.role).toBe('user');
      expect(dto.messages[0].content.parts[0]).toContain('You are terse.');
    });

    it('tool history without tools enabled maps role:"tool" results to tool frames', async () => {
      const res = await postChat({
        model: 'auto',
        messages: [
          { role: 'user', content: 'weather in Tokyo?' },
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
          {
            role: 'tool',
            tool_call_id: 'call_abc123',
            name: 'get_weather',
            content: '{"temp_c":26}',
          },
        ],
      });
      expect(res.status).toBe(200);
      const msgs = mockClient.prepareCalls[0].anonBody.messages;
      expect(msgs.length).toBe(3);
      expect(msgs[0].author.role).toBe('user');
      expect(msgs[1].author.role).toBe('assistant');
      expect(msgs[1].content.parts[0]).toContain('tool_calls');
      expect(msgs[2].author.role).toBe('tool');
      expect(msgs[2].author.name).toBe('get_weather');
      expect(msgs[2].content.parts[0]).toBe('{"temp_c":26}');
      // No tool protocol frame: tools were not part of the request.
      expect(msgs[0].author.role).not.toBe('system');
    });
  });

  describe('Bearer Token Authentication', () => {
    it.each<{
      name: string;
      apiKeys: string;
      path: string;
      headers: Record<string, string>;
      expectedStatus: number;
      expectedCode?: string;
    }>([
      {
        name: 'public mode: no API_KEYS allows /v1/models',
        apiKeys: '',
        path: '/v1/models',
        headers: {},
        expectedStatus: 200,
      },
      {
        name: 'protected: missing header is 401 invalid_api_key',
        apiKeys: 'secret-token-1,secret-token-2',
        path: '/v1/models',
        headers: {},
        expectedStatus: 401,
        expectedCode: 'invalid_api_key',
      },
      {
        name: 'protected: wrong token is 401 invalid_api_key',
        apiKeys: 'secret-token-1,secret-token-2',
        path: '/v1/models',
        headers: { Authorization: 'Bearer wrong-token' },
        expectedStatus: 401,
        expectedCode: 'invalid_api_key',
      },
      {
        name: 'protected: valid Bearer token allows access',
        apiKeys: 'secret-token-1,secret-token-2',
        path: '/v1/models',
        headers: { Authorization: 'Bearer secret-token-2' },
        expectedStatus: 200,
      },
      {
        name: 'protected: valid token via x-api-key allows access',
        apiKeys: 'secret-token-1,secret-token-2',
        path: '/v1/models',
        headers: { 'x-api-key': 'secret-token-1' },
        expectedStatus: 200,
      },
      {
        name: 'protected: /health stays public',
        apiKeys: 'secret-token-1',
        path: '/health',
        headers: {},
        expectedStatus: 200,
      },
    ])('auth: $name', async ({ apiKeys, path, headers, expectedStatus, expectedCode }) => {
      const authEnv = { ...mockEnv, API_KEYS: apiKeys };
      const res = await app.request(path, { method: 'GET', headers }, authEnv);
      expect(res.status).toBe(expectedStatus);
      if (expectedStatus === 401) {
        const data: any = await res.json();
        expect(data.error.code).toBe(expectedCode);
        expect(data.error.type).toBe('invalid_request_error');
        expect(data.error.message).toBe('Incorrect API key provided');
      }
    });
  });

  describe('POST /v1/chat/completions - Request Validation', () => {
    it.each([
      {
        name: 'invalid JSON body',
        body: 'not a json',
        expectedMessage: undefined as string | undefined,
      },
      {
        name: 'empty messages array',
        body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
        expectedMessage: 'messages',
      },
      {
        name: 'JSON null body',
        body: 'null',
        expectedMessage: 'Invalid JSON request body',
      },
    ])('400: $name', async ({ body, expectedMessage }) => {
      const res = await app.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
        mockEnv
      );
      expect(res.status).toBe(400);
      const data: any = await res.json();
      expect(data.error.type).toBe('invalid_request_error');
      if (expectedMessage) {
        expect(data.error.message).toContain(expectedMessage);
      }
    });

    it.each([
      {
        name: 'missing model',
        payload: { messages: [{ role: 'user', content: 'hi' }] },
      },
      {
        name: 'blank model',
        payload: { model: '  ', messages: [{ role: 'user', content: 'hi' }] },
      },
      {
        name: 'non-string model',
        payload: { model: 123, messages: [{ role: 'user', content: 'hi' }] },
      },
      {
        name: 'missing model on a stream request',
        payload: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
      },
    ])('400 model: $name', async ({ payload }) => {
      const res = await app.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        mockEnv
      );
      expect(res.status).toBe(400);
      // Rejected as JSON before the stream opens, never as an SSE error frame.
      expect(res.headers.get('content-type')).toContain('application/json');
      const data = (await res.json()) as {
        error: { type: string; param: string; message: string };
      };
      expect(data.error.type).toBe('invalid_request_error');
      expect(data.error.param).toBe('model');
      expect(data.error.message).toContain('model');
      // No upstream work at all: no device prepared, no conversation opened.
      expect(mockClient.prepareCalls).toHaveLength(0);
      expect(mockClient.conversationCalls).toHaveLength(0);
    });

    // A malformed entry used to reach the upstream DTO builders, which iterate
    // `content` and read `message.role`: a number there threw a TypeError and
    // surfaced as HTTP 500 api_error — a caller-side bug reported as a gateway
    // fault (and triggering SDK retry/alert loops).
    it.each([
      {
        name: 'content is a number',
        messages: [{ role: 'user', content: 123 }],
        expectedMessage: 'messages[0].content',
      },
      {
        name: 'content is an object',
        messages: [{ role: 'user', content: { text: 'hi' } }],
        expectedMessage: 'messages[0].content',
      },
      {
        name: 'content is a boolean (streaming)',
        messages: [{ role: 'user', content: true }],
        expectedMessage: 'messages[0].content',
        stream: true,
      },
      {
        name: 'message is null',
        messages: [null],
        expectedMessage: 'messages[0]',
      },
      {
        name: 'message is a string',
        messages: ['hi'],
        expectedMessage: 'messages[0]',
      },
      {
        name: 'role is a number',
        messages: [{ role: 42, content: 'hi' }],
        expectedMessage: 'messages[0].role',
      },
      {
        name: 'content part is not an object',
        messages: [{ role: 'user', content: [123] }],
        expectedMessage: 'messages[0].content[0]',
      },
      {
        name: 'tool result content is a number',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 5 },
        ],
        expectedMessage: 'messages[2].content',
      },
    ])('400 on malformed message shape: $name', async ({ messages, expectedMessage, stream }) => {
      const res = await app.request(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'auto', messages, ...(stream ? { stream } : {}) }),
        },
        mockEnv
      );
      expect(res.status).toBe(400);
      const data: { error: { type: string; param: string; message: string } } = await res.json();
      expect(data.error.type).toBe('invalid_request_error');
      expect(data.error.param).toBe('messages');
      expect(data.error.message).toContain(expectedMessage);
      // Rejected before any upstream work: no device, no conversation.
      expect(mockClient.prepareCalls).toHaveLength(0);
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

    it('streaming tool refusal is transparently retried on a fresh device and yields tool_calls', async () => {
      const tool = {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      };
      let callCount = 0;
      mockClient.conversationHandler = async () => {
        callCount++;
        if (callCount === 1) {
          // Attempt 1: refusal prose, no tool_call JSON.
          return createSseResponse([
            `data: ${JSON.stringify(
              mkAssistantEvent("I'm unable to access the weather tool from here.")
            )}\n\n`,
          ]);
        }
        // Attempt 2: the tool-call convention JSON.
        return createSseResponse([
          `data: ${JSON.stringify(
            mkAssistantEvent('{"tool_calls":[{"name":"get_weather","arguments":{"city":"上海"}}]}')
          )}\n\n`,
        ]);
      };

      const reqPayload = {
        model: 'auto',
        stream: true,
        search: false,
        tools: [tool],
        messages: [{ role: 'user', content: '查一下上海今天天气' }],
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

      // Upstream was consulted twice: refusal attempt + successful retry.
      expect(callCount).toBe(2);
      // Client received a real tool_call frame. The refusal prose never leaked.
      expect(bodyText).toContain('"tool_calls"');
      expect(bodyText).toContain('get_weather');
      expect(bodyText).not.toContain('unable to access');
      expect(bodyText).toContain('"finish_reason":"tool_calls"');
      expect(bodyText).toContain('data: [DONE]');
    });

    it('streaming retry preserves finish_reason length from the aggregated retry result', async () => {
      const tool = {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      };
      let callCount = 0;
      mockClient.conversationHandler = async () => {
        callCount++;
        if (callCount === 1) {
          // Attempt 1: refusal prose, no tool_call JSON.
          return createSseResponse([
            `data: ${JSON.stringify(
              mkAssistantEvent("I'm unable to access the weather tool from here.")
            )}\n\n`,
          ]);
        }
        // Attempt 2: long plain prose; the aggregated retry cuts it at max_tokens.
        return createSseResponse([
          `data: ${JSON.stringify(mkAssistantEvent('a'.repeat(200)))}\n\n`,
        ]);
      };

      const reqPayload = {
        model: 'auto',
        stream: true,
        search: false,
        tools: [tool],
        // 6 tokens admits 27 ASCII chars (floor(27/4)=6): the refusal keeps
        // its "unable to access" shape (still recognized, retried), while
        // the 200-char retry text is capped at 27.
        max_tokens: 6,
        messages: [{ role: 'user', content: 'hi' }],
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
      const bodyText = await res.text();
      // Upstream consulted twice: refusal attempt + retried aggregate.
      expect(callCount).toBe(2);
      // The refusal prose itself never leaked into the stream.
      expect(bodyText).not.toContain('unable to access');
      // The retried aggregate was capped, and the synthesized stream must
      // report the SAME binding constraint, not degrade it to "stop".
      expect(bodyText).toContain('"finish_reason":"length"');
      expect(bodyText).not.toContain('"finish_reason":"stop"');
      expect(bodyText).not.toContain('a'.repeat(28));
      expect(bodyText).toContain('data: [DONE]');
    });

    it('streaming refusal retries are exhausted: the last refusal streams as-is', async () => {
      const tool = {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      };
      let callCount = 0;
      mockClient.conversationHandler = async () => {
        callCount++;
        return createSseResponse([
          `data: ${JSON.stringify(
            mkAssistantEvent("I'm unable to access that tool right now.")
          )}\n\n`,
        ]);
      };

      const reqPayload = {
        model: 'auto',
        stream: true,
        search: false,
        tools: [tool],
        messages: [{ role: 'user', content: '查一下上海今天天气' }],
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
      const bodyText = await res.text();
      // Refusal text only ever appears ONCE in the client-visible stream, from
      // the final attempt — previous buffered attempts never leaked.
      const refusalOccurrences = (bodyText.match(/unable to access/g) || []).length;
      expect(refusalOccurrences).toBe(1);
      expect(bodyText).toContain('data: [DONE]');
      // 1 initial + up to (MAX_STREAM_ATTEMPTS-1) transparent retries + the
      // final non-stream retry inside the loop that also failed → bounded.
      expect(callCount).toBeGreaterThanOrEqual(1);
      expect(callCount).toBeLessThanOrEqual(8);
    });

    it('streaming non-tool traffic skips refusal retry entirely', async () => {
      let callCount = 0;
      mockClient.conversationHandler = async () => {
        callCount++;
        return createSseResponse([
          `data: ${JSON.stringify(
            mkAssistantEvent("I can't access private systems, but here's public info.")
          )}\n\n`,
        ]);
      };

      const reqPayload = {
        model: 'auto',
        stream: true,
        messages: [{ role: 'user', content: '介绍一下股份有限公司' }],
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
      const bodyText = await res.text();
      expect(callCount).toBe(1);
      expect(bodyText).toContain("can't access private systems");
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

  it('rejects an orphan role:"tool" message with 400 invalid_request_error', async () => {
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({
      client: new MockUpstreamClient(),
      deviceManager: new DeviceManager(),
    });

    const payload = {
      model: 'auto',
      stream: false,
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'tool', tool_call_id: 'call_missing', name: 'get_weather', content: '{}' },
      ],
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, mockEnv);

    expect(res.status).toBe(400);
    const data: { error: { type: string; message: string } } = await res.json();
    expect(data.error.type).toBe('invalid_request_error');
    expect(data.error.message).toContain('tool');
  });

  it('accepts a role:"tool" message whose id matches a preceding tool_calls id', async () => {
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({
      client: new MockUpstreamClient(),
      deviceManager: new DeviceManager(),
    });

    const payload = {
      model: 'auto',
      stream: false,
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_ok1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_ok1', name: 'get_weather', content: '{"temp_c":26}' },
      ],
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, mockEnv);

    expect(res.status).toBe(200);
  });

  it('retries a tool-less plain reply under tool_choice:"required" and returns the eventual tool call', async () => {
    const client = new MockUpstreamClient();
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({ client, deviceManager: dm });

    let callCount = 0;
    client.conversationHandler = async () => {
      callCount++;
      if (callCount === 1) {
        // Violation: fluent prose instead of the mandated tool call.
        return createSseResponse([
          `data: ${JSON.stringify(mkAssistantEvent('北京今天晴，气温 22 度左右。'))}\n\n`,
        ]);
      }
      return createSseResponse([
        `data: ${JSON.stringify(
          mkAssistantEvent('{"tool_calls":[{"name":"get_weather","arguments":{"city":"北京"}}]}')
        )}\n\n`,
      ]);
    };

    const payload = {
      model: 'auto',
      stream: false,
      tool_choice: 'required',
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } },
        },
      ],
      messages: [{ role: 'user', content: '北京天气' }],
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, mockEnv);

    expect(res.status).toBe(200);
    const data: { choices: Array<{ finish_reason: string; message: { tool_calls?: Array<{ function: { name: string } }> } }> } = await res.json();
    expect(callCount).toBeGreaterThan(1);
    expect(data.choices[0].finish_reason).toBe('tool_calls');
    expect(data.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('does NOT retry a plain reply when tool_choice is auto', async () => {
    const client = new MockUpstreamClient();
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({ client, deviceManager: dm });

    let callCount = 0;
    client.conversationHandler = async () => {
      callCount++;
      return createSseResponse([
        `data: ${JSON.stringify(mkAssistantEvent('北京今天晴，气温 22 度左右。'))}\n\n`,
      ]);
    };

    const payload = {
      model: 'auto',
      stream: false,
      tool_choice: 'auto',
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } },
        },
      ],
      messages: [{ role: 'user', content: '北京天气' }],
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, mockEnv);

    expect(res.status).toBe(200);
    const data: { choices: Array<{ finish_reason: string }> } = await res.json();
    // Plain answer accepted as-is: no retry, single upstream call.
    expect(callCount).toBe(1);
    expect(data.choices[0].finish_reason).toBe('stop');
  });

  it('retries when a named tool_choice produced a call to a DIFFERENT tool', async () => {
    const client = new MockUpstreamClient();
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({ client, deviceManager: dm });

    let callCount = 0;
    client.conversationHandler = async () => {
      callCount++;
      if (callCount === 1) {
        // Wrong tool: contract demanded get_weather, the model called search.
        return createSseResponse([
          `data: ${JSON.stringify(
            mkAssistantEvent('{"tool_calls":[{"name":"web_search","arguments":{"q":"北京"}}]}')
          )}\n\n`,
        ]);
      }
      return createSseResponse([
        `data: ${JSON.stringify(
          mkAssistantEvent('{"tool_calls":[{"name":"get_weather","arguments":{"city":"北京"}}]}')
        )}\n\n`,
      ]);
    };

    const payload = {
      model: 'auto',
      stream: false,
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      tools: [
        { type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'web_search', description: 's', parameters: { type: 'object', properties: {} } } },
      ],
      messages: [{ role: 'user', content: '北京天气' }],
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, mockEnv);

    expect(res.status).toBe(200);
    const data: { choices: Array<{ finish_reason: string; message: { tool_calls?: Array<{ function: { name: string } }> } }> } = await res.json();
    expect(callCount).toBeGreaterThan(1);
    expect(data.choices[0].finish_reason).toBe('tool_calls');
    expect(data.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  describe('tool_choice validation', () => {
    const weatherTool = {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'w',
        parameters: { type: 'object', properties: {} },
      },
    };

    function setup() {
      const client = new MockUpstreamClient();
      const testApp = createApp({ client, deviceManager: new DeviceManager() });
      const env = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
      const post = (payload: object) =>
        testApp.request(
          '/v1/chat/completions',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          env
        );
      return { post, client };
    }

    // Every illegal tool_choice is the caller's bug. Answering it with 200 (and,
    // for a ghost name, burning 4 upstream retries before degrading to plain
    // text) hides that bug and contradicts the contract the caller declared.
    it.each([
      {
        name: 'named function absent from tools',
        payload: {
          model: 'auto',
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [weatherTool],
          tool_choice: { type: 'function', function: { name: 'delete_everything' } },
        },
      },
      {
        name: 'named function with no tools at all',
        payload: {
          model: 'auto',
          messages: [{ role: 'user', content: 'weather?' }],
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
        },
      },
      {
        name: 'required with no tools',
        payload: {
          model: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
          tool_choice: 'required',
        },
      },
      {
        name: 'required with an empty tools array',
        payload: {
          model: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          tool_choice: 'required',
        },
      },
      {
        name: 'unknown string value',
        payload: {
          model: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [weatherTool],
          tool_choice: 'banana',
        },
      },
      {
        name: 'function object without a name',
        payload: {
          model: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [weatherTool],
          tool_choice: { type: 'function' },
        },
      },
      {
        name: 'non-string, non-object value',
        payload: {
          model: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [weatherTool],
          tool_choice: 7,
        },
      },
      {
        name: 'named function on a stream request',
        payload: {
          model: 'auto',
          stream: true,
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [weatherTool],
          tool_choice: { type: 'function', function: { name: 'delete_everything' } },
        },
      },
    ])('400 tool_choice: $name', async ({ payload }) => {
      const t = setup();
      const res = await t.post(payload);
      expect(res.status).toBe(400);
      // Rejected as JSON before the stream opens, never as an SSE error frame.
      expect(res.headers.get('content-type')).toContain('application/json');
      const data = (await res.json()) as {
        error: { type: string; param: string; message: string };
      };
      expect(data.error.type).toBe('invalid_request_error');
      expect(data.error.param).toBe('tool_choice');
      expect(data.error.message).toContain('tool_choice');
      // No upstream work at all: no device prepared, no conversation opened.
      // This is the part that matters for a ghost name — the old code ran four
      // retries before degrading to a plain-text 200.
      expect(t.client.prepareCalls).toHaveLength(0);
      expect(t.client.conversationCalls).toHaveLength(0);
    });

    it('keeps accepting "auto" and "none" without touching the tools array', async () => {
      for (const choice of ['auto', 'none']) {
        const t = setup();
        const res = await t.post({
          model: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [weatherTool],
          tool_choice: choice,
        });
        expect(res.status).toBe(200);
        expect(t.client.conversationCalls).toHaveLength(1);
      }
    });

    it('keeps accepting "required" and a declared named function', async () => {
      for (const choice of ['required', { type: 'function', function: { name: 'get_weather' } }]) {
        const t = setup();
        // A compliant tool call: no retry, so one upstream conversation proves
        // the choice was accepted rather than rejected.
        t.client.conversationHandler = async () =>
          createSseResponse([
            `data: ${JSON.stringify(
              mkAssistantEvent('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}')
            )}\n\n`,
          ]);
        const res = await t.post({
          model: 'auto',
          messages: [{ role: 'user', content: 'Weather in Paris?' }],
          tools: [weatherTool],
          tool_choice: choice,
        });
        expect(res.status).toBe(200);
        expect(t.client.conversationCalls).toHaveLength(1);
      }
    });
  });
});

describe('toolChoiceError', () => {
  const tools = [
    {
      type: 'function' as const,
      function: { name: 'get_weather', parameters: { type: 'object' } },
    },
  ];
  const base = (extra: Partial<ChatCompletionRequest>): ChatCompletionRequest => ({
    model: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  });

  it('accepts auto, none and an absent choice', () => {
    expect(toolChoiceError(base({ tools }))).toBeNull();
    expect(toolChoiceError(base({ tools, tool_choice: 'auto' }))).toBeNull();
    expect(toolChoiceError(base({ tools, tool_choice: 'none' }))).toBeNull();
  });

  it('accepts required and a declared name when tools exist', () => {
    expect(toolChoiceError(base({ tools, tool_choice: 'required' }))).toBeNull();
    expect(
      toolChoiceError(base({ tools, tool_choice: { type: 'function', function: { name: 'get_weather' } } }))
    ).toBeNull();
  });

  it('rejects an undeclared function name and names it in the message', () => {
    const err = toolChoiceError(
      base({ tools, tool_choice: { type: 'function', function: { name: 'ghost_tool' } } })
    );
    expect(err).toContain('ghost_tool');
    expect(err).toContain('tool_choice');
  });

  it('rejects required with no tools', () => {
    expect(toolChoiceError(base({ tool_choice: 'required' }))).toContain('tool_choice');
    expect(toolChoiceError(base({ tools: [], tool_choice: 'required' }))).toContain('tool_choice');
  });

  it('rejects malformed choices', () => {
    expect(toolChoiceError(base({ tools, tool_choice: 'banana' as never }))).toContain('tool_choice');
    expect(toolChoiceError(base({ tools, tool_choice: { type: 'function' } as never }))).toContain(
      'tool_choice'
    );
    expect(toolChoiceError(base({ tools, tool_choice: 7 as never }))).toContain('tool_choice');
  });

  it('treats exotic function name in tools as declared', () => {
    const exotic = [
      { type: 'function' as const, function: { name: 'ns:do_thing', parameters: { type: 'object' } } },
    ];
    expect(
      toolChoiceError(
        base({ tools: exotic, tool_choice: { type: 'function', function: { name: 'ns:do_thing' } } })
      )
    ).toBeNull();
  });
});

describe('Tool results vs upstream web search', () => {
  const weatherTool = {
    type: 'function',
    function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } },
  };
  const toolResultTurn = [
    { role: 'user', content: 'Thời tiết Hà Nội?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hà Nội"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"temp_c":17}' },
  ];
  // The model's own search, as upstream emits it before the visible reply.
  const searchFrames = [
    { message: { id: 'm-q', author: { role: 'assistant' }, recipient: 'web.run', content: { content_type: 'text', parts: [''] } } },
    { message: { id: 'm-r', author: { role: 'tool', name: 'web.run' }, content: { content_type: 'text', parts: [''] } } },
  ];
  const searchedAnswer = 'Theo dự báo trên mạng, Hà Nội hiện khoảng 27°C, trời nhiều mây, độ ẩm cao và có thể có mưa rào vào buổi tối.';
  const toolAnswer = 'Hà Nội hiện 17°C.';

  function setup(handler: (call: number) => Response) {
    const client = new MockUpstreamClient();
    const testApp = createApp({ client, deviceManager: new DeviceManager() });
    const env = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    let calls = 0;
    client.conversationHandler = async () => handler(++calls);
    const post = (payload: object) =>
      testApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, env);
    return { post, calls: () => calls };
  }

  const searchedReply = () =>
    createSseResponse([
      ...searchFrames.map((f) => `data: ${JSON.stringify(f)}\n\n`),
      `data: ${JSON.stringify(mkAssistantEvent(searchedAnswer))}\n\n`,
    ]);
  const toolReply = () => createSseResponse([`data: ${JSON.stringify(mkAssistantEvent(toolAnswer))}\n\n`]);

  it('retries a non-stream reply that searched the web instead of using the tool result', async () => {
    const t = setup((n) => (n === 1 ? searchedReply() : toolReply()));
    const res = await t.post({ model: 'auto', stream: false, tools: [weatherTool], messages: toolResultTurn });
    const data: any = await res.json();
    expect(t.calls()).toBe(2);
    expect(data.choices[0].message.content).toBe(toolAnswer);
  });

  it('retries a streaming reply that searched the web, never leaking the searched text', async () => {
    const t = setup((n) => (n === 1 ? searchedReply() : toolReply()));
    const res = await t.post({ model: 'auto', stream: true, tools: [weatherTool], messages: toolResultTurn });
    const body = await res.text();
    expect(t.calls()).toBe(2);
    expect(body).toContain('17°C');
    expect(body).not.toContain('27°C');
  });

  it('does not retry when the caller opted into search', async () => {
    const t = setup(() => searchedReply());
    const res = await t.post({ model: 'auto', stream: false, search: true, tools: [weatherTool], messages: toolResultTurn });
    const data: any = await res.json();
    expect(t.calls()).toBe(1);
    expect(data.choices[0].message.content).toBe(searchedAnswer);
  });

  it('does not retry a search when the last message is not a tool result', async () => {
    const t = setup(() => searchedReply());
    const res = await t.post({ model: 'auto', stream: false, tools: [weatherTool], messages: [{ role: 'user', content: 'Thời tiết Hà Nội?' }] });
    await res.json();
    expect(t.calls()).toBe(1);
  });
});

describe('Empty replies on tool requests', () => {
  const weatherTool = {
    type: 'function',
    function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } },
  };

  // The observed failure: the model ran its own web search, the search
  // returned no results, and upstream closed the turn with an empty text
  // part. Nothing about that frame is an error, so the gateway used to
  // forward it verbatim as an empty assistant message.
  const emptyAnswer = () =>
    createSseResponse([
      `data: ${JSON.stringify({
        message: {
          id: 'm-empty',
          author: { role: 'assistant', metadata: { real_author: 'tool:web' } },
          content: { content_type: 'text', parts: [''] },
          status: 'finished_successfully',
          end_turn: true,
          metadata: {
            finish_details: { type: 'stop' },
            is_complete: true,
            search_result_groups: [],
            message_type: 'next',
          },
          channel: 'final',
        },
      })}\n\n`,
    ]);
  const toolCallReply = () =>
    createSseResponse([
      `data: ${JSON.stringify(
        mkAssistantEvent('{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}')
      )}\n\n`,
    ]);

  function setup(handler: (call: number) => Response) {
    const client = new MockUpstreamClient();
    const testApp = createApp({ client, deviceManager: new DeviceManager() });
    const env = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    let calls = 0;
    client.conversationHandler = async () => handler(++calls);
    const post = (payload: object) =>
      testApp.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, env);
    return { post, calls: () => calls };
  }

  it('retries a non-stream tools request that returned neither content nor tool_calls', async () => {
    const t = setup((n) => (n === 1 ? emptyAnswer() : toolCallReply()));
    const res = await t.post({
      model: 'auto', stream: false, tools: [weatherTool],
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
    });
    const data: any = await res.json();
    expect(t.calls()).toBe(2);
    expect(data.choices[0].finish_reason).toBe('tool_calls');
    expect(data.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('retries a streaming tools request that returned neither content nor tool_calls', async () => {
    const t = setup((n) => (n === 1 ? emptyAnswer() : toolCallReply()));
    const res = await t.post({
      model: 'auto', stream: true, tools: [weatherTool],
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
    });
    const body = await res.text();
    expect(t.calls()).toBe(2);
    expect(body).toContain('get_weather');
    expect(body).toContain('"tool_calls"');
  });

  it('gives up after the bounded retry budget when every attempt is empty', async () => {
    const t = setup(() => emptyAnswer());
    const res = await t.post({
      model: 'auto', stream: false, tools: [weatherTool],
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
    });
    const data: any = await res.json();
    // One initial attempt plus the 4 bounded retries in retryToolTurn.
    expect(t.calls()).toBe(5);
    expect(res.status).toBe(200);
    expect(data.choices[0].message.content).toBe('');
  });

  it('does not retry an empty reply when the request carries no tools', async () => {
    const t = setup(() => emptyAnswer());
    const res = await t.post({
      model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }],
    });
    const data: any = await res.json();
    expect(t.calls()).toBe(1);
    expect(data.choices[0].message.content).toBe('');
  });
});

describe('Streaming incrementality with tools (typing effect)', () => {
  it('streams tool-request prose incrementally instead of one buffered burst', async () => {
    const client = new MockUpstreamClient();
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({
      client,
      deviceManager: dm,
      // Keep the time trigger from firing so the byte trigger alone decides.
      nonStreamCommitDeadlineMs: 60_000,
      keepAliveIntervalMs: 60_000,
    });

    // Cumulative snapshots of a long non-refusal answer, released with real
    // gaps so a "buffer everything" regression is observable in the timing.
    const encoder = new TextEncoder();
    const snap = (text: string, finished = false) =>
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

    // First snapshot already exceeds TOOL_REFUSAL_DECISION_CHARS (80), so the
    // commit decision happens on frame one: anything after that must stream
    // straight through rather than wait for the socket to close.
    const parts = ['A'.repeat(100), 'A'.repeat(160), 'A'.repeat(220), 'A'.repeat(280)];
    const queued: Array<() => void> = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let i = 0;
        const push = () => {
          if (i >= parts.length) return;
          const text = parts[i];
          const last = i === parts.length - 1;
          i++;
          controller.enqueue(snap(text, last));
          if (!last) queued.push(push);
        };
        push();
      },
    });
    client.conversationHandler = async () =>
      new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });

    const res = await testApp.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'auto',
          stream: true,
          tools: [
            {
              type: 'function',
              function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } },
            },
          ],
          messages: [{ role: 'user', content: '写一篇长文' }],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    // First frame must arrive BEFORE the upstream stream ends (i.e. before the
    // remaining snapshots are released) — the whole point of the fix.
    while (!seen.includes('"content":"AAAA')) {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      if (value) seen += decoder.decode(value, { stream: true });
    }
    // Release the rest so the handler can finish.
    for (const release of queued) release();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) seen += decoder.decode(value, { stream: true });
    }

    const contents = seen
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l.slice(6).trim() !== '[DONE]')
      .map((l) => JSON.parse(l.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> })
      .map((c) => c.choices?.[0]?.delta?.content)
      .filter((c): c is string => typeof c === 'string');
    // Multiple content frames, not one burst: incremental delivery.
    expect(contents.length).toBeGreaterThan(1);
    expect(contents.join('')).toContain('A'.repeat(280));
  });

  it('still holds a long refusal so it can be retried on a fresh device', async () => {
    const client = new MockUpstreamClient();
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({ client, deviceManager: dm, keepAliveIntervalMs: 60_000 });

    const encoder = new TextEncoder();
    const snap = (text: string) =>
      encoder.encode(
        `data: ${JSON.stringify({
          type: 'message_stream',
          message: {
            id: 'live-1',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: [text] },
            status: 'in_progress',
            metadata: { message_type: 'next' },
          },
        })}\n\n`
      );

    let call = 0;
    client.conversationHandler = async () => {
      call++;
      if (call === 1) {
        // Long refusal: exceeds the byte trigger several times over, yet must
        // never be committed early — it has to remain retryable.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(snap("I'm unable to access the weather tool, so I cannot check that for you. ".repeat(4)));
              c.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              snap('{"tool_calls":[{"name":"get_weather","arguments":{"city":"上海"}}]}')
            );
            c.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    };

    const res = await testApp.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'auto',
          stream: true,
          tools: [
            {
              type: 'function',
              function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } },
            },
          ],
          messages: [{ role: 'user', content: '上海天气' }],
        }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    // Retried and recovered: the tool call reached the client, and the refusal
    // prose was never streamed as the answer.
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(call).toBeGreaterThan(1);
    expect(text).not.toContain('unable to access the weather tool');
  });
});

describe('Transport behavior (heartbeat / keepalive)', () => {
  it('emits SSE : ping comment lines while the upstream stream is idle', async () => {
    const client = new MockUpstreamClient();
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    const testApp = createApp({ client, deviceManager: dm, keepAliveIntervalMs: 10 });

    // Upstream sends nothing until we release it, forcing the ping timer to fire.
    const gate = Promise.withResolvers<void>();
    const encoder = new TextEncoder();
    client.conversationHandler = async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate.promise;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(mkAssistantEvent('Late answer.'))}\n\n`)
          );
          controller.close();
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }, mockEnv);

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    // Read until at least one ping comment is observed.
    while (!seen.includes(': ping')) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    expect(seen).toContain(': ping');

    gate.resolve();
    // Drain the rest so the handler's finally/cleanup runs.
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  });

  it('commits early with a whitespace-heartbeat body when the non-stream deadline elapses', async () => {
    const client = new MockUpstreamClient();
    const dm = new DeviceManager();
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    // Tiny deadline so the slow path triggers deterministically in-test.
    const testApp = createApp({ client, deviceManager: dm, nonStreamCommitDeadlineMs: 10, keepAliveIntervalMs: 10 });

    const gate = Promise.withResolvers<void>();
    const encoder = new TextEncoder();
    client.conversationHandler = async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate.promise;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(mkAssistantEvent('Slow final answer.'))}\n\n`)
          );
          controller.close();
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };

    const res = await testApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    }, mockEnv);

    // Committed before the body was ready: chunked, and still parses once
    // the whitespace heartbeats are stripped.
    expect(res.status).toBe(200);
    expect(res.headers.get('transfer-encoding')).toBe('chunked');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const firstRead = await reader.read();
    seen += decoder.decode(firstRead.value, { stream: true });
    // First byte is whitespace (heartbeat), not JSON.
    expect(seen.trim()).toBe('');

    gate.resolve();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    const parsed = JSON.parse(seen.trim()) as { choices: Array<{ message: { content: string } }> };
    expect(parsed.choices[0].message.content).toBe('Slow final answer.');
  });
});

describe('parallel_tool_calls:false', () => {
  const threeCalls =
    '{"tool_calls":[{"name":"get_temp","arguments":{"city":"Paris"}},{"name":"get_wind","arguments":{"city":"Paris"}},{"name":"get_humidity","arguments":{"city":"Paris"}}]}';
  const tools = [
    { type: 'function' as const, function: { name: 'get_temp', description: 't', parameters: { type: 'object', properties: {} } } },
    { type: 'function' as const, function: { name: 'get_wind', description: 'w', parameters: { type: 'object', properties: {} } } },
    { type: 'function' as const, function: { name: 'get_humidity', description: 'h', parameters: { type: 'object', properties: {} } } },
  ];

  function makeApp() {
    const client = new MockUpstreamClient();
    client.conversationHandler = async () =>
      createSseResponse([`data: ${JSON.stringify(mkAssistantEvent(threeCalls))}\n\n`]);
    const mockEnv = { CHATGPT_KV: new MockKVNamespace() } as unknown as Env;
    return { client, mockEnv, app: createApp({ client, deviceManager: new DeviceManager() }) };
  }

  async function post(app: ReturnType<typeof createApp>, mockEnv: Env, extra: Record<string, unknown>) {
    return app.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'auto',
          messages: [{ role: 'user', content: 'weather, wind, humidity in Paris' }],
          tools,
          ...extra,
        }),
      },
      mockEnv
    );
  }

  it('returns one tool call for a non-streaming request', async () => {
    const { app, mockEnv } = makeApp();
    const res = await post(app, mockEnv, { parallel_tool_calls: false });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.choices[0].finish_reason).toBe('tool_calls');
    expect(data.choices[0].message.tool_calls).toHaveLength(1);
    expect(data.choices[0].message.tool_calls[0].function.name).toBe('get_temp');
  });

  it('returns every tool call when parallel_tool_calls is absent', async () => {
    const { app, mockEnv } = makeApp();
    const data: any = await (await post(app, mockEnv, {})).json();
    expect(data.choices[0].message.tool_calls).toHaveLength(3);
  });

  it('returns every tool call when parallel_tool_calls is true', async () => {
    const { app, mockEnv } = makeApp();
    const data: any = await (await post(app, mockEnv, { parallel_tool_calls: true })).json();
    expect(data.choices[0].message.tool_calls).toHaveLength(3);
  });

  it('streams exactly one tool_calls delta with index 0', async () => {
    const { app, mockEnv } = makeApp();
    const res = await post(app, mockEnv, { parallel_tool_calls: false, stream: true });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const deltas: any[] = [];
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ') || line.slice(6) === '[DONE]') continue;
      const chunk = JSON.parse(line.slice(6));
      for (const c of chunk.choices ?? []) {
        for (const tc of c.delta?.tool_calls ?? []) deltas.push(tc);
      }
    }
    expect(deltas).toHaveLength(1);
    expect(deltas[0].index).toBe(0);
    expect(deltas[0].function.name).toBe('get_temp');
    expect(raw).toContain('"finish_reason":"tool_calls"');
  });

  it('keeps the named tool when tool_choice demands it', async () => {
    const { app, mockEnv } = makeApp();
    const res = await post(app, mockEnv, {
      parallel_tool_calls: false,
      tool_choice: { type: 'function', function: { name: 'get_humidity' } },
    });
    const data: any = await res.json();
    expect(data.choices[0].message.tool_calls).toHaveLength(1);
    expect(data.choices[0].message.tool_calls[0].function.name).toBe('get_humidity');
  });

  it('rejects a non-boolean parallel_tool_calls with 400', async () => {
    const { app, mockEnv } = makeApp();
    const res = await post(app, mockEnv, { parallel_tool_calls: 'no' });
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error.type).toBe('invalid_request_error');
    expect(data.error.param).toBe('parallel_tool_calls');
  });
});

describe('sampling parameters (max_tokens / stop)', () => {
  let client: MockUpstreamClient;
  let mockEnv: Env;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clearCatalogCache();
    client = new MockUpstreamClient();
    app = createApp({ client, deviceManager: new DeviceManager(100) });
    mockEnv = {
      CHATGPT_KV: new MockKVNamespace() as unknown as Env['CHATGPT_KV'],
      API_KEYS: '',
      DEVICE_POOL_SIZE: '3',
    } as unknown as Env;
  });

  async function post(payload: Record<string, unknown>) {
    return app.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-5', messages: [{ role: 'user', content: 'hi' }], ...payload }),
      },
      mockEnv
    );
  }


  it('rejects max_tokens below 1 with 400', async () => {
    const res = await post({ max_tokens: 0 });
    expect(res.status).toBe(400);
    const data: { error: { type: string; param: string; message: string } } = await res.json();
    expect(data.error.type).toBe('invalid_request_error');
    expect(data.error.param).toBe('max_tokens');
    expect(data.error.message).toContain('positive integer');
  });

  it('rejects a non-string stop with 400', async () => {
    const res = await post({ stop: 123 });
    expect(res.status).toBe(400);
    const data: { error: { param: string } } = await res.json();
    expect(data.error.param).toBe('stop');
  });

  it('rejects more than four stop sequences with 400', async () => {
    const res = await post({ stop: ['a', 'b', 'c', 'd', 'e'] });
    expect(res.status).toBe(400);
  });

  it('truncates a non-streaming reply at the stop sequence', async () => {
    client.conversationHandler = async () =>
      createSseResponse([
        `data: ${JSON.stringify(mkAssistantEvent('Counting '))}\n\n`,
        `data: ${JSON.stringify(mkAssistantEvent('Counting 1, 2, 3 STOP after'))}\n\n`,
      ]);

    const res = await post({ stream: false, stop: 'STOP' });
    expect(res.status).toBe(200);
    const data: {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    } = await res.json();
    expect(data.choices[0].message.content).toBe('Counting 1, 2, 3 ');
    expect(data.choices[0].finish_reason).toBe('stop');
  });

  it('caps a streaming reply at max_tokens with finish_reason length', async () => {
    client.conversationHandler = async () =>
      createSseResponse([`data: ${JSON.stringify(mkAssistantEvent('a'.repeat(200)))}\n\n`]);

    const res = await post({ stream: true, max_tokens: 3 });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"finish_reason":"length"');
    expect(body).toContain('data: [DONE]');
  });
});

// Guards [audit:silent-unsupported-params]: `n` and `logprobs` change the
// RESPONSE STRUCTURE (`choices.length`, `choices[0].logprobs.content`), so the
// anonymous single-session upstream cannot honour them. Accepting them and
// answering a single choice without logprobs makes parsing clients read
// undefined or run off the array end. Both the streaming and the non-streaming
// path must reject them before any upstream call is spent.
describe('unsupported response-shape parameters (n / logprobs)', () => {
  let client: MockUpstreamClient;
  let mockEnv: Env;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clearCatalogCache();
    client = new MockUpstreamClient();
    app = createApp({ client, deviceManager: new DeviceManager(100) });
    mockEnv = {
      CHATGPT_KV: new MockKVNamespace() as unknown as Env['CHATGPT_KV'],
      API_KEYS: '',
      DEVICE_POOL_SIZE: '3',
    } as unknown as Env;
  });

  async function post(payload: Record<string, unknown>) {
    return app.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-5', messages: [{ role: 'user', content: 'hi' }], ...payload }),
      },
      mockEnv
    );
  }

  it('rejects n greater than 1 with 400 param "n" and spends no upstream call', async () => {
    const res = await post({ n: 3 });
    expect(res.status).toBe(400);
    const data: { error: { type: string; param: string; code: string } } = await res.json();
    expect(data.error.type).toBe('invalid_request_error');
    expect(data.error.param).toBe('n');
    expect(data.error.code).toBe('unsupported_parameter');
    expect(client.prepareCalls.length).toBe(0);
    expect(client.conversationCalls.length).toBe(0);
  });

  it('rejects a streaming request with n greater than 1 before opening SSE', async () => {
    const res = await post({ n: 2, stream: true });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type') || '').toContain('application/json');
  });

  it('rejects an illegal n (0, negative, fractional, non-numeric) with 400 param "n"', async () => {
    for (const value of [0, -1, 1.5, '2', true]) {
      const res = await post({ n: value });
      expect(res.status).toBe(400);
      const data: { error: { param: string } } = await res.json();
      expect(data.error.param).toBe('n');
    }
  });

  it('still accepts n omitted and n equal to 1', async () => {
    for (const payload of [{}, { n: 1 }]) {
      const res = await post(payload);
      expect(res.status).toBe(200);
      const data: { choices: unknown[] } = await res.json();
      expect(data.choices.length).toBe(1);
    }
  });

  it('rejects logprobs:true with 400 param "logprobs"', async () => {
    const res = await post({ logprobs: true });
    expect(res.status).toBe(400);
    const data: { error: { param: string; code: string } } = await res.json();
    expect(data.error.param).toBe('logprobs');
    expect(data.error.code).toBe('unsupported_parameter');
    expect(client.conversationCalls.length).toBe(0);
  });

  it('rejects a non-boolean logprobs and a top_logprobs without logprobs', async () => {
    const nonBoolean = await post({ logprobs: 'yes' });
    expect(nonBoolean.status).toBe(400);
    const nonBooleanData: { error: { param: string } } = await nonBoolean.json();
    expect(nonBooleanData.error.param).toBe('logprobs');

    const orphanTopLogprobs = await post({ top_logprobs: 2 });
    expect(orphanTopLogprobs.status).toBe(400);
    const orphanData: { error: { param: string } } = await orphanTopLogprobs.json();
    expect(orphanData.error.param).toBe('top_logprobs');
  });

  it('accepts logprobs:false as an explicit opt-out', async () => {
    const res = await post({ logprobs: false });
    expect(res.status).toBe(200);
  });
});

// Guards [audit:response-format-ignored]: `response_format` / `modalities` /
// `audio` must be answered with 400 before any upstream work. A 200 with prose
// breaks structured-output clients at their own JSON.parse step, where the
// gateway log cannot show it; the honest answer is the same 400 shape #29 uses
// for n/logprobs. Streaming and non-streaming share the entry point, so both
// are covered here and neither may spend a device call.
describe('unsupported reply-shape parameters (response_format / modalities / audio)', () => {
  let client: MockUpstreamClient;
  let mockEnv: Env;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    clearCatalogCache();
    client = new MockUpstreamClient();
    app = createApp({ client, deviceManager: new DeviceManager(100) });
    mockEnv = {
      CHATGPT_KV: new MockKVNamespace() as unknown as Env['CHATGPT_KV'],
      API_KEYS: '',
      DEVICE_POOL_SIZE: '3',
    } as unknown as Env;
  });

  async function post(payload: Record<string, unknown>) {
    return app.request(
      '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-5', messages: [{ role: 'user', content: 'hi' }], ...payload }),
      },
      mockEnv
    );
  }

  it('rejects response_format json_object with 400 param "response_format"', async () => {
    const res = await post({ response_format: { type: 'json_object' } });
    expect(res.status).toBe(400);
    const data: { error: { type: string; param: string; code: string } } = await res.json();
    expect(data.error.type).toBe('invalid_request_error');
    expect(data.error.param).toBe('response_format');
    expect(data.error.code).toBe('unsupported_parameter');
    expect(client.prepareCalls.length).toBe(0);
    expect(client.conversationCalls.length).toBe(0);
  });

  it('rejects json_schema on a streaming request before opening SSE', async () => {
    const res = await post({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'x', strict: true, schema: { type: 'object', properties: {} } },
      },
      stream: true,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type') || '').toContain('application/json');
    expect(client.conversationCalls.length).toBe(0);
  });

  it('rejects audio modalities and an audio field', async () => {
    const audioModality = await post({ modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'wav' } });
    expect(audioModality.status).toBe(400);
    const audioModalityData: { error: { param: string; code: string } } = await audioModality.json();
    expect(audioModalityData.error.param).toBe('modalities');
    expect(audioModalityData.error.code).toBe('unsupported_parameter');

    const audioOnly = await post({ audio: { voice: 'alloy', format: 'wav' } });
    expect(audioOnly.status).toBe(400);
    const audioOnlyData: { error: { param: string } } = await audioOnly.json();
    expect(audioOnlyData.error.param).toBe('audio');
  });

  it('still accepts text-only shapes and an omitted audio section', async () => {
    for (const payload of [
      {},
      { response_format: { type: 'text' } },
      { modalities: ['text'] },
    ]) {
      const res = await post(payload);
      expect(res.status).toBe(200);
    }
  });
});
