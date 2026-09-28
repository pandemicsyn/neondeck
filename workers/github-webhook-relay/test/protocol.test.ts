import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { jsonObjectSchema, jsonValueSchema } from '../src/json';
import {
  clientControlFrameSchema,
  extractPrNumber,
  githubWebhookEnvelopeSchema,
  pingFrameText,
  pongFrameText,
} from '../src/protocol';

describe('protocol validation', () => {
  it('rejects non-finite, non-JSON, cyclic, and sparse values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse: unknown[] = [];
    sparse.length = 1;

    expect(v.safeParse(jsonValueSchema, Number.POSITIVE_INFINITY).success).toBe(
      false,
    );
    expect(v.safeParse(jsonValueSchema, 1n).success).toBe(false);
    expect(v.safeParse(jsonObjectSchema, cyclic).success).toBe(false);
    expect(v.safeParse(jsonValueSchema, sparse).success).toBe(false);
  });

  it('rejects unknown protocol fields', () => {
    expect(
      v.safeParse(clientControlFrameSchema, {
        version: 1,
        type: 'ping',
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(githubWebhookEnvelopeSchema, {
        version: 1,
        type: 'github.webhook',
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  // Pins the exact wire bytes, not just their parsed shape. `pingFrameText`
  // and `pongFrameText` are `JSON.stringify(v.parse(...))`, so their bytes
  // depend on field declaration order in `clientControlFrameSchema` /
  // `serverControlFrameSchema` (see the field-order comment on those
  // schemas in src/protocol.ts). `setWebSocketAutoResponse` matches the
  // canonical ping byte-for-byte, and PROTOCOL.md documents this exact
  // string as the wire contract every external client's keepalive relies
  // on. A reorder would keep every schema-shape assertion green while
  // silently breaking the auto-response match — this is the one assertion
  // that would actually catch that.
  it('pins the canonical ping and pong frame bytes', () => {
    expect(pingFrameText).toBe('{"version":1,"type":"ping"}');
    expect(pongFrameText).toBe('{"version":1,"type":"pong"}');
  });
});

describe('extractPrNumber', () => {
  it('reads the PR number from a pull_request payload', () => {
    expect(extractPrNumber({ pull_request: { number: 42 } })).toBe(42);
  });

  it('falls back to an issue payload when pull_request is absent', () => {
    expect(extractPrNumber({ issue: { number: 7 } })).toBe(7);
  });

  it('prefers pull_request.number when both are present', () => {
    expect(
      extractPrNumber({ pull_request: { number: 42 }, issue: { number: 7 } }),
    ).toBe(42);
  });

  it('returns null when neither pull_request nor issue is present', () => {
    expect(
      extractPrNumber({ repository: { full_name: 'owner/repository' } }),
    ).toBeNull();
  });

  it('returns null for a non-positive-integer number field', () => {
    expect(extractPrNumber({ pull_request: { number: 0 } })).toBeNull();
    expect(extractPrNumber({ pull_request: { number: -1 } })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(extractPrNumber(null)).toBeNull();
    expect(extractPrNumber('not an object')).toBeNull();
  });
});
