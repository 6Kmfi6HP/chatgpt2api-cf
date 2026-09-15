/**
 * Tool-call "request wiring" layer for the anonymous ChatGPT upstream.
 *
 * The /f/conversation DTO has no `tools` field (E-007), so the tool protocol
 * is compiled into a system message (src/toolcall.ts) and prepended to the
 * upstream messages array. This module bridges an extended OpenAI
 * chat-completions request to that DTO and translates tool-call replies back
 * into OpenAI assistant messages on the wire.
 */

import {
  buildToolProtocolSystemMessage,
  buildUpstreamMessages,
  stripGenuiMarkers,
  toOpenAIToolCalls,
  tryParseToolCall,
} from './toolcall';
import type { GenericMessage, ToolDefinition, UpstreamMessage } from './toolcall';
import { buildAnonRequest } from './translate';

/** OpenAI chat-completions request extended with the tool-calling fields. */
export interface WireToolCallRequest {
  model: string;
  messages: any[];
  stream?: boolean;
  /** Web-search toggle. Upstream forceUseSearch defaults to ON. */
  search?: boolean;
  /** Upstream `thinkingEffort`. */
  reasoning_effort?: string;
  /** Upstream `serviceTier`. */
  service_tier?: string;
  /** Upstream `oneOffModelOverride`. */
  one_off_model_override?: string;
  /** Upstream `systemHints`. */
  system_hints?: string[];
  /** Upstream `localFunctionNames`. */
  local_function_names?: string[];
  /** Upstream `mapSearchParams`. */
  map_search_params?: any;
  /**
   * Function tools. Accepts the OpenAI standard form
   * ({type:'function', function:{name,description,parameters}}) and the
   * shorthand form ({type:'function', name, description, parameters}).
   */
  tools?: Array<{
    type: 'function';
    function?: { name: string; description?: string; parameters?: Record<string, any> };
    name?: string;
    description?: string;
    parameters?: Record<string, any>;
  }>;
  tool_choice?: any;
}

/**
 * Normalize the request's `tools` array into the canonical ToolDefinition
 * shape ({type:'function', function:{name,description,parameters}}),
 * accepting the OpenAI standard form and the top-level shorthand
 * ({type:'function', name, description, parameters}).
 * Entries without a usable name are skipped.
 */
export function normalizeToolDefinitions(req: WireToolCallRequest): ToolDefinition[] {
  const tools = req?.tools;
  if (!Array.isArray(tools)) return [];
  const out: ToolDefinition[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const fn = t.function;
    const name =
      typeof fn?.name === 'string' && fn.name !== ''
        ? fn.name
        : typeof t.name === 'string'
          ? t.name
          : undefined;
    if (!name) continue;
    const description =
      typeof fn?.description === 'string'
        ? fn.description
        : typeof t.description === 'string'
          ? t.description
          : undefined;
    const parameters = fn?.parameters ?? t.parameters;
    out.push({
      type: 'function',
      function: {
        name,
        ...(description !== undefined ? { description } : {}),
        ...(parameters && typeof parameters === 'object' ? { parameters } : {}),
      },
    });
  }
  return out;
}

/**
 * Map raw request messages into the GenericMessage shape toolcall.ts expects.
 * OpenAI-style assistant tool_calls ({id,type,function:{name,arguments}}) are
 * normalized into the {name,arguments} form its serializer understands.
 */
function toGenericMessages(messages: any[]): GenericMessage[] {
  const out: GenericMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role =
      m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool'
        ? m.role
        : 'user';
    const g: GenericMessage = { role, content: m.content ?? '' };
    if (typeof m.name === 'string') g.name = m.name;
    if (typeof m.tool_call_id === 'string') g.tool_call_id = m.tool_call_id;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      g.tool_calls = m.tool_calls
        .filter((tc: any) => tc && typeof tc === 'object')
        .map((tc: any) => ({
          name:
            typeof tc.name === 'string'
              ? tc.name
              : typeof tc.function?.name === 'string'
                ? tc.function.name
                : '',
          arguments:
            typeof tc.arguments === 'string'
              ? tc.arguments
              : typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : '',
        }));
    }
    out.push(g);
  }
  return out;
}

/** Build the tool protocol system message as an upstream frame. */
function toolProtocolFrame(tools: ToolDefinition[]): UpstreamMessage {
  return {
    author: { role: 'system' },
    content: { content_type: 'text', parts: [buildToolProtocolSystemMessage(tools)] },
  };
}

/**
 * Build the full anonymous upstream DTO for a request that carries tools.
 *
 * - The conversation comes from req.messages via buildUpstreamMessages
 *   (system messages are preserved; tool results keep author.name). The tool
 *   protocol system message, when tools are present, is inserted at index 0.
 * - `prompt` is only the placeholder for buildAnonRequest's default user
 *   message; it is overridden by req.messages whenever any are provided.
 * - When opts.messageContent is set (multimodal), it replaces the content of
 *   the last user message (falling back to the placeholder user message).
 * - search/reasoning_effort/service_tier/one_off_model_override/system_hints/
 *   local_function_names/map_search_params and opts.attachmentMimeTypes are
 *   passed through to buildAnonRequest options verbatim.
 */
export function buildAnonRequestBodyWithTools(
  req: WireToolCallRequest,
  opts: { prompt: string; messageContent?: Record<string, any>; attachmentMimeTypes?: string[] }
): Record<string, any> {
  const tools = normalizeToolDefinitions(req);

  const dto = buildAnonRequest(req?.model ?? '', opts.prompt, {
    search: req?.search,
    thinkingEffort: req?.reasoning_effort,
    serviceTier: req?.service_tier,
    oneOffModelOverride: req?.one_off_model_override,
    systemHints: req?.system_hints,
    localFunctionNames: req?.local_function_names,
    mapSearchParams: req?.map_search_params,
    attachmentMimeTypes: opts.attachmentMimeTypes,
  });

  const rawMessages = Array.isArray(req?.messages) ? req.messages : [];
  let messages: UpstreamMessage[] = buildUpstreamMessages(toGenericMessages(rawMessages));
  if (messages.length === 0) {
    // No caller messages: keep buildAnonRequest's prompt-placeholder user message.
    messages = dto.messages as UpstreamMessage[];
  }
  if (tools.length > 0) {
    messages = [toolProtocolFrame(tools), ...messages];
  }

  if (opts.messageContent && typeof opts.messageContent === 'object') {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].author?.role === 'user') {
        messages[i] = {
          ...messages[i],
          content: opts.messageContent as UpstreamMessage['content'],
        };
        break;
      }
    }
  }

  dto.messages = messages;
  return dto;
}

/** Convenience: true when the reply parses as our tool-call convention. */
export function isToolCallResponseText(text: string): boolean {
  return tryParseToolCall(stripGenuiMarkers(text)) !== null;
}

/**
 * Convert a complete (non-streaming) model reply into an OpenAI assistant
 * message carrying tool_calls (content=null), or null when the reply is
 * plain text.
 */
export function buildToolCallsChatMessage(
  text: string
): {
  role: 'assistant';
  content: string | null;
  tool_calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
} | null {
  const parsed = tryParseToolCall(stripGenuiMarkers(text));
  if (!parsed) return null;
  return { role: 'assistant', content: null, tool_calls: toOpenAIToolCalls(parsed) };
}

/** Extract the tool name from an upstream message frame (role=tool only). */
export function extractToolNameFromUpstreamMessage(msg: any): string | null {
  if (!msg || typeof msg !== 'object') return null;
  const author = msg.author;
  if (!author || typeof author !== 'object') return null;
  if (author.role !== 'tool') return null;
  return typeof author.name === 'string' && author.name !== '' ? author.name : null;
}
