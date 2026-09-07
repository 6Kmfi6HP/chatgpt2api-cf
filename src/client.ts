export const BASE_URL = 'https://android.chat.openai.com/backend-anon/';
export const USER_AGENT = 'ChatGPT/1.2026.237 (Android 14; sdk_gphone64_arm64; build 2623711)';
export const APP_PACKAGE = 'com.openai.chatgpt.internal';
export const CLIENT_TYPE = 'android';

export type Stage = 'sentinel' | 'prepare' | 'conversation';

export class StatusError extends Error {
  readonly status: number;
  readonly code: number; // alias for status
  readonly stage: Stage;
  readonly retryAfter?: number; // in milliseconds
  readonly bodySniff: string;

  constructor(
    stage: Stage,
    status: number,
    bodySniff: string,
    retryAfter?: number,
  ) {
    const stageName = stage || 'upstream';
    const message = `chatgpt-anon ${stageName}: HTTP ${status}: ${bodySniff}`;
    super(message);
    this.name = 'StatusError';
    this.status = status;
    this.code = status;
    this.stage = stage;
    this.bodySniff = bodySniff;
    this.retryAfter = retryAfter;
  }
}

export function parseRetryAfter(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

export async function extractBodySniff(resp: Response, maxChars = 512): Promise<string> {
  try {
    const text = await resp.text();
    const trimmed = text.trim();
    return trimmed.length > maxChars ? trimmed.slice(0, maxChars) + '...' : trimmed;
  } catch {
    return '';
  }
}

export class UpstreamClient {
  readonly baseURL: string;
  private fetchFn: typeof fetch;

  constructor(baseURL: string = BASE_URL, fetchFn?: typeof fetch) {
    this.baseURL = baseURL;
    this.fetchFn = fetchFn ? fetchFn.bind(globalThis) : globalThis.fetch.bind(globalThis);
  }

  private buildUrl(path: string): string {
    const base = this.baseURL.endsWith('/') ? this.baseURL : `${this.baseURL}/`;
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    return `${base}${cleanPath}`;
  }

  private async post(
    stage: Stage,
    path: string,
    deviceId: string,
    extraHeaders: Record<string, string>,
    body: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = this.buildUrl(path);
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'OAI-Client-Type': CLIENT_TYPE,
      'OAI-Device-Id': deviceId,
      'OAI-Package-Name': APP_PACKAGE,
      'X-OpenAI-No-Http-Logging': '1',
      ...extraHeaders,
    };

    let resp: Response;
    try {
      resp = await this.fetchFn.call(globalThis, url, {
        method: 'POST',
        headers,
        body,
        signal,
      });
    } catch (err: any) {
      throw new Error(`chatgpt-anon ${stage}: ${err.message}`);
    }

    if (!resp.ok) {
      const retryAfter = parseRetryAfter(resp.headers.get('Retry-After'));
      const bodySniff = await extractBodySniff(resp);
      throw new StatusError(stage, resp.status, bodySniff, retryAfter);
    }

    return resp;
  }

  async models(deviceId: string, signal?: AbortSignal): Promise<string[]> {
    const url = this.buildUrl('models');
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'OAI-Client-Type': CLIENT_TYPE,
      'OAI-Device-Id': deviceId,
      'OAI-Package-Name': APP_PACKAGE,
      'X-OpenAI-No-Http-Logging': '1',
    };

    let resp: Response;
    try {
      resp = await this.fetchFn.call(globalThis, url, { method: 'GET', headers, signal });
    } catch (err: any) {
      throw new Error(`chatgpt-anon models: ${err.message}`);
    }

    if (!resp.ok) {
      const bodySniff = await extractBodySniff(resp);
      throw new Error(`chatgpt-anon models: HTTP ${resp.status}: ${bodySniff}`);
    }

    let data: any;
    try {
      data = await resp.json();
    } catch (err: any) {
      throw new Error(`chatgpt-anon models: decode: ${err.message}`);
    }

    const slugs: string[] = [];
    if (data && Array.isArray(data.models)) {
      for (const m of data.models) {
        if (m && typeof m.slug === 'string' && m.slug) slugs.push(m.slug);
      }
    }
    return slugs;
  }

  async sentinel(deviceId: string, signal?: AbortSignal): Promise<{ token: string; expiry: number }> {
    const resp = await this.post('sentinel', 'sentinel/chat-requirements', deviceId, {}, '{}', signal);

    let data: any;
    try {
      data = await resp.json();
    } catch (err: any) {
      throw new Error(`chatgpt-anon sentinel: decode: ${err.message}`);
    }

    if (!data || !data.token) {
      throw new Error('chatgpt-anon sentinel: empty token');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let expiry = 0;

    if (typeof data.expire_after === 'number' && data.expire_after > 0) {
      expiry = nowSec + data.expire_after;
    }

    if (data.expire_at !== undefined && data.expire_at !== null && data.expire_at !== '') {
      const expireAtSec = Number(data.expire_at);
      if (!isNaN(expireAtSec) && expireAtSec > nowSec - 60 && expireAtSec < nowSec + 3600) {
        expiry = Math.floor(expireAtSec);
      }
    }

    if (!expiry || expiry <= nowSec) {
      // Protocol documents 540s; fall back to a conservative 8 minutes (480s).
      expiry = nowSec + 8 * 60;
    }

    return {
      token: data.token,
      expiry,
    };
  }

  async prepare(deviceId: string, sentinelToken: string, anonBody: any, signal?: AbortSignal): Promise<string> {
    const extraHeaders: Record<string, string> = {
      'openai-sentinel-chat-requirements-token': sentinelToken,
      'x-conduit-token': 'no-token',
    };
    const bodyStr = anonBody ? (typeof anonBody === 'string' ? anonBody : JSON.stringify(anonBody)) : '{}';
    const resp = await this.post('prepare', 'f/conversation/prepare', deviceId, extraHeaders, bodyStr, signal);

    let data: any;
    try {
      data = await resp.json();
    } catch (err: any) {
      throw new Error(`chatgpt-anon prepare: decode: ${err.message}`);
    }

    if (!data || !data.conduit_token) {
      throw new Error(`chatgpt-anon prepare: empty conduit_token (status="${data?.status || ''}")`);
    }

    return data.conduit_token;
  }

  async conversation(
    deviceId: string,
    sentinelToken: string,
    conduitToken: string,
    anonBody: any,
    signal?: AbortSignal,
  ): Promise<Response> {
    const extraHeaders: Record<string, string> = {
      'openai-sentinel-chat-requirements-token': sentinelToken,
      'x-conduit-token': conduitToken,
    };
    const bodyStr = anonBody ? (typeof anonBody === 'string' ? anonBody : JSON.stringify(anonBody)) : '{}';
    return await this.post('conversation', 'f/conversation', deviceId, extraHeaders, bodyStr, signal);
  }
}
