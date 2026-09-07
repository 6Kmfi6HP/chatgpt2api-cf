export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string }>;
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
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string;
  };
  finish_reason: 'stop' | 'length' | null;
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
  };
  finish_reason: 'stop' | 'length' | null;
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
