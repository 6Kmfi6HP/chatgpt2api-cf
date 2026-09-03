import { describe, it, expect } from 'vitest';
import {
  cleanURL,
  cleanAttribution,
  ingestMetadata,
  formatCitations,
  stripCitations,
  splitCitationTail,
  resolveWithheld,
  PUA_ANNOTATION_START,
  PUA_ANNOTATION_SEP,
  PUA_ANNOTATION_END,
} from './citations';
import type { SearchSource } from './types';

// Helper to build a PUA-wrapped annotation the way upstream embeds it
function pua(kind: string, payload: string): string {
  return PUA_ANNOTATION_START + kind + PUA_ANNOTATION_SEP + payload + PUA_ANNOTATION_END;
}

describe('cleanURL', () => {
  it('strips utm_source query parameter', () => {
    expect(cleanURL('https://news.com/72?utm_source=chatgpt.com')).toBe('https://news.com/72');
    expect(cleanURL('https://news.com/72?foo=bar&utm_source=chatgpt.com')).toBe('https://news.com/72?foo=bar');
  });

  it('preserves clean URLs and returns empty string for empty input', () => {
    expect(cleanURL('https://wsj.com/75')).toBe('https://wsj.com/75');
    expect(cleanURL('')).toBe('');
    expect(cleanURL('   ')).toBe('');
  });
});

describe('cleanAttribution', () => {
  it('strips www. and www2. prefixes', () => {
    expect(cleanAttribution('www.reuters.com', 'https://www.reuters.com/g20')).toBe('reuters.com');
    expect(cleanAttribution('www2.example.com', 'https://www2.example.com')).toBe('example.com');
    expect(cleanAttribution('The Wall Street Journal', 'https://wsj.com')).toBe('The Wall Street Journal');
  });

  it('falls back to hostname of targetURL or "source"', () => {
    expect(cleanAttribution('', 'https://www.reuters.com/g20')).toBe('reuters.com');
    expect(cleanAttribution('', 'https://example.com/test')).toBe('example.com');
    expect(cleanAttribution('', '')).toBe('source');
  });
});

describe('stripCitations', () => {
  const cases = [
    { name: 'single', in: '监管。' + pua('cite', 'turn0news72') + '\n', want: '监管。\n' },
    { name: 'concatenated run', in: pua('cite', 'turn0news72') + 'turn0news0', want: '' },
    { name: 'space before run', in: '阶段。** ' + pua('cite', 'turn0news72') + 'turn0news75turn0news7', want: '阶段。**' },
    { name: 'mid sentence', in: '他说了这句话' + pua('cite', 'turn0news7') + 'turn0news31，然后离开', want: '他说了这句话，然后离开' },
    { name: 'english', in: 'Big deal announced. ' + pua('cite', 'turn0news75') + ' More text', want: 'Big deal announced. More text' },
    { name: 'file chunk', in: 'see citeturn0file12c3 now', want: 'see now' },
    { name: 'plain text untouched', in: 'in turn, the result was c', want: 'in turn, the result was c' },
    { name: 'no markers', in: 'just normal text', want: 'just normal text' },
    { name: 'stray end rune', in: 'orphan ' + PUA_ANNOTATION_END + ' marker', want: 'orphan  marker' },
    { name: 'stray sep rune', in: 'orphan ' + PUA_ANNOTATION_SEP + ' marker', want: 'orphan  marker' },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      expect(stripCitations(tc.in)).toBe(tc.want);
    });
  }
});

describe('splitCitationTail', () => {
  const cases = [
    { in: 'done', keep: 'done', tail: '' },
    { in: 'text. cite', keep: 'text.', tail: ' cite' },
    { in: 'text. citeturn0news7', keep: 'text.', tail: ' citeturn0news7' },
    { in: 'run continues: turn0ne', keep: 'run continues:', tail: ' turn0ne' },
    { in: 't', keep: '', tail: 't' },
    { in: 'c', keep: '', tail: 'c' },
    { in: 'hello world', keep: 'hello world', tail: '' },
    { in: 'about', keep: 'abou', tail: 't' },
    { in: '文本继续' + pua('cite', 'turn0news1'), keep: '文本继续', tail: pua('cite', 'turn0news1') },
    {
      in: 'This is a longer answer about the topic turn0ne',
      keep: 'This is a longer answer about the topic',
      tail: ' turn0ne',
    },
    {
      in: 'This is a longer answer about the topic and it ends cleanly',
      keep: 'This is a longer answer about the topic and it ends cleanly',
      tail: '',
    },
  ];

  for (const tc of cases) {
    it(`splits: "${tc.in.slice(0, 25)}"`, () => {
      const { keep, tail } = splitCitationTail(tc.in);
      expect(keep).toBe(tc.keep);
      expect(tail).toBe(tc.tail);
    });
  }
});

describe('resolveWithheld', () => {
  it('drops fragments with digits or PUA delimiters', () => {
    expect(resolveWithheld('citeturn0new')).toBe('');
    expect(resolveWithheld(' turn0ne')).toBe('');
    expect(resolveWithheld(PUA_ANNOTATION_START + 'cite')).toBe('');
    expect(resolveWithheld(PUA_ANNOTATION_SEP + 'tail')).toBe('');
  });

  it('keeps pure-letter tail', () => {
    expect(resolveWithheld('turn')).toBe('turn');
    expect(resolveWithheld('about')).toBe('about');
  });

  it('handles empty string', () => {
    expect(resolveWithheld('')).toBe('');
  });
});

describe('formatCitations', () => {
  const sources = new Map<string, SearchSource>([
    ['turn0news72', { url: 'https://news.com/72?utm_source=chatgpt.com', title: 'News 72', attribution: 'news.com' }],
    ['turn0news75', { url: 'https://wsj.com/75', title: 'WSJ 75', attribution: 'The Wall Street Journal' }],
    ['turn0news30', { url: 'https://www.reuters.com/g20', title: 'Reuters G20', attribution: 'www.reuters.com' }],
    ['turn0news6', { url: 'https://www.reuters.com/g20', title: 'Reuters Duplicate', attribution: 'Reuters' }],
    ['turn0file12', { url: 'https://example.com/file12', title: 'File 12', attribution: 'example.com' }],
  ]);

  it('formats single citation', () => {
    const input = '监管。' + pua('cite', 'turn0news72') + '\n';
    const want = '监管。 [news.com](https://news.com/72)\n';
    expect(formatCitations(input, sources)).toBe(want);
  });

  it('formats multiple citations with deduplication', () => {
    const input = '政策分析。' + pua('cite', 'turn0news30' + PUA_ANNOTATION_SEP + 'turn0news6' + PUA_ANNOTATION_SEP + 'turn0news75');
    const want = '政策分析。 [reuters.com](https://www.reuters.com/g20) [The Wall Street Journal](https://wsj.com/75)';
    expect(formatCitations(input, sources)).toBe(want);
  });

  it('formats PUA url button', () => {
    const input = '官方资料：' + pua('url', 'UEFA 2024' + PUA_ANNOTATION_SEP + 'https://uefa.com/2024?utm_source=chatgpt.com');
    const want = '官方资料： [UEFA 2024](https://uefa.com/2024)';
    expect(formatCitations(input, sources)).toBe(want);
  });

  it('strips unknown source keys', () => {
    const input = '未知来源。' + pua('cite', 'turn0unknown99') + '完成';
    expect(formatCitations(input, sources)).toBe('未知来源。完成');
  });

  it('resolves chunk citation fallback (c suffix)', () => {
    const input = 'see citeturn0file12c3 now';
    expect(formatCitations(input, sources)).toBe('see [example.com](https://example.com/file12) now');
  });

  it('replaces ASCII citation runs when sources match', () => {
    const input = 'see turn0news72 now';
    expect(formatCitations(input, sources)).toBe('see [news.com](https://news.com/72) now');
  });
});

describe('ingestMetadata', () => {
  it('ingests search_result_groups and content_references', () => {
    const sources = new Map<string, SearchSource>();

    const toolPayload = {
      message: {
        author: { role: 'tool', name: 'web.run' },
        metadata: {
          search_result_groups: [
            {
              domain: 'www.reuters.com',
              entries: [
                {
                  url: 'https://www.reuters.com/business/ai-rules-2026?utm_source=chatgpt.com',
                  title: 'US urges G20 on AI rules',
                  attribution: 'Reuters',
                  ref_id: { turn_index: 0, ref_type: 'news', ref_index: 30 },
                },
              ],
            },
          ],
        },
      },
    };

    ingestMetadata(sources, toolPayload);

    expect(sources.has('turn0news30')).toBe(true);
    const src = sources.get('turn0news30')!;
    expect(src.url).toBe('https://www.reuters.com/business/ai-rules-2026');
    expect(src.title).toBe('US urges G20 on AI rules');
    expect(src.attribution).toBe('Reuters');

    const crPayload = JSON.stringify({
      message: {
        metadata: {
          content_references: [
            {
              matched_text: pua('cite', 'turn0news75'),
              items: [
                {
                  url: 'https://wsj.com/ai-policies',
                  title: 'WSJ AI Policies',
                  attribution: 'The Wall Street Journal',
                },
              ],
            },
          ],
        },
      },
    });

    ingestMetadata(sources, crPayload);

    expect(sources.has('turn0news75')).toBe(true);
    const src75 = sources.get('turn0news75')!;
    expect(src75.url).toBe('https://wsj.com/ai-policies');
    expect(src75.title).toBe('WSJ AI Policies');
    expect(src75.attribution).toBe('The Wall Street Journal');

    // Test formatting with ingested metadata
    const text = '美国政府在 G20 提出倡议。' + pua('cite', 'turn0news30') + '\n详细分析如下：';
    const formatted = formatCitations(text, sources);
    expect(formatted).toBe('美国政府在 G20 提出倡议。 [Reuters](https://www.reuters.com/business/ai-rules-2026)\n详细分析如下：');
  });

  it('handles empty or malformed inputs safely', () => {
    const sources = new Map<string, SearchSource>();
    ingestMetadata(sources, null);
    ingestMetadata(sources, undefined);
    ingestMetadata(sources, 'invalid json');
    ingestMetadata(sources, {});
    expect(sources.size).toBe(0);
  });
});
