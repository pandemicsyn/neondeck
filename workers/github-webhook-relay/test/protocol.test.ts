import { describe, expect, it } from 'vitest';
import { jsonObjectSchema, jsonValueSchema } from '../src/json';
import {
  clientControlFrameSchema,
  githubWebhookEnvelopeSchema,
} from '../src/protocol';

describe('protocol validation', () => {
  it('rejects non-finite, non-JSON, cyclic, and sparse values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse: unknown[] = [];
    sparse.length = 1;

    expect(jsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(
      false,
    );
    expect(jsonValueSchema.safeParse(1n).success).toBe(false);
    expect(jsonObjectSchema.safeParse(cyclic).success).toBe(false);
    expect(jsonValueSchema.safeParse(sparse).success).toBe(false);
  });

  it('rejects unknown protocol fields', () => {
    expect(
      clientControlFrameSchema.safeParse({
        version: 1,
        type: 'ping',
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      githubWebhookEnvelopeSchema.safeParse({
        version: 1,
        type: 'github.webhook',
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});
