import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { subscribeNotificationEvents } from './modules/app-state';
import type { GitHubPullRequestEventState } from './modules/github';
import {
  listPrWatchEventWatermarks,
  readPendingPrWatchEventIntake,
  refreshPrWatchEventState,
} from './modules/pr-events';
import {
  categoryWatermark,
  conversationCommentFingerprint,
  watermarksFromEventState,
} from './modules/pr-events/watermarks';
import { refreshWatchJobEvents } from './modules/scheduler/pr-watch-events';
import {
  addPrWatch,
  listPrWatchRecords,
  refreshPrWatch,
  removePrWatch,
} from './modules/watches';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';
import { emptyPrWatchInitialEventBaseline } from './testing/pr-watch-event-baseline';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Package 2 process-existing intake', () => {
  it('retries a persisted first-poll baseline after policy recovery and admits it exactly once', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );

    const state = eventState({
      requestedChangesReviews: [requestedChangesReview()],
      requestedChangesState: {
        active: [requestedChangesReview()],
        latestByReviewer: [requestedChangesReview()],
        history: [requestedChangesReview()],
      },
    });
    const refreshEvents = eventRefresh(state);
    const target = [{ watch: { id: watchId } }] as never;

    // Simulate a first-poll race where the watch exists before its repository
    // policy is available. The baseline is durable, but processing is not.
    await writeRepoRegistry(paths, false);
    const first = await refreshWatchJobEvents(
      target,
      paths,
      { refreshPrWatchEventState: refreshEvents },
      null,
    );
    expect(first).toEqual([
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining('policy is unavailable'),
      }),
    ]);
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: null,
    });
    expect(readPendingPrWatchEventIntake(paths, watchId)).toMatchObject({
      initialEvent: true,
      changedCategories: expect.arrayContaining(['requested_changes_reviews']),
    });

    await writeRepoRegistry(paths, true);
    let invocationCount = 0;
    const dependencies = {
      refreshPrWatchEventState: refreshEvents,
      invokeWorkflow: async () => {
        invocationCount += 1;
        return { runId: `run-${invocationCount}` };
      },
    };
    const second = await refreshWatchJobEvents(
      target,
      paths,
      dependencies,
      null,
    );
    expect(second).toEqual([
      expect.objectContaining({
        ok: true,
        changed: true,
        message: expect.stringContaining('Durably admitted'),
      }),
    ]);
    expect(
      (await listPrWatchRecords(paths))[0]!.initialEventProcessedAt,
    ).toEqual(expect.any(String));

    await refreshWatchJobEvents(target, paths, dependencies, null);
    expect(invocationCount).toBe(1);
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: true },
        paths,
        async () => {
          throw new Error('idempotent true mode must not refetch detail');
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      message: expect.stringContaining(
        'Current actionable feedback was selected for processing and its initial state has already been handled.',
      ),
    });
    const database = new DatabaseSync(paths.neondeckDatabase, {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM autopilot_admissions WHERE watch_id = ?;',
          )
          .get(watchId),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            `SELECT status, outcome, admission_id, notification_id,
                    repo_full_name, pr_number, source, initial_event
             FROM pr_watch_event_intakes WHERE watch_id = ?;`,
          )
          .get(watchId),
      ).toMatchObject({
        status: 'acknowledged',
        outcome: 'admission',
        admission_id: expect.any(String),
        notification_id: null,
        repo_full_name: 'pandemicsyn/neondeck',
        pr_number: 164,
        source: 'watch',
        initial_event: 1,
      });
    } finally {
      database.close();
    }
  });

  it('admits only feedback created after watch configuration on the true first poll', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: false },
        paths,
        async () => prDetail(),
        undefined,
        async (reference, baselineWatchId) => [
          ...(
            await emptyPrWatchInitialEventBaseline(reference, baselineWatchId)
          ).filter(
            (watermark) => watermark.category !== 'conversation_comments',
          ),
          categoryWatermark(
            watchId,
            'conversation_comments',
            '2026-07-19T05:00:00.000Z',
            {
              total: 1,
              truncated: false,
              comments: [
                {
                  id: 7001,
                  authorLogin: 'maintainer',
                  body: 'This feedback predates watch configuration.',
                  createdAt: '2026-07-19T05:00:00.000Z',
                  updatedAt: '2026-07-19T05:00:00.000Z',
                  bodyTruncated: false,
                  actionable: true,
                  fingerprint: conversationCommentFingerprint(
                    conversationComment(
                      7001,
                      'This feedback predates watch configuration.',
                      '2026-07-19T05:00:00.000Z',
                    ),
                  ),
                },
              ],
            },
          ),
        ],
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Current feedback was baselined'),
    });

    const refreshEvents = eventRefresh(
      eventState({
        conversationComments: [
          conversationComment(
            7001,
            'This feedback predates watch configuration.',
            '2026-07-19T05:00:00.000Z',
          ),
          conversationComment(
            7002,
            'This arrived between watch creation and first poll.',
            '2026-07-19T05:01:00.000Z',
          ),
        ],
      }),
    );
    const admittedInputs: Array<Record<string, unknown>> = [];
    const dependencies = {
      refreshPrWatchEventState: refreshEvents,
      invokeWorkflow: async (_workflow: string, input: unknown) => {
        admittedInputs.push(input as Record<string, unknown>);
        return { runId: `run-${admittedInputs.length}` };
      },
    };
    const target = [{ watch: { id: watchId } }] as never;

    await expect(
      refreshWatchJobEvents(target, paths, dependencies as never, null),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        changed: true,
      }),
    ]);
    await refreshWatchJobEvents(target, paths, dependencies as never, null);

    expect(admittedInputs).toHaveLength(1);
    expect(admittedInputs[0]!.deltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'conversation-comment',
          itemId: '7002',
        }),
      ]),
    );
    expect(
      (admittedInputs[0]!.deltas as Array<Record<string, unknown>>).some(
        (delta) => delta.itemId === '7001',
      ),
    ).toBe(false);
    expect(
      (await listPrWatchRecords(paths))[0]!.initialEventProcessedAt,
    ).toEqual(expect.any(String));
  });

  it('captures a fresh baseline on true-to-false reconfiguration and resets only on false-to-true', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: true },
        paths,
        async () => prDetail(),
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining(
        'Current actionable feedback will be processed before later changes.',
      ),
    });
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: null,
    });

    const unchangedState = eventState({
      requestedChangesReviews: [requestedChangesReview()],
      requestedChangesState: {
        active: [requestedChangesReview()],
        latestByReviewer: [requestedChangesReview()],
        history: [requestedChangesReview()],
      },
    });
    let baselineCaptures = 0;
    const captureBaseline = async (
      _reference: Parameters<typeof emptyPrWatchInitialEventBaseline>[0],
      baselineWatchId: string,
    ) => {
      baselineCaptures += 1;
      return watermarksFromEventState(baselineWatchId, unchangedState);
    };
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: false },
        paths,
        async () => {
          throw new Error(
            'nonterminal reconfiguration must not refetch detail',
          );
        },
        undefined,
        captureBaseline,
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Current feedback was baselined'),
    });
    const falseModeWatch = (await listPrWatchRecords(paths))[0]!;
    expect(falseModeWatch).toMatchObject({ processExisting: false });
    expect(falseModeWatch.initialEventProcessedAt).toEqual(expect.any(String));
    expect(
      (await listPrWatchEventWatermarks({ watchId }, paths)).data,
    ).toMatchObject({
      watermarks: expect.arrayContaining([expect.anything()]),
    });

    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: false },
        paths,
        async () => {
          throw new Error('idempotent reconfiguration must not refetch detail');
        },
        undefined,
        async () => {
          throw new Error('idempotent false mode must not recapture baseline');
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      message: expect.stringContaining(
        'Current feedback was baselined; only later changes will run.',
      ),
    });
    expect(baselineCaptures).toBe(1);
    expect((await listPrWatchRecords(paths))[0]!.initialEventProcessedAt).toBe(
      falseModeWatch.initialEventProcessedAt,
    );

    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: true },
        paths,
        async () => {
          throw new Error(
            'nonterminal reconfiguration must not refetch detail',
          );
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining(
        'Current actionable feedback will be processed',
      ),
    });
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: null,
    });
    expect(
      (await listPrWatchEventWatermarks({ watchId }, paths)).data,
    ).toMatchObject({ watermarks: [] });
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: true },
        paths,
        async () => {
          throw new Error('idempotent true mode must not refetch detail');
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      message: expect.stringContaining(
        'Current actionable feedback will be processed before later changes.',
      ),
    });

    const target = [{ watch: { id: watchId } }] as never;
    let invocationCount = 0;
    await expect(
      refreshWatchJobEvents(
        target,
        paths,
        {
          refreshPrWatchEventState: eventRefresh({
            ...unchangedState,
            conversationCommentsTruncated: true,
          }),
        },
        null,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining('incomplete'),
      }),
    ]);
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      initialEventProcessedAt: null,
    });

    const dependencies = {
      refreshPrWatchEventState: eventRefresh(unchangedState),
      invokeWorkflow: async () => {
        invocationCount += 1;
        return { runId: `rearm-run-${invocationCount}` };
      },
    };
    await expect(
      refreshWatchJobEvents(target, paths, dependencies, null),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        changed: true,
        message: expect.stringContaining('Durably admitted'),
      }),
    ]);
    await expect(
      refreshWatchJobEvents(target, paths, dependencies, null),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        changed: false,
      }),
    ]);
    expect(invocationCount).toBe(1);
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: expect.any(String),
    });
  });

  it('replays the same staged intake after a crash without refetching GitHub', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const state = eventState({
      conversationComments: [
        conversationComment(7001, 'Please preserve this across restart.'),
      ],
    });
    let fetchCount = 0;
    await expect(
      refreshPrWatchEventState({ watchId }, paths, {
        token: 'test-token',
        fetchPullRequestEventState: async () => {
          fetchCount += 1;
          return state;
        },
        afterPrWatchEventIntakeStaged: async () => {
          throw new Error('simulated crash after intake stage');
        },
      }),
    ).rejects.toThrow('simulated crash after intake stage');
    const pending = readPendingPrWatchEventIntake(paths, watchId);
    expect(pending).toMatchObject({
      eventId: expect.stringContaining(`${watchId}:intake:1:`),
      initialEvent: true,
    });
    expect(
      (await listPrWatchEventWatermarks({ watchId }, paths)).data,
    ).toMatchObject({
      watermarks: [],
    });

    let invocationCount = 0;
    const target = [{ watch: { id: watchId } }] as never;
    const offlinePendingRefresh = (
      input: Parameters<typeof refreshPrWatchEventState>[0],
      runtime: RuntimePaths,
    ) =>
      refreshPrWatchEventState(input, runtime, {
        fetchPullRequestEventState: async () => {
          throw new Error('GitHub is unavailable during restart');
        },
      });
    await expect(
      refreshWatchJobEvents(
        target,
        paths,
        {
          refreshPrWatchEventState: offlinePendingRefresh,
          invokeWorkflow: async () => {
            invocationCount += 1;
            return { runId: 'restart-run' };
          },
        },
        null,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        message: expect.stringContaining('Durably admitted'),
      }),
    ]);
    expect(fetchCount).toBe(1);
    expect(invocationCount).toBe(1);
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();

    await refreshWatchJobEvents(
      target,
      paths,
      {
        refreshPrWatchEventState: eventRefresh(state),
        invokeWorkflow: async () => {
          invocationCount += 1;
          return { runId: 'unexpected-run' };
        },
      },
      null,
    );
    expect(invocationCount).toBe(1);
  });

  it('fails closed on unknown persisted intake categories without fetching, acknowledging, or dispatching', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const state = eventState({
      conversationComments: [
        conversationComment(7001, 'Persist this before corruption.'),
      ],
    });
    await refreshPrWatchEventState({ watchId }, paths, {
      token: 'test-token',
      fetchPullRequestEventState: async () => state,
    });
    corruptPendingIntakeCategories(
      paths.neondeckDatabase,
      watchId,
      '["not-a-real-category"]',
    );

    let fetchCount = 0;
    let invocationCount = 0;
    const target = [{ watch: { id: watchId } }] as never;
    await expect(
      refreshWatchJobEvents(
        target,
        paths,
        {
          refreshPrWatchEventState: (input, runtime) =>
            refreshPrWatchEventState(input, runtime, {
              token: 'test-token',
              fetchPullRequestEventState: async () => {
                fetchCount += 1;
                return state;
              },
            }),
          invokeWorkflow: async () => {
            invocationCount += 1;
            return { runId: 'must-not-dispatch-corrupt-intake' };
          },
        },
        null,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        changed: false,
        message: expect.stringContaining('requires operator repair'),
        refresh: expect.objectContaining({
          requires: ['repairPrWatchEventIntake'],
        }),
      }),
    ]);
    expect(fetchCount).toBe(0);
    expect(invocationCount).toBe(0);
    expect(readCorruptIntakeState(paths.neondeckDatabase, watchId)).toEqual({
      intake_status: 'pending',
      acknowledged_watermarks: 0,
      admissions: 0,
    });
  });

  it('rejects a schema-valid changed-category subset that omits candidate feedback', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const state = eventState({
      conversationComments: [
        conversationComment(7001, 'This delta must not be omitted.'),
      ],
    });
    await refreshPrWatchEventState({ watchId }, paths, {
      token: 'test-token',
      fetchPullRequestEventState: async () => state,
    });
    corruptPendingIntakeCategories(
      paths.neondeckDatabase,
      watchId,
      '["commits"]',
    );

    let fetchCount = 0;
    let invocationCount = 0;
    const target = [{ watch: { id: watchId } }] as never;
    await expect(
      refreshWatchJobEvents(
        target,
        paths,
        {
          refreshPrWatchEventState: (input, runtime) =>
            refreshPrWatchEventState(input, runtime, {
              token: 'test-token',
              fetchPullRequestEventState: async () => {
                fetchCount += 1;
                return state;
              },
            }),
          invokeWorkflow: async () => {
            invocationCount += 1;
            return { runId: 'must-not-dispatch-omitted-feedback' };
          },
        },
        null,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining('requires operator repair'),
        refresh: expect.objectContaining({
          requires: ['repairPrWatchEventIntake'],
          errors: [expect.stringContaining('do not match')],
        }),
      }),
    ]);
    expect(fetchCount).toBe(0);
    expect(invocationCount).toBe(0);
    expect(readCorruptIntakeState(paths.neondeckDatabase, watchId)).toEqual({
      intake_status: 'pending',
      acknowledged_watermarks: 0,
      admissions: 0,
    });
  });

  it('fails closed on a corrupt delivery-ledger fingerprint without acknowledgement or dispatch', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    insertCorruptDelivery(paths.neondeckDatabase);
    const state = eventState({
      conversationComments: [
        conversationComment(7001, 'This still requires processing.'),
      ],
    });
    let invocationCount = 0;
    const target = [{ watch: { id: watchId } }] as never;
    await expect(
      refreshWatchJobEvents(
        target,
        paths,
        {
          refreshPrWatchEventState: eventRefresh(state),
          invokeWorkflow: async () => {
            invocationCount += 1;
            return { runId: 'must-not-dispatch-corrupt-delivery' };
          },
        },
        null,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        changed: false,
        message: expect.stringContaining(
          'delivery identity is invalid and requires operator repair',
        ),
        triage: expect.objectContaining({
          status: 'blocked',
          reason: 'invalid-delivery-ledger',
        }),
      }),
    ]);
    expect(invocationCount).toBe(0);
    expect(readCorruptIntakeState(paths.neondeckDatabase, watchId)).toEqual({
      intake_status: 'pending',
      acknowledged_watermarks: 0,
      admissions: 0,
    });
  });

  it('reuses the durable admission after a crash before intake acknowledgement', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const state = eventState({
      requestedChangesReviews: [requestedChangesReview()],
      requestedChangesState: {
        active: [requestedChangesReview()],
        latestByReviewer: [requestedChangesReview()],
        history: [requestedChangesReview()],
      },
    });
    const target = [{ watch: { id: watchId } }] as never;
    let invocationCount = 0;
    await expect(
      refreshWatchJobEvents(
        target,
        paths,
        {
          refreshPrWatchEventState: eventRefresh(state),
          invokeWorkflow: async () => {
            invocationCount += 1;
            return { runId: 'admitted-before-crash' };
          },
          beforePrWatchEventIntakeAcknowledged: async () => {
            throw new Error('simulated crash before intake acknowledgement');
          },
        },
        null,
      ),
    ).rejects.toThrow('simulated crash before intake acknowledgement');
    const pending = readPendingPrWatchEventIntake(paths, watchId);
    expect(pending).toBeDefined();
    const beforeRestart = readAdmissionAndIntake(
      paths.neondeckDatabase,
      watchId,
    );
    expect(beforeRestart).toMatchObject({
      intake_status: 'pending',
      admission_count: 1,
      admission_fingerprint: pending?.eventId,
    });

    await expect(
      refreshWatchJobEvents(
        target,
        paths,
        {
          refreshPrWatchEventState: eventRefresh(state),
          invokeWorkflow: async () => {
            invocationCount += 1;
            return { runId: 'must-not-dispatch-twice' };
          },
        },
        null,
      ),
    ).resolves.toEqual([expect.objectContaining({ ok: true, changed: true })]);
    expect(invocationCount).toBe(1);
    expect(
      readAdmissionAndIntake(paths.neondeckDatabase, watchId),
    ).toMatchObject({
      intake_status: 'acknowledged',
      intake_outcome: 'admission',
      intake_admission_id: beforeRestart.admission_id,
      admission_count: 1,
    });
  });

  it('keeps incomplete initial facts unacknowledged and processes the later complete state once', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const reviewThread = {
      id: 'thread-7001',
      isResolved: false,
      isOutdated: false,
      path: 'src/app.ts',
      line: 12,
      originalLine: 12,
      diffSide: 'RIGHT',
      pullRequestRepo: 'pandemicsyn/neondeck',
      pullRequestNumber: 164,
      commentsTruncated: false,
      comments: [
        {
          id: 'review-comment-7001',
          databaseId: 7001,
          authorLogin: 'reviewer',
          authorType: 'User',
          authorIsBot: false,
          body: 'This complete nested review fact should run once.',
          url: null,
          path: 'src/app.ts',
          line: 12,
          originalLine: 12,
          diffHunk: '@@',
          reviewId: 9001,
          createdAt: '2026-07-19T00:05:00.000Z',
          updatedAt: '2026-07-19T00:05:00.000Z',
        },
      ],
    };
    const complete = eventState({ reviewThreads: [reviewThread] });
    const target = [{ watch: { id: watchId } }] as never;
    const expectIncompleteWithoutStaging = async (
      state: GitHubPullRequestEventState,
    ) => {
      await expect(
        refreshWatchJobEvents(
          target,
          paths,
          { refreshPrWatchEventState: eventRefresh(state) },
          null,
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          ok: false,
          message: expect.stringContaining('incomplete'),
        }),
      ]);
      expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
      expect((await listPrWatchRecords(paths))[0]).toMatchObject({
        initialEventProcessedAt: null,
      });
      expect(
        (await listPrWatchEventWatermarks({ watchId }, paths)).data,
      ).toMatchObject({ watermarks: [] });
    };
    await expectIncompleteWithoutStaging({
      ...complete,
      reviewThreads: [{ ...reviewThread, commentsTruncated: true }],
      reviewThreadsTruncated: false,
    });
    await expectIncompleteWithoutStaging({
      ...complete,
      reviewThreads: [
        {
          ...reviewThread,
          comments: [{ ...reviewThread.comments[0]!, bodyTruncated: true }],
        },
      ],
    });
    const truncatedReview = {
      ...requestedChangesReview(),
      bodyTruncated: true,
    };
    await expectIncompleteWithoutStaging(
      eventState({
        requestedChangesReviews: [truncatedReview],
        requestedChangesState: {
          active: [truncatedReview],
          latestByReviewer: [truncatedReview],
          history: [truncatedReview],
        },
      }),
    );
    await expectIncompleteWithoutStaging(
      eventState({
        conversationComments: [conversationComment(7002, 'x'.repeat(65_537))],
      }),
    );

    let invocationCount = 0;
    const dependencies = {
      refreshPrWatchEventState: eventRefresh(complete),
      invokeWorkflow: async () => {
        invocationCount += 1;
        return { runId: 'complete-run' };
      },
    };
    await refreshWatchJobEvents(target, paths, dependencies, null);
    await refreshWatchJobEvents(target, paths, dependencies, null);
    expect(invocationCount).toBe(1);
    expect(
      (await listPrWatchRecords(paths))[0]!.initialEventProcessedAt,
    ).toEqual(expect.any(String));
  });

  it('atomically supersedes pending intake history on implicit and explicit terminal false-mode rearm', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    const baseline = eventState();
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: false },
      paths,
      async () => prDetail(),
      undefined,
      async () => watermarksFromEventState(watchId, baseline),
    );
    const firstChanged = eventState({
      conversationComments: [conversationComment(7001, 'First pending item.')],
    });
    await refreshPrWatchEventState({ watchId }, paths, {
      token: 'test-token',
      fetchPullRequestEventState: async () => firstChanged,
    });
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeDefined();
    markWatchTerminal(paths.neondeckDatabase, watchId);
    await addPrWatch(
      { ref: 'neondeck#164' },
      paths,
      async () => prDetail(),
      undefined,
      async () => watermarksFromEventState(watchId, firstChanged),
    );
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
    expect(readSupersededIntakes(paths.neondeckDatabase, watchId)).toHaveLength(
      1,
    );

    const secondChanged = eventState({
      conversationComments: [
        conversationComment(7001, 'First pending item.'),
        conversationComment(7002, 'Second pending item.'),
      ],
    });
    await refreshPrWatchEventState({ watchId }, paths, {
      token: 'test-token',
      fetchPullRequestEventState: async () => secondChanged,
    });
    markWatchTerminal(paths.neondeckDatabase, watchId);
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: false },
      paths,
      async () => prDetail(),
      undefined,
      async () => watermarksFromEventState(watchId, secondChanged),
    );
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
    expect(readSupersededIntakes(paths.neondeckDatabase, watchId)).toEqual([
      expect.objectContaining({ sequence: 1, outcome: 'baseline-reset' }),
      expect.objectContaining({ sequence: 2, outcome: 'baseline-reset' }),
    ]);
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      status: 'watching',
      processExisting: false,
      initialEventProcessedAt: expect.any(String),
    });
  });

  it('supersedes pending intake history before remove and preserves monotonic re-add processing', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    const current = eventState({
      requestedChangesReviews: [requestedChangesReview()],
      requestedChangesState: {
        active: [requestedChangesReview()],
        latestByReviewer: [requestedChangesReview()],
        history: [requestedChangesReview()],
      },
    });
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    await refreshPrWatchEventState({ watchId }, paths, {
      token: 'test-token',
      fetchPullRequestEventState: async () => current,
    });
    expect(readPendingPrWatchEventIntake(paths, watchId)).toMatchObject({
      sequence: 1,
      initialEvent: true,
    });

    await removePrWatch({ id: watchId, confirm: true }, paths);
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
    expect(readSupersededIntakes(paths.neondeckDatabase, watchId)).toEqual([
      expect.objectContaining({
        sequence: 1,
        outcome: 'baseline-reset',
        superseded_reason: 'Operator removed the PR watch.',
        acknowledged_at: expect.any(String),
        updated_at: expect.any(String),
      }),
    ]);

    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    let invocationCount = 0;
    const target = [{ watch: { id: watchId } }] as never;
    const dependencies = {
      refreshPrWatchEventState: eventRefresh(current),
      invokeWorkflow: async () => {
        invocationCount += 1;
        return { runId: `remove-readd-${invocationCount}` };
      },
    };
    await refreshWatchJobEvents(target, paths, dependencies, null);
    await refreshWatchJobEvents(target, paths, dependencies, null);
    expect(invocationCount).toBe(1);

    const database = new DatabaseSync(paths.neondeckDatabase, {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare(
            `SELECT sequence, status, outcome, admission_id, superseded_reason
             FROM pr_watch_event_intakes
             WHERE watch_id = ?
             ORDER BY sequence;`,
          )
          .all(watchId),
      ).toEqual([
        {
          sequence: 1,
          status: 'superseded',
          outcome: 'baseline-reset',
          admission_id: null,
          superseded_reason: 'Operator removed the PR watch.',
        },
        {
          sequence: 2,
          status: 'acknowledged',
          outcome: 'admission',
          admission_id: expect.any(String),
          superseded_reason: null,
        },
      ]);
    } finally {
      database.close();
    }

    await removePrWatch({ id: watchId, confirm: true }, paths);
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: false },
      paths,
      async () => prDetail(),
      undefined,
      async () => watermarksFromEventState(watchId, current),
    );
    await expect(
      refreshPrWatchEventState({ watchId }, paths, {
        token: 'test-token',
        fetchPullRequestEventState: async () => current,
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      data: { changedCategories: [] },
    });
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: false,
      initialEventProcessedAt: expect.any(String),
    });
  });

  it('fences a stale event fetch across removal and true-mode re-add', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const originalGeneration = (await listPrWatchRecords(paths))[0]!
      .eventGenerationId;
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    const current = eventState({
      requestedChangesReviews: [requestedChangesReview()],
      requestedChangesState: {
        active: [requestedChangesReview()],
        latestByReviewer: [requestedChangesReview()],
        history: [requestedChangesReview()],
      },
    });
    const staleRefresh = refreshPrWatchEventState({ watchId }, paths, {
      token: 'test-token',
      fetchPullRequestEventState: async () => {
        fetchStarted.resolve();
        await releaseFetch.promise;
        return current;
      },
    });
    await fetchStarted.promise;

    await removePrWatch({ id: watchId, confirm: true }, paths);
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    expect((await listPrWatchRecords(paths))[0]!.eventGenerationId).not.toBe(
      originalGeneration,
    );
    releaseFetch.resolve();

    await expect(staleRefresh).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['currentWatchGeneration'],
    });
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
    expect(
      (await listPrWatchEventWatermarks({ watchId }, paths)).data,
    ).toMatchObject({ watermarks: [] });

    let invocationCount = 0;
    const target = [{ watch: { id: watchId } }] as never;
    const dependencies = {
      refreshPrWatchEventState: eventRefresh(current),
      invokeWorkflow: async () => {
        invocationCount += 1;
        return { runId: `fresh-generation-${invocationCount}` };
      },
    };
    await refreshWatchJobEvents(target, paths, dependencies, null);
    await refreshWatchJobEvents(target, paths, dependencies, null);
    expect(invocationCount).toBe(1);
    expect(readIntakeRows(paths.neondeckDatabase, watchId)).toEqual([
      expect.objectContaining({
        sequence: 1,
        status: 'acknowledged',
        outcome: 'admission',
      }),
    ]);
  });

  it('fences a stale legacy baseline install after an event-generation reset', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    setWatchWatermarkVersion(paths.neondeckDatabase, watchId, 1);
    const originalGeneration = (await listPrWatchRecords(paths))[0]!
      .eventGenerationId;
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    const staleRefresh = refreshPrWatchEventState({ watchId }, paths, {
      token: 'test-token',
      fetchPullRequestEventState: async () => {
        fetchStarted.resolve();
        await releaseFetch.promise;
        return eventState({
          conversationComments: [
            conversationComment(7099, 'Stale legacy fetch result.'),
          ],
        });
      },
    });
    await fetchStarted.promise;

    const replacement = eventState({
      conversationComments: [
        conversationComment(7100, 'Fresh operator baseline.'),
      ],
    });
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: false },
      paths,
      async () => prDetail(),
      undefined,
      async () => watermarksFromEventState(watchId, replacement),
    );
    const replacementGeneration = (await listPrWatchRecords(paths))[0]!
      .eventGenerationId;
    expect(replacementGeneration).not.toBe(originalGeneration);
    releaseFetch.resolve();

    await expect(staleRefresh).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['currentWatchGeneration'],
    });
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      eventGenerationId: replacementGeneration,
      eventWatermarkVersion: 2,
      processExisting: false,
    });
    expect(conversationWatermarkIds(paths.neondeckDatabase, watchId)).toEqual([
      7100,
    ]);
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
  });

  it('CAS-fences a slow false-mode baseline update after a newer reset commits', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const originalGeneration = (await listPrWatchRecords(paths))[0]!
      .eventGenerationId;
    const baselineStarted = deferred();
    const releaseBaseline = deferred();
    const slowUpdate = addPrWatch(
      { ref: 'neondeck#164', processExisting: false },
      paths,
      async () => prDetail(),
      undefined,
      async () => {
        baselineStarted.resolve();
        await releaseBaseline.promise;
        return watermarksFromEventState(
          watchId,
          eventState({
            conversationComments: [
              conversationComment(7201, 'Superseded slow baseline.'),
            ],
          }),
        );
      },
    );
    await baselineStarted.promise;

    const winner = eventState({
      conversationComments: [
        conversationComment(7202, 'Winning operator baseline.'),
      ],
    });
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: false },
        paths,
        async () => prDetail(),
        undefined,
        async () => watermarksFromEventState(watchId, winner),
      ),
    ).resolves.toMatchObject({ ok: true, changed: true });
    const winnerGeneration = (await listPrWatchRecords(paths))[0]!
      .eventGenerationId;
    expect(winnerGeneration).not.toBe(originalGeneration);
    releaseBaseline.resolve();

    await expect(slowUpdate).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['currentWatchGeneration'],
    });
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      eventGenerationId: winnerGeneration,
      processExisting: false,
    });
    expect(conversationWatermarkIds(paths.neondeckDatabase, watchId)).toEqual([
      7202,
    ]);
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
  });

  it('CAS-fences a slow watch-detail refresh after removal and re-add', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const originalGeneration = (await listPrWatchRecords(paths))[0]!
      .eventGenerationId;
    const detailStarted = deferred();
    const releaseDetail = deferred();
    const slowRefresh = refreshPrWatch({ id: watchId }, paths, async () => {
      detailStarted.resolve();
      await releaseDetail.promise;
      return {
        ...prDetail(),
        title: 'Stale detail from the removed generation',
        updatedAt: '2026-07-19T01:00:00.000Z',
      };
    });
    await detailStarted.promise;

    await removePrWatch({ id: watchId, confirm: true }, paths);
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const replacement = (await listPrWatchRecords(paths))[0]!;
    expect(replacement.eventGenerationId).not.toBe(originalGeneration);
    releaseDetail.resolve();

    await expect(slowRefresh).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['currentWatchGeneration'],
    });
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      eventGenerationId: replacement.eventGenerationId,
      title: 'Restart-safe process-existing intake',
      processExisting: true,
    });
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
  });

  it('requires the exact pending intake generation inside durable admission', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const current = eventState({
      requestedChangesReviews: [requestedChangesReview()],
      requestedChangesState: {
        active: [requestedChangesReview()],
        latestByReviewer: [requestedChangesReview()],
        history: [requestedChangesReview()],
      },
    });
    const intakeStaged = deferred();
    const releaseAdmission = deferred();
    let invocationCount = 0;
    const target = [{ watch: { id: watchId } }] as never;
    const staleRun = refreshWatchJobEvents(
      target,
      paths,
      {
        refreshPrWatchEventState: async (input, runtime) => {
          const result = await eventRefresh(current)(input, runtime);
          expect(readPendingPrWatchEventIntake(paths, watchId)).toMatchObject({
            sequence: 1,
            eventGenerationId: (await listPrWatchRecords(paths))[0]!
              .eventGenerationId,
          });
          intakeStaged.resolve();
          await releaseAdmission.promise;
          return result;
        },
        invokeWorkflow: async () => {
          invocationCount += 1;
          return { runId: `stale-admission-${invocationCount}` };
        },
      },
      null,
    );
    await intakeStaged.promise;

    await removePrWatch({ id: watchId, confirm: true }, paths);
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    releaseAdmission.resolve();

    await expect(staleRun).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        changed: false,
        message: expect.stringContaining(
          'is no longer pending for the current watch generation',
        ),
        notifications: [],
      }),
    ]);
    expect(invocationCount).toBe(0);
    expect(
      readAdmissionAndIntake(paths.neondeckDatabase, watchId),
    ).toMatchObject({
      intake_status: 'superseded',
      intake_outcome: 'baseline-reset',
      admission_count: 0,
    });

    const freshDependencies = {
      refreshPrWatchEventState: eventRefresh(current),
      invokeWorkflow: async () => {
        invocationCount += 1;
        return { runId: `fresh-admission-${invocationCount}` };
      },
    };
    await refreshWatchJobEvents(target, paths, freshDependencies, null);
    await refreshWatchJobEvents(target, paths, freshDependencies, null);
    expect(invocationCount).toBe(1);
    const intakeRows = readIntakeRows(paths.neondeckDatabase, watchId);
    expect(intakeRows).toEqual([
      expect.objectContaining({ sequence: 1, status: 'superseded' }),
      expect.objectContaining({
        sequence: 2,
        status: 'acknowledged',
        outcome: 'admission',
      }),
    ]);
    const acknowledged = intakeRows[1] as Record<string, unknown>;
    const acknowledgedRetry = {
      eventResults: [
        {
          watchId,
          triage: {
            status: 'failed',
            input: {
              eventId: acknowledged.event_id,
              eventGenerationId: acknowledged.event_generation_id,
              source: 'watch',
            },
          },
        },
      ],
    } as never;
    await expect(
      refreshWatchJobEvents(
        target,
        paths,
        freshDependencies,
        acknowledgedRetry,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining(
          'is no longer pending for the current watch generation',
        ),
      }),
    ]);
    expect(invocationCount).toBe(1);
    expect(
      readAdmissionAndIntake(paths.neondeckDatabase, watchId).admission_count,
    ).toBe(1);
  });

  it('rejects a superseded intake reconstructed from previous scheduler output', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const current = eventState({
      requestedChangesReviews: [requestedChangesReview()],
      requestedChangesState: {
        active: [requestedChangesReview()],
        latestByReviewer: [requestedChangesReview()],
        history: [requestedChangesReview()],
      },
    });
    await refreshPrWatchEventState({ watchId }, paths, {
      token: 'test-token',
      fetchPullRequestEventState: async () => current,
    });
    const staged = readPendingPrWatchEventIntake(paths, watchId)!;
    const previousJobResult = {
      eventResults: [
        {
          watchId,
          triage: {
            status: 'failed',
            input: {
              eventId: staged.eventId,
              eventGenerationId: staged.eventGenerationId,
              source: 'watch',
            },
          },
        },
      ],
    } as never;

    await addPrWatch(
      { ref: 'neondeck#164', processExisting: false },
      paths,
      async () => prDetail(),
      undefined,
      async () => watermarksFromEventState(watchId, current),
    );
    let invocationCount = 0;
    await expect(
      refreshWatchJobEvents(
        [{ watch: { id: watchId } }] as never,
        paths,
        {
          refreshPrWatchEventState: eventRefresh(current),
          invokeWorkflow: async () => {
            invocationCount += 1;
            return { runId: 'must-not-run' };
          },
        },
        previousJobResult,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining(
          'is no longer pending for the current watch generation',
        ),
      }),
    ]);
    expect(invocationCount).toBe(0);
    expect(
      readAdmissionAndIntake(paths.neondeckDatabase, watchId),
    ).toMatchObject({
      intake_status: 'superseded',
      intake_outcome: 'baseline-reset',
      admission_count: 0,
    });
  });

  it('rejects a coherent pending row whose persisted generation mismatches the watch', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: false },
      paths,
      async () => prDetail(),
      undefined,
      async () => watermarksFromEventState(watchId, eventState()),
    );
    const current = eventState({
      requestedChangesReviews: [requestedChangesReview()],
      requestedChangesState: {
        active: [requestedChangesReview()],
        latestByReviewer: [requestedChangesReview()],
        history: [requestedChangesReview()],
      },
    });
    const intakeStaged = deferred();
    const releaseAdmission = deferred();
    let invocationCount = 0;
    const run = refreshWatchJobEvents(
      [{ watch: { id: watchId } }] as never,
      paths,
      {
        refreshPrWatchEventState: async (input, runtime) => {
          const result = await eventRefresh(current)(input, runtime);
          intakeStaged.resolve();
          await releaseAdmission.promise;
          return result;
        },
        invokeWorkflow: async () => {
          invocationCount += 1;
          return { runId: 'must-not-run' };
        },
      },
      null,
    );
    await intakeStaged.promise;
    rewritePendingIntakeGeneration(
      paths.neondeckDatabase,
      watchId,
      'coherent-but-mismatched-generation',
    );
    releaseAdmission.resolve();

    await expect(run).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        changed: false,
        message: expect.stringContaining(
          'is no longer pending for the current watch generation',
        ),
        notifications: [],
      }),
    ]);
    expect(invocationCount).toBe(0);
    expect(
      readAdmissionAndIntake(paths.neondeckDatabase, watchId).admission_count,
    ).toBe(0);
  });

  it('atomically rearms a terminal true-mode watch for one full current-state intake', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const current = eventState({
      requestedChangesReviews: [requestedChangesReview()],
      requestedChangesState: {
        active: [requestedChangesReview()],
        latestByReviewer: [requestedChangesReview()],
        history: [requestedChangesReview()],
      },
    });
    await refreshPrWatchEventState({ watchId }, paths, {
      token: 'test-token',
      fetchPullRequestEventState: async () => current,
    });
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeDefined();

    markWatchTerminal(paths.neondeckDatabase, watchId);
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: true },
        paths,
        async () => prDetail(),
      ),
    ).resolves.toMatchObject({ ok: true, changed: true });
    expect(readPendingPrWatchEventIntake(paths, watchId)).toBeUndefined();
    expect(readSupersededIntakes(paths.neondeckDatabase, watchId)).toEqual([
      expect.objectContaining({
        outcome: 'baseline-reset',
        superseded_reason:
          'Operator rearmed process-existing=true for current feedback.',
      }),
    ]);
    expect(
      (await listPrWatchEventWatermarks({ watchId }, paths)).data,
    ).toMatchObject({ watermarks: [] });
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      status: 'watching',
      processExisting: true,
      initialEventProcessedAt: null,
    });

    let invocationCount = 0;
    const target = [{ watch: { id: watchId } }] as never;
    const dependencies = {
      refreshPrWatchEventState: eventRefresh(current),
      invokeWorkflow: async () => {
        invocationCount += 1;
        return { runId: `terminal-rearm-${invocationCount}` };
      },
    };
    await refreshWatchJobEvents(target, paths, dependencies, null);
    await refreshWatchJobEvents(target, paths, dependencies, null);
    expect(invocationCount).toBe(1);
    expect(
      (await listPrWatchRecords(paths))[0]!.initialEventProcessedAt,
    ).toEqual(expect.any(String));
  });

  it('does not report initial notify-only success when a baseline reset wins the acknowledgement race', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true, 'notify-only');
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const target = [{ watch: { id: watchId } }] as never;
    const published: string[] = [];
    const unsubscribe = subscribeNotificationEvents((event) => {
      published.push(event.notification.id);
    });
    try {
      await expect(
        refreshWatchJobEvents(
          target,
          paths,
          {
            refreshPrWatchEventState: eventRefresh(
              eventState({
                conversationComments: [
                  conversationComment(7001, 'Notify about this once.'),
                ],
              }),
            ),
            beforePrWatchEventIntakeAcknowledged: async () => {
              supersedePendingIntake(paths.neondeckDatabase, watchId);
            },
          },
          null,
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          ok: false,
          changed: false,
          message: expect.stringContaining('was not acknowledged'),
        }),
      ]);
    } finally {
      unsubscribe();
    }
    expect(published).toEqual([]);
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      initialEventProcessedAt: null,
    });
    const database = new DatabaseSync(paths.neondeckDatabase, {
      readOnly: true,
    });
    try {
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM notifications;').get(),
      ).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it('does not duplicate an atomic notification-and-ack delivery after restart', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true, 'notify-only');
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const refreshEvents = eventRefresh(
      eventState({
        conversationComments: [
          conversationComment(7001, 'Please update the error copy.'),
        ],
      }),
    );
    const dependencies = {
      refreshPrWatchEventState: refreshEvents,
    };
    const target = [{ watch: { id: watchId } }] as never;
    const published: Array<{ action: string; sourceId: string | null }> = [];
    const unsubscribe = subscribeNotificationEvents((event) => {
      published.push({
        action: event.action,
        sourceId: event.notification.sourceId,
      });
    });

    try {
      await refreshWatchJobEvents(target, paths, dependencies, null);
      await refreshWatchJobEvents(target, paths, dependencies, null);
    } finally {
      unsubscribe();
    }

    expect(
      (await listPrWatchRecords(paths))[0]!.initialEventProcessedAt,
    ).toEqual(expect.any(String));
    const database = new DatabaseSync(paths.neondeckDatabase, {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count, MAX(occurrence_count) AS occurrences
             FROM notifications
             WHERE source = 'watch-pr-events';`,
          )
          .get(),
      ).toEqual({ count: 1, occurrences: 1 });
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM autopilot_admissions WHERE watch_id = ?;',
          )
          .get(watchId),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
    expect(published).toEqual([
      {
        action: 'created',
        sourceId: expect.stringContaining(`${watchId}:intake:1:`),
      },
    ]);
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-package-2-intake-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  return paths;
}

async function writeRepoRegistry(
  paths: RuntimePaths,
  includeRepo: boolean,
  mode = 'prepare-only',
) {
  await writeFile(
    paths.repos,
    `${JSON.stringify(
      {
        repos: includeRepo
          ? [
              {
                id: 'neondeck',
                github: { owner: 'pandemicsyn', name: 'neondeck' },
                path: '/tmp/neondeck',
                defaultBranch: 'main',
                metadata: { autopilot: { mode } },
              },
            ]
          : [],
      },
      null,
      2,
    )}\n`,
  );
}

function prDetail() {
  return {
    number: 164,
    title: 'Restart-safe process-existing intake',
    body: null,
    repo: 'pandemicsyn/neondeck',
    url: 'https://github.com/pandemicsyn/neondeck/pull/164',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    headSha: 'a'.repeat(40),
    headRef: 'feature',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}

function readAdmissionAndIntake(databasePath: string, watchId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT
           (SELECT status FROM pr_watch_event_intakes WHERE watch_id = ? ORDER BY sequence DESC LIMIT 1) AS intake_status,
           (SELECT outcome FROM pr_watch_event_intakes WHERE watch_id = ? ORDER BY sequence DESC LIMIT 1) AS intake_outcome,
           (SELECT admission_id FROM pr_watch_event_intakes WHERE watch_id = ? ORDER BY sequence DESC LIMIT 1) AS intake_admission_id,
           (SELECT COUNT(*) FROM autopilot_admissions WHERE watch_id = ?) AS admission_count,
           (SELECT id FROM autopilot_admissions WHERE watch_id = ? ORDER BY created_at DESC LIMIT 1) AS admission_id,
           (SELECT event_fingerprint FROM autopilot_admissions WHERE watch_id = ? ORDER BY created_at DESC LIMIT 1) AS admission_fingerprint;`,
      )
      .get(watchId, watchId, watchId, watchId, watchId, watchId) as Record<
      string,
      unknown
    >;
  } finally {
    database.close();
  }
}

function corruptPendingIntakeCategories(
  databasePath: string,
  watchId: string,
  categoriesJson: string,
) {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `UPDATE pr_watch_event_intakes
         SET changed_categories_json = ?
         WHERE watch_id = ? AND status = 'pending';`,
      )
      .run(categoriesJson, watchId);
  } finally {
    database.close();
  }
}

function readCorruptIntakeState(databasePath: string, watchId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT
           (SELECT status FROM pr_watch_event_intakes WHERE watch_id = ? ORDER BY sequence DESC LIMIT 1) AS intake_status,
           (SELECT COUNT(*) FROM pr_watch_event_watermarks WHERE watch_id = ?) AS acknowledged_watermarks,
           (SELECT COUNT(*) FROM autopilot_admissions WHERE watch_id = ?) AS admissions;`,
      )
      .get(watchId, watchId, watchId);
  } finally {
    database.close();
  }
}

function insertCorruptDelivery(databasePath: string) {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO pr_neondeck_deliveries (
           repo_full_name, pr_number, item_kind, item_id,
           item_fingerprint, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?);`,
      )
      .run(
        'pandemicsyn/neondeck',
        164,
        'conversation-comment',
        '7001',
        'not-a-sha256-fingerprint',
        '2026-07-19T00:00:00.000Z',
      );
  } finally {
    database.close();
  }
}

function supersedePendingIntake(databasePath: string, watchId: string) {
  const database = new DatabaseSync(databasePath);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `UPDATE pr_watch_event_intakes
         SET status = 'superseded', outcome = 'baseline-reset',
             superseded_reason = 'Concurrent operator baseline reset.',
             acknowledged_at = ?, updated_at = ?
         WHERE watch_id = ? AND status = 'pending';`,
      )
      .run(now, now, watchId);
  } finally {
    database.close();
  }
}

function markWatchTerminal(databasePath: string, watchId: string) {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `UPDATE pr_watches
         SET status = 'merged', pr_state = 'closed', updated_at = ?
         WHERE id = ?;`,
      )
      .run(new Date().toISOString(), watchId);
  } finally {
    database.close();
  }
}

function readSupersededIntakes(databasePath: string, watchId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT sequence, status, outcome, superseded_reason,
                acknowledged_at, updated_at
         FROM pr_watch_event_intakes
         WHERE watch_id = ? AND status = 'superseded'
         ORDER BY sequence;`,
      )
      .all(watchId);
  } finally {
    database.close();
  }
}

function readIntakeRows(databasePath: string, watchId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT event_id, event_generation_id, sequence, status, outcome,
                admission_id, superseded_reason
         FROM pr_watch_event_intakes
         WHERE watch_id = ?
         ORDER BY sequence;`,
      )
      .all(watchId);
  } finally {
    database.close();
  }
}

function setWatchWatermarkVersion(
  databasePath: string,
  watchId: string,
  version: number,
) {
  const database = new DatabaseSync(databasePath);
  try {
    expect(
      database
        .prepare(
          `UPDATE pr_watches
           SET event_watermark_version = ?
           WHERE id = ?;`,
        )
        .run(version, watchId).changes,
    ).toBe(1);
  } finally {
    database.close();
  }
}

function rewritePendingIntakeGeneration(
  databasePath: string,
  watchId: string,
  generation: string,
) {
  const database = new DatabaseSync(databasePath);
  try {
    expect(
      database
        .prepare(
          `UPDATE pr_watch_event_intakes
           SET event_generation_id = ?
           WHERE watch_id = ? AND status = 'pending';`,
        )
        .run(generation, watchId).changes,
    ).toBe(1);
  } finally {
    database.close();
  }
}

function conversationWatermarkIds(databasePath: string, watchId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT watermark_json
         FROM pr_watch_event_watermarks
         WHERE watch_id = ? AND category = 'conversation_comments';`,
      )
      .get(watchId) as { watermark_json?: unknown } | undefined;
    if (typeof row?.watermark_json !== 'string') return [];
    const watermark = JSON.parse(row.watermark_json) as {
      comments?: Array<{ id?: unknown }>;
    };
    return (watermark.comments ?? [])
      .map((comment) => comment.id)
      .filter((id): id is number => typeof id === 'number');
  } finally {
    database.close();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function eventRefresh(state: GitHubPullRequestEventState) {
  return (
    input: Parameters<typeof refreshPrWatchEventState>[0],
    paths: RuntimePaths,
  ) =>
    refreshPrWatchEventState(input, paths, {
      token: 'test-token',
      fetchPullRequestEventState: async () => state,
    });
}

function conversationComment(
  id: number,
  body: string,
  timestamp = '2026-07-19T00:05:00.000Z',
) {
  return {
    id,
    nodeId: `comment-${id}`,
    url: `https://github.com/pandemicsyn/neondeck/pull/164#issuecomment-${id}`,
    authorLogin: 'maintainer',
    authorType: 'User',
    authorIsBot: false,
    body,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function requestedChangesReview() {
  return {
    id: 9001,
    nodeId: 'review-9001',
    state: 'CHANGES_REQUESTED',
    authorLogin: 'reviewer',
    authorType: 'User',
    authorIsBot: false,
    submittedAt: '2026-07-19T00:04:00.000Z',
    commitId: 'a'.repeat(40),
    url: 'https://github.com/pandemicsyn/neondeck/pull/164#pullrequestreview-9001',
    body: 'Please cover the restart path.',
    bodyTruncated: false,
  };
}

function eventState(
  overrides: Partial<GitHubPullRequestEventState> = {},
): GitHubPullRequestEventState {
  return {
    repo: 'pandemicsyn/neondeck',
    number: 164,
    url: 'https://github.com/pandemicsyn/neondeck/pull/164',
    title: 'Restart-safe process-existing intake',
    body: null,
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: 'a'.repeat(40),
    headRef: 'feature',
    headRepoFullName: 'pandemicsyn/neondeck',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    baseRepoFullName: 'pandemicsyn/neondeck',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [],
    reviewThreads: [],
    requestedChangesReviews: [],
    requestedChangesState: { active: [], latestByReviewer: [], history: [] },
    conversationComments: [],
    checkSuites: [],
    checkRuns: [],
    branchPermissions: {
      headRepoFullName: 'pandemicsyn/neondeck',
      baseRepoFullName: 'pandemicsyn/neondeck',
      isFork: false,
      maintainerCanModify: true,
      headRepoPush: true,
      baseRepoPush: true,
      canLikelyPush: true,
      checkedAt: '2026-07-19T00:09:00.000Z',
    },
    isOutOfDate: false,
    fetchedAt: '2026-07-19T00:10:00.000Z',
    ...overrides,
  };
}
