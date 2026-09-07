import * as v from 'valibot';
import type { CodingAdapterEvents } from './contract.ts';

// Kilo 7.4.23 run.ts emits these envelopes; these are not Codex events or
// server SSE messages. Limits apply even when this parser is used without IO.
const identifier = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,256}$/));
const session = v.pipe(identifier, v.startsWith('ses_'));
const finite = v.pipe(v.number(), v.finite(), v.minValue(0));
const envelope = v.object({
  type: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  timestamp: finite,
  sessionID: session,
});
const partIdentity = {
  id: identifier,
  sessionID: session,
  messageID: identifier,
};
const start = v.object({
  part: v.object({ ...partIdentity, type: v.literal('step-start') }),
});
const finish = v.object({
  part: v.object({
    ...partIdentity,
    type: v.literal('step-finish'),
    reason: v.picklist([
      'stop',
      'tool-calls',
      'length',
      'content-filter',
      'error',
      'other',
      'unknown',
    ]),
    cost: finite,
    tokens: v.object({
      input: finite,
      output: finite,
      reasoning: finite,
      cache: v.object({ read: finite, write: finite }),
    }),
  }),
});
const text = v.object({
  part: v.object({
    ...partIdentity,
    type: v.picklist(['text', 'reasoning']),
    text: v.pipe(v.string(), v.maxLength(1024 * 1024)),
  }),
});
const tool = v.object({
  part: v.object({
    ...partIdentity,
    type: v.literal('tool'),
    callID: identifier,
    tool: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    state: v.object({ status: v.picklist(['completed', 'error']) }),
  }),
});
const error = v.object({
  error: v.union([
    v.pipe(v.string(), v.minLength(1), v.maxLength(64 * 1024)),
    v.object({ name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)) }),
  ]),
});

function boundedJson(line: string): unknown {
  if (Buffer.byteLength(line) > 1024 * 1024)
    throw new Error('Kilo event exceeds line limit');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of line) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (++depth > 32) throw new Error('Kilo event exceeds nesting limit');
    } else if (char === '}' || char === ']') depth--;
  }
  return JSON.parse(line);
}

export class KiloEvents implements CodingAdapterEvents {
  sessionId: string | null = null;
  terminal: 'completed' | 'failed' | null = null;
  private activeMessage: string | null = null;
  private settlingMessage: string | null = null;
  private eventCount = 0;
  private bytes = 0;
  private invalid = false;
  private ids = new Set<string>();

  accept(line: string): void {
    if (this.invalid) throw new Error('Kilo stream already invalid');
    try {
      this.bytes += Buffer.byteLength(line);
      if (++this.eventCount > 10_000 || this.bytes > 16 * 1024 * 1024)
        throw new Error('Kilo stream exceeds parser limits');
      this.consume(boundedJson(line));
    } catch {
      this.invalid = true;
      this.terminal = null;
      // Do not include untrusted event text, secrets or paths in diagnostics.
      throw new Error('Invalid Kilo event stream');
    }
  }

  private consume(raw: unknown): void {
    const event = v.parse(envelope, raw);
    if (this.terminal) throw new Error('Kilo event after terminal');
    if (this.sessionId && this.sessionId !== event.sessionID)
      throw new Error('Foreign Kilo session');
    if (event.type === 'error') {
      v.parse(error, raw);
      this.sessionId ??= event.sessionID;
      this.terminal = 'failed';
      return;
    }
    if (event.type === 'step_start') {
      const { part } = v.parse(start, raw);
      this.checkPart(part, event.sessionID);
      if (this.activeMessage) throw new Error('Overlapping Kilo step');
      this.sessionId ??= event.sessionID;
      this.activeMessage = part.messageID;
      this.settlingMessage = null;
      return;
    }
    if (event.type === 'step_finish') {
      const { part } = v.parse(finish, raw);
      this.checkPart(part, event.sessionID);
      if (!this.sessionId || this.activeMessage !== part.messageID)
        throw new Error('Unstarted Kilo step');
      this.activeMessage = null;
      // Tagged native-runtime.ts appends queued tool settlements after the
      // provider stream (including step-finish), before the next model step.
      this.settlingMessage =
        part.reason === 'tool-calls' ? part.messageID : null;
      if (part.reason === 'stop') this.terminal = 'completed';
      else if (part.reason !== 'tool-calls') this.terminal = 'failed';
      return;
    }
    if (
      event.type === 'text' ||
      event.type === 'reasoning' ||
      event.type === 'tool_use'
    ) {
      const { part } =
        event.type === 'tool_use' ? v.parse(tool, raw) : v.parse(text, raw);
      this.checkPart(part, event.sessionID);
      const belongsToStep =
        this.activeMessage === part.messageID ||
        (event.type === 'tool_use' && this.settlingMessage === part.messageID);
      if (!this.sessionId || !belongsToStep)
        throw new Error('Kilo part outside active step');
      if (event.type !== 'tool_use' && part.type !== event.type)
        throw new Error('Kilo part type mismatch');
    }
    // Unknown informational envelopes establish neither provenance nor success.
  }

  private checkPart(
    part:
      | v.InferOutput<typeof start>['part']
      | v.InferOutput<typeof finish>['part']
      | v.InferOutput<typeof text>['part']
      | v.InferOutput<typeof tool>['part'],
    root: string,
  ): void {
    if (part.sessionID !== root || this.ids.has(part.id))
      throw new Error('Foreign or duplicate Kilo part');
    this.ids.add(part.id);
  }
}
