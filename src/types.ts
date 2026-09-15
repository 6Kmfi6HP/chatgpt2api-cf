export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }> | null;
  /** Tool executor name for role="tool" messages. */
  name?: string;
  /** Assistant tool-call requests (mirrors OpenAI wire format). */
  tool_calls?: OpenAIToolCall[];
  /** Matches the assistant tool_calls[].id this message answers. */
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  temperature?: number;
  max_tokens?: number;
  /**
   * Web-search toggle. Default true (search ON). Set to false to disable
   * upstream web search for this request (forceUseSearch=false).
   */
  search?: boolean;
  /**
   * Thinking/reasoning effort (GPT-5.x). Passed through verbatim to the
   * upstream `thinkingEffort` field. Values follow the upstream model
   * (e.g. "low" | "medium" | "high"); omit to leave the upstream default.
   */
  reasoning_effort?: string;
  /**
   * Upstream service tier / priority. Passed through verbatim to
   * `serviceTier`. Omit to use the upstream default tier.
   */
  service_tier?: string;
  /**
   * One-off model override for a single request. Passed through verbatim
   * to `oneOffModelOverride` (takes precedence over `model` upstream when
   * the server honours it). Omit to use `model`.
   */
  one_off_model_override?: string;
  /**
   * System-hint ids applied to this conversation. Passed through verbatim
   * to `systemHints`. Ids come from the upstream `prompt_library/system_hints`
   * catalog. Omit to leave the default.
   */
  system_hints?: string[];
  /**
   * Client-side tool/function names. Passed through verbatim to
   * `localFunctionNames`. The Android app sends `["search"]` alongside
   * force search; set to `["search"]` to mirror that, or omit.
   */
  local_function_names?: string[];
  /**
   * Map area-search parameters. Passed through verbatim to `mapSearchParams`
   * (`{latitude, longitude, latitudeSpan, longitudeSpan, mapMessageId}`).
   * Omit unless doing a map "search this area" request.
   */
  map_search_params?: {
    latitude?: number;
    longitude?: number;
    latitudeSpan?: number;
    longitudeSpan?: number;
    mapMessageId?: string;
  };
  /**
   * OpenAI function tool definitions. The gateway compiles them into the
   * upstream system protocol; when the model emits a tool call the response
   * carries assistant `tool_calls` with `finish_reason: "tool_calls"`.
   */
  tools?: OpenAIToolDefinition[];
  /**
   * Accepted for OpenAI compatibility: "auto" | "none" | named function.
   * "none" disables tool-calling for the request; other values behave as
   * "auto" (upstream has no native tool-choice knob).
   */
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string;
    tool_calls?: Array<OpenAIToolCall & { index?: number }>;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface SearchSource {
  url: string;
  title: string;
  attribution: string;
}

export interface DeviceIdentity {
  id: string; // UUIDv4
  sentinelToken?: string;
  sentinelExpiry?: number; // Unix timestamp in seconds
  cooldownUntil?: number; // Unix timestamp in milliseconds
  failureCount?: number;
  lastUsedAt?: number; // Unix timestamp in milliseconds for round-robin rotation
}

export interface DevicePoolState {
  devices: DeviceIdentity[];
  lastUpdated: number;
}

export interface Env {
  CHATGPT_KV: KVNamespace;
  API_KEYS?: string; // Comma separated allowed api keys (empty = public)
  DEVICE_POOL_SIZE?: string; // Default "3"
}
