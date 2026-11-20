/**
 * Custom tool-calling protocol for the anonymous ChatGPT upstream.
 *
 * The /f/conversation DTO has no `tools` field, so the tool protocol is
 * compiled into a system message: available tools plus a single-line JSON
 * reply convention ({"tool_calls":[{"name":"<tool>","arguments":{...}}]}).
 * Model replies are then strict-parsed for that shape and translated back
 * into OpenAI-compatible tool_calls on the wire.
 */

/** OpenAI chat-completions `tools[]` element (function tool). */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

/** A single parsed tool call extracted from a model reply. */
export interface ParsedToolCall {
  name: string;
  /** OpenAI wire format: arguments are always a JSON string. */
  arguments: string;
}

/** Generic chat-completions message we accept from callers. */
export interface GenericMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }>;
  name?: string;
  tool_calls?: Array<{ name: string; arguments: string }>;
  tool_call_id?: string;
}

/** Message shape the anonymous ChatGPT conversation endpoint accepts. */
export interface UpstreamMessage {
  author: { role: string; name?: string; metadata?: Record<string, any> };
  content: { content_type: string; parts: (string | Record<string, any>)[] };
  recipient?: string;
  metadata?: Record<string, any>;
}

/** Reply format we ask the model to use when it wants to call tools. */
export const TOOL_CALL_REPLY_FORMAT = '{"tool_calls":[{"name":"<tool>","arguments":{}}]}';

/**
 * Per-request tool-call cardinality. `parallel_tool_calls: false` means the
 * caller can only execute ONE call per turn, so the gateway must expose at
 * most one (see {@link selectSingleToolCall}) — dropping the extra calls
 * after the model already committed to them is lossy either way, hence the
 * matching protocol directive that asks for a single call up front.
 */
export interface SingleCallOptions {
  singleCall?: boolean;
  /** Tool name demanded by tool_choice; preferred over "first call wins". */
  preferredName?: string | null;
}

/**
 * Reduce parsed tool calls to the single call the caller can execute.
 *
 * `preferredName` (a named tool_choice) wins so the retained call still
 * satisfies the named contract; otherwise the model's first call is kept.
 * Returns the input untouched when there is nothing to cut.
 */
export function selectSingleToolCall(
  calls: ParsedToolCall[],
  preferredName?: string | null
): ParsedToolCall[] {
  if (calls.length <= 1) return calls;
  if (preferredName) {
    const hit = calls.find((c) => c.name === preferredName);
    if (hit) return [hit];
  }
  return [calls[0]];
}

/** Tool name from a named tool_choice, or null for string choices. */
export function toolChoiceName(choice: unknown): string | null {
  if (!choice || typeof choice !== 'object') return null;
  if (!('function' in choice)) return null;
  const fn = choice.function;
  if (!fn || typeof fn !== 'object' || !('name' in fn)) return null;
  return typeof fn.name === 'string' && fn.name !== '' ? fn.name : null;
}

/**
 * Build the system message that teaches the model the tool protocol.
 *
 * Empirically (2026-09-15, anonymous backend replicas), adherence depends on
 * three factors baked into the wording:
 *  1. tools are framed as REAL, CALLABLE system-provided tools (otherwise the
 *     model answers "unable to access the tool");
 *  2. an explicit "you do not know this from training - MUST call, never
 *     guess" clause (otherwise the model hallucinates plausible answers);
 *  3. a concrete single-line JSON template shown once per request.
 *
 * `toolChoice` is an optional strong hint. The upstream DTO has no native
 * tool-choice knob, so "required" and a named function only strengthen the
 * protocol wording (the tool list stays complete); they are not guarantees.
 * "auto" and undefined leave the wording byte-identical.
 *
 * `opts.singleCall` mirrors OpenAI's `parallel_tool_calls: false`: the caller
 * can execute only one call this turn. The gateway also truncates whatever
 * the model returns ({@link selectSingleToolCall}), but asking first is what
 * keeps the model from spending the turn on calls that will be dropped.
 */
export function buildToolProtocolSystemMessage(
  tools: ToolDefinition[],
  toolChoice?: 'auto' | 'required' | { type: 'function'; function: { name: string } },
  opts?: SingleCallOptions
): string {
  const toolLines: string[] = [];
  for (const t of tools) {
    const f = t.function;
    const schema = f.parameters ? JSON.stringify(f.parameters) : '{}';
    const params = schema === '{}' ? 'no arguments' : schema;
    toolLines.push(`- ${f.name}(${params})${f.description ? ` -> ${f.description}` : ''}`);
  }

  const lines: string[] = [
    '[SYSTEM TOOL PROTOCOL - MANDATORY]',
    '',
    'You are integrated with a tool execution engine. The following tools are REAL and CONNECTED. When you reply with a tool call, the engine EXECUTES it and returns the result to you automatically.',
    '',
    'Tools:',
    ...toolLines,
    '',
    'BEHAVIORAL RULE (HIGHEST PRIORITY):',
    'For anything the tools cover, you have ZERO knowledge of your own. The only path to the answer is: reply with a tool call. The engine will run it and give you the result.',
    '',
    'TOOL CALL FORMAT (your entire reply, one line, raw JSON, machine-parsed):',
    TOOL_CALL_REPLY_FORMAT,
    '',
    'FORBIDDEN:',
    '- Saying a tool is unavailable or not accessible (all listed tools ARE available and connected).',
    '- Guessing or inventing results.',
    '- Claiming you lack access (you have full access).',
    '',
    'TOOL RESULTS (messages from a tool in this conversation):',
    'A tool result is the authoritative, current answer for what it covers. Answer from it directly. Never search the web or use your own knowledge to replace, verify, or update it — not even for real-time data such as weather, prices, or news.',
    '',
    'If — and only if — the question is fully answerable without any tool, answer in plain text.',
  ];

  if (toolChoice === 'required') {
    lines.push(
      '',
      'MANDATORY TOOL USE (this request):',
      'You MUST reply with a tool call. A plain-text answer is INVALID and will be rejected.'
    );
  } else if (toolChoice && typeof toolChoice === 'object') {
    const name = toolChoice.function?.name;
    if (typeof name === 'string' && name.length > 0) {
      lines.push(
        '',
        'MANDATORY TOOL USE (this request):',
        `You MUST call the tool "${name}". No other tool and no plain-text answer is acceptable.`
      );
    }
  }

  // parallel_tool_calls:false — the caller executes exactly one call.
  if (opts?.singleCall) {
    lines.push(
      '',
      'SINGLE TOOL CALL (this request):',
      'Reply with exactly ONE tool call. Do not combine several calls in one reply: the caller executes only the first and discards the rest.'
    );
  }

  return lines.join('\n');
}

/** Max reply length considered for tool-call parsing; longer means prose. */
const MAX_PARSE_LENGTH = 8000;

/**
 * Extract the JSON payload from a model reply, or null.
 * Accepts a whole-text JSON, a first-line JSON with only whitespace
 * around it, or a fenced ```json ...``` code block.
 */
function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // ```json ... ``` / ``` ... ``` fenced block (whole reply)
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fence) return fence[1].trim();

  // Whole text is one JSON value
  if (!trimmed.includes('\n')) return trimmed;

  // JSON on the first line with only whitespace before/after the block
  const nl = trimmed.indexOf('\n');
  const first = trimmed.slice(0, nl).trim();
  const rest = trimmed.slice(nl + 1).trim();
  if (first.startsWith('{') && first.endsWith('}') && rest === '') return first;

  // JSON block spanning multiple lines, only whitespace around it
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  return null;
}

/**
 * Strictly parse a model reply as a tool call.
 * Returns the parsed calls with `arguments` normalized to a JSON string,
 * or null when the reply is (or must be treated as) plain text.
 */
export function tryParseToolCall(text: string): ParsedToolCall[] | null {
  if (!text || text.length > MAX_PARSE_LENGTH) return null;
  const candidate = extractJsonCandidate(text);
  if (!candidate) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const calls = parsed.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return null;

  const out: ParsedToolCall[] = [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') return null;
    const name = typeof c.name === 'string' ? c.name : c.function?.name;
    if (typeof name !== 'string' || name.length === 0) return null;
    let args = c.arguments !== undefined ? c.arguments : c.function?.arguments;
    if (args === undefined || args === null) args = {};
    if (typeof args === 'string') {
      const s = args.trim();
      if (!s) {
        args = {};
      } else {
        try {
          args = JSON.parse(s);
        } catch {
          out.push({ name, arguments: s }); // keep original string if not valid JSON
          continue;
        }
      }
    }
    if (typeof args !== 'object') args = { value: args };
    out.push({ name, arguments: JSON.stringify(args) });
  }
  return out;
}

/** Canonical opening of the protocol payload; prefixes of it are also artifacts. */
const TRUNCATED_OPENER = '{"tool_calls":[';
const TRUNCATED_TOOL_CALL_OPEN = /^\{\s*"tool_calls"\s*:\s*\[/;

/**
 * True when `text` is an interrupted tool-call protocol payload: it opens the
 * `{"tool_calls":[` carrier but never became parseable JSON. Such text is a
 * transport artifact, never an assistant answer (see [audit:truncated-tool-json-leak]).
 */
export function isTruncatedToolCallPrefix(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  if (TRUNCATED_TOOL_CALL_OPEN.test(trimmed)) return true;
  // A cut inside the header itself ("{"tool_calls") still carries no answer.
  return TRUNCATED_OPENER.startsWith(trimmed.replace(/\s+/g, ''));
}

/**
 * Split the array body into entry slices at brace depth 0. The last slice may
 * be unterminated: the cut landed inside it (or right after its opener).
 */
function splitTruncatedEntries(body: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        entries.push(body.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (start >= 0) entries.push(body.slice(start));
  return entries;
}

/** The entry's tool name; also reads a name literal the cut left open. */
function truncatedEntryName(entry: string): string | null {
  const m =
    /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(entry) ??
    /"name"\s*:\s*"((?:[^"\\]|\\.)*)$/.exec(entry);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    // An escape the cut left dangling: keep the literal bytes.
    return m[1];
  }
}

/** The entry's arguments text, normalized to the OpenAI wire shape. */
function truncatedEntryArguments(entry: string): string {
  const key = entry.search(/"arguments"\s*:/);
  if (key < 0) return '{}';
  return normalizeTruncatedArguments(entry.slice(entry.indexOf(':', key) + 1));
}

/** Normalize the salvaged arguments text to the OpenAI wire shape (a string). */
function normalizeTruncatedArguments(raw: string): string {
  if (/^[,[\]{}\s]*$/.test(raw)) return '{}';
  let s = raw.trim();
  // Every entry but the last carries the closers of its own object; the last
  // one may end mid-value. Drop one trailing structural byte at a time so a
  // complete object still round-trips, and keep the model's bytes when the
  // text never parses (a cut argument is not valid JSON, which is what OpenAI
  // reports too).
  for (;;) {
    try {
      const value: unknown = JSON.parse(s);
      if (typeof value !== 'string') return JSON.stringify(value);
      try {
        return JSON.stringify(JSON.parse(value));
      } catch {
        return value;
      }
    } catch {
      // Not parseable yet: maybe only structural bytes are left over.
    }
    if (!/[,\]}\s]$/.test(s)) return s;
    s = s.slice(0, -1).trimEnd();
  }
}

/**
 * Salvage tool calls from a protocol payload a limit cut mid-JSON.
 *
 * Returns the calls whose `"name"` survived, with the arguments text exactly
 * as the model generated it (possibly not valid JSON, which is what OpenAI
 * also reports when `max_tokens` cuts a call). Returns `[]` when the payload
 * carries no recoverable call, and `null` when `text` is not a truncated
 * protocol payload at all.
 */
export function tryParseTruncatedToolCall(text: string): ParsedToolCall[] | null {
  if (text.length > MAX_PARSE_LENGTH) return [];
  if (!isTruncatedToolCallPrefix(text)) return null;
  const trimmed = text.trim();
  // Complete JSON stays with the normal path: it either already converted to
  // tool_calls or it is a genuine answer that merely mentions the key.
  try {
    JSON.parse(trimmed);
    return null;
  } catch {
    // Truncated payload: salvage what the model emitted before the cut.
  }
  const out: ParsedToolCall[] = [];
  for (const entry of splitTruncatedEntries(trimmed.slice(trimmed.indexOf('[') + 1))) {
    const name = truncatedEntryName(entry);
    if (name === null || name === '') continue;
    out.push({ name, arguments: truncatedEntryArguments(entry) });
  }
  return out;
}

const CALL_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Generate a `call_` id with 22 random [a-zA-Z0-9] chars. */
export function generateCallId(): string {
  let id = 'call_';
  const buf = new Uint32Array(22);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 22; i++) id += CALL_ID_ALPHABET[buf[i] % CALL_ID_ALPHABET.length];
  return id;
}

/** Convert parsed tool calls into OpenAI-compatible assistant.tool_calls entries. */
export function toOpenAIToolCalls(parsed: ParsedToolCall[]): Array<{
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}> {
  return parsed.map((p) => ({
    id: generateCallId(),
    type: 'function' as const,
    function: { name: p.name, arguments: p.arguments },
  }));
}

/** Extract plain text from a generic message content (string or parts). */
function contentToText(content: GenericMessage['content']): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const p of content) {
    if (p && (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string') {
      parts.push(p.text);
    }
  }
  return parts.join('\n');
}

/** Strip our tool-call protocol prefix from a user-provided tool name. */
function toolResultName(name: string | undefined, toolCallId: string | undefined): string {
  if (name) return name;
  if (toolCallId) return toolCallId.replace(/^call_/, '');
  return 'tool';
}

/** Map one generic message to the upstream conversation DTO shape. */
export function buildUpstreamMessages(messages: GenericMessage[]): UpstreamMessage[] {
  return messages.map((m): UpstreamMessage => {
    switch (m.role) {
      case 'system':
        return {
          author: { role: 'system' },
          content: { content_type: 'text', parts: [contentToText(m.content)] },
        };
      case 'tool':
        return {
          author: { role: 'tool', name: toolResultName(m.name, m.tool_call_id) },
          content: { content_type: 'text', parts: [contentToText(m.content)] },
        };
      case 'assistant': {
        if (m.tool_calls && m.tool_calls.length > 0) {
          const payload = JSON.stringify({
            tool_calls: m.tool_calls.map((tc) => {
              let args: unknown = {};
              const s = (tc.arguments ?? '').trim();
              if (s) {
                try {
                  args = JSON.parse(s);
                } catch {
                  args = s;
                }
              }
              return { name: tc.name, arguments: args };
            }),
          });
          // OpenAI lets one assistant turn carry prose AND calls ("looking that
          // up…" + the call). That prose is history the model must still read on
          // later turns; serializing only the payload had the model deny words it
          // had already said, with a 200 hiding the loss. The payload stays the
          // last part and byte-identical, so the protocol line the model imitates
          // never gains prose around the JSON.
          const text = contentToText(m.content);
          return {
            author: { role: 'assistant' },
            content: {
              content_type: 'text',
              parts: text === '' ? [payload] : [text, payload],
            },
          };
        }
        return {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: [contentToText(m.content)] },
        };
      }
      case 'user':
      default:
        return {
          author: { role: 'user' },
          content: { content_type: 'text', parts: [contentToText(m.content)] },
        };
    }
  });
}

/** Convenience: build a tool-result upstream message. */
export function buildToolResultMessage(toolName: string, resultText: string): UpstreamMessage {
  return {
    author: { role: 'tool', name: toolName },
    content: { content_type: 'text', parts: [resultText] },
  };
}

const GENUI_MARKER_START = '\ue200';
const GENUI_MARKER_END = '\ue201';

/** Remove \ue200..\ue201-wrapped genui fragments (markers included). */
export function stripGenuiMarkers(text: string): string {
  return text
    .replace(new RegExp(`${GENUI_MARKER_START}[^${GENUI_MARKER_END}]*${GENUI_MARKER_END}`, 'g'), '')
    .replace(new RegExp(`[${GENUI_MARKER_START}${GENUI_MARKER_END}]`, 'g'), '');
}
