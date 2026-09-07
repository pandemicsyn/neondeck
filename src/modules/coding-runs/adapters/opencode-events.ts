import * as v from 'valibot';
import type { CodingAdapterEvents } from './contract.ts';

const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,256}$/));
const count = v.pipe(v.number(), v.finite(), v.minValue(0));
const envelope = v.object({
  type: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  timestamp: count,
  sessionID: identifier,
});
const part = { id: identifier, sessionID: identifier, messageID: identifier };
const start = v.object({ ...part, type: v.literal('step-start') });
const finish = v.object({
  ...part,
  type: v.literal('step-finish'),
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  cost: count,
  tokens: v.object({
    total: v.optional(count),
    input: count,
    output: count,
    reasoning: count,
    cache: v.object({ read: count, write: count }),
  }),
});
const textPart = v.object({
  ...part,
  type: v.picklist(['text', 'reasoning']),
  text: v.pipe(v.string(), v.maxLength(1024 * 1024)),
  time: v.object({ start: count, end: count }),
});
const tool = v.object({
  ...part,
  type: v.literal('tool'),
  tool: identifier,
  callID: identifier,
  state: v.variant('status', [
    v.object({
      status: v.literal('completed'),
      output: v.string(),
      time: v.object({ start: count, end: count }),
    }),
    v.object({
      status: v.literal('error'),
      error: v.string(),
      time: v.object({ start: count, end: count }),
    }),
  ]),
});
const payload = v.object({ part: v.unknown() });

// Validate lexical depth before JSON.parse; ignored extension fields are bounded too.
function boundedJson(line: string): unknown {
  if (Buffer.byteLength(line) > 1024 * 1024)
    throw new Error('OpenCode event exceeds line limit');
  let depth = 0;
  let quoted = false;
  let escape = false;
  for (const char of line) {
    if (quoted) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') {
      if (++depth > 32) throw new Error('OpenCode event exceeds nesting limit');
    } else if (char === ']' || char === '}') depth--;
  }
  return JSON.parse(line);
}

/** OpenCode 1.18.29 run JSONL, not the SDK's session event stream. */
export class OpenCodeEvents implements CodingAdapterEvents {
  sessionId: string | null = null;
  terminal: 'completed' | 'failed' | null = null;
  private message: string | null = null;
  private activeStep = false;
  private failed = false;
  private bytes = 0;
  private events = 0;
  private readonly parts = new Set<string>();

  accept(line: string): void {
    try {
      this.consume(line);
    } catch {
      this.failed = true;
      this.terminal = 'failed';
      // Never include provider text or Valibot input in public diagnostics.
      throw new Error('Invalid or contradictory OpenCode event stream');
    }
  }

  private consume(line: string): void {
    this.bytes += Buffer.byteLength(line);
    if (this.failed || ++this.events > 100_000 || this.bytes > 64 * 1024 * 1024)
      throw new Error('OpenCode stream limit');
    const raw = boundedJson(line);
    const event = v.parse(envelope, raw);
    if (this.sessionId !== null && event.sessionID !== this.sessionId)
      throw new Error('Foreign OpenCode session');
    if (this.terminal) throw new Error('Event after OpenCode terminal');

    if (event.type === 'error') {
      v.parse(
        v.object({
          error: v.object({
            name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
          }),
        }),
        raw,
      );
      this.sessionId ??= event.sessionID;
      this.terminal = 'failed';
      return;
    }
    if (
      !['step_start', 'step_finish', 'tool_use', 'text', 'reasoning'].includes(
        event.type,
      )
    )
      return;
    const body = v.parse(payload, raw).part;
    const identity = v.parse(v.object(part), body);
    if (identity.sessionID !== event.sessionID || this.parts.has(identity.id))
      throw new Error('OpenCode part identity mismatch');
    this.parts.add(identity.id);
    if (event.type === 'step_start') {
      v.parse(start, body);
      if (this.activeStep) throw new Error('Overlapping OpenCode step');
      this.sessionId ??= event.sessionID;
      this.message = identity.messageID;
      this.activeStep = true;
      return;
    }
    if (!this.sessionId || identity.messageID !== this.message)
      throw new Error('OpenCode part without matching step');
    if (event.type === 'step_finish') {
      const value = v.parse(finish, body);
      if (!this.activeStep) throw new Error('OpenCode finish without start');
      this.activeStep = false;
      if (value.reason === 'tool-calls') return;
      this.terminal = value.reason === 'stop' ? 'completed' : 'failed';
    } else if (event.type === 'tool_use') {
      v.parse(tool, body);
      // A tool failure can be repaired by the following model turn.
    } else {
      const value = v.parse(textPart, body);
      if (value.type !== event.type || !this.activeStep)
        throw new Error('Unexpected OpenCode text part');
    }
  }
}
