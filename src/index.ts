import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, ChatCompletionRequest, ChatCompletionResponse } from './types';
import { UpstreamClient, StatusError } from './client';
import {
  deviceManager as defaultDeviceManager,
  DeviceManager,
  resolveMaxDeviceUses,
} from './device';
import { flattenMessages, lastUserMessageText, SEARCH_SYSTEM_PROMPT } from './translate';
import {
  buildAnonRequestBodyWithTools,
  normalizeToolDefinitions,
  shouldInjectSearchPrompt,
} from './toolcall_wire';
import { getModelCatalog } from './catalog';
import {
  pipeOpenAIStream,
  aggregateNonStreamWithSignals,
  StreamProcessor,
  TURN_METADATA_GRACE_MS,
  READ_TIMEOUT,
  type UpstreamTurnSignals,
} from './stream';
import { createParser } from 'eventsource-parser';
import {
  collectImageRefs,
  isUsableImagePart,
  resolveImage,
  buildMultimodalContent,
  type ResolvedImage,
} from './image_parts';
import { uploadImage, sniffImageMime, defaultExtensionForMime } from './upload';
import {
  booleanControlParamError,
  responseShapeParamError,
  samplingParamError,
  type ParamError,
} from './sampling';

export interface AppOptions {
  client?: UpstreamClient;
  deviceManager?: DeviceManager;
  /**
   * Override the non-streaming commit deadline (ms) — test seam. Production
   * uses NONSTREAM_COMMIT_DEADLINE_MS.
   */
  nonStreamCommitDeadlineMs?: number;
  /**
   * Override the SSE keepalive / heartbeat interval (ms) — test seam.
   * Production uses SSE_PING_INTERVAL_MS.
   */
  keepAliveIntervalMs?: number;
}



/** Refusal patterns anonymous models emit instead of a tool call. */
const REFUSAL_PATTERNS = [
  /unable to (access|use|invoke|retrieve|determine)/i,
  /can'?t (access|use|invoke|determine|retrieve)/i,
  /cannot (access|use|invoke|determine|retrieve)/i,
  /don'?t have (access|the)/i,
  /tool .{0,24}(available|accessible)/i,
  /no access to/i,
  /can'?t determine that from/i,
  /from (public web|public) results/i,
];

/** True when a reply looks like a tool refusal rather than a real answer. */
export function looksLikeRefusal(text: string): boolean {
  if (!text) return false;
  return REFUSAL_PATTERNS.some((p) => p.test(text));
}

/**
 * True when the request demands a tool call: tool_choice "required" or a named
 * function. The upstream DTO has no native knob, so this only strengthens the
 * compiled protocol wording — these are strong hints, not guarantees, which is
 * exactly why a plain-text reply under them is retried below.
 */
export function requiresToolCall(req: ChatCompletionRequest): boolean {
  const choice = req?.tool_choice;
  if (choice === 'required') return true;
  if (choice && typeof choice === 'object') {
    const name = choice.function?.name;
    return typeof name === 'string' && name !== '';
  }
  return false;
}

/**
 * Message roles the gateway understands. `developer` is OpenAI's replacement
 * for `system` and is compiled to a system frame, since the upstream protocol
 * has only the one system channel.
 */
const KNOWN_MESSAGE_ROLES: Record<string, true> = {
  system: true,
  developer: true,
  user: true,
  assistant: true,
  tool: true,
};

/**
 * Returns a human-readable problem with one message's `tool_calls`, or null.
 *
 * `toGenericMessages` filters non-objects and blanks an unknown name or a
 * non-string `arguments`, so a malformed tool-call frame used to reach the
 * upstream with the call missing or anonymous while the caller got HTTP 200.
 * In an agent loop that is silent history corruption: the model answers from a
 * trajectory that no longer holds what the caller said it did. A shape the
 * gateway cannot forward is therefore rejected, as with `tools` (#39).
 *
 * Absent/null/empty `tool_calls` stay legal; `id` stays optional because the
 * wire layer links a tool result by id OR name, but a present id must be
 * usable, and `arguments` must be the JSON string the OpenAI wire defines
 * (the shorthand `name`/`arguments` positions are accepted as they are
 * elsewhere in this file).
 */
function toolCallsShapeError(toolCalls: unknown, path: string): string | null {
  if (toolCalls === undefined || toolCalls === null) return null;
  if (!Array.isArray(toolCalls)) {
    return `${path}.tool_calls must be an array of tool-call objects`;
  }
  for (let j = 0; j < toolCalls.length; j++) {
    const entry: unknown = toolCalls[j];
    const callPath = `${path}.tool_calls[${j}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return `${callPath} must be an object`;
    }
    const call = entry as Record<string, unknown>;
    if (call.type !== undefined && call.type !== 'function') {
      return `${callPath}.type must be "function"`;
    }
    if (call.id !== undefined && (typeof call.id !== 'string' || call.id === '')) {
      return `${callPath}.id must be a non-empty string`;
    }
    const fn = call.function;
    if (fn !== undefined && (fn === null || typeof fn !== 'object' || Array.isArray(fn))) {
      return `${callPath}.function must be an object`;
    }
    const fnObj = (fn ?? {}) as Record<string, unknown>;
    const name = fnObj.name !== undefined ? fnObj.name : call.name;
    if (typeof name !== 'string' || name === '') {
      return `${callPath} must carry a non-empty function name in 'function.name' (or 'name')`;
    }
    const args = fnObj.arguments !== undefined ? fnObj.arguments : call.arguments;
    if (args !== undefined && args !== null && typeof args !== 'string') {
      return `${callPath} must carry 'function.arguments' as a JSON string (or 'arguments')`;
    }
  }
  return null;
}

/**
 * Returns a human-readable problem with the `messages` array, or null when
 * every entry has a shape the OpenAI wire accepts.
 *
 * Why the handler must check this itself: the DTO builders read
 * `message.role` (`flattenMessages`) and iterate `content`
 * (`contentToText` in toolcall.ts, reached by every request through
 * buildAnonRequestBodyWithTools). A number in either position throws a
 * TypeError, which is not a StatusError, so `app.onError` reports it as a 500
 * `api_error` — a caller-side bug disguised as a gateway fault, with SDK
 * retry/alert loops and internal stack text in the response.
 *
 * The role VALUE is checked, not just its type. Every downstream builder
 * coerces an unrecognised role rather than refusing it (`toGenericMessages`
 * falls back to `user`, `buildUpstreamMessages` defaults to `user`), so a
 * single-case-different `"Tool"` slipped past the orphan-tool guard in the
 * handler and had its payload replayed to the model as a user instruction
 * instead of a tool result. Rejecting here keeps the role a real trust
 * boundary and matches OpenAI, which answers an unknown role with 400.
 *
 * `tool_calls` is validated by the same argument: `toGenericMessages` silently
 * drops or blanks a call it cannot map, which corrupts the history the model
 * reads while the caller sees a success status.
 */
export function messageShapeError(messages: unknown[]): string | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const path = `messages[${i}]`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return `${path} must be an object`;
    }
    const { role, content, tool_calls: toolCalls } = m as {
      role?: unknown;
      content?: unknown;
      tool_calls?: unknown;
    };
    if (typeof role !== 'string') {
      return `${path}.role must be a string`;
    }
    if (!Object.prototype.hasOwnProperty.call(KNOWN_MESSAGE_ROLES, role)) {
      return `${path}.role "${role}" is not a valid role; expected one of "system", "developer", "user", "assistant", or "tool"`;
    }
    const toolCallsError = toolCallsShapeError(toolCalls, path);
    if (toolCallsError) {
      return toolCallsError;
    }
    // null and undefined are legal: assistant turns that only call tools carry
    // no text, and some clients omit content entirely.
    if (content === undefined || content === null || typeof content === 'string') {
      continue;
    }
    if (!Array.isArray(content)) {
      return `${path}.content must be a string, an array of content parts, or null`;
    }
    for (let p = 0; p < content.length; p++) {
      const part = content[p];
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        return `${path}.content[${p}] must be an object`;
      }
    }
  }
  return null;
}

/**
 * Content part types the gateway can forward upstream, and how each is turned
 * into an upstream frame: `text`/`input_text` become prompt text,
 * `image_url`/`input_image` become uploaded attachments. Anything else —
 * `input_audio`, `file`, `video_url`, or a future type — has no upstream
 * representation, so forwarding the rest of the request would answer a question
 * the user never finished asking.
 */
const FORWARDABLE_PART_KIND: Record<string, 'text' | 'image'> = {
  text: 'text',
  input_text: 'text',
  image_url: 'image',
  input_image: 'image',
};

/**
 * Validates the parts of every `messages[].content` array and rejects the two
 * shapes that used to be dropped silently on the way to the prompt.
 *
 * Why this exists: `extractMessageText` keeps only parts whose type is
 * `text`/`input_text` and `collectImageRefs` keeps only fetchable image URLs.
 * Everything else disappears while the request continues, so an `input_audio`
 * or `file` part reached the upstream as an empty prompt and the caller got a
 * 200 with an unrelated greeting and `usage.prompt_tokens: 0`. Data loss with
 * a success status is undetectable from the client side, hence a 400.
 *
 * Two rules, matching how `n`/`response_format` are handled next door:
 *  - a part the gateway cannot forward → `unsupported_parameter`, naming it;
 *  - a part it claims to support but cannot use (an `image_url` with no
 *    fetchable URL, a `text` with no string `text`) → `invalid_request_error`,
 *    since the caller's payload is malformed rather than merely unimplemented.
 *
 * Empty content that carries nothing at all is a separate failure, checked in
 * the handler once the prompt is assembled.
 */
export function contentPartError(messages: unknown[]): ParamError | null {
  for (let i = 0; i < messages.length; i++) {
    const frame: unknown = messages[i];
    const content = (frame as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (let p = 0; p < content.length; p++) {
      const raw: unknown = content[p];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        continue; // messageShapeError already reported the non-object part
      }
      // Every entry of an array is an object here; Record gives the unvalidated
      // fields a typed home instead of `any` at each read below.
      const part = raw as Record<string, unknown>;
      const path = `messages[${i}].content[${p}]`;
      const { type } = part;
      if (typeof type !== 'string' || type === '') {
        return { message: `${path}.type must be a string`, param: 'messages' };
      }
      const kind = FORWARDABLE_PART_KIND[type];
      if (!kind) {
        return {
          message: `Unsupported parameter: 'messages' contains a content part of type "${type}", which is not supported by this gateway`,
          param: 'messages',
          code: 'unsupported_parameter',
        };
      }
      if (kind === 'text') {
        if (typeof part.text !== 'string') {
          return { message: `${path}.text must be a string`, param: 'messages' };
        }
        continue;
      }
      // Image part: the upload path only resolves data:/http(s) URLs, so a part
      // it cannot resolve would silently contribute nothing to the request.
      if (!isUsableImagePart({ ...part, type })) {
        return { message: `${path}.image_url must carry a data: or http(s) URL`, param: 'messages' };
      }
    }
  }
  return null;
}

/**
 * Returns a human-readable problem with an assistant `tool_calls` entry that
 * the history never answers, or null when every declared call is answered
 * before the next non-tool frame.
 *
 * Why this is a 400 and not an answer: OpenAI rejects a turn whose tool calls
 * are still outstanding ("An assistant message with 'tool_calls' must be
 * followed by tool messages responding to each 'tool_call_id'"), because the
 * model has asked for a result it never received. The upstream has no such
 * rule, so an unanswered call was replayed as an assistant transcript frame and
 * the model narrated progress it could not have made — "I'm checking ticket
 * TCK-77 for its latest status." with `finish_reason: "stop"`, and `content:
 * null` when the assistant frame was last. An agent loop reads that 200 as a
 * finished turn: it records a false answer and stops calling the tool.
 *
 * The check walks the history once, collecting the ids announced by an
 * assistant frame and dropping each one when a `tool` frame with that
 * `tool_call_id` arrives. A call still pending when the next non-tool frame
 * starts (or at end of history) can never be answered: upstream frames are
 * ordered and the model reads them in order.
 *
 * Scope, matching what the rest of the handler already promises:
 *  - only calls that carry a string id are tracked; an id-less entry is the
 *    tolerated shorthand form (see toolCallsShapeError) and stays a transcript
 *    line, because nothing could answer it anyway — the orphan guard needs an
 *    id to match;
 *  - the ORDER of results inside one batch is free (parallel callers may
 *    answer out of order);
 *  - an assistant frame may carry text and calls at once.
 */
export function unansweredToolCallError(messages: unknown[]): string | null {
  const describe = (at: number, id: string): string =>
    `messages[${at}].tool_calls contains id "${id}", which has no matching role "tool" message; an assistant tool call must be answered before the history continues, or the model is asked to answer a call whose result it never received`;
  /** Ids announced by the most recent assistant frame that nothing answered. */
  let pending: { at: number; ids: string[] } | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = (messages[i] ?? {}) as {
      role?: unknown;
      tool_calls?: unknown;
      tool_call_id?: unknown;
    };
    if (m.role === 'tool') {
      if (pending && typeof m.tool_call_id === 'string') {
        pending.ids = pending.ids.filter((id) => id !== m.tool_call_id);
      }
      continue;
    }
    // Any non-tool frame closes the window in which the pending calls could be
    // answered. Report the first one: the client has to fix that call before
    // the rest of the history can mean anything.
    if (pending && pending.ids.length > 0) {
      return describe(pending.at, pending.ids[0]);
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const ids: string[] = [];
      for (const tc of m.tool_calls) {
        const id = (tc as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && id !== '') ids.push(id);
      }
      pending = ids.length > 0 ? { at: i, ids } : null;
      continue;
    }
    pending = null;
  }
  if (pending && pending.ids.length > 0) {
    return describe(pending.at, pending.ids[0]);
  }
  return null;
}

/**
 * The tool name demanded by tool_choice, or null when the choice does not name
 * a specific function.
 */
export function requiredToolName(req: ChatCompletionRequest): string | null {
  const choice = req?.tool_choice;
  if (choice && typeof choice === 'object') {
    const name = choice.function?.name;
    if (typeof name === 'string' && name !== '') return name;
  }
  return null;
}

/**
 * True when the turn must be answered from the tool result the caller just
 * supplied (the last message is a tool result) and the caller did not opt
 * into web search. The upstream model treats the search toggle as advisory
 * and may still search — overriding the tool result with web data.
 */
export function mustAnswerFromToolResult(req: ChatCompletionRequest): boolean {
  const msgs = req?.messages;
  return Array.isArray(msgs) && msgs.length > 0 && msgs[msgs.length - 1]?.role === 'tool' && req.search !== true;
}

/**
 * Validates the request's `tools` array, returning the OpenAI-shaped error or
 * null when every entry can be compiled into the upstream tool protocol.
 *
 * Why this exists: `normalizeToolDefinitions` skips entries it cannot name, and
 * an empty result switches the whole tool path off (`hasTools` false, no
 * protocol system message). A caller that mistyped one entry — a bare
 * `{"type":"function"}` with no nested `function`, a `null` in the list, or a
 * `tools` value that is not an array at all — therefore got an ordinary
 * plain-chat 200 with no `tool_calls` and no error, which an agent loop cannot
 * tell apart from "the model chose not to call a tool". Capability silently
 * disappeared.
 *
 * Two rules, matching `contentPartError` next door:
 *  - a shape the gateway cannot represent at all (non-array `tools`, a
 *    non-`function` type, an unnameable entry) → `invalid_request_error`,
 *    naming the offending index so the client can fix its payload;
 *  - `parameters` may be absent or null (a tool with no arguments), but a
 *    non-object schema would be dropped from the protocol text → 400 as well.
 *
 * A well-formed list is left untouched: this only rejects, it never rewrites.
 */
export function toolsParamError(tools: unknown): ParamError | null {
  if (tools === undefined || tools === null) return null;
  if (!Array.isArray(tools)) {
    return {
      message: "Invalid parameter: 'tools' must be an array of tool definitions.",
      param: 'tools',
    };
  }
  for (let i = 0; i < tools.length; i++) {
    const entry: unknown = tools[i];
    const path = `tools[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        message: `Invalid parameter: ${path} must be an object.`,
        param: 'tools',
      };
    }
    // Proven an object by the guard above; the cast only gives the unvalidated
    // fields a typed home instead of `any` at each read.
    const tool = entry as Record<string, unknown>;
    // Only `function` tools have an upstream representation: the protocol is a
    // JSON convention for named functions, so anything else could never be
    // called. An absent `type` is tolerated for clients that omit it.
    if (tool.type !== undefined && tool.type !== 'function') {
      return {
        message: `Invalid parameter: ${path}.type must be "function".`,
        param: 'tools',
      };
    }
    const fn = tool.function;
    if (fn !== undefined && (fn === null || typeof fn !== 'object' || Array.isArray(fn))) {
      return {
        message: `Invalid parameter: ${path}.function must be an object.`,
        param: 'tools',
      };
    }
    const fnObj = (fn ?? {}) as Record<string, unknown>;
    // Standard form reads the name from `function.name`, shorthand form from
    // the entry itself; either is accepted, an empty/absent one is not.
    const name = fnObj.name !== undefined ? fnObj.name : tool.name;
    if (typeof name !== 'string' || name === '') {
      return {
        message: `Invalid parameter: ${path} must carry a non-empty function name in 'function.name' (or 'name').`,
        param: 'tools',
      };
    }
    // A schema that is not an object is dropped by normalizeToolDefinitions, so
    // the model would be handed a tool with no argument contract at all.
    const parameters = fnObj.parameters !== undefined ? fnObj.parameters : tool.parameters;
    if (
      parameters !== undefined &&
      parameters !== null &&
      (typeof parameters !== 'object' || Array.isArray(parameters))
    ) {
      return {
        message: `Invalid parameter: ${path}.function.parameters must be a JSON Schema object.`,
        param: 'tools',
      };
    }
  }
  return null;
}

/**
 * Validates the deprecated `functions` / `function_call` pair, which the
 * gateway cannot compile into the upstream tool protocol (`tools` is the only
 * input `normalizeToolDefinitions` reads).
 *
 * Why this exists: a request carrying `functions` + `function_call` used to be
 * answered as an ordinary chat completion — 200 prose, `finish_reason: "stop"`,
 * no `tool_calls` and no `function_call`. That is the same silent-shape-loss
 * failure as #39 (`tools` entries dropped) and #32 (`response_format` ignored):
 * an agent loop that sent an explicit `function_call: {"name": X}` mandate sees
 * a legal reply and concludes the model simply chose not to call anything.
 *
 * Two honourable shapes stay accepted, because neither asks for a call:
 *  - no/empty `functions`, and
 *  - `function_call: "none"` (the caller explicitly forbids calling).
 * Everything else is `unsupported_parameter` on `functions`, pointing at
 * `tools`. `function_call` without a declared `functions` list is a payload
 * error (`invalid_request_error`) rather than an unimplemented feature.
 */
export function legacyFunctionsParamError(req: unknown): ParamError | null {
  // Read as unknown: the decoded body is untrusted JSON, so these fields can
  // hold any type even though the interface does not declare them.
  const raw = (req ?? {}) as { functions?: unknown; function_call?: unknown };
  const { functions, function_call: functionCall } = raw;

  let declared = false;
  if (functions !== undefined && functions !== null) {
    if (!Array.isArray(functions)) {
      return {
        message: "Invalid parameter: 'functions' must be an array of function definitions.",
        param: 'functions',
      };
    }
    declared = functions.length > 0;
  }

  if (!declared) {
    // A `function_call` with nothing to call is a typo: the caller meant to
    // send definitions and lost them, or reused a body from a different model.
    if (functionCall !== undefined && functionCall !== null && functionCall !== 'none') {
      return {
        message:
          "Invalid parameter: 'function_call' was provided but 'functions' declares no functions.",
        param: 'function_call',
      };
    }
    return null;
  }

  // The caller forbade calling: a plain chat completion is exactly that.
  if (functionCall === 'none') {
    return null;
  }

  return {
    message:
      "Unsupported parameter: 'functions'/'function_call' are not supported by this gateway; use 'tools'/'tool_choice' instead",
    param: 'functions',
    code: 'unsupported_parameter',
  };
}

/**
 * Validates `tool_choice` against the tools the request declares, returning an
 * OpenAI-shaped error message or null when the choice is legal.
 *
 * An unsatisfiable choice is the caller's bug. The upstream has no native
 * tool-choice knob, so "call the tool X" is compiled into protocol wording:
 * naming a function the request never declared produces an instruction the
 * model can never satisfy, so every reply is judged a contract violation and
 * the turn burns four upstream retries before degrading to a plain-text 200.
 * Rejecting up front is both cheaper and honest.
 */
export function toolChoiceError(req: ChatCompletionRequest): string | null {
  const choice = req?.tool_choice;
  if (choice === undefined || choice === null || choice === 'auto' || choice === 'none') {
    return null;
  }
  const declared = new Set(
    normalizeToolDefinitions({ model: '', messages: [], tools: req.tools }).map(
      (t) => t.function.name
    )
  );
  if (choice === 'required') {
    return declared.size > 0
      ? null
      : 'Invalid parameter: "tool_choice" is "required", but no named tools were provided in "tools".';
  }
  const name =
    typeof choice === 'object' && !Array.isArray(choice) && choice.type === 'function'
      ? choice.function?.name
      : undefined;
  if (typeof name !== 'string' || name === '') {
    return 'Invalid parameter: "tool_choice" must be "auto", "none", "required", or {"type":"function","function":{"name":"..."}}.';
  }
  return declared.has(name)
    ? null
    : `Invalid parameter: "tool_choice" names the function "${name}", which is not defined in "tools".`;
}

/**
 * True when a completion breaks the request's tool contract: the model neither
 * called a tool nor produced an acceptable plain answer. A refusal-looking
 * reply always qualifies; so does a reply with no visible text at all, which
 * is what upstream returns when its own web search yields nothing. Under a
 * mandatory tool_choice any tool-less reply qualifies, even fluent prose — and
 * a named tool_choice additionally requires the model to have called THAT
 * tool. A plain answer that ran its own web search instead of using the
 * supplied tool result qualifies too.
 */
export function violatesToolContract(
  req: ChatCompletionRequest,
  result: ChatCompletionResponse | null,
  usedWebSearch = false
): boolean {
  const choice = result?.choices?.[0];
  if (!choice) return false;
  const calls = choice.message?.tool_calls ?? [];
  if (calls.length > 0) {
    // A named tool_choice is enforced, not just suggested: calling some other
    // tool still breaks the contract the protocol frame demanded.
    const demanded = requiredToolName(req);
    if (demanded && !calls.some((c) => c.function?.name === demanded)) return true;
    return false;
  }
  const content = choice.message?.content ?? '';
  // An empty reply is not an answer. Upstream closes the turn with no text
  // when its own web search comes back with zero results, and the caller
  // cannot tell that apart from a deliberate empty answer — an agent loop
  // simply ends with no output and no error. Retrying on a fresh device is
  // the only recovery; the retry budget stays bounded as before.
  if (content.trim() === '') return true;
  if (looksLikeRefusal(content)) return true;
  if (usedWebSearch && mustAnswerFromToolResult(req)) return true;
  return requiresToolCall(req);
}

/**
 * Non-streaming commit deadline. A non-stream response body is only complete
 * once upstream generation ends, which can take 20s+ — longer than the default
 * read-idle timeout of some clients (Cursor ships 10s). Deferring the HTTP
 * commit that long is what makes them give up. After this deadline the handler
 * commits an early 200 with a chunked body and keeps it warm with whitespace
 * heartbeats (leading whitespace is legal before a JSON value and the final
 * body is still a single JSON.parse-able document).
 */
const NONSTREAM_COMMIT_DEADLINE_MS = 8000;

/**
 * SSE keepalive interval. Long upstream waits (especially tool-request
 * buffering before any decision) leave the socket byte-idle; `: ping` comment
 * lines are SSE comments that every spec-compliant parser ignores, so they
 * reset client read-idle timers without appearing in the data stream.
 */
const SSE_PING_INTERVAL_MS = 5000;

/** Whitespace heartbeat payload written between the early 200 commit and the JSON body. */
const NONSTREAM_HEARTBEAT = '\n';

/**
 * Tool-request refusal decision window. A refusal ("I'm unable to access the
 * weather tool") is legible in its opening clause, so the attempt commits as
 * soon as either trigger fires on non-refusal text:
 *
 *  - TOOL_REFUSAL_DECISION_CHARS of text, or
 *  - TOOL_REFUSAL_DECISION_MS held since the first unsent chunk.
 *
 * Buffering the whole reply (the previous behavior) destroyed the typing effect
 * for every client that sends `tools` — which is most of them. The byte trigger
 * alone was still too coarse because upstream delivers its opening snapshots in
 * a burst, so the time trigger bounds how long the client waits for the first
 * frame when the model starts slowly.
 */
const TOOL_REFUSAL_DECISION_CHARS = 80;
const TOOL_REFUSAL_DECISION_MS = 600;

/** OpenAI-shaped error payload (mirrors the global onError handler's mapping). */
export function openAIErrorBody(err: unknown): {
  status: number;
  error: { message: string; type: string; param: string | null; code: string | null };
} {
  const e = err as { message?: string; status?: number; bodySniff?: string; model?: string } | null;
  let status = 500;
  let type = 'api_error';
  let code: string | null = null;
  let param: string | null = null;
  let message = e?.message || 'Internal server error';

  if (err instanceof StatusError && err.status >= 400 && err.status < 600) {
    status = err.status;
    message = err.bodySniff || err.message;
    // Strip internal debug prefixes like "chatgpt-anon conversation: HTTP 429: "
    message = message.replace(/^chatgpt-anon\s+\w+:\s*HTTP\s+\d+:\s*/i, '').trim() || err.message;

    if (status === 429) {
      type = 'rate_limit_error';
      code = 'rate_limit_exceeded';
    } else if (status === 403) {
      type = 'permission_error';
      code = 'insufficient_quota';
    } else if (status === 401) {
      type = 'invalid_request_error';
      code = 'invalid_api_key';
    } else if (status >= 500) {
      type = 'server_error';
      code = 'internal_server_error';
    } else if (status === 400) {
      type = 'invalid_request_error';
      // The upstream signals an unusable model with an empty conduit_token;
      // it is the request's model field that is wrong, not the upstream.
      if (/empty conduit_token/.test(err.bodySniff || '')) {
        param = 'model';
        message = `The model '${e?.model || 'unknown'}' does not exist`;
      }
    }
  }

  return { status, error: { message, type, param, code } };
}

/** Observability response headers exposed to browser/CORS clients. */
export const OBSERVABILITY_HEADERS = [
  'x-device-id',
  'x-device-use-count',
  'x-device-max-uses',
  'x-search-enabled',
  'x-search-prompt-injected',
  'x-upstream-model',
  'x-used-web-search',
  'x-search-sources-count',
  'x-model-degraded',
];

interface RetryArgs {
  model: string;
  prompt: string;
  imageRefs: ReturnType<typeof collectImageRefs>;
  req: ChatCompletionRequest;
  client: UpstreamClient;
  dm: DeviceManager;
  signal?: AbortSignal;
}

interface StreamRetryCtx {
  env: Env;
  prompt: string;
  imageRefs: ReturnType<typeof collectImageRefs>;
  client: UpstreamClient;
  dm: DeviceManager;
  deviceId: string;
  hasTools: boolean;
}

type SSEWriter = Parameters<typeof pipeOpenAIStream>[1];

/** Emit an SSE comment carrying turn observability metadata right before [DONE]. */
async function emitStreamMeta(writer: SSEWriter, signals: UpstreamTurnSignals): Promise<void> {
  if (typeof writer.write === 'function') {
    const meta = {
      upstream_model: signals.upstreamModel || 'unknown',
      used_web_search: signals.usedWebSearch,
      search_sources: signals.sourcesCount,
      model_degraded: signals.modelDegraded,
    };
    await writer.write(`: meta ${JSON.stringify(meta)}\n\n`);
  }
}

/** Emit one OpenAI chunk (or "[DONE]") to an SSE writer. */
async function emitSSE(
  writer: SSEWriter,
  chunk: import('./types').ChatCompletionChunk | string
): Promise<void> {
  const data = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
  if (typeof writer.writeSSE === 'function') {
    await writer.writeSSE({ data });
  } else if (typeof writer.write === 'function') {
    await writer.write(`data: ${data}\n\n`);
  }
}

/**
 * Outcome of streaming one upstream attempt.
 *
 * `committed` means chunks have already gone to the client, so the attempt can
 * no longer be retried. When false, `chunks` holds everything produced so far
 * (nothing was emitted) and the caller may still retry on a fresh device.
 */
interface AttemptOutcome {
  chunks: import('./types').ChatCompletionChunk[];
  sp: StreamProcessor;
  aborted: boolean;
  committed: boolean;
}

/**
 * Streams one upstream attempt with a BOUNDED decision window.
 *
 * Why not buffer everything (the previous behavior): for any client that sends
 * `tools` — which is most of them — the whole reply was held until the socket
 * closed, so the first byte arrived seconds late and every content frame then
 * landed in one burst. The typing effect was destroyed even for plain prose
 * that could never have been a tool call.
 *
 * A refusal ("I'm unable to access the weather tool") is legible in its opening
 * sentence, and the tool-call detector already decides "this cannot be tool-call
 * JSON" from the first character. So the window is tiny:
 *
 *  - tool_calls deltas appear (detector resolved the JSON) → commit immediately
 *  - plain prose of >= TOOL_REFUSAL_DECISION_CHARS that is not a refusal, when
 *    the request does NOT mandate a tool call → commit immediately
 *  - otherwise hold: a refusal (retryable), a mandated-choice reply whose
 *    compliance is still unknown, or (holdOnWebSearch) a reply that ran its own
 *    web search instead of using the supplied tool result — upstream searches
 *    before writing any text, so this is known before the commit window
 *
 * Holding is bounded by the reply itself (refusals and tool-call JSON are
 * short); once committed, every later chunk streams straight through.
 */
async function streamAttempt(
  resp: Response,
  writer: SSEWriter,
  sp: StreamProcessor,
  commitOnPlainText: boolean,
  holdOnWebSearch: boolean,
  signal?: AbortSignal
): Promise<AttemptOutcome> {
  const pending: import('./types').ChatCompletionChunk[] = [];
  let committed = false;
  let aborted = false;
  let sawToolCalls = false;
  /** When the first chunk that has not been sent yet appeared. */
  let firstUnsentAt = 0;

  const parser = createParser({
    onEvent: (event) => {
      if (event.data === '[DONE]') return;
      try {
        const parsed = JSON.parse(event.data);
        for (const c of sp.processEvent(parsed)) {
          if (c.choices?.[0]?.delta?.tool_calls) sawToolCalls = true;
          pending.push(c);
        }
      } catch {
        // Ignore non-JSON frames
      }
    },
  });

  const drainPending = async (): Promise<void> => {
    while (pending.length > 0) {
      if (signal?.aborted) return;
      await emitSSE(writer, pending.shift()!);
    }
    firstUnsentAt = 0;
  };

  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const onAbort = () => {
      aborted = true;
      try {
        reader.cancel();
      } catch {}
    };
    if (signal) {
      if (signal.aborted) {
        aborted = true;
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    try {
      let graceDeadline = 0;
      let tailTimedOut = false;
      while (!aborted) {
        let done = false;
        if (graceDeadline > 0) {
          const remaining = graceDeadline - Date.now();
          if (remaining <= 0) {
            tailTimedOut = true;
            break;
          }
          const timeout = Promise.withResolvers<typeof READ_TIMEOUT>();
          const tid = setTimeout(() => timeout.resolve(READ_TIMEOUT), remaining);
          const raced = await Promise.race([reader.read(), timeout.promise]);
          clearTimeout(tid);
          if (raced === READ_TIMEOUT) {
            tailTimedOut = true;
            break;
          }
          done = raced.done;
          if (!done && raced.value) {
            parser.feed(decoder.decode(raced.value, { stream: true }));
          }
        } else {
          const { done: d, value } = await reader.read();
          done = d;
          if (!done && value) {
            parser.feed(decoder.decode(value, { stream: true }));
          }
        }

        // Commit as soon as the attempt is provably not a retry candidate.
        if (!committed) {
          if (pending.length > 0 && firstUnsentAt === 0) {
            firstUnsentAt = Date.now();
          }
          if (sawToolCalls) {
            // The detector resolved the reply as tool-call JSON.
            committed = true;
          } else if (
            commitOnPlainText &&
            !looksLikeRefusal(sp.lastFullText) &&
            !(holdOnWebSearch && sp.usedWebSearch)
          ) {
            // Refusal text must stay held so it can be retried on a fresh
            // device; any other prose is a legitimate answer. Commit once the
            // byte or time trigger fires so the typing effect starts early.
            const byteTrigger = sp.lastFullText.length >= TOOL_REFUSAL_DECISION_CHARS;
            const timeTrigger =
              firstUnsentAt > 0 && Date.now() - firstUnsentAt >= TOOL_REFUSAL_DECISION_MS;
            if (byteTrigger || timeTrigger) {
              committed = true;
            }
          }
        }
        if (committed) {
          await drainPending();
        }

        if (done) break;
        // Idle-based window: keep reading until the post-turn metadata frame
        // lands so streaming turns do not drop model_limits (mirrors
        // pipeOpenAIStream; see TURN_METADATA_GRACE_MS).
        if (sp.endedTurn) {
          if (sp.sawTurnMetadata) {
            try {
              await reader.cancel();
            } catch {}
            break;
          }
          graceDeadline = Date.now() + TURN_METADATA_GRACE_MS;
        }
      }
      if (tailTimedOut) {
        // A read is still in flight; cancel it before releasing the lock.
        try {
          await reader.cancel();
        } catch {}
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }
  if (!aborted && typeof (parser as any).reset === 'function') {
    try {
      (parser as any).reset({ consume: true });
    } catch {
      // ignore
    }
  }
  if (committed) {
    await drainPending();
  }
  return { chunks: pending, sp, aborted, committed };
}

/**
 * Synthesize a stream from an aggregated completion by feeding its text
 * through a fresh StreamProcessor once. Used to deliver a retryToolTurn
 * result (a non-stream completion) through the streaming code path.
 */
async function emitAggregatedAsStream(
  writer: SSEWriter,
  result: ChatCompletionResponse,
  model: string,
  req: ChatCompletionRequest,
  signals?: UpstreamTurnSignals
): Promise<void> {
  const sp = new StreamProcessor(model, req);
  const text = result.choices?.[0]?.message?.content ?? '';
  const resultCalls = result.choices?.[0]?.message?.tool_calls ?? [];
  // A limit-cut reply reports "length"/"stop" while still carrying tool_calls,
  // so key off the calls themselves instead of the finish reason.
  if (resultCalls.length > 0) {
    const wire = JSON.stringify({
      tool_calls: resultCalls.map((tc) => {
        // A limit-cut call carries argument text that may not be valid JSON;
        // embedding it as a string keeps the bytes the model produced.
        const raw = tc.function?.arguments ?? '';
        let args: unknown = raw;
        if (raw.trim() !== '') {
          try {
            args = JSON.parse(raw);
          } catch {
            args = raw;
          }
        }
        return { name: tc.function?.name, arguments: args };
      }),
    });
    const synth = {
      type: 'message_stream',
      message: {
        id: 'synth-retry',
        author: { role: 'assistant' },
        status: 'in_progress',
        metadata: { message_type: 'next' },
        content: { content_type: 'text', parts: [wire] },
      },
    };
    for (const chunk of sp.processEvent(synth)) {
      await emitSSE(writer, chunk);
    }
  } else if (text) {
    const synth = {
      type: 'message_stream',
      message: {
        id: 'synth-retry',
        author: { role: 'assistant' },
        status: 'in_progress',
        metadata: { message_type: 'next' },
        content: { content_type: 'text', parts: [text] },
      },
    };
    for (const chunk of sp.processEvent(synth)) {
      await emitSSE(writer, chunk);
    }
  }
  // The aggregated result was already truncated by its own limiter, so the
  // fresh processor re-scanning the pre-cut text cannot see that the cap
  // fired — its flush would degrade finish_reason "length" to "stop".
  if (result.choices?.[0]?.finish_reason === 'length') {
    sp.sampling.latchFinish('length');
  }
  for (const chunk of sp.flush()) {
    await emitSSE(writer, chunk);
  }
  await emitStreamMeta(writer, signals ?? sp.signals());
  await emitSSE(writer, '[DONE]');
}

/**
 * pipeOpenAIStreamRetrying is the streaming counterpart to the non-stream
 * retryToolTurn path: when tool calling is active and the upstream model
 * replies with a refusal text instead of a tool call, retry the turn on
 * fresh devices up to 3 attempts.
 *
 * Streaming-vs-buffering: retrying is only possible while NOTHING has been
 * emitted. The decision window is deliberately tiny (see streamAttempt): a
 * tool call commits on the first tool_calls delta, and plain prose commits as
 * soon as enough non-refusal text exists — so a normal answer streams
 * incrementally from ~200 characters in, instead of arriving in one burst
 * after the socket closes. Only a genuine refusal (or a mandated tool_choice
 * whose compliance is still unknown) is ever held back.
 *
 * hasTools=false: no ambiguity to resolve; falls through to pipeOpenAIStream.
 */
async function pipeOpenAIStreamRetrying(
  resp: Response,
  writer: SSEWriter,
  model: string,
  req: ChatCompletionRequest,
  signal: AbortSignal | undefined,
  ctx: StreamRetryCtx
): Promise<void> {
  const handleSignals = async (signals: UpstreamTurnSignals, targetDeviceId: string) => {
    if (signals.modelDegraded && targetDeviceId) {
      await ctx.dm.retireDevice(ctx.env, targetDeviceId).catch(() => {});
    }
    await emitStreamMeta(writer, signals);
  };

  if (!ctx.hasTools) {
    await pipeOpenAIStream(resp, writer, model, req, signal, (signals) =>
      handleSignals(signals, ctx.deviceId)
    );
    return;
  }

  // Under a mandatory tool_choice the contract is only satisfiable by a tool
  // call, so a plain answer must not be committed early if it is still a
  // candidate for retry. Under "auto" a non-refusal plain answer is always
  // acceptable, so prose commits as soon as the decision window is filled.
  const commitOnPlainText = !requiresToolCall(req);
  const holdOnWebSearch = mustAnswerFromToolResult(req);

  const MAX_STREAM_ATTEMPTS = 3;
  let currentResp: Response = resp;

  for (let attempt = 0; attempt < MAX_STREAM_ATTEMPTS; attempt++) {
    const sp = new StreamProcessor(model, req);
    const outcome = await streamAttempt(currentResp, writer, sp, commitOnPlainText, holdOnWebSearch, signal);
    if (outcome.aborted) return;

    if (outcome.committed) {
      // Already mid-stream on the client: finish this attempt.
      for (const chunk of outcome.chunks) {
        await emitSSE(writer, chunk);
      }
      for (const chunk of sp.flush()) {
        await emitSSE(writer, chunk);
      }
      await handleSignals(sp.signals(), ctx.deviceId);
      await emitSSE(writer, '[DONE]');
      return;
    }

    const chunks = outcome.chunks;
    const sawToolCalls = chunks.some((c) => c.choices?.[0]?.delta?.tool_calls);
    // Same contract as the non-stream path: a refusal, or any tool-less reply
    // under a mandatory tool_choice, warrants a retry on a fresh device.
    const bufferedCompletion: ChatCompletionResponse = {
      id: sp.messageId,
      object: 'chat.completion',
      created: sp.created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: sawToolCalls ? null : sp.lastFullText,
            tool_calls: sawToolCalls
              ? chunks
                  .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
                  .map((tc) => ({
                    id: tc.id ?? '',
                    type: 'function' as const,
                    function: {
                      name: tc.function?.name ?? '',
                      arguments: tc.function?.arguments ?? '',
                    },
                  }))
              : undefined,
          },
          finish_reason: sawToolCalls ? 'tool_calls' : sp.toolCallFinishReason(),
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const primarySignals = sp.signals();
    const contractViolated = violatesToolContract(req, bufferedCompletion, sp.usedWebSearch);

    if (contractViolated && attempt < MAX_STREAM_ATTEMPTS - 1) {
      if (primarySignals.modelDegraded && ctx.deviceId) {
        await ctx.dm.retireDevice(ctx.env, ctx.deviceId).catch(() => {});
      }
      try {
        await currentResp.body?.cancel();
      } catch {}
      const retryResp = await retryToolTurn(ctx.env, {
        model,
        prompt: ctx.prompt,
        imageRefs: ctx.imageRefs,
        req,
        client: ctx.client,
        dm: ctx.dm,
        signal,
      });
      if (retryResp) {
        if (!violatesToolContract(req, retryResp.result, retryResp.usedWebSearch)) {
          // Got a usable answer — stream it out as a synthesized attempt and
          // finish, preserving the streaming contract.
          await emitAggregatedAsStream(writer, retryResp.result, model, req, {
            usedWebSearch: retryResp.usedWebSearch,
            upstreamModel: retryResp.upstreamModel,
            sourcesCount: retryResp.sourcesCount,
            modelLimitReached: retryResp.modelLimitReached,
            modelDegraded: retryResp.modelDegraded,
          });
          return;
        }
      }
      // Still violating (or retry failed): fall through and emit the attempt we
      // already held — the client gets a proper reply instead of silence.
      // This mirrors the non-stream branch which keeps lastResult.
    }

    // Committed to this attempt: stream what was held, then the tail.
    for (const chunk of chunks) {
      await emitSSE(writer, chunk);
    }
    for (const chunk of sp.flush()) {
      await emitSSE(writer, chunk);
    }
    await handleSignals(primarySignals, ctx.deviceId);
    await emitSSE(writer, '[DONE]');
    return;
  }
}

/**
 * Re-runs a tool turn on fresh devices (up to 4 attempts). Returns the first
 * result that satisfies the tool contract (a tool call, or a non-refusal plain
 * answer when no tool_choice was mandatory), or the last result if every
 * attempt violated it. Turn observability signals travel with the result so
 * callers can report headers and retire silently downgraded devices.
 */
async function retryToolTurn(
  env: Env,
  args: RetryArgs
): Promise<({ result: ChatCompletionResponse; deviceId: string } & UpstreamTurnSignals) | null> {
  const { model, prompt, imageRefs, req, client, dm, signal } = args;
  let lastResult: ({ result: ChatCompletionResponse; deviceId: string } & UpstreamTurnSignals) | null = null;
  for (let i = 0; i < 4; i++) {
    let deviceId = '';
    try {
      const device = await dm.getHealthyDevice(env, client);
      deviceId = device.id;
      let messageContent: Record<string, any> | undefined;
      let mimeTypes: string[] | undefined;
      if (imageRefs.length > 0) {
        const resolved: ResolvedImage[] = [];
        const mimeSet = new Set<string>();
        for (const ref of imageRefs) {
          const img = await resolveImage(ref, (u, init) => fetch(u, { ...init, signal }));
          const sniffed = sniffImageMime(img.bytes);
          const mimeType = sniffed !== 'application/octet-stream' ? sniffed : img.mimeType;
          const { fileId } = await uploadImage({
            client,
            deviceId: device.id,
            imageBytes: img.bytes,
            mimeType,
            fileName: `image.${defaultExtensionForMime(mimeType)}`,
            signal,
          });
          mimeSet.add(mimeType);
          resolved.push({ fileId, sizeBytes: img.bytes.byteLength, width: img.width, height: img.height, mimeType });
        }
        messageContent = buildMultimodalContent(
          lastUserMessageText(req.messages),
          resolved
        );
        mimeTypes = [...mimeSet];
      }
      const anonBody = buildAnonRequestBodyWithTools(req as any, {
        prompt,
        messageContent,
        attachmentMimeTypes: mimeTypes,
      });
      const conduitToken = await client.prepare(device.id, device.sentinelToken!, anonBody, signal);
      const resp = await client.conversation(device.id, device.sentinelToken!, conduitToken, anonBody, signal);
      const attempt = await aggregateNonStreamWithSignals(resp, model, req);
      if (attempt.modelDegraded) {
        await dm.retireDevice(env, device.id).catch(() => {});
      }
      lastResult = { ...attempt, deviceId: device.id };
      // Accept when the tool contract is satisfied: a tool call, or (absent a
      // mandatory tool_choice) any non-refusal plain answer.
      if (!violatesToolContract(req, attempt.result, attempt.usedWebSearch)) {
        return lastResult;
      }
    } catch (err) {
      if (deviceId && err instanceof StatusError && (err.status === 429 || err.status === 403 || err.status === 401)) {
        await dm.reportCooldown(env, deviceId, err).catch(() => {});
      }
      // keep trying
    }
  }
  return lastResult;
}

/**
 * Creates and configures the Hono application for chatgpt2api-cf.
 */
export function createApp(options?: AppOptions) {
  const app = new Hono<{ Bindings: Env }>();
  const commitDeadlineMs = options?.nonStreamCommitDeadlineMs ?? NONSTREAM_COMMIT_DEADLINE_MS;
  const keepAliveMs = options?.keepAliveIntervalMs ?? SSE_PING_INTERVAL_MS;

  // Enable CORS for all routes and expose observability headers
  app.use('*', cors({ exposeHeaders: OBSERVABILITY_HEADERS }));

  // Bearer token authentication middleware for API routes
  app.use('/v1/*', async (c, next) => {
    const apiKeys = c.env?.API_KEYS?.trim();
    if (!apiKeys) {
      return next();
    }

    const allowed = apiKeys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (allowed.length === 0) {
      return next();
    }

    const authHeader = c.req.header('Authorization') || c.req.header('authorization');
    const xApiKey = c.req.header('x-api-key') || c.req.header('X-Api-Key');
    let token = '';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (xApiKey) {
      token = xApiKey.trim();
    }

    if (!token) {
      return c.json(
        {
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401
      );
    }

    if (!allowed.includes(token)) {
      return c.json(
        {
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401
      );
    }

    return next();
  });

  // Global error handler: converts exceptions into OpenAI-formatted JSON
  app.onError((err, c) => {
    const { status, error } = openAIErrorBody(err);
    // openAIErrorBody clamps to a concrete HTTP status (400-599); the cast
    // re-narrows the Hono generics that `number` widens.
    return c.json({ error }, status as ContentfulStatusCode);
  });

  // Root / Status endpoint
  app.get('/', async (c) => {
    const client = options?.client || new UpstreamClient();
    const models = await getModelCatalog(c.env, client);

    return c.json({
      status: 'ok',
      service: 'chatgpt2api-cf',
      models,
      docs: 'https://github.com/6Kmfi6HP/chatgpt2api',
    });
  });

  // Health check endpoints
  app.get('/health', async (c) => {
    const kvBound = Boolean(c.env?.CHATGPT_KV);
    let kvPool: any = null;
    if (kvBound) {
      try {
        kvPool = await c.env.CHATGPT_KV.get('chatgpt_device_pool', 'json');
      } catch (err: any) {
        kvPool = { error: err.message };
      }
    }
    return c.json({
      status: 'ok',
      kvBound,
      hasPool: Boolean(kvPool?.devices),
      poolDevicesCount: kvPool?.devices?.length || 0,
      maxDeviceUses: resolveMaxDeviceUses(c.env),
      deviceUseCounts: Array.isArray(kvPool?.devices)
        ? kvPool.devices.map((d: any) => d.useCount || 0)
        : [],
    });
  });
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Model list endpoint: live anonymous catalog, fallback ["auto"]
  app.get('/v1/models', async (c) => {
    const client = options?.client || new UpstreamClient();
    const models = await getModelCatalog(c.env, client);

    return c.json({
      object: 'list',
      data: models.map((id) => ({
        id,
        object: 'model',
        created: 1700000000,
        owned_by: 'openai',
      })),
    });
  });

  // Chat completions endpoint
  app.post('/v1/chat/completions', async (c) => {
    let req: ChatCompletionRequest;
    try {
      const parsed: unknown = await c.req.json();
      // JSON `null` parses fine but has no fields: reading `.messages` off it
      // threw a TypeError and surfaced as 500 api_error.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('body is not a JSON object');
      }
      req = parsed as ChatCompletionRequest;
    } catch {
      return c.json(
        {
          error: {
            message: 'Invalid JSON request body',
            type: 'invalid_request_error',
          },
        },
        400
      );
    }

    if (!req.messages || !Array.isArray(req.messages) || req.messages.length === 0) {
      return c.json(
        {
          error: {
            message: 'Missing or invalid "messages" array',
            type: 'invalid_request_error',
          },
        },
        400
      );
    }

    // Per-message shape: reject before any upstream work rather than let the
    // DTO builders throw a TypeError that surfaces as 500 api_error.
    const shapeError = messageShapeError(req.messages);
    if (shapeError) {
      return c.json(
        {
          error: {
            message: `Invalid parameter: ${shapeError}.`,
            type: 'invalid_request_error',
            param: 'messages',
            code: 'invalid_request_error',
          },
        },
        400
      );
    }

    // Shape-affecting boolean controls: `stream` selects SSE over JSON,
    // `stream_options.include_usage` adds the usage frame, and `search` enables
    // the upstream web search. Reading any of them as truthiness silently
    // answered "stream":"false" with an SSE stream, so a non-boolean is
    // rejected here — the same contract already applied to parallel_tool_calls.
    const flagErr = booleanControlParamError(req);
    if (flagErr) {
      return c.json(
        {
          error: {
            message: flagErr.message,
            type: 'invalid_request_error',
            param: flagErr.param,
            code: flagErr.code ?? 'invalid_request_error',
          },
        },
        400
      );
    }

    // parallel_tool_calls is a boolean gate on how many tool calls the caller
    // can execute. A truthy string would be silently read as "parallel", so a
    // non-boolean value is a client bug worth surfacing.
    if (req.parallel_tool_calls !== undefined && typeof req.parallel_tool_calls !== 'boolean') {
      return c.json(
        {
          error: {
            message: "Invalid parameter: 'parallel_tool_calls' must be a boolean.",
            type: 'invalid_request_error',
            param: 'parallel_tool_calls',
            code: 'invalid_request_error',
          },
        },
        400
      );
    }

    // Sampling parameters the gateway must honour or reject, never silently
    // drop: a malformed max_tokens/stop would otherwise turn the cap and the
    // truncation markers into no-ops.
    const samplingErr = samplingParamError(req);
    if (samplingErr) {
      return c.json(
        {
          error: {
            message: samplingErr.message,
            type: 'invalid_request_error',
            param: samplingErr.param,
            code: 'invalid_request_error',
          },
        },
        400
      );
    }

    // Input parts the gateway cannot forward must be rejected, never dropped:
    // an `input_audio` or `file` part disappears while building the prompt, so
    // the upstream answers an empty question and the caller gets a 200 with an
    // unrelated greeting and `prompt_tokens: 0`. Rejecting here keeps the
    // failure legible and spends no upstream call.
    const partErr = contentPartError(req.messages);
    if (partErr) {
      return c.json(
        {
          error: {
            message: partErr.message,
            type: 'invalid_request_error',
            param: partErr.param,
            code: partErr.code ?? 'invalid_request_error',
          },
        },
        400
      );
    }

    // `n` and `logprobs` change the SHAPE of the reply, not just its wording:
    // a client indexing `choices[n-1]` or reading `choices[0].logprobs` breaks
    // when the gateway silently answers one plain choice. The anonymous
    // upstream is a single conversation, so neither can be honoured; reject
    // before any upstream work starts (stream and non-stream alike).
    const shapeErr = responseShapeParamError(req);
    if (shapeErr) {
      return c.json(
        {
          error: {
            message: shapeErr.message,
            type: 'invalid_request_error',
            param: shapeErr.param,
            code: shapeErr.code ?? 'invalid_request_error',
          },
        },
        400
      );
    }

    // A "tool" message must answer a tool_calls id declared by a preceding
    // assistant message. OpenAI rejects orphans with 400; answering them with a
    // normal chat reply silently hides a client bug (the tool payload gets
    // treated as user intent, and the caller never learns its id was wrong).
    const declaredToolCallIds = new Set<string>();
    for (const m of req.messages) {
      if (m?.role === 'assistant') {
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) {
            if (tc && typeof tc.id === 'string' && tc.id !== '') {
              declaredToolCallIds.add(tc.id);
            }
          }
        }
        continue;
      }
      if (m?.role === 'tool') {
        const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
        if (id === '' || !declaredToolCallIds.has(id)) {
          return c.json(
            {
              error: {
                message:
                  "Invalid parameter: messages with role 'tool' must be a response to a preceding message with 'tool_calls'.",
                type: 'invalid_request_error',
                param: 'messages',
                code: 'invalid_request_error',
              },
            },
            400
          );
        }
      }
    }

    // The mirror image of the orphan guard: an assistant tool call that no
    // `tool` message answers. OpenAI answers that shape with 400 ("An assistant
    // message with 'tool_calls' must be followed by tool messages responding to
    // each 'tool_call_id'"). Answering it with a 200 is worse than an error: the
    // upstream replays the call as a transcript line and the model narrates
    // progress it cannot have made, so an agent loop records a false answer and
    // never runs the tool.
    const unanswered = unansweredToolCallError(req.messages);
    if (unanswered) {
      return c.json(
        {
          error: {
            message: `Invalid parameter: ${unanswered}.`,
            type: 'invalid_request_error',
            param: 'messages',
            code: 'invalid_request_error',
          },
        },
        400
      );
    }

    // `model` is required by the OpenAI contract. Rewriting a missing/blank
    // value to "auto" hides a request-assembly bug on the client (for example a
    // model nested inside metadata), and "auto" is not necessarily in
    // /v1/models. Reject before any upstream work starts.
    if (typeof req.model !== 'string' || req.model.trim() === '') {
      return c.json(
        {
          error: {
            message: 'you must provide a model parameter',
            type: 'invalid_request_error',
            param: 'model',
            code: null,
          },
        },
        400
      );
    }

    // The deprecated `functions`/`function_call` pair has no path into the
    // upstream protocol: `normalizeToolDefinitions` reads only `tools`, so a
    // request that declared functions used to be answered as plain prose with
    // `finish_reason: "stop"` and no tool channel, and an explicit
    // `function_call: {"name": X}` mandate silently degraded to a text reply.
    // Reject the unimplemented field instead of dropping it.
    const legacyFunctionsErr = legacyFunctionsParamError(req);
    if (legacyFunctionsErr) {
      return c.json(
        {
          error: {
            message: legacyFunctionsErr.message,
            type: 'invalid_request_error',
            param: legacyFunctionsErr.param,
            code: legacyFunctionsErr.code ?? 'invalid_request_error',
          },
        },
        400
      );
    }

    // A `tools` entry the gateway cannot compile is dropped by
    // normalizeToolDefinitions, which turns the whole tool path off and answers
    // the caller with plain prose: the request declared tools and got no tool
    // channel, with no error to detect it. Reject the payload shape instead of
    // silently running without the tools the caller asked for.
    const toolsErr = toolsParamError(req.tools);
    if (toolsErr) {
      return c.json(
        {
          error: {
            message: toolsErr.message,
            type: 'invalid_request_error',
            param: toolsErr.param,
            code: toolsErr.code ?? 'invalid_request_error',
          },
        },
        400
      );
    }

    // `tool_choice` must name something the request declares. An unsatisfiable
    // choice cannot be honoured by the upstream, so it would be compiled into
    // an impossible mandate, judged a violation on every reply, and retried
    // four times before degrading to a plain-text 200. Reject it up front.
    const toolChoiceProblem = toolChoiceError(req);
    if (toolChoiceProblem) {
      return c.json(
        {
          error: {
            message: toolChoiceProblem,
            type: 'invalid_request_error',
            param: 'tool_choice',
            code: 'invalid_request_error',
          },
        },
        400
      );
    }

    // No name mapping: the requested model slug is passed through verbatim.
    const model = req.model;
    const prompt = flattenMessages(req.messages);

    // Collect image references from every frame (order preserved). A tool
    // result carries the screenshot in an agent loop, and an assistant frame
    // can carry one too: reading only user frames (the pre-existing tools-on
    // shortcut) validated and accepted those parts, then dropped them, so the
    // model answered about a picture it never received while the caller read a
    // 200. Both roles are forwarded exactly like user frames, which is what the
    // tools-off path has always done.
    // Computed once: req.tools / req.tool_choice are never mutated below,
    // so the retry loop and downstream uses share this value.
    const hasTools =
      Array.isArray(req.tools) && req.tools.length > 0 && req.tool_choice !== 'none';
    const imageRefs = req.messages.flatMap((m) => collectImageRefs(m.content as any));

    // A request with neither text nor an attachment carries nothing the
    // upstream can answer: it greets the caller and the client reads a 200 it
    // never asked for. This covers `content: ""`, an empty `content: []`, and a
    // history whose only text-bearing frames were assistant/tool frames. An
    // image-only message is legitimate (vision requests carry no prompt text),
    // so images count as content.
    if (prompt.trim() === '' && imageRefs.length === 0) {
      return c.json(
        {
          error: {
            message:
              'Invalid parameter: the request carries no user text and no image attachment, so there is nothing to answer',
            type: 'invalid_request_error',
            param: 'messages',
            code: 'invalid_request_error',
          },
        },
        400
      );
    }

    const client = options?.client || new UpstreamClient();
    const dm = options?.deviceManager || defaultDeviceManager;

    const MAX_ATTEMPTS = 3;
    let upstreamResp: Response | null = null;
    let lastError: any = null;
    let selectedDeviceId = '';
    let selectedDeviceUseCount = 0;
    const maxDeviceUses = resolveMaxDeviceUses(c.env);
    const searchEnabled = hasTools ? req.search === true : req.search !== false;
    let searchPromptInjected = false;
    /** Set when the non-stream refusal retry swapped to a fresh device. */
    let deviceRotated = false;
    const signal = c.req.raw?.signal;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) {
        throw new Error('Request aborted by client');
      }

      try {
        const device = await dm.getHealthyDevice(c.env, client);
        selectedDeviceId = device.id;
        selectedDeviceUseCount = device.useCount ?? 1;

        // Image uploads are per-device quota'd upstream, so they happen inside
        // the retry loop with the same device that runs the conversation. A
        // 429/403 from the upload path cools this device down and the loop
        // retries with a fresh one.
        // (hasTools is computed once before the loop; req is never mutated.)

        // Resolve and upload image attachments (order preserved). All images
        // ride the last user frame, exactly like the pre-existing behavior.
        let messageContent: Record<string, any> | undefined;
        let attachmentMimeTypes: string[] | undefined;
        if (imageRefs.length > 0) {
          const resolved: ResolvedImage[] = [];
          const mimeTypes = new Set<string>();
          for (const ref of imageRefs) {
            const img = await resolveImage(ref, (u, init) =>
              fetch(u, { ...init, signal })
            );
            const sniffed = sniffImageMime(img.bytes);
            const mimeType =
              sniffed !== 'application/octet-stream' ? sniffed : img.mimeType;
            const { fileId } = await uploadImage({
              client,
              deviceId: device.id,
              imageBytes: img.bytes,
              mimeType,
              fileName: `image.${defaultExtensionForMime(mimeType)}`,
              signal,
            });
            mimeTypes.add(mimeType);
            resolved.push({ fileId, sizeBytes: img.bytes.byteLength, width: img.width, height: img.height, mimeType });
          }
          // The multimodal frame carries only the final user message's text:
          // the rest of the history is replayed as its own native frames.
          messageContent = buildMultimodalContent(
            lastUserMessageText(req.messages),
            resolved
          );
          attachmentMimeTypes = [...mimeTypes];
        }

        // Multi-turn continuity: every OpenAI message (system/user/assistant/
        // tool) maps to one native upstream frame in a fresh conversation.
        // The anonymous upstream model treats a pasted transcript prompt as
        // untrusted external content and disowns it ("I don't have access to
        // that memory"), but native frames are honored as its own history, so
        // follow-up turns keep recalling prior context. Tool requests
        // additionally get the compiled tool-protocol system frame prepended.
        //
        // Search defaults are unchanged: ON for plain chat unless
        // "search": false; OFF for tool requests unless "search": true (the
        // upstream web tool competes with tool-calling).
        const injectSearchPrompt = shouldInjectSearchPrompt(req as any, hasTools, searchEnabled);
        const wireReq = {
          ...req,
          model,
          search: searchEnabled,
        } as any;
        const anonBody = buildAnonRequestBodyWithTools(wireReq, {
          prompt,
          messageContent,
          attachmentMimeTypes,
          injectSearchPrompt,
        });

        // Degenerate history without a single user message (e.g. system-only):
        // replay it as the pre-existing single user frame so the upstream
        // conversation still opens on a user turn.
        if (
          !hasTools &&
          !(anonBody.messages as any[]).some((m) => m?.author?.role === 'user')
        ) {
          anonBody.messages = [
            {
              author: { role: 'user' },
              content:
                messageContent ?? { content_type: 'text', parts: [prompt] },
            },
          ];
        }

        searchPromptInjected =
          shouldInjectSearchPrompt(req as any, hasTools, searchEnabled) &&
          (anonBody.messages as any[]).some(
            (m) => m?.author?.role === 'system' && m?.content?.parts?.[0] === SEARCH_SYSTEM_PROMPT
          );

        const conduitToken = await client.prepare(
          device.id,
          device.sentinelToken!,
          anonBody,
          signal
        );
        upstreamResp = await client.conversation(
          device.id,
          device.sentinelToken!,
          conduitToken,
          anonBody,
          signal
        );
        break;
      } catch (err: any) {
        lastError = err;
        if (err instanceof StatusError && (err.status === 429 || err.status === 403 || err.status === 401)) {
          if (selectedDeviceId) {
            await dm.reportCooldown(c.env, selectedDeviceId, err);
          }
          continue;
        }
        // Client-side image validation failures (undecodable data URLs,
        // unsupported formats, non-image responses) are the caller's fault:
        // surface them as 400 instead of 500.
        const msg: string = err?.message ?? '';
        if (
          msg.includes('Unsupported image format') ||
          msg.includes('Invalid data URL') ||
          msg.includes('did not return an image') ||
          msg.includes('Failed to fetch image') ||
          msg.includes('Cannot parse') ||
          msg.includes('Empty image payload')
        ) {
          err = new StatusError('upload', 400, msg);
          lastError = err;
          throw err;
        }
        // The anonymous upstream signals an unusable model by answering
        // prepare with HTTP 200 but no conduit_token. Every device hits the
        // same business-level rejection (it is a property of the model, not
        // the device), so this is the caller's fault: surface 400, not 500.
        if (/empty conduit_token \(status="ok"\)/.test(msg)) {
          err = new StatusError('prepare', 400, msg);
          Object.assign(err, { model });
          lastError = err;
          throw err;
        }
        throw err;
      }
    }

    if (!upstreamResp) {
      throw lastError || new Error('Failed to communicate with upstream after retries');
    }

    c.header('x-device-id', selectedDeviceId);
    c.header('x-device-use-count', String(selectedDeviceUseCount));
    c.header('x-device-max-uses', String(maxDeviceUses));
    c.header('x-search-enabled', String(searchEnabled));
    c.header('x-search-prompt-injected', String(searchPromptInjected));

    if (req.stream) {
      return streamSSE(c, async (sseStream) => {
        // Client read-idle keepalive: a long upstream wait (notably the
        // tool-request buffering window, where nothing may be emitted yet)
        // otherwise leaves the socket byte-idle past client read timeouts.
        // `: ping` is an SSE comment and is ignored by every spec parser.
        const ping = setInterval(() => {
          void sseStream.write(': ping\n\n').catch(() => {});
        }, keepAliveMs);
        const stopPing = () => clearInterval(ping);
        sseStream.onAbort(stopPing);
        try {
          await pipeOpenAIStreamRetrying(upstreamResp!, sseStream, model, req, signal, {
            env: c.env,
            prompt,
            imageRefs,
            client,
            dm,
            deviceId: selectedDeviceId,
            hasTools: hasTools,
          });
        } finally {
          stopPing();
        }
      });
    }

    // Transparent refusal retry for non-stream tool requests: anonymous
    // models sometimes answer "unable to access the tool" instead of calling
    // it. Give the request one more round on a fresh device when detected.
    //
    // Commit deadline: generation can outlast a client's read-idle timeout, so
    // once NONSTREAM_COMMIT_DEADLINE_MS elapses without a result we commit a
    // 200 early and stream whitespace heartbeats (legal before a JSON value)
    // until the real body is ready. Browsers and SDKs reset read timers on
    // those bytes; the final document is still one JSON.parse-able value.
    const liveSignals: UpstreamTurnSignals = {
      usedWebSearch: false,
      upstreamModel: '',
      sourcesCount: 0,
      modelLimitReached: false,
      modelDegraded: false,
    };
    const syncSignals = (sig: UpstreamTurnSignals) => {
      liveSignals.usedWebSearch = sig.usedWebSearch;
      liveSignals.upstreamModel = sig.upstreamModel;
      liveSignals.sourcesCount = sig.sourcesCount;
      liveSignals.modelLimitReached = sig.modelLimitReached;
      liveSignals.modelDegraded = sig.modelDegraded;
    };

    const resultPromise = (async (): Promise<ChatCompletionResponse> => {
      const first = await aggregateNonStreamWithSignals(upstreamResp!, model, req, liveSignals);
      syncSignals(first);
      let result = first.result;
      let activeDeviceId = selectedDeviceId;
      let finalSignals: UpstreamTurnSignals = first;
      if (hasTools && violatesToolContract(req, result, first.usedWebSearch)) {
        if (first.modelDegraded && selectedDeviceId) {
          await dm.retireDevice(c.env, selectedDeviceId).catch(() => {});
        }
        try {
          await upstreamResp!.body?.cancel();
        } catch {}
        const retryResp = await retryToolTurn(c.env, {
          model, prompt, imageRefs, req, client, dm, signal,
        });
        if (retryResp) {
          result = retryResp.result;
          activeDeviceId = retryResp.deviceId;
          finalSignals = retryResp;
          syncSignals(retryResp);
          deviceRotated = true;
        }
      }
      if (finalSignals.modelDegraded && activeDeviceId) {
        await dm.retireDevice(c.env, activeDeviceId).catch(() => {});
      }
      return result;
    })();

    const deadlineTimer = Promise.withResolvers<'timeout'>();
    const deadlineId = setTimeout(() => deadlineTimer.resolve('timeout'), commitDeadlineMs);
    const deadline = await Promise.race([
      resultPromise.then((result) => ({ settled: true as const, result })),
      deadlineTimer.promise.then(() => ({ settled: false as const })),
    ]);
    if (deadline.settled) {
      clearTimeout(deadlineId);
    }

    // Header must be set before the body commits; the retry runs inside
    // resultPromise, so the rotation flag and upstream signals are read once
    // settled (fast path) or as populated so far (slow path).
    if (deviceRotated) {
      c.header('x-device-id', 'rotated');
    }
    c.header('x-upstream-model', liveSignals.upstreamModel || 'unknown');
    c.header('x-used-web-search', String(liveSignals.usedWebSearch));
    c.header('x-search-sources-count', String(liveSignals.sourcesCount));
    c.header('x-model-degraded', String(liveSignals.modelDegraded));

    if (deadline.settled) {
      return c.json(deadline.result);
    }

    // Slow path: commit now, keep the connection warm, then flush the body.
    c.header('Content-Type', 'application/json; charset=UTF-8');
    c.header('Transfer-Encoding', 'chunked');
    c.header('Cache-Control', 'no-cache');
    return c.body(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          let alive = true;
          const flush = () => {
            // A disconnected client makes enqueue throw; stop the timer and
            // let the final result resolution settle silently.
            if (!alive) return;
            try {
              controller.enqueue(encoder.encode(NONSTREAM_HEARTBEAT));
            } catch {
              alive = false;
              clearInterval(hb);
            }
          };
          const hb = setInterval(flush, keepAliveMs);
          flush();
          try {
            const result = await resultPromise;
            if (alive) controller.enqueue(encoder.encode(JSON.stringify(result)));
          } catch (err) {
            if (alive) {
              const { error } = openAIErrorBody(err);
              try {
                controller.enqueue(encoder.encode(JSON.stringify({ error })));
              } catch {
                alive = false;
              }
            }
          } finally {
            alive = false;
            clearInterval(hb);
            try {
              controller.close();
            } catch {
              // already closed by the client
            }
          }
        },
      })
    );
  });

  return app;
}

const app = createApp();
export default app;
export { app };
