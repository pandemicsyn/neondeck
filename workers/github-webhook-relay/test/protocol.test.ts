import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
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
});
