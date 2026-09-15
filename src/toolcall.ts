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
 * Build the system message that teaches the model the tool protocol.
 *
 * Empirically (2026-09-15, anonymous backend replicas), adherence depends on
 * three factors baked into the wording:
 *  1. tools are framed as REAL, CALLABLE system-provided tools (otherwise the
 *     model answers "unable to access the tool");
 *  2. an explicit "you do not know this from training - MUST call, never
 *     guess" clause (otherwise the model hallucinates plausible answers);
 *  3. a concrete single-line JSON template shown once per request.
 */
export function buildToolProtocolSystemMessage(tools: ToolDefinition[]): string {
  const toolLines: string[] = [];
  for (const t of tools) {
    const f = t.function;
    const schema = f.parameters ? JSON.stringify(f.parameters) : '{}';
    const params = schema === '{}' ? 'no arguments' : schema;
    toolLines.push(`- ${f.name}(${params})${f.description ? ` -> ${f.description}` : ''}`);
  }

  const lines: string[] = [
    'You have access to REAL, CALLABLE tools provided by the system (not hypothetical).',
    '',
    'Available tools:',
    ...toolLines,
    '',
    'Tool call protocol (STRICT):',
    'When a tool call is needed, your ENTIRE reply must be exactly one line of raw JSON and nothing else:',
    TOOL_CALL_REPLY_FORMAT,
    '',
    'Rules:',
    '- No markdown code fences, no explanation, no text before or after. The reply is parsed by a machine.',
    '- "arguments" must be a valid JSON object matching the tool parameter schema.',
    '- Multiple entries in "tool_calls" are allowed to call several tools at once.',
    '- ONLY when you already have all the information needed to fully answer, reply in plain text instead.',
    '- You do NOT have this data from training - you MUST call the tools to get it. Never guess or invent results.',
  ];
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
    const name = typeof c.name === 'string' ? c.name : c?.function?.name;
    if (typeof name !== 'string' || name.length === 0) return null;
    let args = c.arguments !== undefined ? c.arguments : c?.function?.arguments;
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
          return {
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: [payload] },
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
