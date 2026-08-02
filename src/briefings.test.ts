import type { DispatchReceipt, FlueObservation } from '@flue/runtime';
import type { FlueConversationSnapshot } from '@flue/sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { openDb } from './lib/sqlite';
import {
  admitBriefing,
  collectBriefingSnapshot,
  composeBriefingInput,
  createBriefingRun,
  prepareBriefingAgentDelivery,
  recoverInterruptedBriefingAdmissions,
  readBriefingProfile,
  readBriefingRunDetails,
  readBriefingState,
  runBriefingNow,
  rotateBriefingSession,
  settleBriefingObservation,
  updateBriefingProfile,
} from './modules/briefings';
import { listNotifications } from './modules/app-state';
import {
  createChatSessionCommandEvent,
  listChatSessionCommandEvents,
  readNeonSessionState,
  sessionContextInstructionsForAgentSync,
} from './modules/sessions';
import {
  readScheduledTask,
  upsertScheduledTask,
} from './modules/scheduled-tasks';
import { runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('conversational briefings', () => {
  it('initializes the advertised default schedule on a fresh runtime', async () => {
    const paths = runtimePaths(await tempDir());

    await expect(readBriefingProfile('morning', paths)).resolves.toMatchObject({
      compatibility: false,
      enabled: true,
      schedule: '0 8 * * 1-5',
    });
    await expect(
      readScheduledTask('briefing:morning', paths),
    ).resolves.toMatchObject({
      enabled: true,
      spec: { kind: 'run-briefing', briefingId: 'morning' },
      trigger: { kind: 'cron', expression: '0 8 * * 1-5' },
      nextRunAt: expect.any(String),
    });
  });

  it('admits manual briefing requests directly into the briefing conversation', async () => {
    const paths = runtimePaths(await tempDir());
    const dispatchAgent = vi.fn<
      (request: {
        agent: string;
        id: string;
        input: string;
      }) => Promise<DispatchReceipt>
    >(async () => ({
      submissionId: 'submission:briefing:manual',
      acceptedAt: new Date().toISOString(),
      uid: 'briefing-test-session',
    }));

    await expect(
      runBriefingNow(
        {
          profileId: 'morning',
          sessionId: 'neondeck-main',
          commandEventId: 'command:briefing:1',
          trigger: 'manual',
        },
        paths,
        { dispatchAgent },
      ),
    ).resolves.toMatchObject({
      ok: true,
      briefingRunId: expect.any(String),
      submissionId: 'submission:briefing:manual',
      sessionId: 'neondeck-main',
    });
    expect(dispatchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'display-assistant',
        id: 'neondeck-main',
      }),
    );
  });

  it('collects bounded partial snapshots without failing the whole briefing', async () => {
    const paths = runtimePaths(await tempDir());
    const snapshot = await collectBriefingSnapshot(paths, {
      async readRepos() {
        throw new Error('repo provider unavailable');
      },
    });

    expect(snapshot.sources.repos).toMatchObject({
      status: 'unavailable',
      error: 'repo provider unavailable',
      data: null,
    });
    expect(snapshot.sources.notifications.status).toBe('ok');
    expect(snapshot.byteSize).toBeGreaterThan(0);
    expect(snapshot.byteSize).toBeLessThanOrEqual(96_000);
  });

  it('recollects the current repo registry for every briefing snapshot', async () => {
    const paths = runtimePaths(await tempDir());
    const repos = [
      {
        id: 'neondeck',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/repos/neondeck',
        defaultBranch: 'main',
      },
    ];
    const dependencies = {
      async readRepos() {
        return {
          home: paths.home,
          path: paths.repos,
          repos: [...repos],
          count: repos.length,
          fetchedAt: new Date().toISOString(),
        };
      },
    };

    const first = await collectBriefingSnapshot(paths, dependencies);
    repos.push({
      id: 'flue',
      github: { owner: 'earendil-works', name: 'flue' },
      path: '/repos/flue',
      defaultBranch: 'main',
    });
    const second = await collectBriefingSnapshot(paths, dependencies);

    expect(first.sources.repos.data).toMatchObject({
      total: 1,
      items: [{ id: 'neondeck' }],
    });
    expect(second.sources.repos.data).toMatchObject({
      total: 2,
      items: [{ id: 'neondeck' }, { id: 'flue' }],
    });
  });

  it('compacts oversized deterministic sections with explicit truncation metadata', async () => {
    const paths = runtimePaths(await tempDir());
    const snapshot = await collectBriefingSnapshot(paths, {
      async readNotifications() {
        return Array.from({ length: 50 }, (_, index) => ({
          id: `notification:${index}`,
          level: 'info' as const,
          title: `Notification ${index}`,
          message: 'x'.repeat(10_000),
          source: 'test',
          sourceId: String(index),
          data: null,
          readAt: null,
          resolvedAt: null,
          occurrenceCount: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
      },
    });

    expect(snapshot).toMatchObject({
      truncated: true,
      sources: {
        notifications: { status: 'partial', truncated: true },
      },
    });
    expect(snapshot.byteSize).toBeLessThanOrEqual(96_000);
  });

  it('reads legacy briefing tasks compatibly and persists typed profile updates', async () => {
    const paths = runtimePaths(await tempDir());
    await upsertScheduledTask(
      {
        id: 'briefing:morning',
        spec: { kind: 'run-briefing', briefingId: 'morning' },
        trigger: {
          kind: 'cron',
          expression: '30 7 * * 1-5',
          timezone: 'America/Chicago',
        },
        enabled: false,
      },
      paths,
    );

    await expect(readBriefingProfile('morning', paths)).resolves.toMatchObject({
      compatibility: true,
      enabled: false,
      schedule: '30 7 * * 1-5',
      timezone: 'America/Chicago',
    });

    const updated = await updateBriefingProfile(
      {
        instructions: 'Prioritize Jira sprint blockers and team reviews.',
        enabled: true,
        schedule: '0 9 * * 1-5',
        timezone: 'America/New_York',
      },
      paths,
    );
    expect(updated).toMatchObject({
      ok: true,
      profile: {
        compatibility: false,
        instructionsVersion: 2,
        schedule: '0 9 * * 1-5',
      },
    });
    await expect(
      readScheduledTask('briefing:morning', paths),
    ).resolves.toMatchObject({
      enabled: true,
      trigger: {
        kind: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'America/New_York',
      },
    });
  });

  it('persists the exact snapshot before dispatching to the selected display assistant session', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    let stateDuringDispatch:
      Awaited<ReturnType<typeof readBriefingState>> | undefined;
    const dispatchAgent = vi.fn<
      (request: {
        agent: string;
        id: string;
        input: string;
      }) => Promise<DispatchReceipt>
    >(async (request) => {
      stateDuringDispatch = await readBriefingState(paths);
      expect(request.agent).toBe('display-assistant');
      expect(request.id).toBe(active.activeSessionId);
      expect(request.input).toContain('User briefing instructions:');
      expect(request.input).toContain('do not mutate external systems');
      return {
        submissionId: 'dispatch:manual:1',
        acceptedAt: new Date().toISOString(),

        uid: 'briefing-test-session',
      };
    });

    const run = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'manual',
        sessionId: active.activeSessionId,
      },
      paths,
      { dispatchAgent },
    );

    expect(stateDuringDispatch?.latestRun).toMatchObject({
      id: run.id,
      status: 'queued',
      dispatchId: null,
      sessionId: active.activeSessionId,
    });
    expect(run.dispatchId).toBe('dispatch:manual:1');
    const input = composeBriefingInput(run);
    expect(input).toContain(
      `[NEONDECK_INTERNAL_BRIEFING_INPUT v1 trigger=manual run=${run.id}]`,
    );
    expect(input).not.toContain('output schema');
    await expect(
      prepareBriefingAgentDelivery(
        {
          runId: run.id,
          sessionId: active.activeSessionId,
          profileId: 'morning',
          snapshotVersion: '1',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      prompt: expect.stringContaining(`run=${run.id}`),
      data: {
        briefingRunId: run.id,
        profileId: 'morning',
        status: 'grounded',
        snapshotVersion: 1,
        sourceHealth: expect.arrayContaining([
          expect.objectContaining({ name: 'reviewQueue' }),
        ]),
        topActions: expect.any(Array),
        failures: expect.any(Array),
      },
    });
    await expect(
      prepareBriefingAgentDelivery(
        { runId: run.id, sessionId: 'wrong-session' },
        paths,
      ),
    ).rejects.toThrow('bound conversation');
    expect(stateDuringDispatch?.latestRun).not.toHaveProperty('instructions');
    expect(stateDuringDispatch?.latestRun?.snapshot).not.toHaveProperty(
      'sources',
    );
    await expect(readBriefingRunDetails(run.id, paths)).resolves.toMatchObject({
      ok: true,
      run: {
        id: run.id,
        instructions: expect.any(String),
        snapshot: { sources: expect.any(Object) },
      },
    });
  });

  it('recovers an accepted briefing from durable Flue history without dispatching it twice', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const admitted = await runBriefingNow(
      {
        profileId: 'morning',
        sessionId: active.activeSessionId,
        trigger: 'manual',
      },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'submission:accepted-before-crash',
          acceptedAt: new Date().toISOString(),
          uid: 'briefing-test-session',
        }),
        attachDispatch: async () => {
          throw new Error('simulated SQLite outage after Flue acceptance');
        },
      },
    );
    expect(admitted).toMatchObject({
      ok: true,
      submissionId: 'submission:accepted-before-crash',
      run: {
        admissionReconciliationPending: true,
      },
    });
    if (!admitted.ok) throw new Error('Briefing was not admitted.');

    const redispatch = vi.fn<
      (request: {
        agent: string;
        id: string;
        input: string;
        idempotencyKey: string;
      }) => Promise<DispatchReceipt>
    >(async () => ({
      submissionId: 'submission:accepted-before-crash',
      acceptedAt: new Date().toISOString(),
      uid: 'briefing-test-session',
      deduplicated: true,
    }));
    const history = briefingHistory({
      conversationId: active.activeSessionId,
      runId: admitted.briefingRunId,
      submissionId: 'submission:accepted-before-crash',
      outcome: 'completed',
    });
    await expect(
      recoverInterruptedBriefingAdmissions(
        {
          readConversationHistory: async () => history,
          dispatchAgent: redispatch,
        },
        paths,
      ),
    ).resolves.toEqual({
      recovered: [admitted.briefingRunId],
      dispatched: [],
      failed: [],
    });
    expect(redispatch).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: admitted.briefingRunId }),
    );
    await expect(
      readBriefingRunDetails(admitted.briefingRunId, paths),
    ).resolves.toMatchObject({
      run: {
        dispatchId: 'submission:accepted-before-crash',
        status: 'ready',
        error: null,
      },
    });
  });

  it('reconciles a delayed transient admission from durable history before rejecting the duplicate', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    onTestFinished(() => dateNow.mockRestore());
    const first = await runBriefingNow(
      {
        profileId: 'morning',
        sessionId: active.activeSessionId,
        trigger: 'manual',
      },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'submission:transient-attach',
          acceptedAt: new Date().toISOString(),
          uid: 'briefing-test-session',
        }),
        attachDispatch: async () => {
          throw new Error('transient attach failure');
        },
      },
    );
    if (!first.ok) throw new Error('First briefing was not accepted.');
    await settleBriefingObservation(
      {
        type: 'submission_settled',
        v: 3,
        eventIndex: 1,
        timestamp: new Date().toISOString(),
        instanceId: active.activeSessionId,
        submissionId: 'submission:transient-attach',
        outcome: 'completed',
      } as Extract<FlueObservation, { type: 'submission_settled' }>,
      paths,
    );
    dateNow.mockReturnValue(32_000);
    const retryDispatch = vi.fn<
      (request: {
        agent: string;
        id: string;
        input: string;
        idempotencyKey: string;
      }) => Promise<DispatchReceipt>
    >(async (request) => {
      const deduplicated = request.idempotencyKey === first.briefingRunId;
      return {
        submissionId: deduplicated
          ? 'submission:transient-attach'
          : 'submission:next-briefing',
        acceptedAt: new Date().toISOString(),
        uid: 'briefing-test-session',
        ...(deduplicated ? { deduplicated: true as const } : {}),
      };
    });

    const next = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'manual',
        sessionId: active.activeSessionId,
      },
      paths,
      {
        dispatchAgent: retryDispatch,
        readConversationHistory: async () =>
          briefingHistory({
            conversationId: active.activeSessionId,
            runId: first.briefingRunId,
            submissionId: 'submission:transient-attach',
            outcome: 'completed',
          }),
      },
    );
    expect(next).toMatchObject({
      status: 'queued',
      dispatchId: 'submission:next-briefing',
    });
    expect(retryDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: first.briefingRunId }),
    );
    await expect(
      readBriefingRunDetails(first.briefingRunId, paths),
    ).resolves.toMatchObject({
      run: {
        dispatchId: 'submission:transient-attach',
        status: 'ready',
        error: null,
      },
    });
  });

  it('replays durable settlement for an attached run after Neondeck restarts', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const run = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'scheduled',
        sessionId: active.activeSessionId,
      },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'submission:settled-before-app-write',
          acceptedAt: new Date().toISOString(),
          uid: 'briefing-test-session',
        }),
      },
    );
    const redispatch =
      vi.fn<
        (request: {
          agent: string;
          id: string;
          input: string;
          idempotencyKey: string;
        }) => Promise<DispatchReceipt>
      >();

    await expect(
      recoverInterruptedBriefingAdmissions(
        {
          readConversationHistory: async () =>
            briefingHistory({
              conversationId: active.activeSessionId,
              runId: run.id,
              submissionId: 'submission:settled-before-app-write',
              outcome: 'completed',
            }),
          dispatchAgent: redispatch,
        },
        paths,
      ),
    ).resolves.toEqual({
      recovered: [run.id],
      dispatched: [],
      failed: [],
    });
    expect(redispatch).not.toHaveBeenCalled();
    await expect(readBriefingRunDetails(run.id, paths)).resolves.toMatchObject({
      run: { status: 'ready' },
    });
  });

  it('dispatches a persisted outbox briefing when Flue history proves it was never accepted', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const profile = await readBriefingProfile('morning', paths);
    const snapshot = await collectBriefingSnapshot(paths);
    const orphan = await createBriefingRun(
      {
        profileId: profile.id,
        trigger: 'scheduled',
        snapshot,
        instructions: profile.instructions,
        instructionsVersion: profile.instructionsVersion,
        sessionId: active.activeSessionId,
      },
      paths,
    );
    if (!orphan) throw new Error('Outbox briefing was not created.');
    const dispatchAgent = vi.fn<
      (request: {
        agent: string;
        id: string;
        input: string;
        idempotencyKey: string;
      }) => Promise<DispatchReceipt>
    >(async () => ({
      submissionId: 'submission:replayed-outbox',
      acceptedAt: new Date().toISOString(),
      uid: 'briefing-test-session',
    }));

    await expect(
      recoverInterruptedBriefingAdmissions(
        {
          readConversationHistory: async () => null,
          dispatchAgent,
        },
        paths,
      ),
    ).resolves.toEqual({
      recovered: [],
      dispatched: [orphan.id],
      failed: [],
    });
    expect(dispatchAgent).toHaveBeenCalledTimes(1);
    expect(dispatchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: orphan.id }),
    );
    await expect(
      readBriefingRunDetails(orphan.id, paths),
    ).resolves.toMatchObject({
      run: {
        dispatchId: 'submission:replayed-outbox',
        status: 'queued',
        error: null,
      },
    });
  });

  it('reuses a non-active briefing conversation for sequential scheduled occurrences', async () => {
    const paths = runtimePaths(await tempDir());
    const activeBefore = await readNeonSessionState(paths);
    let sequence = 0;
    const dispatchAgent = vi.fn<
      (request: {
        agent: string;
        id: string;
        input: string;
      }) => Promise<DispatchReceipt>
    >(async () => ({
      submissionId: `dispatch:scheduled:${++sequence}`,
      acceptedAt: new Date().toISOString(),

      uid: 'briefing-test-session',
    }));

    const first = await admitBriefing(
      { profileId: 'morning', trigger: 'scheduled' },
      paths,
      { dispatchAgent },
    );
    await settleBriefingObservation(
      {
        type: 'submission_settled',
        v: 3,
        eventIndex: 1,
        timestamp: new Date().toISOString(),
        instanceId: first.sessionId,
        submissionId: first.dispatchId!,
        outcome: 'completed',
      } as Extract<FlueObservation, { type: 'submission_settled' }>,
      paths,
    );
    const second = await admitBriefing(
      { profileId: 'morning', trigger: 'scheduled' },
      paths,
      { dispatchAgent },
    );
    const activeAfter = await readNeonSessionState(paths);

    expect(first.sessionId).toBe(second.sessionId);
    expect(first.sessionId).not.toBe(activeBefore.activeSessionId);
    expect(activeAfter.activeSessionId).toBe(activeBefore.activeSessionId);
    expect(
      activeAfter.sessions.find((session) => session.id === first.sessionId),
    ).toMatchObject({ kind: 'briefing', linkedTaskId: 'briefing:morning' });
  });

  it('rejects a second briefing while an attached submission is still active', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const dispatchAgent = vi.fn(async () => ({
      submissionId: 'submission:briefing:active',
      acceptedAt: new Date().toISOString(),
      uid: 'briefing-test-session',
    }));

    const first = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'manual',
        sessionId: active.activeSessionId,
      },
      paths,
      { dispatchAgent },
    );

    await expect(
      admitBriefing(
        {
          profileId: 'morning',
          trigger: 'manual',
          sessionId: active.activeSessionId,
        },
        paths,
        {
          dispatchAgent,
          readConversationHistory: async () => {
            throw new Error('temporary history outage');
          },
        },
      ),
    ).rejects.toThrow(`Briefing "${first.id}" is already active`);
    expect(dispatchAgent).toHaveBeenCalledTimes(1);
  });

  it('fences a conversation across briefing profiles', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const snapshot = await collectBriefingSnapshot(paths);
    const first = await createBriefingRun(
      {
        profileId: 'morning',
        trigger: 'manual',
        snapshot,
        instructions: 'First profile.',
        instructionsVersion: 1,
        sessionId: active.activeSessionId,
      },
      paths,
    );

    await expect(
      createBriefingRun(
        {
          profileId: 'another-profile',
          trigger: 'manual',
          snapshot,
          instructions: 'Second profile.',
          instructionsVersion: 1,
          sessionId: active.activeSessionId,
        },
        paths,
      ),
    ).rejects.toThrow(`Briefing "${first?.id}" is already active`);
  });

  it('does not stale briefing context for dashboard-only layout changes', async () => {
    const paths = runtimePaths(await tempDir());
    const first = await admitBriefing(
      { profileId: 'morning', trigger: 'scheduled' },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'dispatch:layout:first',
          acceptedAt: new Date().toISOString(),

          uid: 'briefing-test-session',
        }),
      },
    );
    await settleBriefingObservation(
      {
        type: 'submission_settled',
        v: 3,
        eventIndex: 1,
        timestamp: new Date().toISOString(),
        instanceId: first.sessionId,
        submissionId: first.dispatchId!,
        outcome: 'completed',
      } as Extract<FlueObservation, { type: 'submission_settled' }>,
      paths,
    );
    const database = openDb(paths.neondeckDatabase);
    database
      .prepare(
        `
        INSERT INTO config_history (
          action,
          file,
          target,
          before_json,
          after_json,
          changed_at
        )
        VALUES (?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        'config_update_dashboard_layout',
        paths.dashboard,
        'layout',
        '{}',
        '{}',
        new Date(Date.now() + 1_000).toISOString(),
      );
    database.close();

    await expect(readBriefingState(paths)).resolves.toMatchObject({
      profile: { sessionId: first.sessionId },
      sessionStaleReasons: [],
    });
  });

  it('refreshes stale context in the same briefing conversation', async () => {
    const paths = runtimePaths(await tempDir());
    const first = await admitBriefing(
      { profileId: 'morning', trigger: 'scheduled' },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'dispatch:stale:first',
          acceptedAt: new Date().toISOString(),

          uid: 'briefing-test-session',
        }),
      },
    );
    await settleBriefingObservation(
      {
        type: 'submission_settled',
        v: 3,
        eventIndex: 1,
        timestamp: new Date().toISOString(),
        instanceId: first.sessionId,
        submissionId: first.dispatchId!,
        outcome: 'completed',
      } as Extract<FlueObservation, { type: 'submission_settled' }>,
      paths,
    );
    const database = openDb(paths.neondeckDatabase);
    database
      .prepare('UPDATE chat_sessions SET stale_reasons_json = ? WHERE id = ?;')
      .run(
        JSON.stringify([
          {
            type: 'model',
            message: 'Display-assistant model selection changed.',
            changedAt: new Date().toISOString(),
            target: 'displayAssistant',
          },
        ]),
        first.sessionId,
      );
    database.close();

    await expect(readBriefingState(paths)).resolves.toMatchObject({
      sessionStaleReasons: expect.arrayContaining([
        expect.objectContaining({ type: 'model' }),
      ]),
    });
    const staleDispatch = vi.fn<
      (request: {
        agent: string;
        id: string;
        input: string;
      }) => Promise<DispatchReceipt>
    >(async () => ({
      submissionId: 'dispatch:stale:continued',
      acceptedAt: new Date().toISOString(),

      uid: 'briefing-test-session',
    }));
    const continued = await admitBriefing(
      { profileId: 'morning', trigger: 'scheduled' },
      paths,
      {
        dispatchAgent: staleDispatch,
      },
    );

    expect(continued.sessionId).toBe(first.sessionId);
    expect(staleDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'display-assistant',
        id: first.sessionId,
      }),
    );

    const transitionInstructions = sessionContextInstructionsForAgentSync(
      first.sessionId,
      paths,
    );
    expect(transitionInstructions).toContain(
      'Server-controlled Neondeck briefing context transition',
    );
    expect(transitionInstructions).toContain(
      'Current system instructions, memory context, available tools',
    );
    expect(transitionInstructions).toContain(
      'first acknowledge in one brief sentence',
    );
    expect(transitionInstructions).toContain('model');
    expect(transitionInstructions).toContain('displayAssistant');
    await expect(readBriefingState(paths)).resolves.toMatchObject({
      profile: { sessionId: first.sessionId },
      sessionStaleReasons: [],
    });
    const refreshedDatabase = openDb(paths.neondeckDatabase);
    const audit = refreshedDatabase
      .prepare(
        `
        SELECT action
        FROM chat_session_audit
        WHERE session_id = ?
          AND action = 'briefing_context_refreshed'
        LIMIT 1;
      `,
      )
      .get(first.sessionId);
    refreshedDatabase.close();
    expect(audit).toBeTruthy();

    const subsequentInstructions = sessionContextInstructionsForAgentSync(
      first.sessionId,
      paths,
    );
    expect(subsequentInstructions).not.toContain(
      'Neondeck briefing context transition',
    );
  });

  it('allows a stale briefing conversation to be refreshed manually in place', async () => {
    const paths = runtimePaths(await tempDir());
    const first = await admitBriefing(
      { profileId: 'morning', trigger: 'scheduled' },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'dispatch:manual-stale:first',
          acceptedAt: new Date().toISOString(),

          uid: 'briefing-test-session',
        }),
      },
    );
    await settleBriefingObservation(
      {
        type: 'submission_settled',
        v: 3,
        eventIndex: 1,
        timestamp: new Date().toISOString(),
        instanceId: first.sessionId,
        submissionId: first.dispatchId!,
        outcome: 'completed',
      } as Extract<FlueObservation, { type: 'submission_settled' }>,
      paths,
    );
    const database = openDb(paths.neondeckDatabase);
    database
      .prepare('UPDATE chat_sessions SET stale_reasons_json = ? WHERE id = ?;')
      .run(
        JSON.stringify([
          {
            type: 'skill',
            message: 'Runtime skill configuration changed.',
            changedAt: new Date().toISOString(),
            target: 'skillRoots',
          },
        ]),
        first.sessionId,
      );
    database.close();

    const manual = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'manual',
        sessionId: first.sessionId,
      },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'dispatch:manual-stale:continued',
          acceptedAt: new Date().toISOString(),

          uid: 'briefing-test-session',
        }),
      },
    );

    expect(manual.sessionId).toBe(first.sessionId);
  });

  it('keeps explicit briefing conversation rotation available', async () => {
    const paths = runtimePaths(await tempDir());
    const first = await admitBriefing(
      { profileId: 'morning', trigger: 'scheduled' },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'dispatch:rotation:first',
          acceptedAt: new Date().toISOString(),

          uid: 'briefing-test-session',
        }),
      },
    );
    const rotated = await rotateBriefingSession({}, paths);
    expect(rotated).toMatchObject({
      ok: true,
      profile: { sessionId: expect.any(String) },
    });
    if (!('session' in rotated) || !rotated.session)
      throw new Error('Rotation did not return session.');
    expect(rotated.session.id).not.toBe(first.sessionId);
  });

  it('settles from the dispatched Flue agent observation without parsing assistant prose', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const command = await createChatSessionCommandEvent(
      {
        sessionId: active.activeSessionId,
        input: '/briefing',
        reason: 'test',
      },
      paths,
    );
    if (!('event' in command) || !command.event) {
      throw new Error('Command event was not created.');
    }
    const run = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'manual',
        sessionId: active.activeSessionId,
        commandEventId: command.event.id,
      },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'dispatch:settle:1',
          acceptedAt: new Date().toISOString(),

          uid: 'briefing-test-session',
        }),
      },
    );

    await settleBriefingObservation(
      {
        type: 'submission_settled',
        v: 3,
        eventIndex: 12,
        timestamp: new Date().toISOString(),
        instanceId: active.activeSessionId,
        submissionId: run.dispatchId,
        outcome: 'completed',
      } as Extract<FlueObservation, { type: 'submission_settled' }>,
      paths,
    );

    await expect(readBriefingState(paths)).resolves.toMatchObject({
      latestRun: {
        id: run.id,
        status: 'ready',
        completedAt: expect.any(String),
      },
    });
    await expect(
      listChatSessionCommandEvents(
        { sessionId: active.activeSessionId },
        paths,
      ),
    ).resolves.toMatchObject({
      events: [{ id: command.event.id, status: 'completed', result: null }],
    });
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Morning briefing ready',
          data: expect.objectContaining({ sessionId: active.activeSessionId }),
        }),
      ]),
    );
  });

  it('settles failed dispatches from terminal Flue submission state', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const run = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'manual',
        sessionId: active.activeSessionId,
      },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'dispatch:settle:failed',
          acceptedAt: new Date().toISOString(),

          uid: 'briefing-test-session',
        }),
      },
    );

    await settleBriefingObservation(
      {
        type: 'submission_settled',
        v: 3,
        eventIndex: 14,
        timestamp: new Date().toISOString(),
        instanceId: active.activeSessionId,
        submissionId: run.dispatchId,
        outcome: 'failed',
        error: { message: 'provider unavailable' },
      } as Extract<FlueObservation, { type: 'submission_settled' }>,
      paths,
    );

    await expect(readBriefingState(paths)).resolves.toMatchObject({
      latestRun: {
        id: run.id,
        status: 'failed',
        error: 'provider unavailable',
      },
    });
  });

  it('reconciles a terminal observation emitted before dispatch admission returns', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const command = await createChatSessionCommandEvent(
      {
        sessionId: active.activeSessionId,
        input: '/briefing',
        reason: 'fast-terminal-test',
      },
      paths,
    );
    if (!('event' in command) || !command.event) {
      throw new Error('Command event was not created.');
    }
    const dispatchId = 'dispatch:fast-terminal';
    const run = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'manual',
        sessionId: active.activeSessionId,
        commandEventId: command.event.id,
      },
      paths,
      {
        dispatchAgent: async () => {
          await settleBriefingObservation(
            {
              type: 'submission_settled',
              v: 3,
              eventIndex: 1,
              timestamp: new Date().toISOString(),
              instanceId: active.activeSessionId,
              submissionId: dispatchId,
              outcome: 'completed',
            } as Extract<FlueObservation, { type: 'submission_settled' }>,
            paths,
          );
          return {
            submissionId: dispatchId,
            acceptedAt: new Date().toISOString(),
            uid: 'briefing-test-session',
          };
        },
      },
    );

    await expect(readBriefingRunDetails(run.id, paths)).resolves.toMatchObject({
      run: { status: 'ready', dispatchId },
    });
    await expect(
      listChatSessionCommandEvents(
        { sessionId: active.activeSessionId },
        paths,
      ),
    ).resolves.toMatchObject({
      events: [
        {
          id: command.event.id,
          status: 'completed',
          flueRunId: dispatchId,
        },
      ],
    });
  });

  it('ignores nested and mismatched terminal observations', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const run = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'manual',
        sessionId: active.activeSessionId,
      },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'dispatch:nested',
          acceptedAt: new Date().toISOString(),

          uid: 'briefing-test-session',
        }),
      },
    );
    const base = {
      type: 'submission_settled',
      v: 3,
      eventIndex: 2,
      timestamp: new Date().toISOString(),
      submissionId: run.dispatchId,
      outcome: 'completed',
    };
    await settleBriefingObservation(
      {
        ...base,
        instanceId: active.activeSessionId,
        taskId: 'task:child',
      } as unknown as Extract<FlueObservation, { type: 'submission_settled' }>,
      paths,
    );
    await settleBriefingObservation(
      {
        ...base,
        instanceId: 'another-session',
      } as Extract<FlueObservation, { type: 'submission_settled' }>,
      paths,
    );

    await expect(readBriefingRunDetails(run.id, paths)).resolves.toMatchObject({
      run: { status: 'queued' },
    });
  });

  it('leaves both profile and task unchanged when schedule validation fails', async () => {
    const paths = runtimePaths(await tempDir());
    await updateBriefingProfile({ schedule: '0 8 * * 1-5' }, paths);
    const beforeProfile = await readBriefingProfile('morning', paths);
    const beforeTask = await readScheduledTask('briefing:morning', paths);

    await expect(
      updateBriefingProfile({ schedule: 'not a cron expression' }, paths),
    ).resolves.toMatchObject({ ok: false, changed: false });
    await expect(readBriefingProfile('morning', paths)).resolves.toEqual(
      beforeProfile,
    );
    await expect(readScheduledTask('briefing:morning', paths)).resolves.toEqual(
      beforeTask,
    );
  });

  it('rejects malformed persisted snapshot data with a controlled diagnostic', async () => {
    const paths = runtimePaths(await tempDir());
    const active = await readNeonSessionState(paths);
    const run = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'manual',
        sessionId: active.activeSessionId,
      },
      paths,
      {
        dispatchAgent: async () => ({
          submissionId: 'dispatch:corrupt-snapshot',
          acceptedAt: new Date().toISOString(),

          uid: 'briefing-test-session',
        }),
      },
    );
    const database = openDb(paths.neondeckDatabase);
    database
      .prepare('UPDATE briefing_runs SET snapshot_json = ? WHERE id = ?;')
      .run('{"version":99}', run.id);
    database.close();

    await expect(readBriefingRunDetails(run.id, paths)).rejects.toThrow(
      `Invalid persisted briefing snapshot for ${run.id}.`,
    );
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-briefings-'));
  tempRoots.push(path);
  return path;
}

function briefingHistory(input: {
  conversationId: string;
  runId: string;
  submissionId: string;
  outcome?: 'completed' | 'failed' | 'aborted';
}): FlueConversationSnapshot {
  return {
    v: 1,
    conversationId: input.conversationId,
    offset: '1',
    messages: [
      {
        id: `signal:${input.runId}`,
        role: 'system',
        purpose: 'dispatch',
        display: 'hidden',
        submissionId: input.submissionId,
        signal: {
          tagName: 'morning-briefing',
          attributes: { briefingRunId: input.runId },
        },
        parts: [],
      },
    ],
    settlements: input.outcome
      ? [{ submissionId: input.submissionId, outcome: input.outcome }]
      : [],
  };
}
