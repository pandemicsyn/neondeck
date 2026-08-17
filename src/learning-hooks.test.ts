import type { FlueObservationSubscriber } from '@flue/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimePaths } from './runtime-home';
import {
  installFlueObservationHandlers,
  resetFlueObservationHandlersForTests,
} from './server/learning-hooks';

afterEach(() => {
  resetFlueObservationHandlersForTests();
});

describe('Flue v3 observation handlers', () => {
  it('installs one subscriber per runtime home and unsubscribes all', () => {
    const unsubscribers = [vi.fn<() => void>(), vi.fn<() => void>()];
    let subscriptionCount = 0;
    const observe = vi.fn<
      (subscriber: FlueObservationSubscriber) => () => void
    >((_: FlueObservationSubscriber) => {
      const unsubscribe =
        unsubscribers[subscriptionCount] ?? vi.fn<() => void>();
      subscriptionCount += 1;
      return unsubscribe;
    });

    installFlueObservationHandlers(runtimePaths('/tmp/neondeck-a'), {
      observe,
    });
    installFlueObservationHandlers(runtimePaths('/tmp/neondeck-a'), {
      observe,
    });
    installFlueObservationHandlers(runtimePaths('/tmp/neondeck-b'), {
      observe,
    });

    expect(observe).toHaveBeenCalledTimes(2);
    resetFlueObservationHandlersForTests();
    expect(unsubscribers[0]).toHaveBeenCalledTimes(1);
    expect(unsubscribers[1]).toHaveBeenCalledTimes(1);
  });

  it('records v3 submission activity for the matching runtime home', async () => {
    let subscriber: FlueObservationSubscriber | undefined;
    const record = vi.fn<() => Promise<void>>(async () => undefined);
    const paths = runtimePaths('/tmp/neondeck-observation-home');
    installFlueObservationHandlers(paths, {
      observe(next) {
        subscriber = next;
        return vi.fn<() => void>();
      },
      recordFlueObservation: record,
    });

    const event = {
      v: 3,
      type: 'submission_queued',
      eventIndex: 1,
      timestamp: '2026-08-01T10:00:00.000Z',
      submissionId: 'submission-1',
      agentName: 'display-assistant',
      instanceId: 'session-1',
      kind: 'dispatch',
    } as const;
    await subscriber?.(event, {
      env: { NEONDECK_HOME: paths.home },
    } as never);
    await subscriber?.({ ...event, submissionId: 'submission-other' }, {
      env: { NEONDECK_HOME: '/tmp/other-home' },
    } as never);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(event, paths);
  });

  it('contains activity persistence failures inside the observer', async () => {
    let subscriber: FlueObservationSubscriber | undefined;
    const paths = runtimePaths('/tmp/neondeck-observation-failure');
    installFlueObservationHandlers(paths, {
      observe(next) {
        subscriber = next;
        return vi.fn<() => void>();
      },
      recordFlueObservation: vi.fn<() => Promise<never>>(async () => {
        throw new Error('activity write failed');
      }),
    });

    await expect(
      subscriber?.(
        {
          v: 3,
          type: 'log',
          eventIndex: 2,
          timestamp: '2026-08-01T10:00:01.000Z',
          submissionId: 'submission-1',
          agentName: 'display-assistant',
          instanceId: 'session-1',
          level: 'info',
          message: 'test activity',
        },
        {} as never,
      ),
    ).resolves.toBeUndefined();
  });

  it('serializes activity persistence in Flue emission order', async () => {
    let subscriber: FlueObservationSubscriber | undefined;
    const paths = runtimePaths('/tmp/neondeck-observation-order');
    const firstWrite = Promise.withResolvers<void>();
    const recorded: number[] = [];
    const recordFlueObservation = vi.fn(
      async (event: { eventIndex: number }) => {
        if (event.eventIndex === 1) await firstWrite.promise;
        recorded.push(event.eventIndex);
      },
    );
    installFlueObservationHandlers(paths, {
      observe(next) {
        subscriber = next;
        return vi.fn<() => void>();
      },
      recordFlueObservation: recordFlueObservation as never,
    });
    const event = {
      v: 3,
      type: 'log',
      eventIndex: 1,
      timestamp: '2026-08-01T10:00:00.000Z',
      submissionId: 'submission-1',
      agentName: 'display-assistant',
      instanceId: 'session-1',
      level: 'info',
      message: 'first',
    } as const;

    const first = subscriber?.(event, {} as never);
    const second = subscriber?.(
      { ...event, eventIndex: 2, message: 'second' },
      {} as never,
    );
    await vi.waitFor(() =>
      expect(recordFlueObservation).toHaveBeenCalledTimes(1),
    );
    firstWrite.resolve();
    await Promise.all([first, second]);

    expect(recorded).toEqual([1, 2]);
  });

  it('admits conversation cadence only from successful direct assistant settlements', async () => {
    let subscriber: FlueObservationSubscriber | undefined;
    const paths = runtimePaths('/tmp/neondeck-learning-settlement');
    const recordConversationTurn = vi.fn(async () => ({
      queued: [],
      turnCount: 1,
      message: 'recorded',
    }));
    installFlueObservationHandlers(paths, {
      observe(next) {
        subscriber = next;
        return vi.fn<() => void>();
      },
      recordFlueObservation: vi.fn(async () => undefined),
      recordConversationTurn,
      isDirectDisplayAssistantSubmission: vi.fn(() => true),
    });

    const settled = {
      v: 3,
      type: 'submission_settled',
      eventIndex: 3,
      timestamp: '2026-08-01T10:00:02.000Z',
      submissionId: 'submission-direct',
      agentName: 'display-assistant',
      instanceId: 'session-1',
      outcome: 'completed',
    } as const;
    await subscriber?.(settled, {} as never);
    await subscriber?.(
      { ...settled, submissionId: 'submission-failed', outcome: 'failed' },
      {} as never,
    );
    await subscriber?.(
      {
        ...settled,
        submissionId: 'submission-review',
        agentName: 'learning-review-agent',
      },
      {} as never,
    );
    await subscriber?.(
      {
        v: 3,
        type: 'operation',
        eventIndex: 4,
        timestamp: '2026-08-01T10:00:03.000Z',
        submissionId: 'submission-direct',
        agentName: 'display-assistant',
        instanceId: 'session-1',
        operationId: 'operation-1',
        operationKind: 'prompt',
        durationMs: 10,
        isError: false,
      },
      {} as never,
    );

    expect(recordConversationTurn).toHaveBeenCalledTimes(1);
    expect(recordConversationTurn).toHaveBeenCalledWith(
      'session-1',
      paths,
      {},
      'submission-direct',
    );
  });
});
