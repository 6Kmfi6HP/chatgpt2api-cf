import type { ChatCompletionRequest } from './types';
import { countRoughTokens } from './translate';

/**
 * OpenAI accepts at most this many stop sequences per request.
 * https://platform.openai.com/docs/api-reference/chat/create#chat-create-stop
 */
export const MAX_STOP_SEQUENCES = 4;

/**
 * The parameters read as `unknown`: the decoded request body is untrusted
 * JSON, so a caller can send any type for them. Narrowing happens below
 * instead of trusting the interface.
 */
interface RawRequestParams {
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  stop?: unknown;
  n?: unknown;
  logprobs?: unknown;
  top_logprobs?: unknown;
  response_format?: unknown;
  modalities?: unknown;
  audio?: unknown;
}

function rawRequestParams(req: ChatCompletionRequest | undefined): RawRequestParams {
  return (req ?? {}) as RawRequestParams;
}

/**
 * The OpenAI-shaped 400 the gateway answers with. `code` defaults to
 * `invalid_request_error`; an honourable-but-unimplementable field uses
 * `unsupported_parameter` so clients can tell a typo apart from a gap.
 */
export interface ParamError {
  message: string;
  param: string;
  code?: string;
}

/** Sampling controls the gateway enforces itself (upstream has no equivalent). */
export interface SamplingLimits {
  /** Stop sequences; empty when the request has none. */
  stops: string[];
  /** Completion-token cap (`max_completion_tokens` ?? `max_tokens`), or null. */
  maxTokens: number | null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Request validation for the sampling parameters. Returns the OpenAI-shaped
 * error to answer with, or null when the values are usable.
 *
 * These are validated instead of ignored: a `max_tokens` the gateway cannot
 * honour, or a malformed `stop`, must fail loudly — silently dropping them is
 * how the cap became advisory in the first place.
 */
export function samplingParamError(
  req: ChatCompletionRequest | undefined
): ParamError | null {
  const raw = rawRequestParams(req);
  const params: Array<[string, unknown]> = [
    ['max_tokens', raw.max_tokens],
    ['max_completion_tokens', raw.max_completion_tokens],
  ];
  for (const [param, value] of params) {
    if (value === undefined || value === null) continue;
    if (!isPositiveInteger(value)) {
      return {
        message: `Invalid '${param}': expected a positive integer`,
        param,
      };
    }
  }
  const stop = raw.stop;
  if (stop !== undefined && stop !== null && typeof stop !== 'string') {
    if (!Array.isArray(stop)) {
      return {
        message: "Invalid 'stop': expected a string or an array of strings",
        param: 'stop',
      };
    }
    if (stop.length > MAX_STOP_SEQUENCES) {
      return {
        message: `Invalid 'stop': expected at most ${MAX_STOP_SEQUENCES} sequences`,
        param: 'stop',
      };
    }
    if (stop.some((s) => typeof s !== 'string')) {
      return {
        message: "Invalid 'stop': expected a string or an array of strings",
        param: 'stop',
      };
    }
  }
  return null;
}

/**
 * Request validation for the response-shape parameters, which the gateway
 * cannot honour and must therefore reject.
 *
 * These differ from the sampling knobs in README's "accepted but ignored"
 * list: `temperature`/`top_p`/`seed` only bend the text, so forwarding a value
 * the upstream drops leaves a slightly different but well-typed reply. `n` and
 * `logprobs` change the *structure* of the reply — a client parsing
 * `choices[n-1]` or `choices[0].logprobs.content` reads `undefined` or runs off
 * the array end when the gateway answers one plain choice. Answering 400 is the
 * only honest option for a single-session anonymous upstream, and it matches
 * how `max_tokens`/`stop` are handled next door.
 *
 * Validation happens before any upstream work so a rejected request costs
 * nothing.
 */
export function responseShapeParamError(
  req: ChatCompletionRequest | undefined
): ParamError | null {
  const raw = rawRequestParams(req);
  const n = raw.n;
  if (n !== undefined && n !== null) {
    // Only `1` is honourable: one conversation yields one reply. Any other
    // value is either unsatisfiable (n > 1) or illegal (n <= 0, non-integer,
    // non-number) — both answered with 400, and the message says which.
    if (!isPositiveInteger(n)) {
      return { message: "Invalid 'n': expected a positive integer", param: 'n' };
    }
    if (n !== 1) {
      return {
        message: `Unsupported parameter: 'n' > 1 is not supported by this gateway`,
        param: 'n',
        code: 'unsupported_parameter',
      };
    }
  }

  const logprobs = raw.logprobs;
  const topLogprobs = raw.top_logprobs;
  if (logprobs !== undefined && logprobs !== null && typeof logprobs !== 'boolean') {
    return { message: "Invalid 'logprobs': expected a boolean", param: 'logprobs' };
  }
  if (logprobs === true) {
    // The upstream SSE carries no token-level probabilities, so there is no
    // value the field could honestly hold.
    return {
      message: `Unsupported parameter: 'logprobs' is not supported by this gateway`,
      param: 'logprobs',
      code: 'unsupported_parameter',
    };
  }
  if (topLogprobs !== undefined && topLogprobs !== null) {
    // `top_logprobs` is a companion of `logprobs`; without it the request asks
    // for nothing the upstream can return, and accepting it silently is the
    // same trap one level down.
    if (logprobs !== false) {
      return {
        message: `Unsupported parameter: 'top_logprobs' requires 'logprobs' to be useful, and 'logprobs' is not supported by this gateway`,
        param: 'top_logprobs',
        code: 'unsupported_parameter',
      };
    }
  }

  const { response_format: responseFormat, modalities, audio } = raw;

  // `response_format`: the upstream answers free text, with no JSON mode. A
  // `json_object`/`json_schema` request honoured only by a prompt hint would
  // sometimes emit a JSON document and sometimes prose — a coin flip the
  // client cannot detect before its own JSON.parse throws. `text` is the
  // default and therefore honourable; everything else is a rejection.
  if (responseFormat !== undefined && responseFormat !== null) {
    if (typeof responseFormat !== 'object' || Array.isArray(responseFormat)) {
      return {
        message:
          "Invalid 'response_format': expected an object with a 'type' of \"text\", \"json_object\", or \"json_schema\"",
        param: 'response_format',
      };
    }
    let type: unknown;
    if ('type' in responseFormat) {
      type = responseFormat.type;
    }
    if (type === 'json_object' || type === 'json_schema') {
      return {
        message: `Unsupported parameter: 'response_format' type "${type}" is not supported by this gateway, which cannot guarantee a JSON document`,
        param: 'response_format',
        code: 'unsupported_parameter',
      };
    }
    // `text` is the OpenAI default, so it asks for nothing the gateway cannot
    // do. Any other value (including a missing one) names a shape it cannot
    // produce, and a typo must not read as a silent acceptance.
    if (type !== 'text') {
      return {
        message:
          "Invalid 'response_format': expected an object with a 'type' of \"text\", \"json_object\", or \"json_schema\"",
        param: 'response_format',
      };
    }
  }

  // `modalities`: only `text` is producible. Any list naming `audio` would be
  // answered without `choices[0].message.audio`, which a caller reading that
  // field sees as `undefined` — silent failure, so reject.
  if (modalities !== undefined && modalities !== null) {
    if (
      !Array.isArray(modalities) ||
      modalities.length === 0 ||
      modalities.some((m) => m !== 'text' && m !== 'audio')
    ) {
      return {
        message: "Invalid 'modalities': expected a non-empty array containing only \"text\" or \"audio\"",
        param: 'modalities',
      };
    }
    if (modalities.includes('audio')) {
      return {
        message: `Unsupported parameter: 'modalities' entry "audio" is not supported by this gateway`,
        param: 'modalities',
        code: 'unsupported_parameter',
      };
    }
  }

  // `audio` output config is meaningless without audio output; its presence
  // means the caller expects `choices[0].message.audio` back.
  if (audio !== undefined && audio !== null) {
    if (typeof audio !== 'object' || Array.isArray(audio)) {
      return {
        message: "Invalid 'audio': expected an object with 'voice' and 'format'",
        param: 'audio',
      };
    }
    return {
      message: "Unsupported parameter: 'audio' output is not supported by this gateway",
      param: 'audio',
      code: 'unsupported_parameter',
    };
  }

  return null;
}

/**
 * resolveSampling extracts the enforceable limits from a request. Values that
 * failed `samplingParamError` are treated as absent (the caller answered 400).
 * Empty stop strings are dropped: they match at index 0 and would truncate
 * every reply to nothing.
 */
export function resolveSampling(req?: ChatCompletionRequest): SamplingLimits {
  const raw = rawRequestParams(req);
  const stops: string[] = [];
  if (typeof raw.stop === 'string') {
    if (raw.stop !== '') stops.push(raw.stop);
  } else if (Array.isArray(raw.stop)) {
    for (const s of raw.stop) {
      if (typeof s === 'string' && s !== '') stops.push(s);
    }
  }
  const cap = raw.max_completion_tokens ?? raw.max_tokens;
  return {
    stops: stops.slice(0, MAX_STOP_SEQUENCES),
    maxTokens: isPositiveInteger(cap) ? cap : null,
  };
}

/**
 * stopPrefixSuffix returns the longest suffix of `text` that is a *proper*
 * prefix of one of `stops` — text that could still turn into a stop sequence
 * when the next snapshot arrives. It must be withheld: emitting it now would
 * leak half a stop into the client, which cannot be retracted.
 */
export function stopPrefixSuffix(text: string, stops: string[]): string {
  let best = '';
  if (!text || stops.length === 0) return best;
  for (const stop of stops) {
    const maxLen = Math.min(stop.length - 1, text.length);
    for (let len = maxLen; len > best.length; len--) {
      if (text.endsWith(stop.slice(0, len))) {
        best = stop.slice(0, len);
        break;
      }
    }
  }
  return best;
}

/**
 * tokenBudgetPrefixLength returns the longest prefix of `text` whose rough
 * token count stays within `maxTokens`. countRoughTokens is monotonic
 * non-decreasing over prefixes, so a binary search finds that prefix exactly.
 *
 * The result is a UTF-16 code-unit offset, so the longest fitting prefix can
 * end between the two units of one astral character. That prefix is backed off
 * to the pair boundary: `text.slice()` of half a pair yields a lone surrogate,
 * which serialises as a legal `\ud83d` escape but decodes to a string no strict
 * UTF-8 encoder accepts. Shortening the prefix only lowers the token count, so
 * the budget still holds.
 */
export function tokenBudgetPrefixLength(text: string, maxTokens: number): number {
  if (countRoughTokens(text) <= maxTokens) return text.length;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countRoughTokens(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return backOffSurrogateSplit(text, lo);
}

/**
 * backOffSurrogateSplit moves a cut that lands between the two code units of
 * one surrogate pair back by one unit, so the retained prefix ends on a code
 * point boundary. A cut anywhere else is returned unchanged: a lone surrogate
 * already inside `text` is upstream's bytes, not something slicing created.
 */
function backOffSurrogateSplit(text: string, cut: number): number {
  if (cut <= 0 || cut >= text.length) return cut;
  const high = text.charCodeAt(cut - 1);
  const low = text.charCodeAt(cut);
  const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return splitsPair ? cut - 1 : cut;
}

/**
 * SamplingLimiter enforces stop sequences and the completion-token cap on the
 * cumulative reply text. Upstream has no knob for either, so the gateway must
 * cut the text it replays.
 *
 * The cut is latched: once a stop sequence or the cap fires, every later
 * snapshot is sliced to the same length, so nothing after the cut can leak —
 * upstream keeps generating (and re-sending longer snapshots) after we stop.
 */
export class SamplingLimiter {
  private cutAt = Infinity;
  private finish: 'stop' | 'length' | null = null;

  constructor(private readonly limits: SamplingLimits) {}

  /**
   * Truncate the cumulative reply text to the latched cut, if any.
   *
   * Whichever bound comes FIRST wins: a stop sequence that occurs after the
   * cap position must not rescue text the token budget already disallowed.
   * Cut at min(stop position, cap prefix) and report the finish reason of
   * the binding constraint (stop and cap meeting at the same position count
   * as a stop — the sequence was generated, the budget merely ran out).
   */
  limit(text: string): string {
    if (this.cutAt !== Infinity) return text.slice(0, this.cutAt);

    const stopAt = this.stopIndex(text);
    const cap = this.limits.maxTokens;
    let capAt = -1;
    if (cap !== null) {
      const len = tokenBudgetPrefixLength(text, cap);
      if (len < text.length) capAt = len;
    }

    if (stopAt >= 0 && (capAt < 0 || stopAt <= capAt)) {
      this.cutAt = stopAt;
      this.finish = 'stop';
      return text.slice(0, stopAt);
    }
    if (capAt >= 0) {
      this.cutAt = capAt;
      this.finish = 'length';
      return text.slice(0, capAt);
    }
    return text;
  }

  /** Finish reason forced by a fired limit, or null while the reply is live. */
  limitFinish(): 'stop' | 'length' | null {
    return this.finish;
  }

  /** Forget a latched cut: a new live message starts a fresh reply. */
  reset(): void {
    this.cutAt = Infinity;
    this.finish = null;
  }

  /**
   * Adopt a finish reason computed elsewhere (an aggregated non-stream
   * result replayed as a stream): the text arrives already truncated, so
   * this limiter's own scan cannot see that the cap fired. cutAt stays
   * untouched — nothing further needs cutting.
   */
  latchFinish(reason: 'stop' | 'length'): void {
    this.finish = reason;
  }

  get stops(): string[] {
    return this.limits.stops;
  }

  private stopIndex(text: string): number {
    let idx = -1;
    for (const stop of this.limits.stops) {
      const i = text.indexOf(stop);
      if (i >= 0 && (idx < 0 || i < idx)) idx = i;
    }
    return idx;
  }
}
