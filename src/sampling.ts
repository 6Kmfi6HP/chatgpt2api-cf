import type { ChatCompletionRequest } from './types';
import { countRoughTokens } from './translate';

/**
 * OpenAI accepts at most this many stop sequences per request.
 * https://platform.openai.com/docs/api-reference/chat/create#chat-create-stop
 */
export const MAX_STOP_SEQUENCES = 4;

/**
 * The sampling parameters read as `unknown`: the decoded request body is
 * untrusted JSON, so a caller can send any type for them. Narrowing happens
 * below instead of trusting the interface.
 */
interface RawSamplingParams {
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  stop?: unknown;
}

function rawSamplingParams(req: ChatCompletionRequest | undefined): RawSamplingParams {
  return (req ?? {}) as RawSamplingParams;
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
): { message: string; param: string } | null {
  const raw = rawSamplingParams(req);
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
 * resolveSampling extracts the enforceable limits from a request. Values that
 * failed `samplingParamError` are treated as absent (the caller answered 400).
 * Empty stop strings are dropped: they match at index 0 and would truncate
 * every reply to nothing.
 */
export function resolveSampling(req?: ChatCompletionRequest): SamplingLimits {
  const raw = rawSamplingParams(req);
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
  return lo;
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

  /** Truncate the cumulative reply text to the latched cut, if any. */
  limit(text: string): string {
    if (this.cutAt !== Infinity) return text.slice(0, this.cutAt);

    const stopAt = this.stopIndex(text);
    if (stopAt >= 0) {
      this.cutAt = stopAt;
      this.finish = 'stop';
      return text.slice(0, stopAt);
    }

    const cap = this.limits.maxTokens;
    if (cap !== null) {
      const len = tokenBudgetPrefixLength(text, cap);
      if (len < text.length) {
        this.cutAt = len;
        this.finish = 'length';
        return text.slice(0, len);
      }
    }
    return text;
  }

  /** Finish reason forced by a fired limit, or null while the reply is live. */
  limitFinish(): 'stop' | 'length' | null {
    return this.finish;
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
