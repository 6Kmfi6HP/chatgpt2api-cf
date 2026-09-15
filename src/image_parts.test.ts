import { describe, it, expect, vi } from 'vitest';
import {
  collectImageRefs,
  resolveImage,
  buildMultimodalContent,
  hasImageContent,
  parseImageSize,
  type ImageRef,
  type ResolvedImage,
} from './image_parts';

/** Build a minimal PNG header with the given dimensions (IHDR at bytes 16-23). */
function pngBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b[0] = 0x89;
  b[1] = 0x50; // P
  b[2] = 0x4e; // N
  b[3] = 0x47; // G
  b[4] = 0x0d;
  b[5] = 0x0a;
  b[6] = 0x1a;
  b[7] = 0x0a;
  // IHDR chunk length + type live at 8-15; width/height at 16-23 big-endian.
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width, false);
  dv.setUint32(20, height, false);
  return b;
}

/** Build a minimal GIF header with the given dimensions (little-endian at 6-9). */
function gifBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(14);
  const sig = 'GIF89a';
  for (let i = 0; i < sig.length; i++) b[i] = sig.charCodeAt(i);
  b[6] = width & 0xff;
  b[7] = (width >> 8) & 0xff;
  b[8] = height & 0xff;
  b[9] = (height >> 8) & 0xff;
  return b;
}

/** Build a minimal WebP VP8X container with the given canvas dimensions. */
function webpVp8xBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(38);
  const riff = 'RIFF';
  const webp = 'WEBP';
  const chunk = 'VP8X';
  for (let i = 0; i < 4; i++) {
    b[i] = riff.charCodeAt(i);
    b[8 + i] = webp.charCodeAt(i);
    b[12 + i] = chunk.charCodeAt(i);
  }
  // VP8X stores (dim - 1) as 24-bit little-endian at 24 (width) and 27 (height).
  const w1 = width - 1;
  const h1 = height - 1;
  b[24] = w1 & 0xff;
  b[25] = (w1 >> 8) & 0xff;
  b[26] = (w1 >> 16) & 0xff;
  b[27] = h1 & 0xff;
  b[28] = (h1 >> 8) & 0xff;
  b[29] = (h1 >> 16) & 0xff;
  return b;
}

/** Build a minimal WebP VP8L (lossless) container with the given dimensions. */
function webpVp8lBytes(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  const riff = 'RIFF';
  const webp = 'WEBP';
  const chunk = 'VP8L';
  for (let i = 0; i < 4; i++) {
    b[i] = riff.charCodeAt(i);
    b[8 + i] = webp.charCodeAt(i);
    b[12 + i] = chunk.charCodeAt(i);
  }
  // Payload at byte 20: signature byte then 14 bits width-1, 14 bits height-1, LSB-first.
  b[20] = 0x2f; // VP8L signature
  const w1 = width - 1;
  const h1 = height - 1;
  let bits = w1 | (h1 << 14);
  b[21] = bits & 0xff;
  b[22] = (bits >> 8) & 0xff;
  b[23] = (bits >> 16) & 0xff;
  b[24] = (bits >> 24) & 0xff;
  return b;
}

describe('collectImageRefs', () => {
  it('recognizes image_url object form (Chat Completions)', () => {
    const content = [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ];
    expect(collectImageRefs(content as any)).toEqual([
      { kind: 'url', source: 'https://example.com/a.png', partIndex: 1 },
    ]);
  });

  it('recognizes image_url with data URL', () => {
    const content = [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ];
    expect(collectImageRefs(content as any)).toEqual([
      { kind: 'data_url', source: 'data:image/png;base64,aGVsbG8=', partIndex: 0 },
    ]);
  });

  it('recognizes input_image string form (Responses style)', () => {
    const content = [{ type: 'input_image', image_url: 'https://example.com/b.jpg' }];
    expect(collectImageRefs(content as any)).toEqual([
      { kind: 'url', source: 'https://example.com/b.jpg', partIndex: 0 },
    ]);
  });

  it('collects mixed text + multiple images in order without dedup', () => {
    const content = [
      { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
      { type: 'text', text: 'and this' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,AAA=' },
      { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
    ];
    const refs = collectImageRefs(content as any);
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.partIndex)).toEqual([0, 2, 3]);
    expect(refs.map((r) => r.kind)).toEqual(['url', 'data_url', 'url']);
    expect(refs[0].source).toBe(refs[2].source);
  });

  it('ignores unsupported schemes and malformed parts', () => {
    const content = [
      { type: 'image_url', image_url: { url: 'ftp://example.com/x.png' } },
      { type: 'image_url', image_url: {} },
      { type: 'image_url' },
      { type: 'input_image', image_url: 42 },
      null,
      { type: 'text', text: 'plain' },
    ];
    expect(collectImageRefs(content as any)).toEqual([]);
  });

  it('returns [] for plain string content and nullish content', () => {
    expect(collectImageRefs('hello')).toEqual([]);
    expect(collectImageRefs(null)).toEqual([]);
    expect(collectImageRefs(undefined)).toEqual([]);
    expect(collectImageRefs([])).toEqual([]);
  });
});

describe('buildMultimodalContent', () => {
  const img: ResolvedImage = {
    fileId: 'file-ABC123',
    sizeBytes: 1234,
    width: 1024,
    height: 1024,
    mimeType: 'image/png',
  };

  it('degrades to plain text content when there are no images', () => {
    expect(buildMultimodalContent('hello', [])).toEqual({
      content_type: 'text',
      parts: ['hello'],
    });
  });

  it('builds multimodal_text with a single image pointer', () => {
    const result = buildMultimodalContent('what is this?', [img]);
    expect(result).toEqual({
      content_type: 'multimodal_text',
      parts: [
        'what is this?',
        {
          content_type: 'image_asset_pointer',
          asset_pointer: 'file-service://file-ABC123',
          size_bytes: 1234,
          width: 1024,
          height: 1024,
        },
      ],
    });
  });

  it('keeps multiple images in order', () => {
    const img2: ResolvedImage = { ...img, fileId: 'file-DEF', width: 640, height: 480 };
    const result = buildMultimodalContent('compare', [img, img2]);
    expect(result.content_type).toBe('multimodal_text');
    expect(result.parts).toHaveLength(3);
    expect(result.parts[1].asset_pointer).toBe('file-service://file-ABC123');
    expect(result.parts[2].asset_pointer).toBe('file-service://file-DEF');
    expect(result.parts[2].width).toBe(640);
    expect(result.parts[2].height).toBe(480);
  });
});

describe('parseImageSize', () => {
  it('parses PNG IHDR dimensions', () => {
    expect(parseImageSize(pngBytes(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
      mimeType: 'image/png',
    });
  });

  it('parses GIF dimensions', () => {
    expect(parseImageSize(gifBytes(320, 240))).toEqual({
      width: 320,
      height: 240,
      mimeType: 'image/gif',
    });
  });

  it('parses JPEG SOF0 dimensions', () => {
    // SOI + SOF0 segment: FF D8 | FF C0 len=11 precision=8 height=600 width=800
    const b = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x58, 0x03, 0x20, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(parseImageSize(b)).toEqual({ width: 800, height: 600, mimeType: 'image/jpeg' });
  });

  it('parses JPEG dimensions after a leading APP1 segment', () => {
    // SOI, APP1 with 4-byte payload, then SOF2 (progressive).
    const b = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x06, 0x00, 0x01, 0x02, 0x03, 0xff, 0xc2, 0x00, 0x0b, 0x08,
      0x01, 0x2c, 0x01, 0xf4, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(parseImageSize(b)).toEqual({ width: 500, height: 300, mimeType: 'image/jpeg' });
  });

  it('parses WebP VP8X dimensions', () => {
    expect(parseImageSize(webpVp8xBytes(1024, 768))).toEqual({
      width: 1024,
      height: 768,
      mimeType: 'image/webp',
    });
  });

  it('parses WebP VP8L dimensions', () => {
    expect(parseImageSize(webpVp8lBytes(640, 480))).toEqual({
      width: 640,
      height: 480,
      mimeType: 'image/webp',
    });
  });

  it('throws on unrecognized formats', () => {
    expect(() => parseImageSize(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(
      'Unsupported image format'
    );
    expect(() => parseImageSize(new Uint8Array(0))).toThrow('Unsupported image format');
  });
});

describe('resolveImage', () => {
  it('decodes a PNG data URL without fetching', async () => {
    const png = pngBytes(64, 32);
    let b64 = '';
    for (const byte of png) b64 += String.fromCharCode(byte);
    const dataUrl = `data:image/png;base64,${btoa(b64)}`;

    const fetcher = vi.fn();
    const result = await resolveImage(
      { kind: 'data_url', source: dataUrl, partIndex: 0 },
      fetcher as any
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(64);
    expect(result.height).toBe(32);
    expect(Array.from(result.bytes)).toEqual(Array.from(png));
  });

  it('fetches http(s) URLs with the injected fetcher and validates headers', async () => {
    const png = pngBytes(128, 128);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(png as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    );
    const result = await resolveImage(
      { kind: 'url', source: 'https://example.com/pic.png', partIndex: 0 },
      fetcher as unknown as typeof fetch
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://example.com/pic.png', { method: 'GET' });
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(128);
    expect(result.height).toBe(128);
    expect(Array.from(result.bytes)).toEqual(Array.from(png));
  });

  it('rejects non-image content types with a clear error', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('<html>not an image</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );
    await expect(
      resolveImage(
        { kind: 'url', source: 'https://example.com/page', partIndex: 0 },
        fetcher as unknown as typeof fetch
      )
    ).rejects.toThrow('did not return an image');
  });

  it('rejects non-2xx responses with a clear error', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })
    );
    await expect(
      resolveImage(
        { kind: 'url', source: 'https://example.com/gone.png', partIndex: 0 },
        fetcher as unknown as typeof fetch
      )
    ).rejects.toThrow('HTTP 404');
  });

  it('rejects data URLs with non-image mime types after decoding', async () => {
    const dataUrl = 'data:text/html;base64,PGh0bWw+PC9odG1sPg==';
    await expect(
      resolveImage({ kind: 'data_url', source: dataUrl, partIndex: 0 })
    ).rejects.toThrow('Unsupported image format');
  });
});

describe('hasImageContent', () => {
  it('detects image parts in array content', () => {
    expect(
      hasImageContent({
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } },
        ],
      })
    ).toBe(true);
    expect(
      hasImageContent({
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/x' }],
      })
    ).toBe(true);
  });

  it('returns false for text-only or plain string content', () => {
    expect(
      hasImageContent({
        role: 'user',
        content: [{ type: 'text', text: 'just words' }],
      })
    ).toBe(false);
    expect(hasImageContent({ role: 'user', content: 'plain string' })).toBe(false);
    expect(hasImageContent({ role: 'user', content: [] })).toBe(false);
  });
});
