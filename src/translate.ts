import type {
  OpenAIMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from './types';

/**
 * Extracts plain text from an OpenAI content field, whether it is a string
 * or an array of content parts. Non-text parts are ignored.
 */
export function extractMessageText(
  content: string | Array<{ type: string; text?: string }>
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part) =>
          part &&
          (part.type === 'text' || part.type === 'input_text') &&
          typeof part.text === 'string'
      )
      .map((part) => part.text)
      .join('');
  }
  return '';
}

/**
 * flattenMessages concatenates the message history into one prompt text.
 * - If single user message, return verbatim
 * - If multi-turn, format System:\n..., User:\n..., Assistant:\n... joined by \n\n
 */
export function flattenMessages(messages: OpenAIMessage[]): string {
  if (!messages || messages.length === 0) {
    return '';
  }

  // If single user message, return verbatim
  if (messages.length === 1 && messages[0].role === 'user') {
    return extractMessageText(messages[0].content);
  }

  const blocks: string[] = [];
  for (const m of messages) {
    const text = extractMessageText(m.content);
    if (!text) {
      continue;
    }
    const roleName = m.role ? m.role.charAt(0).toUpperCase() + m.role.slice(1).toLowerCase() : '';
    blocks.push(`${roleName}:\n${text}`);
  }

  return blocks.join('\n\n');
}

/**
 * buildAnonRequest constructs the upstream conversation DTO payload.
 */
export interface AnonRequestOptions {
  /**
   * Web-search toggle. Anonymous upstream accepts a 3-state forceUseSearch
   * (Auto/ForceSearch/ForceNoSearch -> null/true/false). Per project policy
   * search is ON by default; set search=false to disable.
   */
  search?: boolean;
  /** Thinking/reasoning effort, verbatim upstream `thinkingEffort`. */
  thinkingEffort?: string;
  /** Upstream `serviceTier` (priority tier). */
  serviceTier?: string;
  /** Upstream `oneOffModelOverride` (single-request model override). */
  oneOffModelOverride?: string;
  /** Upstream `systemHints` (system-prompt id list). */
  systemHints?: string[];
  /** Upstream `localFunctionNames` (client tool names, e.g. ["search"]). */
  localFunctionNames?: string[];
  /** Upstream `mapSearchParams` (map area-search params). */
  mapSearchParams?: {
    latitude?: number;
    longitude?: number;
    latitudeSpan?: number;
    longitudeSpan?: number;
    mapMessageId?: string;
  };
  /**
   * Prebuilt upstream content for the single user message (e.g. multimodal
   * text with image asset pointers from src/image_parts). When omitted the
   * default text content `{ content_type: 'text', parts: [prompt] }` is used.
   */
  messageContent?: Record<string, any>;
  /**
   * Upstream `attachmentMimeTypes` (MIME types of the attached files).
   * Only included when provided and non-empty.
   */
  attachmentMimeTypes?: string[];
}

export function buildAnonRequest(
  model: string,
  prompt: string,
  options?: AnonRequestOptions
): Record<string, any> {
  // Optional multimodal content: when provided it replaces the default text
  // content of the single upstream user message.
  const userContent = options?.messageContent ?? {
    content_type: 'text',
    parts: [prompt],
  };
  const body: Record<string, any> = {
    action: 'next',
    messages: [
      {
        author: { role: 'user' },
        content: userContent,
      },
    ],
    parentMessageId: null,
    conversationId: null,
    model: model || 'auto',
    historyAndTrainingDisabled: false,
    conversationMode: { kind: 'primary_assistant' },
    forceUseSearch: options?.search !== false,
    forceUseSse: true,
    supportedEncodings: ['text/plain'],
    timezone: 'UTC',
    timezoneOffsetMin: 0,
    noAuthAdPreferences: true,
  };

  // Optional upstream passthroughs: only included when provided, so the
  // default wire shape stays identical to the pre-existing minimal body.
  if (typeof options?.thinkingEffort === 'string' && options.thinkingEffort.trim() !== '') {
    body.thinkingEffort = options.thinkingEffort;
  }
  if (typeof options?.serviceTier === 'string' && options.serviceTier.trim() !== '') {
    body.serviceTier = options.serviceTier;
  }
  if (typeof options?.oneOffModelOverride === 'string' && options.oneOffModelOverride.trim() !== '') {
    body.oneOffModelOverride = options.oneOffModelOverride;
  }
  if (Array.isArray(options?.systemHints) && options.systemHints.length > 0) {
    body.systemHints = options.systemHints;
  }
  if (Array.isArray(options?.localFunctionNames) && options.localFunctionNames.length > 0) {
    body.localFunctionNames = options.localFunctionNames;
  }
  if (options?.mapSearchParams && typeof options.mapSearchParams === 'object') {
    body.mapSearchParams = options.mapSearchParams;
  }
  if (Array.isArray(options?.attachmentMimeTypes) && options.attachmentMimeTypes.length > 0) {
    body.attachmentMimeTypes = options.attachmentMimeTypes;
  }

  return body;
}

/**
 * buildOpenAIChunk creates a standard streaming chunk.
 */
export function buildOpenAIChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, any>,
  finishReason: string | null = null
): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: delta as any,
        finish_reason: finishReason ? (finishReason as 'stop' | 'length') : null,
      },
    ],
  };
}

/**
 * buildFinalChunk marks the end of an OpenAI stream with choices[0].finish_reason = "stop".
 * If promptTokens and completionTokens are supplied (> 0), includes token usage metrics.
 */
export function buildFinalChunk(
  id: string,
  created: number,
  model: string,
  promptTokens?: number,
  completionTokens?: number
): ChatCompletionChunk {
  const pTokens = promptTokens ?? 0;
  const cTokens = completionTokens ?? 0;
  const chunk: ChatCompletionChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
  };
  if (pTokens > 0 || cTokens > 0) {
    chunk.usage = {
      prompt_tokens: pTokens,
      completion_tokens: cTokens,
      total_tokens: pTokens + cTokens,
    };
  }
  return chunk;
}

/**
 * buildUsageChunk builds the standard OpenAI specification usage chunk (choices: [], usage: {...})
 * emitted when stream_options.include_usage is true.
 */
export function buildUsageChunk(
  id: string,
  created: number,
  model: string,
  promptTokens: number,
  completionTokens: number
): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * buildOpenAICompletion builds a non-streaming chat.completion response.
 */
export function buildOpenAICompletion(
  id: string,
  created: number,
  model: string,
  text: string,
  promptTokens: number,
  completionTokens: number,
  finishReason: 'stop' | 'length' | null = 'stop'
): ChatCompletionResponse {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: finishReason ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * countRoughTokens approximates token usage:
 * - English/ASCII text: ~chars / 4
 * - CJK ideographs/Kana/Hangul: ~1.5 tokens per character (matching tiktoken cl100k)
 */
export function countRoughTokens(s: string): number {
  if (!s) {
    return 0;
  }
  const cjkMatches = s.match(/[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkLength = s.length - cjkCount;
  const cjkTokens = Math.ceil(cjkCount * 1.5);
  const asciiTokens = Math.floor(nonCjkLength / 4);
  return cjkTokens + asciiTokens;
}

/**
 * genID mints IDs in the OpenAI shape (e.g. "chatcmpl-a1b2...") using crypto.getRandomValues.
 */
export function genID(prefix: string = 'chatcmpl-'): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `${prefix}${hex}`;
}

/**
 * wantsStreamUsage checks whether stream_options.include_usage was requested.
 */
export function wantsStreamUsage(
  req: ChatCompletionRequest | string | null | undefined
): boolean {
  if (!req) {
    return false;
  }
  if (typeof req === 'string') {
    try {
      req = JSON.parse(req) as ChatCompletionRequest;
    } catch {
      return false;
    }
  }
  return Boolean(req?.stream_options?.include_usage);
}
