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

// GENUI_CONTAINER_OPEN tags the opener fence line of a bare genui container
// the upstream model sometimes emits verbatim
// (":::writing{variant="document" id="…"}"): no PUA wrapping, just the colon
// fence lines around the real body. The name must start right after ":::"
// and the line must END at the optional closing brace, so prose containing
// ":::" is never touched.
const GENUI_CONTAINER_OPEN = /^:::[A-Za-z][\w-]*(?:\{[^\n]*\})?[ \t]*$/;
// GENUI_CONTAINER_CLOSE matches the bare closing fence line ":::".
const GENUI_CONTAINER_CLOSE = /^:::[ \t]*$/;
// GENUI_CONTAINER_PARTIAL matches a line-starting prefix that could still
// grow into a bare container opener or closer ("::", ":::writ", the opener
// tail with a partial brace, …). Used to withhold fragments split across
// cumulative snapshots.
export const GENUI_CONTAINER_PARTIAL =
  /^(?::(?::(?:(?:[A-Za-z][\w-]*)?(?:\{[^\n]*)?)?)?)?[ \t]*$/;
// GENUI_MAX_ATTR_RUN caps how far back splitGenuiContainerTail rescans for
// an unfinished "{…" attribute run — a bounded window avoids pathological
// cost on huge replies (the whole reply is always cheap anyway, carried by
// the caller's already-linear formatCitations pass).
const GENUI_MAX_ATTR_RUN = 200;

// nestedCitationLink repairs a citation link that landed INSIDE the parens
// of a markdown link the model wrote itself, producing broken nesting:
// "[来源：x]( [aljazeera.com](https://…) )" → "[来源：x](https://…)".
const NESTED_CITATION_LINK = /(\[[^\]\n]*\]\()\s*\[[^\]\n]*\]\(([^()\s]+)\)\s*(\))/g;


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
 * stripGenuiContainers removes bare (non-PUA-wrapped) genui container fence
 * lines — ":::writing{…}" openers and bare ":::" closers — keeping the
 * content between them. Nested containers are unwrapped level by level.
 * Fence-looking text inside fenced code blocks (``` / ~~~) is preserved,
 * since there it is user-visible code, not container markup.
 */
export function stripGenuiContainers(text: string): string {
  if (!text || !text.includes(':::')) {
    return text;
  }
  const lines = text.split('\n');
  const out: string[] = [];
  // depth counts OPEN container fences we dropped: only closers seen while
  // depth > 0 are markup; an unbalanced stray ":::" line stays as content.
  let depth = 0;
  // codeFence tracks the open code fence (""" 或 ~~~, 可能带 info string)
  // so its lines — ":::writing{void}" included — pass through untouched.
  let codeFence: '```' | '~~~' | '' = '';
  for (const line of lines) {
    //  fenced code block boundary: ```xxx / ~~~ (closing fence has no info)
    const fenceMatch = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1].startsWith('~') ? '~~~' : '```';
      if (codeFence === '') {
        codeFence = marker;
      } else if (codeFence === marker) {
        codeFence = '';
      }
      out.push(line);
      continue;
    }
    if (codeFence !== '') {
      out.push(line);
      continue;
    }
    if (GENUI_CONTAINER_OPEN.test(line)) {
      depth++;
      continue; // drop the opener fence line, keep following content
    }
    if (depth > 0 && GENUI_CONTAINER_CLOSE.test(line)) {
      depth--;
      continue; // matching closer fence line
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * splitGenuiContainerTail removes and returns the longest trailing fragment
 * of s that sits INSIDE a bare genui opener line still being written
 * ("::", ":::writing{variant=""…" split mid-attribute). Mirrors
 * splitCitationTail: the fragment is withheld until later snapshots complete
 * the line, at which point stripGenuiContainers drops it.
 */
export function splitGenuiContainerTail(text: string): { keep: string; tail: string } {
  if (!text || !text.includes(':')) {
    return { keep: text, tail: '' };
  }
  const nl = text.lastIndexOf('\n');
  const lineStart = nl + 1;
  const lastLine = text.slice(lineStart);

  // Find the last ":::" run on the last line: everything from there is the
  // candidate fragment. We tolerate the fragment starting after text, since
  // cumulative snapshots could have emitted any prefix of the fence already.
  const fenceIdx = lastLine.lastIndexOf(':::');
  if (fenceIdx >= 0) {
    const candidate = lastLine.slice(fenceIdx);
    const braceOpen = candidate.indexOf('{');
    if (braceOpen === -1) {
      // Partial or complete name-only opener prefix (":", "::", ":::wri").
      if (/^:::[A-Za-z]?[\w-]*[ \t]*$/.test(candidate)) {
        return { keep: text.slice(0, lineStart + fenceIdx), tail: candidate };
      }
      return { keep: text, tail: '' };
    }
    // Unfinished attribute run: withhold until '}' arrives.
    const attrRun = candidate.slice(braceOpen);
    if (attrRun.length <= GENUI_MAX_ATTR_RUN && !attrRun.includes('}')) {
      return { keep: text.slice(0, lineStart + fenceIdx), tail: candidate };
    }
    return { keep: text, tail: '' };
  }

  // Rare alternative form seen in the wild: an unwrapped text token
  // "genui<attrs>" (e.g. "genui5j") — presumably the inner 'writing' node's
  // attribute id bleeding through. Withhold at line end so a following "{…}"
  // or closing action can complete (or be dropped by resolveWithheld).
  const genuiTailMatch = lastLine.match(/(genui[\w-]*)$/);
  if (genuiTailMatch && lineStart + lastLine.length - genuiTailMatch[1].length >= lineStart) {
    const cut = text.length - genuiTailMatch[1].length;
    return { keep: text.slice(0, cut), tail: genuiTailMatch[1] };
  }

  // No ":::" yet: a trailing ":" / "::" (wherever it starts on the line)
  // may still grow into a fence. Withhold only that suffix.
  const trailing = lastLine.match(/(:{1,2})$/);
  if (trailing) {
    const cut = text.length - trailing[1].length;
    return { keep: text.slice(0, cut), tail: trailing[1] };
  }
  return { keep: text, tail: '' };
}

/**
 * formatCitations replaces citation markers with inline markdown links.
 * If a key has no known source, it is safely stripped. When replacement
 * lands a link inside a model-written markdown link, the nesting is repaired.
 */
export function formatCitations(text: string, sources?: Map<string, SearchSource>): string {
  // Fast path: no PUA runs, no ASCII citation markers, and nothing the
  // post-pass could repair (a bare ":::" line is handled by
  // stripGenuiContainers separately — formatCitations itself only needs the
  // nested-link pass when replacements actually ran).
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

  // citePrefixResidue: an ASCII "cite" the model wrote directly before a PUA
  // annotation survives ANNOTATION_BLOCK; drop just that word (the block itself
  // is still replaced with its markdown link by the pass below). The residue's
  // OWN trailing space/tab run is consumed too — otherwise "cite " left the
  // separator space plus the annotation's leading space, emitting two spaces.
  // The lookahead stops at the annotation START rune: ANNOTATION_BLOCK handles
  // the (possibly still-growing) block itself, and matching through to the END
  // rune inside a lookahead made this pass superlinear on unterminated input.
  const CITE_PREFIX_RESIDUE = /(^|[^A-Za-z0-9_])cite[ \t]*(?=\ue200)/g;
  let s = text.replace(CITE_PREFIX_RESIDUE, '$1');

  s = s.replace(ANNOTATION_BLOCK, replaceBlock);
  s = s.replace(CITATION_RUN, replaceRun);
  s = s.replace(PUA_STRAY, '');
  // Second pass: a link the replacement emitted may have landed INSIDE the
  // parens of a markdown link the model wrote itself ("[来源：x]( [y](u) )"),
  // which renders as broken nesting. Collapse it to the model's link text
  // pointing at the citation URL.
  s = s.replace(NESTED_CITATION_LINK, '$1$2$3');
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
  // A withheld ":::"-fragment ("::", ":::writing{…") never made it to a full
  // opener line: it is a truncated genui fence, not real content. Drop it;
  // real prose never consists of only colon-fragments at line end.
  if (fragment && /^:{1,3}[A-Za-z]?[\w-]*(?:\{[^\n]*)?[ \t]*$/.test(fragment)) {
    return '';
  }
  // Bare "genui<attrs>" orphans (e.g. "genui5j") are fragments of an
  // unwrapped writing-node attribute run. Real prose never ends in a bare
  // "genui…" word — drop it.
  if (fragment && /^genui[\w-]*$/.test(fragment)) {
    return '';
  }
  return fragment;
}
