import type { DispatchReceipt, FlueObservation } from '@flue/runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from './lib/sqlite';
import {
  admitBriefing,
  collectBriefingSnapshot,
  composeBriefingInput,
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

  it('admits manual briefing requests through the bounded briefing workflow', async () => {
    const paths = runtimePaths(await tempDir());
    const invokeWorkflow = vi.fn<
      (input: {
        profileId: string;
        sessionId?: string;
        commandEventId?: string;
        trigger: 'manual' | 'dashboard';
      }) => Promise<{ runId: string }>
    >(async () => ({ runId: 'workflow:briefing:manual' }));

    await expect(
      runBriefingNow(
        {
          profileId: 'morning',
          sessionId: 'neondeck-main',
          commandEventId: 'command:briefing:1',
          trigger: 'manual',
        },
        paths,
        { invokeWorkflow },
      ),
    ).resolves.toMatchObject({
      ok: true,
      workflowRunId: 'workflow:briefing:manual',
    });
    expect(invokeWorkflow).toHaveBeenCalledWith({
      profileId: 'morning',
      sessionId: 'neondeck-main',
      commandEventId: 'command:briefing:1',
      trigger: 'manual',
    });
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
        dispatchId: 'dispatch:manual:1',
        acceptedAt: new Date().toISOString(),
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
    const input = composeBriefingInput(
      run,
      await readBriefingProfile('morning', paths),
    );
    expect(input).toContain(
      `[NEONDECK_INTERNAL_BRIEFING_INPUT v1 trigger=manual run=${run.id}]`,
    );
    expect(input).not.toContain('output schema');
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

  it('reuses a non-active briefing conversation for scheduled occurrences', async () => {
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
      dispatchId: `dispatch:scheduled:${++sequence}`,
      acceptedAt: new Date().toISOString(),
    }));

    const first = await admitBriefing(
      { profileId: 'morning', trigger: 'scheduled' },
      paths,
      { dispatchAgent },
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

  it('surfaces stale briefing context and rotates only through the explicit action', async () => {
    const paths = runtimePaths(await tempDir());
    const first = await admitBriefing(
      { profileId: 'morning', trigger: 'scheduled' },
      paths,
      {
        dispatchAgent: async () => ({
          dispatchId: 'dispatch:stale:first',
          acceptedAt: new Date().toISOString(),
        }),
      },
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
    await expect(
      admitBriefing({ profileId: 'morning', trigger: 'scheduled' }, paths, {
        dispatchAgent: async () => ({
          dispatchId: 'dispatch:stale:blocked',
          acceptedAt: new Date().toISOString(),
        }),
      }),
    ).rejects.toThrow('context is stale');

    const rotated = await rotateBriefingSession({}, paths);
    expect(rotated).toMatchObject({
      ok: true,
      profile: { sessionId: expect.any(String) },
    });
    if (!('session' in rotated) || !rotated.session)
      throw new Error('Rotation did not return session.');
    expect(rotated.session.id).not.toBe(first.sessionId);
    await expect(readBriefingState(paths)).resolves.toMatchObject({
      profile: { sessionId: rotated.session.id },
      sessionStaleReasons: [],
    });
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
          dispatchId: 'dispatch:settle:1',
          acceptedAt: new Date().toISOString(),
        }),
      },
    );

    await settleBriefingObservation(
      {
        type: 'agent_end',
        v: 3,
        eventIndex: 12,
        timestamp: new Date().toISOString(),
        instanceId: active.activeSessionId,
        dispatchId: run.dispatchId,
        messages: [],
        agentOutput: {
          type: 'text',
          text: 'Arbitrary prose that app state must never parse.',
          finishReason: 'stop',
        },
      } as Extract<FlueObservation, { type: 'agent_end' }>,
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

  it('settles failed dispatches from the terminal Flue prompt operation', async () => {
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
          dispatchId: 'dispatch:settle:failed',
          acceptedAt: new Date().toISOString(),
        }),
      },
    );

    await settleBriefingObservation(
      {
        type: 'operation',
        v: 3,
        eventIndex: 14,
        timestamp: new Date().toISOString(),
        instanceId: active.activeSessionId,
        dispatchId: run.dispatchId,
        operationId: 'operation:failed',
        operationKind: 'prompt',
        durationMs: 20,
        isError: true,
        error: new Error('provider unavailable'),
      } as Extract<FlueObservation, { type: 'operation' }>,
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
    const dispatchId = 'dispatch:fast-terminal';
    const run = await admitBriefing(
      {
        profileId: 'morning',
        trigger: 'manual',
        sessionId: active.activeSessionId,
      },
      paths,
      {
        dispatchAgent: async () => {
          await settleBriefingObservation(
            {
              type: 'agent_end',
              v: 3,
              eventIndex: 1,
              timestamp: new Date().toISOString(),
              instanceId: active.activeSessionId,
              dispatchId,
              messages: [],
              agentOutput: {
                type: 'text',
                text: 'Fast response.',
                finishReason: 'stop',
              },
            } as Extract<FlueObservation, { type: 'agent_end' }>,
            paths,
          );
          return { dispatchId, acceptedAt: new Date().toISOString() };
        },
      },
    );

    await expect(readBriefingRunDetails(run.id, paths)).resolves.toMatchObject({
      run: { status: 'ready', dispatchId },
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
          dispatchId: 'dispatch:nested',
          acceptedAt: new Date().toISOString(),
        }),
      },
    );
    const base = {
      type: 'agent_end',
      v: 3,
      eventIndex: 2,
      timestamp: new Date().toISOString(),
      dispatchId: run.dispatchId,
      messages: [],
      agentOutput: { type: 'text', text: 'nested', finishReason: 'stop' },
    };
    await settleBriefingObservation(
      {
        ...base,
        instanceId: active.activeSessionId,
        taskId: 'task:child',
      } as unknown as Extract<FlueObservation, { type: 'agent_end' }>,
      paths,
    );
    await settleBriefingObservation(
      {
        ...base,
        instanceId: 'another-session',
      } as Extract<FlueObservation, { type: 'agent_end' }>,
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
          dispatchId: 'dispatch:corrupt-snapshot',
          acceptedAt: new Date().toISOString(),
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
