import { AgentRunError } from '@flue/runtime';
import { expect, it, vi } from 'vitest';
import {
  assertReviewerAdmissionWindow,
  admitCandidateReviewWithinDeadline,
  readCandidateReviewWithinDeadline,
  ReviewerDeadlineError,
  ReviewerTerminalError,
  type ReviewerReadHandle,
} from './reviewer-deadline';
it('expires short reserved windows and durably aborts a read that ignores its signal', async () => {
  const abort = vi.fn(async () => {});
  const handle: ReviewerReadHandle = {
    read: () => new Promise(() => {}),
    abort,
  };
  const started = Date.now();
  await expect(
    readCandidateReviewWithinDeadline(handle, 'hung', {
      maxDurationMs: 25,
      deadlineAt: started + 25,
    }),
  ).rejects.toBeInstanceOf(ReviewerDeadlineError);
  expect(abort).toHaveBeenCalledOnce();
  expect(Date.now() - started).toBeLessThan(1500);
});
it.each(['failed', 'aborted'] as const)(
  'distinguishes known terminal %s from unknown usage',
  async (terminalOutcome) => {
    const handle: ReviewerReadHandle = {
      read: async () => {
        throw new AgentRunError({
          outcome: terminalOutcome,
          submissionId: 'known',
        });
      },
      abort: async () => {},
    };
    await expect(
      readCandidateReviewWithinDeadline(handle, 'known', {
        maxDurationMs: 100,
        deadlineAt: Date.now() + 100,
      }),
    ).rejects.toMatchObject({
      terminalOutcome,
      submissionId: 'known',
      usageKnown: false,
      reservedDurationMs: 100,
    });
  },
);
it('expired restart aborts before reattachment and never renews the original window', async () => {
  const order: string[] = [];
  const durable = JSON.parse(
    JSON.stringify({ maxDurationMs: 20, deadlineAt: Date.now() - 1 }),
  );
  const handle: ReviewerReadHandle = {
    read: async () => {
      order.push('read');
      throw new AgentRunError({ outcome: 'aborted', submissionId: 'same' });
    },
    abort: async () => {
      order.push('abort');
    },
  };
  await expect(
    readCandidateReviewWithinDeadline(handle, 'same', durable),
  ).rejects.toBeInstanceOf(ReviewerTerminalError);
  expect(order).toEqual(['abort', 'read']);
  expect(() => assertReviewerAdmissionWindow(durable)).toThrow(
    ReviewerDeadlineError,
  );
  expect(() =>
    assertReviewerAdmissionWindow({
      maxDurationMs: 10,
      deadlineAt: Date.now() + 1000,
    }),
  ).toThrow(ReviewerDeadlineError);
});

it('bounds a hung admission and aborts again if its receipt arrives after expiry', async () => {
  const abort = vi.fn(async () => {});
  const pending = Promise.withResolvers<string>();
  const handle: ReviewerReadHandle = {
    read: () => new Promise(() => {}),
    abort,
  };
  await expect(
    admitCandidateReviewWithinDeadline(
      handle,
      { maxDurationMs: 20, deadlineAt: Date.now() + 20 },
      () => pending.promise,
    ),
  ).rejects.toBeInstanceOf(ReviewerDeadlineError);
  expect(abort).toHaveBeenCalledOnce();
  pending.resolve('late-receipt');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(abort).toHaveBeenCalledTimes(2);
});
it('a transport read failure requests durable abort before returning uncertainty', async () => {
  const abort = vi.fn(async () => {});
  await expect(
    readCandidateReviewWithinDeadline(
      {
        read: async () => {
          throw new Error('transport unavailable');
        },
        abort,
      },
      'same',
      { maxDurationMs: 100, deadlineAt: Date.now() + 100 },
    ),
  ).rejects.toThrow('transport unavailable');
  expect(abort).toHaveBeenCalledOnce();
});
