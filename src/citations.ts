import type { SearchSource } from './types';

export const PUA_ANNOTATION_START = '\ue200';
export const PUA_ANNOTATION_SEP = '\ue202';
export const PUA_ANNOTATION_END = '\ue201';

// annotationBlock matches one closed PUA annotation (kind + payload),
// optionally preceded by a single space/tab so replacement or removal
// does not leave double spaces (newlines are preserved).
const ANNOTATION_BLOCK = /(?:[ \t])?\ue200[^\ue201]*\ue201/g;

// puaStray matches leftover annotation control runes.
const PUA_STRAY = /[\ue200\ue201\ue202]/g;

// citationRun matches an ASCII-fallback run of citation markers
// ("citeturn0news72turn0news0") occasionally seen without PUA wrapping,
// optionally preceded by a single space/tab (never a newline).
const CITATION_RUN = /(?:[ \t]|^)?(?:(?:cite)?turn\d+[a-z]+[0-9]+(?:c[0-9]+)?)+/g;

// citationPartial matches a PROPER PREFIX of an ASCII citation marker,
// i.e. text that could still grow into one ("c", "cit", "turn0ne", ...).
// Used to withhold partial markers split across cumulative snapshots.
const CITATION_PARTIAL = /^(?:t(?:u(?:r(?:n[\da-z]*)?)?)?|c(?:i(?:t(?:e(?:turn[\da-z]*)?)?)?)?)$/;

// singleKeyRe finds individual citation keys inside an ASCII citation run.
const SINGLE_KEY_RE = /turn\d+[a-z]+[0-9]+(?:c[0-9]+)?/g;

/**
 * cleanURL removes tracking parameters (e.g. utm_source) and trims whitespace.
 */
export function cleanURL(raw: string): string {
  raw = (raw || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const u = new URL(raw);
    if (u.searchParams.has('utm_source')) {
      u.searchParams.delete('utm_source');
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * cleanAttribution removes leading www/www2 and falls back to targetURL hostname or "source".
 */
export function cleanAttribution(attr: string, targetURL: string): string {
  let cleaned = (attr || '').trim();
  if (cleaned.startsWith('www.')) {
    cleaned = cleaned.slice(4);
  } else if (cleaned.startsWith('www2.')) {
    cleaned = cleaned.slice(5);
  }
  if (cleaned !== '') {
    return cleaned;
  }
  try {
    const u = new URL(targetURL);
    let host = u.hostname || '';
    if (host.startsWith('www.')) {
      host = host.slice(4);
    }
    if (host !== '') {
      return host;
    }
  } catch {
    // ignore
  }
  return 'source';
}

/**
 * ingestMetadata parses search references from Tool messages (web.run) and
 * Assistant messages, caching them in the sources map by citation key (e.g. turn0news30).
 */
export function ingestMetadata(sources: Map<string, SearchSource>, rawJSON: any): void {
  if (!rawJSON || !sources) {
    return;
  }
  let ev = rawJSON;
  if (typeof rawJSON === 'string') {
    try {
      ev = JSON.parse(rawJSON);
    } catch {
      return;
    }
  }
  const meta = ev?.message?.metadata;
  if (!meta) {
    return;
  }

  if (Array.isArray(meta.search_result_groups)) {
    for (const group of meta.search_result_groups) {
      if (!group || !Array.isArray(group.entries)) {
        continue;
      }
      for (const entry of group.entries) {
        if (!entry || !entry.url) {
          continue;
        }
        const u = cleanURL(entry.url);
        if (!u) {
          continue;
        }
        const refId = entry.ref_id || {};
        const turnIndex = refId.turn_index ?? 0;
        const refType = refId.ref_type ?? '';
        const refIndex = refId.ref_index ?? 0;
        const key = `turn${turnIndex}${refType}${refIndex}`;
        const attr = entry.attribution || group.domain || '';
        sources.set(key, {
          url: u,
          title: entry.title || '',
          attribution: attr,
        });
      }
    }
  }

  if (Array.isArray(meta.content_references)) {
    for (const cr of meta.content_references) {
      if (!cr || !Array.isArray(cr.items) || typeof cr.matched_text !== 'string') {
        continue;
      }
      for (const item of cr.items) {
        if (!item || !item.url) {
          continue;
        }
        const u = cleanURL(item.url);
        if (!u) {
          continue;
        }
        if (cr.matched_text.includes(PUA_ANNOTATION_START)) {
          const inner = cr.matched_text.replace(/^[\ue200\ue201]+|[\ue200\ue201]+$/g, '');
          const parts = inner.split(PUA_ANNOTATION_SEP);
          if (parts.length > 1 && parts[0] === 'cite') {
            for (const k of parts.slice(1)) {
              if (!sources.has(k)) {
                sources.set(k, {
                  url: u,
                  title: item.title || '',
                  attribution: item.attribution || '',
                });
              }
            }
          }
        }
      }
    }
  }
}

/**
 * formatCitations replaces citation markers with inline markdown links.
 * If a key has no known source, it is safely stripped.
 */
export function formatCitations(text: string, sources?: Map<string, SearchSource>): string {
  if (
    !text.includes(PUA_ANNOTATION_START) &&
    !text.includes(PUA_ANNOTATION_SEP) &&
    !text.includes(PUA_ANNOTATION_END) &&
    !text.includes('turn') &&
    !text.includes('cite')
  ) {
    return text;
  }

  const resolveKey = (k: string): SearchSource | undefined => {
    if (!sources || sources.size === 0) {
      return undefined;
    }
    let src = sources.get(k);
    if (!src && k.includes('c')) {
      const cIdx = k.lastIndexOf('c');
      if (cIdx > 0) {
        src = sources.get(k.slice(0, cIdx));
      }
    }
    return src;
  };

  const replaceBlock = (match: string): string => {
    const pua = match.replace(/^[ \t]+/, '');
    if (!pua.startsWith(PUA_ANNOTATION_START) || !pua.endsWith(PUA_ANNOTATION_END)) {
      return '';
    }
    const inner = pua.slice(PUA_ANNOTATION_START.length, pua.length - PUA_ANNOTATION_END.length);
    const parts = inner.split(PUA_ANNOTATION_SEP);
    const kind = parts[0];
    if (kind === 'cite') {
      const keys = parts.slice(1);
      const links: string[] = [];
      const seen = new Set<string>();
      for (const k of keys) {
        const src = resolveKey(k);
        if (src && src.url) {
          const u = cleanURL(src.url);
          if (seen.has(u)) {
            continue;
          }
          seen.add(u);
          const attr = cleanAttribution(src.attribution, u);
          links.push(`[${attr}](${u})`);
        }
      }
      if (links.length === 0) {
        return '';
      }
      return ' ' + links.join(' ');
    } else if (kind === 'url') {
      if (parts.length >= 3) {
        const title = parts[1];
        const u = cleanURL(parts[2]);
        return ` [${title}](${u})`;
      } else if (parts.length === 2) {
        const u = cleanURL(parts[1]);
        return ` [${u}](${u})`;
      }
      return '';
    }
    return '';
  };

  const replaceRun = (match: string): string => {
    const keys = match.match(SINGLE_KEY_RE) || [];
    const links: string[] = [];
    const seen = new Set<string>();
    for (const k of keys) {
      const src = resolveKey(k);
      if (src && src.url) {
        const u = cleanURL(src.url);
        if (seen.has(u)) {
          continue;
        }
        seen.add(u);
        const attr = cleanAttribution(src.attribution, u);
        links.push(`[${attr}](${u})`);
      }
    }
    if (links.length === 0) {
      return '';
    }
    return ' ' + links.join(' ');
  };

  let s = text.replace(ANNOTATION_BLOCK, replaceBlock);
  s = s.replace(CITATION_RUN, replaceRun);
  s = s.replace(PUA_STRAY, '');
  return s;
}

/**
 * stripCitations removes closed annotation blocks and ASCII citation runs
 * from assistant text when no search sources are available.
 */
export function stripCitations(text: string): string {
  return formatCitations(text, new Map());
}

/**
 * splitCitationTail removes and returns the longest trailing fragment of s
 * that could still grow into a citation annotation ("" when the text ends clean).
 */
export function splitCitationTail(text: string): { keep: string; tail: string } {
  if (!text) {
    return { keep: text, tail: '' };
  }
  const idx = text.lastIndexOf(PUA_ANNOTATION_START);
  if (idx >= 0) {
    let splitIdx = idx;
    if (splitIdx > 0 && (text[splitIdx - 1] === ' ' || text[splitIdx - 1] === '\t')) {
      splitIdx--;
    }
    return { keep: text.slice(0, splitIdx), tail: text.slice(splitIdx) };
  }
  const start = Math.max(0, text.length - 24);
  for (let i = start; i < text.length; i++) {
    if (CITATION_PARTIAL.test(text.slice(i))) {
      let splitIdx = i;
      if (splitIdx > 0 && (text[splitIdx - 1] === ' ' || text[splitIdx - 1] === '\t')) {
        splitIdx--;
      }
      return { keep: text.slice(0, splitIdx), tail: text.slice(splitIdx) };
    }
  }
  return { keep: text, tail: '' };
}

/**
 * resolveWithheld decides the fate of a withheld fragment once no more
 * snapshots will arrive: fragments containing digits are certainly truncated
 * citation markers and are dropped; pure-letter fragments may be the tail of
 * a real word ("in turn") and are kept.
 */
export function resolveWithheld(fragment: string): string {
  if (
    /[0-9]/.test(fragment) ||
    fragment.includes(PUA_ANNOTATION_START) ||
    fragment.includes(PUA_ANNOTATION_SEP)
  ) {
    return '';
  }
  return fragment;
}
