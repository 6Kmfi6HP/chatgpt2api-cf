import {
  APP_PACKAGE,
  BASE_URL,
  CLIENT_TYPE,
  StatusError,
  USER_AGENT,
  extractBodySniff,
  parseRetryAfter,
} from './client';
import type { UpstreamClient } from './client';

export interface UploadImageResult {
  fileId: string;
  uploadUrl: string;
}

export interface UploadImageOptions {
  client: UpstreamClient;
  deviceId: string;
  imageBytes: Uint8Array;
  mimeType?: string;
  fileName?: string;
  useCase?: string;
  signal?: AbortSignal;
}

const X_MS_BLOB_VERSION = '2020-04-08';

function backendUrl(path: string): string {
  const base = BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`;
  return `${base}${path.startsWith('/') ? path.slice(1) : path}`;
}

function backendHeaders(deviceId: string): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    'OAI-Client-Type': CLIENT_TYPE,
    'OAI-Device-Id': deviceId,
    'OAI-Package-Name': APP_PACKAGE,
    'X-OpenAI-No-Http-Logging': '1',
  };
}

async function throwStatusError(stage: 'upload' | 'process', resp: Response): Promise<never> {
  const retryAfter = parseRetryAfter(resp.headers.get('Retry-After'));
  const bodySniff = await extractBodySniff(resp);
  throw new StatusError(stage, resp.status, bodySniff, retryAfter);
}

export function sniffImageMime(bytes: Uint8Array): string {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

export function defaultExtensionForMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

/**
 * ChatGPT anonymous image upload, three steps:
 *   1. POST {base}files            -> { upload_url, file_id }
 *   2. PUT  <upload_url>           -> 201 (raw bytes to signed Azure Blob URL)
 *   3. POST {base}files/process_upload_stream -> JSON-lines stream, must end with
 *      a "file.processing.completed" event.
 */
export async function uploadImage(opts: UploadImageOptions): Promise<UploadImageResult> {
  const deviceId = opts.deviceId;
  const imageBytes = opts.imageBytes;
  const mimeType = opts.mimeType ?? 'image/png';
  // Default file name keeps the extension in sync with the mime type
  // (the name is only used for display/validation upstream).
  const fileName = opts.fileName ?? `image.${defaultExtensionForMime(mimeType)}`;
  const useCase = opts.useCase ?? 'multimodal';
  const signal = opts.signal;

  // Step 1: request a short-lived signed Azure Blob upload URL.
  const filesResp = await globalThis.fetch(backendUrl('files'), {
    method: 'POST',
    headers: {
      ...backendHeaders(deviceId),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      file_name: fileName,
      file_size: imageBytes.byteLength,
      use_case: useCase,
    }),
    signal,
  });
  if (!filesResp.ok) {
    await throwStatusError('upload', filesResp);
  }

  let filesData: any;
  try {
    filesData = await filesResp.json();
  } catch (err: any) {
    throw new Error(`chatgpt-anon upload: decode: ${err?.message ?? String(err)}`);
  }
  const uploadUrl: unknown = filesData?.upload_url;
  const fileId: unknown = filesData?.file_id;
  if (typeof uploadUrl !== 'string' || !uploadUrl || typeof fileId !== 'string' || !fileId) {
    throw new Error('chatgpt-anon upload: missing upload_url/file_id in files response');
  }

  // Step 2: PUT raw bytes to the absolute signed blob URL (not a backend-anon path).
  const blobBuffer = new ArrayBuffer(imageBytes.byteLength);
  new Uint8Array(blobBuffer).set(imageBytes);
  const blobResp = await globalThis.fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': X_MS_BLOB_VERSION,
    },
    body: blobBuffer,
    signal,
  });
  if (!blobResp.ok) {
    await throwStatusError('upload', blobResp);
  }

  // Step 3: finalize; response is a JSON-lines stream without a "data:" prefix.
  const processResp = await globalThis.fetch(backendUrl('files/process_upload_stream'), {
    method: 'POST',
    headers: {
      ...backendHeaders(deviceId),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      file_id: fileId,
      use_case: useCase,
      file_name: fileName,
      index_for_retrieval: 0,
    }),
    signal,
  });
  if (!processResp.ok) {
    await throwStatusError('process', processResp);
  }

  let text: string;
  try {
    text = await processResp.text();
  } catch (err: any) {
    throw new Error(`chatgpt-anon process: read: ${err?.message ?? String(err)}`);
  }

  let completed = false;
  let errorDetail = '';
  try {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // tolerate stray non-JSON lines
      }
      const event = typeof obj?.event === 'string' ? obj.event : '';
      if (event === 'file.processing.completed') {
        completed = true;
      } else if (event === 'file.processing.error') {
        const extra = obj.extra ?? {};
        const errorCode =
          typeof extra?.error_code === 'string' && extra.error_code
            ? extra.error_code
            : typeof obj.error_code === 'string' && obj.error_code
              ? obj.error_code
              : 'unknown';
        errorDetail =
          `chatgpt-anon process: file.processing.error (error_code=${errorCode})` +
          (typeof obj.message === 'string' ? `: ${obj.message}` : '');
      }
    }
  } catch (err: any) {
    throw new Error(`chatgpt-anon process: decode: ${err?.message ?? String(err)}`);
  }

  if (errorDetail) {
    throw new Error(errorDetail);
  }
  if (!completed) {
    throw new Error(
      `chatgpt-anon process: file.processing.completed not received: ${text.slice(0, 200)}`,
    );
  }

  return { fileId, uploadUrl };
}
