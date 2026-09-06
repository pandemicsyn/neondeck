import { describe, expect, it } from 'vitest';
import { executionDurationFromReceipt } from './execution-usage';

const receipt = {
  version: 1,
  attemptId: 'fixture-attempt',
  nonce: 'fixture-nonce',
  // Written/observed the next morning, independently of execution endpoints.
  at: 86_500_000,
  startedAt: 100_000,
  endedAt: 400_000,
  supervisor: { pid: 1, pgid: 1, start: 'fixture', command: 'fixture' },
  group: { pid: 2, pgid: 2, start: 'fixture', command: 'fixture' },
  state: 'finished',
  reason: null,
  exitCode: 0,
  signal: null,
  sessionId: 'fixture-session',
  terminal: 'completed',
  outputBytes: 0,
  noWriter: true,
  authCleanup: 'removed',
};

describe('authenticated execution duration decoding', () => {
  it('charges the actual five-minute execution, not overnight collection delay', () => {
    expect(executionDurationFromReceipt(receipt)).toBe(300000);
    expect(
      executionDurationFromReceipt({ ...receipt, at: receipt.at + 86400000 }),
    ).toBe(300000);
  });
  it('preserves unknown usage for legacy or lost-supervisor endpoints', () => {
    const { startedAt: _start, endedAt: _end, ...legacy } = receipt;
    expect(executionDurationFromReceipt(legacy)).toBeNull();
    expect(
      executionDurationFromReceipt({
        ...receipt,
        endedAt: null,
        reason: 'supervisor-lost',
      }),
    ).toBeNull();
    expect(
      executionDurationFromReceipt({
        ...receipt,
        startedAt: null,
        endedAt: null,
        reason: 'supervisor-lost',
      }),
    ).toBeNull();
  });
  it('reports zero only when the host proves it never launched a provider', () => {
    expect(
      executionDurationFromReceipt({
        ...receipt,
        startedAt: null,
        endedAt: null,
        group: null,
        reason: 'host-preflight-failed',
      }),
    ).toBe(0);
    expect(
      executionDurationFromReceipt({
        ...receipt,
        state: 'running',
        noWriter: false,
      }),
    ).toBeNull();
  });
  it('rejects contradictory signed endpoints instead of inventing usage', () => {
    expect(() =>
      executionDurationFromReceipt({ ...receipt, endedAt: 99999 }),
    ).toThrow('inconsistent');
    expect(() =>
      executionDurationFromReceipt({ ...receipt, endedAt: receipt.at + 1 }),
    ).toThrow('inconsistent');
  });
});
