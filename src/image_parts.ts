/**
 * OpenAI image content -> ChatGPT anonymous multimodal_text conversion layer.
 *
 * Verified upstream protocol (end-to-end 200, 2026-09-15): a message with
 * images becomes
 *   { content_type: 'multimodal_text', parts: ['<prompt>', {image_asset_pointer...}] }
 * The upload itself lives in another module; here we parse OpenAI content
 * parts, decode/fetch image bytes, read pixel dimensions from headers, and
 * assemble the upstream parts from already-uploaded file mappings.
 */

export interface UploadedImageInfo {
  fileId: string;
  sizeBytes: number;
  width: number;
  height: number;
}

/** An image reference collected from an OpenAI content array (order preserved, no dedup). */
export interface ImageRef {
  kind: 'data_url' | 'url';
  /** data_url: the full data URL; url: an http(s) URL. */
  source: string;
  /** Index of the part within the content array. */
  partIndex: number;
}

export interface ResolvedImage extends UploadedImageInfo {
  mimeType: string;
}

export type OpenAIContentParts = Array<{ type: string; [k: string]: any }>;

/** Extract the URL from a part, handling both Chat Completions and Responses shapes. */
function extractImageUrl(part: { type: string; [k: string]: any }): string | null {
  if (part.type === 'image_url') {
    const iu = part.image_url;
    if (typeof iu === 'string') {
      return iu;
    }
    if (iu && typeof iu === 'object' && typeof (iu as any).url === 'string') {
      return (iu as any).url;
    }
    return null;
  }
  if (part.type === 'input_image') {
    const v = part.image_url;
    if (typeof v === 'string') {
      return v;
    }
    if (v && typeof v === 'object' && typeof (v as any).url === 'string') {
      return (v as any).url;
    }
    return null;
  }
  return null;
}

/** True for data: URLs (data:[mediatype][;base64],<data>). */
function isDataUrl(s: string): boolean {
  return /^data:/i.test(s);
}

/** True for http:// or https:// URLs. */
function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * Collects all image references from an OpenAI content field. Recognizes:
 *  - { type: 'image_url', image_url: { url } } (Chat Completions)
 *  - { type: 'input_image', image_url: '...' } (Responses style)
 * A plain string content yields []. No dedup; order is preserved.
 */
export function collectImageRefs(
  content: string | OpenAIContentParts | null | undefined
): ImageRef[] {
  if (!content || typeof content === 'string' || !Array.isArray(content)) {
    return [];
  }
  const refs: ImageRef[] = [];
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (!part || typeof part !== 'object') {
      continue;
    }
    const url = extractImageUrl(part);
    if (!url) {
      continue;
    }
    if (isDataUrl(url)) {
      refs.push({ kind: 'data_url', source: url, partIndex: i });
    } else if (isHttpUrl(url)) {
      refs.push({ kind: 'url', source: url, partIndex: i });
    }
  }
  return refs;
}

/** Base64 -> bytes without Buffer (Workers-compatible). */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decode a data URL into bytes + mime type. Throws when the payload is not
 * base64-decodable.
 */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) {
    throw new Error('Invalid data URL: missing comma separator');
  }
  const meta = dataUrl.slice(5, comma); // after "data:"
  const semi = meta.indexOf(';');
  const mimeType = (semi >= 0 ? meta.slice(0, semi) : meta) || 'application/octet-stream';
  const payload = dataUrl.slice(comma + 1);
  try {
    return { bytes: base64ToBytes(payload), mimeType };
  } catch {
    throw new Error('Invalid data URL: base64 decode failed');
  }
}

/* ------------------------- image size sniffing ------------------------- */

/** PNG: IHDR at bytes 16-23, big-endian uint32 width then height. */
function pngSize(b: Uint8Array): { width: number; height: number } {
  return {
    width: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19],
    height: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23],
  };
}

/** GIF: bytes 6-9, little-endian uint16 width then height. */
function gifSize(b: Uint8Array): { width: number; height: number } {
  return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
}

/** JPEG: scan SOF0/SOF2 markers; segment bytes 5-6 = height, 7-8 = width (big-endian). */
function jpegSize(b: Uint8Array): { width: number; height: number } {
  let i = 2; // skip SOI
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers
      continue;
    }
    if (marker === 0xc0 || marker === 0xc2) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) {
      break;
    }
    i += 2 + len;
  }
  throw new Error('Cannot parse JPEG dimensions');
}

/** WebP: parse lossless (VP8L) bitstream dimensions from the header bits. */
function vp8lSize(b: Uint8Array): { width: number; height: number } {
  // Chunk payload starts at byte 20: 1 signature byte, then 14 bits width-1
  // and 14 bits height-1, all LSB-first.
  const v =
    b[20] +
    b[21] * 0x100 +
    b[22] * 0x10000 +
    b[23] * 0x1000000 +
    b[24] * 0x100000000 +
    b[25] * 0x10000000000;
  const width = ((v >> 8) & 0x3fff) + 1;
  const height = ((v >> 22) & 0x3fff) + 1;
  return { width, height };
}

/** WebP: parse dimensions from VP8X / VP8 / VP8L chunk payload. */
function webpSize(b: Uint8Array): { width: number; height: number } {
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === 'VP8X') {
    // Bytes 24-26: canvas width-1 (24-bit LE); 27-29: canvas height-1.
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height };
  }
  if (fourcc === 'VP8 ') {
    // Simple/lossy payload: 3-byte frame tag then 0x9d 0x01 0x2a, then 16-bit LE width/height.
    const width = (b[26] | (b[27] << 8)) & 0x3fff;
    const height = (b[28] | (b[29] << 8)) & 0x3fff;
    return { width, height };
  }
  if (fourcc === 'VP8L') {
    return vp8lSize(b);
  }
  throw new Error('Cannot parse WebP dimensions');
}

/**
 * Parse pixel dimensions from image bytes (PNG / GIF / JPEG / WebP headers
 * only; no external deps). Throws for unknown formats.
 */
export function parseImageSize(
  bytes: Uint8Array
): { width: number; height: number; mimeType: string } {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ...pngSize(bytes), mimeType: 'image/png' };
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { ...gifSize(bytes), mimeType: 'image/gif' };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { ...jpegSize(bytes), mimeType: 'image/jpeg' };
  }
  if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { ...webpSize(bytes), mimeType: 'image/webp' };
  }
  throw new Error('Unsupported image format');
}

/**
 * Resolve an image reference to bytes + dimensions. data URLs are decoded
 * directly; http(s) URLs are fetched via the injected fetcher (default
 * globalThis.fetch) with ok + image/* content-type validation.
 */
export async function resolveImage(
  ref: ImageRef,
  fetcher: typeof fetch = globalThis.fetch
): Promise<{ bytes: Uint8Array; mimeType: string; width: number; height: number }> {
  let bytes: Uint8Array;
  let mimeType: string;
  if (ref.kind === 'data_url') {
    const decoded = decodeDataUrl(ref.source);
    bytes = decoded.bytes;
    mimeType = decoded.mimeType;
  } else {
    const res = await fetcher(ref.source, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Failed to fetch image ${ref.source}: HTTP ${res.status}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new Error(
        `URL ${ref.source} did not return an image (content-type: ${contentType || 'none'})`
      );
    }
    mimeType = contentType.toLowerCase();
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (bytes.length === 0) {
    throw new Error(`Empty image payload from ${ref.source}`);
  }
  const size = parseImageSize(bytes);
  return { bytes, mimeType, width: size.width, height: size.height };
}

/**
 * Assemble the upstream multimodal content. With no images this degrades to
 * the traditional { content_type: 'text', parts: [text] } form.
 */
export function buildMultimodalContent(
  text: string,
  images: ResolvedImage[]
): { content_type: 'multimodal_text' | 'text'; parts: any[] } {
  const parts: any[] = [text];
  for (const img of images) {
    parts.push({
      content_type: 'image_asset_pointer',
      asset_pointer: `file-service://${img.fileId}`,
      size_bytes: img.sizeBytes,
      width: img.width,
      height: img.height,
    });
  }
  return {
    content_type: images.length > 0 ? 'multimodal_text' : 'text',
    parts,
  };
}

/** Whether the message's content array contains at least one image part. */
export function hasImageContent(message: { role: string; content: any }): boolean {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  for (const part of content) {
    if (part && typeof part === 'object' && (part.type === 'image_url' || part.type === 'input_image')) {
      return true;
    }
  }
  return false;
}
