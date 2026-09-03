import { describe, it, expect, vi } from 'vitest';
import {
  UpstreamClient,
  StatusError,
  parseRetryAfter,
  extractBodySniff,
  BASE_URL,
  USER_AGENT,
  APP_PACKAGE,
  CLIENT_TYPE,
} from './client';

describe('UpstreamClient & StatusError', () => {
  describe('StatusError & helpers', () => {
    it('creates StatusError with correct properties', () => {
      const err = new StatusError('prepare', 429, 'Too many requests', 60_000);
      expect(err.status).toBe(429);
      expect(err.code).toBe(429);
      expect(err.stage).toBe('prepare');
      expect(err.retryAfter).toBe(60_000);
      expect(err.bodySniff).toBe('Too many requests');
      expect(err.message).toBe('chatgpt-anon prepare: HTTP 429: Too many requests');
      expect(err.name).toBe('StatusError');
      expect(err instanceof Error).toBe(true);
      expect(err instanceof StatusError).toBe(true);
    });

    it('parses numeric Retry-After in seconds to milliseconds', () => {
      expect(parseRetryAfter('120')).toBe(120_000);
      expect(parseRetryAfter(' 45 ')).toBe(45_000);
      expect(parseRetryAfter('0')).toBe(0);
    });

    it('parses HTTP-date Retry-After to milliseconds', () => {
      const futureDate = new Date(Date.now() + 60_000).toUTCString();
      const ms = parseRetryAfter(futureDate);
      expect(ms).toBeDefined();
      expect(ms!).toBeGreaterThan(0);
      expect(ms!).toBeLessThanOrEqual(61_000);
    });

    it('returns undefined for invalid Retry-After', () => {
      expect(parseRetryAfter(null)).toBeUndefined();
      expect(parseRetryAfter(undefined)).toBeUndefined();
      expect(parseRetryAfter('')).toBeUndefined();
      expect(parseRetryAfter('not-a-number-or-date')).toBeUndefined();
    });

    it('extracts and sniffs response body up to max length', async () => {
      const longText = 'x'.repeat(600);
      const resp = new Response(longText, { status: 500 });
      const sniff = await extractBodySniff(resp, 512);
      expect(sniff).toHaveLength(515); // 512 + '...'
      expect(sniff.endsWith('...')).toBe(true);
    });
  });

  describe('UpstreamClient requests', () => {
    it('sends standard headers and correct body on sentinel()', async () => {
      let interceptedUrl = '';
      let interceptedInit: RequestInit | undefined;

      const mockFetch: typeof fetch = async (url, init) => {
        interceptedUrl = url.toString();
        interceptedInit = init;
        return new Response(
          JSON.stringify({
            token: 'test-sentinel-token',
            expire_after: 540,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new UpstreamClient(BASE_URL, mockFetch);
      const res = await client.sentinel('device-uuid-123');

      expect(interceptedUrl).toBe('https://android.chat.openai.com/backend-anon/sentinel/chat-requirements');
      expect(interceptedInit?.method).toBe('POST');
      const headers = interceptedInit?.headers as Record<string, string>;
      expect(headers['User-Agent']).toBe(USER_AGENT);
      expect(headers['OAI-Client-Type']).toBe(CLIENT_TYPE);
      expect(headers['OAI-Device-Id']).toBe('device-uuid-123');
      expect(headers['OAI-Package-Name']).toBe(APP_PACKAGE);
      expect(headers['X-OpenAI-No-Http-Logging']).toBe('1');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Accept']).toBe('text/event-stream');
      expect(interceptedInit?.body).toBe('{}');

      expect(res.token).toBe('test-sentinel-token');
      expect(res.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000) + 500);
    });

    it('handles expire_at in sentinel response', async () => {
      const targetExpirySec = Math.floor(Date.now() / 1000) + 1200;
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            token: 'test-token-at',
            expire_at: targetExpirySec,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new UpstreamClient(BASE_URL, mockFetch);
      const res = await client.sentinel('device-123');
      expect(res.expiry).toBe(targetExpirySec);
    });

    it('falls back to 8 minutes if no expiry info provided in sentinel', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            token: 'test-token-fallback',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const client = new UpstreamClient(BASE_URL, mockFetch);
      const res = await client.sentinel('device-123');
      const expectedMin = Math.floor(Date.now() / 1000) + 475;
      expect(res.expiry).toBeGreaterThanOrEqual(expectedMin);
    });

    it('throws StatusError on sentinel HTTP error with Retry-After', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Rate limited', {
          status: 429,
          headers: {
            'Retry-After': '90',
          },
        });
      };

      const client = new UpstreamClient(BASE_URL, mockFetch);
      await expect(client.sentinel('device-123')).rejects.toThrow(StatusError);

      try {
        await client.sentinel('device-123');
      } catch (err: any) {
        expect(err).toBeInstanceOf(StatusError);
        expect(err.status).toBe(429);
        expect(err.stage).toBe('sentinel');
        expect(err.retryAfter).toBe(90_000);
        expect(err.bodySniff).toBe('Rate limited');
      }
    });

    it('sends correct headers and extracts conduit_token in prepare()', async () => {
      let interceptedHeaders: Record<string, string> | undefined;
      let interceptedBody: any;

      const mockFetch: typeof fetch = async (url, init) => {
        interceptedHeaders = init?.headers as Record<string, string>;
        interceptedBody = init?.body;
        return new Response(
          JSON.stringify({
            status: 'ok',
            conduit_token: 'conduit-xyz-123',
          }),
          { status: 200 },
        );
      };

      const client = new UpstreamClient(BASE_URL, mockFetch);
      const token = await client.prepare('device-123', 'sentinel-tok', { test: true });

      expect(token).toBe('conduit-xyz-123');
      expect(interceptedHeaders?.['openai-sentinel-chat-requirements-token']).toBe('sentinel-tok');
      expect(interceptedHeaders?.['x-conduit-token']).toBe('no-token');
      expect(interceptedHeaders?.['OAI-Device-Id']).toBe('device-123');
      expect(interceptedBody).toBe(JSON.stringify({ test: true }));
    });

    it('throws StatusError on prepare() failure', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Forbidden access', { status: 403 });
      };

      const client = new UpstreamClient(BASE_URL, mockFetch);
      try {
        await client.prepare('device-123', 'sentinel-tok', {});
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(StatusError);
        expect(err.status).toBe(403);
        expect(err.stage).toBe('prepare');
        expect(err.bodySniff).toBe('Forbidden access');
      }
    });

    it('sends correct headers and returns response stream in conversation()', async () => {
      let interceptedHeaders: Record<string, string> | undefined;

      const mockFetch: typeof fetch = async (url, init) => {
        interceptedHeaders = init?.headers as Record<string, string>;
        return new Response('data: hello\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };

      const client = new UpstreamClient(BASE_URL, mockFetch);
      const resp = await client.conversation(
        'device-123',
        'sentinel-tok',
        'conduit-tok',
        { prompt: 'hi' },
      );

      expect(resp.status).toBe(200);
      expect(interceptedHeaders?.['openai-sentinel-chat-requirements-token']).toBe('sentinel-tok');
      expect(interceptedHeaders?.['x-conduit-token']).toBe('conduit-tok');
      expect(interceptedHeaders?.['OAI-Device-Id']).toBe('device-123');

      const bodyText = await resp.text();
      expect(bodyText).toBe('data: hello\n\n');
    });

    it('throws StatusError on conversation() failure', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('Internal error', { status: 500 });
      };

      const client = new UpstreamClient(BASE_URL, mockFetch);
      try {
        await client.conversation('device-123', 's-tok', 'c-tok', {});
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(StatusError);
        expect(err.status).toBe(500);
        expect(err.stage).toBe('conversation');
      }
    });
  });
});
