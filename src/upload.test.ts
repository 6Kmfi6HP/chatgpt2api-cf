import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_URL,
  APP_PACKAGE,
  CLIENT_TYPE,
  StatusError,
  USER_AGENT,
  UpstreamClient,
} from './client';
import {
  defaultExtensionForMime,
  sniffImageMime,
  uploadImage,
} from './upload';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function makeMockFetch(handlers: Array<(req: RecordedRequest) => Response>) {
  const calls: RecordedRequest[] = [];
  const mockFetch: typeof fetch = async (url, init) => {
    const req: RecordedRequest = { url: url.toString(), init: init ?? {} };
    calls.push(req);
    const handler = handlers[calls.length - 1];
    if (!handler) {
      throw new Error(`unexpected fetch call #${calls.length}: ${req.url}`);
    }
    return handler(req);
  };
  // uploadImage() uses globalThis.fetch directly, so stub the global.
  vi.stubGlobal('fetch', mockFetch);
  return { calls, mockFetch };
}

function defaultClient(mockFetch: typeof fetch): UpstreamClient {
  return new UpstreamClient(BASE_URL, mockFetch);
}

function jsonResp(body: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const UPLOAD_URL = 'https://files42.oaiusercontent.com/file-abc123?se=2026-09-15T00:00:00Z&sig=sig';

function happyHandlers() {
  return [
    () => jsonResp({ status: 'success', upload_url: UPLOAD_URL, file_id: 'file-abc123' }),
    () => new Response(null, { status: 201 }),
    () =>
      new Response(
        [
          JSON.stringify({
            file_id: 'file-abc123',
            event: 'file.processing.started',
            message: 'started',
            progress: 0.0,
            extra: null,
          }),
          JSON.stringify({
            file_id: 'file-abc123',
            event: 'file.processing.file_ready',
            message: 'ready',
            progress: 100.0,
            extra: null,
          }),
          JSON.stringify({
            file_id: 'file-abc123',
            event: 'file.processing.completed',
            message: 'done',
            progress: 100.0,
            extra: null,
          }),
        ].join('\n'),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  ];
}

describe('uploadImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('performs the three-step upload flow and returns the fileId', async () => {
    const { calls, mockFetch } = makeMockFetch(happyHandlers());
    const client = defaultClient(mockFetch);

    const res = await uploadImage({
      client,
      deviceId: 'device-uuid-123',
      imageBytes: PNG_BYTES,
    });

    expect(res).toEqual({ fileId: 'file-abc123', uploadUrl: UPLOAD_URL });
    expect(calls.length).toBe(3);

    // Step 1: POST {base}files
    expect(calls[0].url).toBe(`${BASE_URL}files`);
    expect(calls[0].init.method).toBe('POST');
    const filesHeaders = calls[0].init.headers as Record<string, string>;
    expect(filesHeaders['User-Agent']).toBe(USER_AGENT);
    expect(filesHeaders['OAI-Client-Type']).toBe(CLIENT_TYPE);
    expect(filesHeaders['OAI-Device-Id']).toBe('device-uuid-123');
    expect(filesHeaders['OAI-Package-Name']).toBe(APP_PACKAGE);
    expect(filesHeaders['X-OpenAI-No-Http-Logging']).toBe('1');
    expect(filesHeaders['Content-Type']).toBe('application/json');
    expect(filesHeaders['Accept']).toBe('application/json');
    expect(calls[0].init.body).toBe(
      JSON.stringify({
        file_name: 'image.png',
        file_size: PNG_BYTES.byteLength,
        use_case: 'multimodal',
      }),
    );

    // Step 2: PUT to the absolute signed blob URL with Azure Blob headers
    expect(calls[1].url).toBe(UPLOAD_URL);
    expect(calls[1].init.method).toBe('PUT');
    const blobHeaders = calls[1].init.headers as Record<string, string>;
    expect(blobHeaders['x-ms-blob-type']).toBe('BlockBlob');
    expect(blobHeaders['x-ms-version']).toBe('2020-04-08');
    expect(blobHeaders['Content-Type']).toBe('image/png');
    expect(calls[1].init.body).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(calls[1].init.body as ArrayBuffer)).toEqual(PNG_BYTES);

    // Step 3: POST {base}files/process_upload_stream
    expect(calls[2].url).toBe(`${BASE_URL}files/process_upload_stream`);
    expect(calls[2].init.method).toBe('POST');
    const processHeaders = calls[2].init.headers as Record<string, string>;
    expect(processHeaders['Accept']).toBe('application/json');
    expect(processHeaders['OAI-Device-Id']).toBe('device-uuid-123');
    expect(calls[2].init.body).toBe(
      JSON.stringify({
        file_id: 'file-abc123',
        use_case: 'multimodal',
        file_name: 'image.png',
        index_for_retrieval: 0,
      }),
    );
  });

  it('passes custom mime type, file name, and use case through all steps', async () => {
    const { calls, mockFetch } = makeMockFetch(happyHandlers());
    const client = defaultClient(mockFetch);

    await uploadImage({
      client,
      deviceId: 'device-uuid-123',
      imageBytes: PNG_BYTES,
      mimeType: 'image/webp',
      fileName: 'photo.webp',
      useCase: 'my_files',
    });

    expect(calls[0].init.body).toBe(
      JSON.stringify({
        file_name: 'photo.webp',
        file_size: PNG_BYTES.byteLength,
        use_case: 'my_files',
      }),
    );
    expect((calls[1].init.headers as Record<string, string>)['Content-Type']).toBe('image/webp');
    expect(calls[2].init.body).toBe(
      JSON.stringify({
        file_id: 'file-abc123',
        use_case: 'my_files',
        file_name: 'photo.webp',
        index_for_retrieval: 0,
      }),
    );
  });

  it('parses a single-line JSON stream response without trailing newline', async () => {
    const { mockFetch } = makeMockFetch([
      () => jsonResp({ status: 'success', upload_url: UPLOAD_URL, file_id: 'file-abc123' }),
      () => new Response(null, { status: 201 }),
      () =>
        new Response(
          JSON.stringify({
            file_id: 'file-abc123',
            event: 'file.processing.completed',
            message: 'done',
            progress: 100.0,
            extra: null,
          }),
          { status: 200 },
        ),
    ]);
    const client = defaultClient(mockFetch);

    const res = await uploadImage({ client, deviceId: 'device-1', imageBytes: PNG_BYTES });
    expect(res.fileId).toBe('file-abc123');
  });

  it('throws StatusError with retryAfter on files 429', async () => {
    const { calls, mockFetch } = makeMockFetch([
      () =>
        jsonResp(
          {
            detail: {
              code: 'throttled',
              error_code: 'throttled',
              message: 'You\'ve reached our limit of file uploads. Please try again in 1 day.',
              type: 'throttled',
            },
          },
          429,
          { 'Retry-After': '120' },
        ),
    ]);
    const client = defaultClient(mockFetch);

    try {
      await uploadImage({ client, deviceId: 'device-1', imageBytes: PNG_BYTES });
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(StatusError);
      expect(err.status).toBe(429);
      expect(err.stage).toBe('upload');
      expect(err.retryAfter).toBe(120_000);
      expect(err.bodySniff).toContain('throttled');
    }
    expect(calls.length).toBe(1);
  });

  it('throws StatusError on files 400 use_case_not_allowed', async () => {
    const { calls, mockFetch } = makeMockFetch([
      () => jsonResp({ detail: { code: 'use_case_not_allowed' } }, 400),
    ]);
    const client = defaultClient(mockFetch);

    try {
      await uploadImage({ client, deviceId: 'device-1', imageBytes: PNG_BYTES, useCase: 'dalle_agent' });
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(StatusError);
      expect(err.status).toBe(400);
      expect(err.stage).toBe('upload');
      expect(err.bodySniff).toContain('use_case_not_allowed');
    }
    expect(calls.length).toBe(1);
  });

  it('throws StatusError on blob PUT failure', async () => {
    const { calls, mockFetch } = makeMockFetch([
      () => jsonResp({ status: 'success', upload_url: UPLOAD_URL, file_id: 'file-abc123' }),
      () => new Response('blob error', { status: 500 }),
    ]);
    const client = defaultClient(mockFetch);

    try {
      await uploadImage({ client, deviceId: 'device-1', imageBytes: PNG_BYTES });
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(StatusError);
      expect(err.status).toBe(500);
      expect(err.stage).toBe('upload');
      expect(err.bodySniff).toBe('blob error');
    }
    expect(calls.length).toBe(2);
  });

  it('throws StatusError on process step failure', async () => {
    const { calls, mockFetch } = makeMockFetch([
      () => jsonResp({ status: 'success', upload_url: UPLOAD_URL, file_id: 'file-abc123' }),
      () => new Response(null, { status: 201 }),
      () => jsonResp({ detail: { code: 'boom' } }, 500),
    ]);
    const client = defaultClient(mockFetch);

    try {
      await uploadImage({ client, deviceId: 'device-1', imageBytes: PNG_BYTES });
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(StatusError);
      expect(err.status).toBe(500);
      expect(err.stage).toBe('process');
    }
    expect(calls.length).toBe(3);
  });

  it('throws with error_code when the process stream reports file.processing.error', async () => {
    const { calls, mockFetch } = makeMockFetch([
      () => jsonResp({ status: 'success', upload_url: UPLOAD_URL, file_id: 'file-abc123' }),
      () => new Response(null, { status: 201 }),
      () =>
        new Response(
          [
            JSON.stringify({
              file_id: 'file-abc123',
              event: 'file.processing.started',
              message: 'started',
              progress: 0.0,
              extra: null,
            }),
            JSON.stringify({
              file_id: 'file-abc123',
              event: 'file.processing.error',
              message: 'size mismatch',
              progress: 0.0,
              extra: { error_code: 'file_size_mismatch' },
            }),
          ].join('\n'),
          { status: 200 },
        ),
    ]);
    const client = defaultClient(mockFetch);

    try {
      await uploadImage({ client, deviceId: 'device-1', imageBytes: PNG_BYTES });
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StatusError);
      expect(err.message).toContain('file_size_mismatch');
      expect(err.message).toContain('file.processing.error');
    }
    expect(calls.length).toBe(3);
  });

  it('throws when the process stream never reports completion', async () => {
    const { mockFetch } = makeMockFetch([
      () => jsonResp({ status: 'success', upload_url: UPLOAD_URL, file_id: 'file-abc123' }),
      () => new Response(null, { status: 201 }),
      () =>
        new Response(
          JSON.stringify({
            file_id: 'file-abc123',
            event: 'file.processing.started',
            message: 'started',
            progress: 0.0,
            extra: null,
          }),
          { status: 200 },
        ),
    ]);
    const client = defaultClient(mockFetch);

    await expect(
      uploadImage({ client, deviceId: 'device-1', imageBytes: PNG_BYTES }),
    ).rejects.toThrow(/file.processing.completed/);
  });

  it('forwards the abort signal to every request', async () => {
    const { calls, mockFetch } = makeMockFetch(happyHandlers());
    const client = defaultClient(mockFetch);
    const controller = new AbortController();

    await uploadImage({ client, deviceId: 'device-1', imageBytes: PNG_BYTES, signal: controller.signal });

    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.init.signal).toBe(controller.signal);
    }
  });
});

describe('sniffImageMime', () => {
  it('detects PNG', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
  });

  it('detects JPEG', () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg');
  });

  it('detects GIF', () => {
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
  });

  it('detects WebP (RIFF....WEBP)', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
    ]);
    expect(sniffImageMime(webp)).toBe('image/webp');
  });

  it('returns octet-stream for unknown or short data', () => {
    expect(sniffImageMime(new Uint8Array([0x00, 0x01, 0x02]))).toBe('application/octet-stream');
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBe('application/octet-stream');
    expect(sniffImageMime(new Uint8Array([]))).toBe('application/octet-stream');
  });
});

describe('defaultExtensionForMime', () => {
  it('maps known image mimes to extensions', () => {
    expect(defaultExtensionForMime('image/png')).toBe('png');
    expect(defaultExtensionForMime('image/jpeg')).toBe('jpg');
    expect(defaultExtensionForMime('image/jpg')).toBe('jpg');
    expect(defaultExtensionForMime('image/gif')).toBe('gif');
    expect(defaultExtensionForMime('image/webp')).toBe('webp');
  });

  it('falls back to bin for unknown mimes', () => {
    expect(defaultExtensionForMime('application/octet-stream')).toBe('bin');
    expect(defaultExtensionForMime('image/heic')).toBe('bin');
    expect(defaultExtensionForMime('')).toBe('bin');
  });
});
