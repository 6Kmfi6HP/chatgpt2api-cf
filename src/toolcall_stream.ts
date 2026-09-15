import { tryParseToolCall, stripGenuiMarkers, type ParsedToolCall } from './toolcall';

/**
 * Streaming tool-call detection for the OpenAI-compatible gateway.
 *
 * Strategy = bounded-delay判定. The gateway feeds every cumulative upstream
 * snapshot (full text so far, not increments). The detector buffers while the
 * text could still resolve into the single-line tool-call JSON convention and
 * flushes as soon as it is provably a plain reply.
 */

export const DEFAULT_MAX_TOOLCALL_BUFFER = 1200;

const TOOLCALL_OPENERS = ['{', '```'];

export interface DetectorDecision {
  decision: 'buffer' | 'flush' | 'emit_tool_calls';
  toolCalls?: ParsedToolCall[];
  text?: string;
}

export class ToolCallStreamDetector {
  private readonly maxBuffer: number;
  private flushed = false;
  private emitted = false;

  constructor(options?: { maxBuffer?: number }) {
    const mb = options?.maxBuffer;
    this.maxBuffer =
      typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_TOOLCALL_BUFFER;
  }

  /** Sticky: once flushed/emitted the detector never returns to buffering. */
  private isSettled(): boolean {
    return this.flushed || this.emitted;
  }

  feed(accumulatedText: string): DetectorDecision {
    if (this.flushed) {
      return { decision: 'flush', text: '' };
    }
    if (this.emitted) {
      return { decision: 'flush', text: '' };
    }

    const raw = accumulatedText ?? '';
    const trimmed = raw.trim();

    // Empty / whitespace-only: keep buffering (nothing decidable yet).
    if (trimmed.length === 0) {
      return { decision: 'buffer' };
    }

    // Fast rejection: a plain reply never opens with { or ```.
    const firstChar = trimmed[0];
    if (!TOOLCALL_OPENERS.includes(firstChar) && !trimmed.startsWith('```json')) {
      this.flushed = true;
      return { decision: 'flush', text: raw };
    }

    // Oversize: no tool-call convention reply exceeds this.
    if (raw.length > this.maxBuffer) {
      // Could still be a malformed tool call JSON — but per protocol replies
      // are small; treat as plain text and flush.
      this.flushed = true;
      return { decision: 'flush', text: raw };
    }

    // Try a complete parse. tryParseToolCall only succeeds on full JSON.
    const cleaned = stripGenuiMarkers(raw);
    const parsed = tryParseToolCall(cleaned);
    if (parsed) {
      this.emitted = true;
      return { decision: 'emit_tool_calls', toolCalls: parsed };
    }

    // Incomplete JSON: keep buffering while small enough.
    return { decision: 'buffer' };
  }
}


export interface StreamEmit {
  delta?: Record<string, any>;
  finish_reason?: 'stop' | 'length' | 'tool_calls' | null;
}

/** Random [a-zA-Z0-9] string of length n via crypto (Workers-safe). */
function randToken(n: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < n; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function newCallId(): string {
  return 'call_' + randToken(22);
}

/**
 * Full integration state machine for the gateway StreamProcessor. Feed each
 * cumulative upstream snapshot; receive ready-to-send OpenAI chunks.
 */
export class ToolCallStreamState {
  public emittedToolCalls = false;
  public flushing = false;
  public lastEmittedLen = 0;
  private detector: ToolCallStreamDetector;

  constructor(options?: { maxBuffer?: number }) {
    this.detector = new ToolCallStreamDetector(options);
  }

  feed(accumulated: string): StreamEmit[] {
    const decision = this.detector.feed(accumulated);

    if (decision.decision === 'buffer') {
      return [];
    }

    if (decision.decision === 'flush') {
      this.flushing = true;
      // After tool calls were emitted the accumulated text is the tool-call
      // JSON itself — never leak it as content.
      if (this.emittedToolCalls) {
        this.lastEmittedLen = (accumulated ?? '').length;
        return [];
      }
      // Emit the delta between what we already sent and the full text.
      const text = accumulated ?? '';
      if (text.length > this.lastEmittedLen) {
        const delta = text.slice(this.lastEmittedLen);
        this.lastEmittedLen = text.length;
        return [{ delta: { content: delta } }];
      }
      return [];
    }

    // emit_tool_calls
    this.emittedToolCalls = true;
    this.flushing = true;
    const out: StreamEmit[] = [];
    // The accumulated text IS the tool-call JSON — never leak it as content.
    // (Any stray leading prose would have triggered 'flush' earlier.)
    void stripGenuiMarkers;
    const calls = decision.toolCalls ?? [];
    calls.forEach((c, i) => {
      out.push({
        delta: {
          tool_calls: [
            {
              index: i,
              id: newCallId(),
              type: 'function',
              function: { name: c.name, arguments: c.arguments },
            },
          ],
        },
      });
    });
    return out;
  }

  /** Finish reason for the gateway flush stage. */
  finishReason(): 'tool_calls' | 'stop' {
    return this.emittedToolCalls ? 'tool_calls' : 'stop';
  }
}
