import { tryParseToolCall, stripGenuiMarkers, selectSingleToolCall, type ParsedToolCall } from './toolcall';

/**
 * Streaming tool-call detection for the OpenAI-compatible gateway.
 *
 * Strategy = bounded-delay判定. The gateway feeds every cumulative upstream
 * snapshot (full text so far, not increments). The detector buffers while the
 * text could still resolve into the single-line tool-call JSON convention and
 * flushes as soon as it is provably a plain reply.
 */

export const DEFAULT_MAX_TOOLCALL_BUFFER = 1200;

export interface DetectorDecision {
  decision: 'buffer' | 'flush' | 'emit_tool_calls';
  toolCalls?: ParsedToolCall[];
  text?: string;
}

export class ToolCallStreamDetector {
  private readonly maxBuffer: number;
  private flushed = false;
  private emitted = false;
  /** Latest accumulated text, kept so finalize() can release a stuck buffer. */
  private lastText = '';

  constructor(options?: { maxBuffer?: number }) {
    const mb = options?.maxBuffer;
    this.maxBuffer =
      typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_TOOLCALL_BUFFER;
  }

  feed(accumulatedText: string): DetectorDecision {
    this.lastText = accumulatedText;

    if (this.flushed || this.emitted) {
      return { decision: 'flush', text: '' };
    }

    const raw = accumulatedText;
    const trimmed = raw.trim();

    // Empty / whitespace-only: keep buffering (nothing decidable yet).
    if (trimmed.length === 0) {
      return { decision: 'buffer' };
    }

    // Fast rejection: a plain reply never opens with { or a ```json fence.
    // (The old TOOLCALL_OPENERS.includes(firstChar) check could never match
    // its '```' element — firstChar is one char — so spelling out '{' plus
    // the ```json prefix below preserves the exact original semantics.)
    const firstChar = trimmed[0];
    if (firstChar !== '{' && !trimmed.startsWith('```json')) {
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

  /**
   * Terminal decision once no more snapshots can arrive.
   *
   * `feed` may only ever answer "buffer" for text it cannot resolve: a plain
   * JSON reply that is not the tool-call convention ("{"answer": 42}") parses
   * to null forever, and nothing else triggers a decision before the turn
   * ends. Buffering is a withholding optimization for content that MIGHT turn
   * into a tool call — it must never outlive the turn, or the whole reply is
   * dropped from a 200 response. So the held text is released as content.
   */
  finalize(): DetectorDecision {
    if (this.flushed || this.emitted) {
      return { decision: 'flush', text: '' };
    }
    this.flushed = true;
    return { decision: 'flush', text: this.lastText };
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
  /** Latest cumulative snapshot, so finalize() can release what feed() held. */
  private lastAccumulated = '';
  private readonly singleCall: boolean;
  private readonly preferredName: string | null;

  constructor(options?: { maxBuffer?: number; singleCall?: boolean; preferredName?: string | null }) {
    this.detector = new ToolCallStreamDetector(options);
    this.singleCall = options?.singleCall === true;
    this.preferredName = options?.preferredName ?? null;
  }

  feed(accumulated: string): StreamEmit[] {
    this.lastAccumulated = accumulated;
    const decision = this.detector.feed(accumulated);

    if (decision.decision === 'buffer') {
      return [];
    }

    if (decision.decision === 'flush') {
      return this.emitContent(accumulated);
    }

    // emit_tool_calls
    this.emittedToolCalls = true;
    this.flushing = true;
    const out: StreamEmit[] = [];
    // The accumulated text IS the tool-call JSON — never leak it as content.
    // (Any stray leading prose would have triggered 'flush' earlier.)
    // parallel_tool_calls:false keeps one call; indexes restart at 0 so the
    // client sees a single, contiguous call rather than a gap.
    const parsed = decision.toolCalls ?? [];
    const calls = this.singleCall ? selectSingleToolCall(parsed, this.preferredName) : parsed;
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

  /**
   * Terminal drain for the turn. `feed` withholds text that might still resolve
   * into the tool-call convention; when the turn ends unresolved (a plain JSON
   * reply such as `{"answer": 42}`) that withheld text is real assistant
   * content and must be emitted, not discarded.
   */
  finalize(): StreamEmit[] {
    const decision = this.detector.finalize();
    if (decision.decision !== 'flush') return [];
    return this.emitContent(this.lastAccumulated);
  }

  /** Emit the not-yet-sent suffix of `accumulated` as one content delta. */
  private emitContent(accumulated: string): StreamEmit[] {
    this.flushing = true;
    // After tool calls were emitted the accumulated text is the tool-call
    // JSON itself — never leak it as content.
    if (this.emittedToolCalls) {
      this.lastEmittedLen = accumulated.length;
      return [];
    }
    if (accumulated.length > this.lastEmittedLen) {
      const delta = accumulated.slice(this.lastEmittedLen);
      this.lastEmittedLen = accumulated.length;
      return [{ delta: { content: delta } }];
    }
    return [];
  }

  /** Finish reason for the gateway flush stage. */
  finishReason(): 'tool_calls' | 'stop' {
    return this.emittedToolCalls ? 'tool_calls' : 'stop';
  }
}
