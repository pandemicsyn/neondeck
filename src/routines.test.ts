import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRoutine,
  materializeNextRunAt,
  readRoutine,
  readRoutineConfig,
  recordRoutineFlueObservation,
  routineCreateAction,
  routinePauseAction,
  routineResumeAction,
  runDueRoutines,
  runRoutineNow,
  setRoutineEnabled,
  setRoutineDispatchForTests,
  updateRoutine,
} from './modules/routines';
import { runSchedulerTick } from './modules/scheduler';
import { listChatSessionCommandEvents } from './modules/sessions';
import { createRoutineRoutes } from './server/routes/routines';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { openDb } from './lib/sqlite';
import { listReports, readReportHtml } from './modules/reports';
import { runWithFlueExecutionContextForTests } from './modules/flue/execution-context';
import { updateRoutinesConfig } from './modules/config';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('routines', () => {
  it('materializes interval and one-shot schedules', () => {
    const now = new Date('2026-07-06T09:00:00.000Z');

    expect(materializeNextRunAt('interval', '900', now)).toEqual({
      ok: true,
      nextRunAt: '2026-07-06T09:15:00.000Z',
    });
    expect(
      materializeNextRunAt('once', '2026-07-06T10:00:00.000Z', now),
    ).toEqual({
      ok: true,
      nextRunAt: '2026-07-06T10:00:00.000Z',
    });
    expect(materializeNextRunAt('once', '2026-07-06T10:00:00Z', now)).toEqual({
      ok: true,
      nextRunAt: '2026-07-06T10:00:00.000Z',
    });
    expect(materializeNextRunAt('interval', '60', now)).toMatchObject({
      ok: false,
    });
    expect(
      materializeNextRunAt('once', 'July 6, 2026 10:00', now),
    ).toMatchObject({
      ok: false,
    });
    expect(
      materializeNextRunAt('once', '2026-02-31T10:00:00.000Z', now),
    ).toMatchObject({
      ok: false,
    });
    expect(materializeNextRunAt('cron', '* * * * *', now)).toMatchObject({
      ok: false,
      message: expect.stringContaining('at least 900 seconds between runs'),
    });
    expect(materializeNextRunAt('cron', '0,5 * * * *', now)).toMatchObject({
      ok: false,
      message: expect.stringContaining('found a 300-second gap'),
    });
    expect(materializeNextRunAt('cron', '0,15,30,45 * * * *', now)).toEqual({
      ok: true,
      nextRunAt: '2026-07-06T09:15:00.000Z',
    });
  });

  it('queues run-now routines as session command events', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const dispatches: Array<{ id: string; input: string }> = [];
    const restoreDispatch = setRoutineDispatchForTests(async (input) => {
      dispatches.push({ id: input.id, input: input.input });
      return { dispatchId: `dispatch-${dispatches.length}` } as never;
    });
    const created = await createRoutine(
      {
        name: 'Morning review',
        prompt: 'Summarize what is blocked.',
        scheduleKind: 'interval',
        schedule: '900',
        delivery: 'report',
        createdBy: 'test',
      },
      paths,
    );
    try {
      expect(created.ok).toBe(true);
      if (!created.ok || !('routine' in created)) {
        throw new Error(created.message);
      }

      const run = await runRoutineNow(created.routine.id, paths);

      expect(run).toMatchObject({
        ok: true,
        run: {
          outcome: 'recorded',
          status: 'queued',
          routineId: created.routine.id,
        },
      });
      if (!run.ok || !('run' in run) || !run.run) throw new Error(run.message);
      const runRecord = run.run;
      expect(runRecord.sessionId).toBeTruthy();
      expect(runRecord.commandEventId).toBeTruthy();
      expect(runRecord.dispatchId).toBe('dispatch-1');
      expect(dispatches).toEqual([
        {
          id: runRecord.sessionId,
          input: expect.stringContaining('Summarize what is blocked.'),
        },
      ]);
      const events = await listChatSessionCommandEvents(
        { sessionId: runRecord.sessionId as string },
        paths,
      );
      expect(events).toMatchObject({
        ok: true,
        events: [
          expect.objectContaining({
            id: runRecord.commandEventId,
            status: 'running',
            input: expect.stringContaining('Summarize what is blocked.'),
          }),
        ],
      });

      const saved = await readRoutine(created.routine.id, paths);
      expect(saved).toMatchObject({
        ok: true,
        routine: {
          runCount: 1,
          runningRunId: runRecord.id,
          enabled: true,
          sessionId: runRecord.sessionId,
          nextRunAt: expect.any(String),
        },
      });

      const secondRun = await runRoutineNow(created.routine.id, paths);
      expect(secondRun).toMatchObject({
        ok: false,
        changed: false,
        run: null,
      });
      expect(dispatches).toHaveLength(1);

      await recordRoutineFlueObservation(
        {
          v: 3,
          eventIndex: 1,
          timestamp: '2026-07-06T09:01:00.000Z',
          type: 'agent_end',
          instanceId: runRecord.sessionId as string,
          dispatchId: runRecord.dispatchId as string,
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'Blocked: no owner assigned.\n\nNo approvals are pending.',
                },
              ],
            },
          ],
        } as never,
        paths,
      );
      await expect(
        readRoutine(created.routine.id, paths),
      ).resolves.toMatchObject({
        ok: true,
        routine: {
          runningRunId: null,
        },
        runs: [
          expect.objectContaining({
            id: runRecord.id,
            status: 'completed',
            reportId: expect.any(String),
            summary: expect.objectContaining({
              summary: 'Blocked: no owner assigned.',
            }),
          }),
        ],
      });
      await expect(
        listChatSessionCommandEvents(
          { sessionId: runRecord.sessionId as string },
          paths,
        ),
      ).resolves.toMatchObject({
        ok: true,
        events: [
          expect.objectContaining({
            id: runRecord.commandEventId,
            status: 'completed',
            result: expect.objectContaining({
              message: expect.stringContaining('Blocked: no owner assigned'),
              reportId: expect.any(String),
            }),
          }),
        ],
      });
      const reports = await listReports(paths, { kind: 'routine' });
      const completionReport = reports.find((report) =>
        report.title.startsWith('Routine completed:'),
      );
      expect(completionReport).toBeTruthy();
      const html = await readReportHtml(completionReport!.id, paths);
      expect(html?.html).toContain('Blocked: no owner assigned.');
    } finally {
      restoreDispatch();
    }
  });

  it('dispatches full composed prompts while bounding command event input', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeSkill(join(paths.skills, 'long-guide'), {
      name: 'long-guide',
      description: 'Long routine guidance.',
      body: `Keep all details.\n${'detail '.repeat(450)}`,
    });
    const dispatches: Array<{ id: string; input: string }> = [];
    const restoreDispatch = setRoutineDispatchForTests(async (input) => {
      dispatches.push({ id: input.id, input: input.input });
      return { dispatchId: 'long-prompt-dispatch' } as never;
    });
    const created = await createRoutine(
      {
        name: 'Long skill run',
        prompt: 'Use the long runtime skill.',
        scheduleKind: 'interval',
        schedule: '900',
        skills: ['long-guide'],
        delivery: 'report',
        createdBy: 'test',
      },
      paths,
    );
    try {
      expect(created.ok).toBe(true);
      if (!created.ok || !('routine' in created)) {
        throw new Error(created.message);
      }

      const run = await runRoutineNow(created.routine.id, paths);

      expect(run.ok).toBe(true);
      if (!run.ok || !('run' in run) || !run.run?.sessionId) {
        throw new Error(run.message);
      }
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0].input.length).toBeGreaterThan(2_000);
      expect(dispatches[0].input).toContain('detail detail detail');
      const events = await listChatSessionCommandEvents(
        { sessionId: run.run.sessionId },
        paths,
      );
      expect(events.ok).toBe(true);
      if (!('events' in events)) {
        throw new Error('Expected routine command event to be recorded.');
      }
      expect(events.events[0].input.length).toBeLessThanOrEqual(2_000);
      expect(events.events[0].input).toContain('full prompt was dispatched');
    } finally {
      restoreDispatch();
    }
  });

  it('rejects duplicate routine skill ids', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);

    await expect(
      createRoutine(
        {
          name: 'Duplicate skills',
          prompt: 'Use the same skill twice.',
          scheduleKind: 'interval',
          schedule: '900',
          skills: ['neondeck', 'neondeck'],
          createdBy: 'test',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('must be unique'),
    });
  });

  it('admits due routines without awaiting agent completion', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const restoreDispatch = setRoutineDispatchForTests(async () => {
      return { dispatchId: 'scheduled-dispatch' } as never;
    });
    const created = await createRoutine(
      {
        name: 'Due once',
        prompt: 'List queued approvals.',
        scheduleKind: 'once',
        schedule: '2026-07-06T08:00:00.000Z',
        delivery: 'notification',
        createdBy: 'test',
      },
      paths,
    );
    try {
      expect(created.ok).toBe(true);
      if (!created.ok || !('routine' in created)) {
        throw new Error(created.message);
      }

      const tick = await runDueRoutines(
        paths,
        new Date('2026-07-06T09:00:00.000Z'),
      );

      expect(tick).toMatchObject({
        outcome: 'recorded',
        result: {
          runCount: 1,
          runs: [
            expect.objectContaining({
              status: 'queued',
              outcome: 'recorded',
              commandEventId: expect.any(String),
            }),
          ],
        },
      });
      const saved = await readRoutine(created.routine.id, paths);
      expect(saved).toMatchObject({
        ok: true,
        routine: {
          enabled: false,
          runCount: 1,
          runningRunId: expect.any(String),
          nextRunAt: null,
        },
      });
      await expect(
        setRoutineEnabled(created.routine.id, true, paths),
      ).resolves.toMatchObject({
        ok: true,
        routine: {
          enabled: true,
          nextRunAt: expect.any(String),
        },
      });
    } finally {
      restoreDispatch();
    }
  });

  it('enforces the global active routine cap across scheduler ticks', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    let dispatchCount = 0;
    const restoreDispatch = setRoutineDispatchForTests(async () => {
      dispatchCount += 1;
      return { dispatchId: `capped-dispatch-${dispatchCount}` } as never;
    });
    try {
      const created = await Promise.all(
        [1, 2, 3].map((index) =>
          createRoutine(
            {
              name: `Capped routine ${index}`,
              prompt: `Run capped routine ${index}.`,
              scheduleKind: 'interval',
              schedule: '900',
              delivery: 'notification',
              createdBy: 'test',
            },
            paths,
          ),
        ),
      );
      for (const result of created) {
        expect(result.ok).toBe(true);
        if (!result.ok || !('routine' in result)) {
          throw new Error(result.message);
        }
      }
      const database = openDb(paths.neondeckDatabase);
      try {
        for (const result of created) {
          if (!result.ok || !('routine' in result)) continue;
          database
            .prepare('UPDATE routines SET next_run_at = ? WHERE id = ?;')
            .run('2026-07-06T08:00:00.000Z', result.routine.id);
        }
      } finally {
        database.close();
      }

      const firstTick = await runDueRoutines(
        paths,
        new Date('2026-07-06T09:00:00.000Z'),
      );
      expect(firstTick).toMatchObject({
        outcome: 'recorded',
        result: { runCount: 2 },
      });
      expect(dispatchCount).toBe(2);

      const secondTick = await runDueRoutines(
        paths,
        new Date('2026-07-06T09:01:00.000Z'),
      );
      expect(secondTick).toMatchObject({
        outcome: 'silent',
        message: 'Routine concurrency cap reached.',
        result: {
          runCount: 0,
          activeCount: 2,
          limit: 2,
        },
      });
      expect(dispatchCount).toBe(2);
    } finally {
      restoreDispatch();
    }
  });

  it('reports due routine admission failures without counting them as admitted', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const restoreDispatch = setRoutineDispatchForTests(async () => {
      throw new Error('dispatch unavailable');
    });
    const created = await createRoutine(
      {
        name: 'Failing due routine',
        prompt: 'This dispatch will fail.',
        scheduleKind: 'once',
        schedule: '2026-07-06T08:00:00.000Z',
        delivery: 'report',
        createdBy: 'test',
      },
      paths,
    );
    try {
      expect(created.ok).toBe(true);
      if (!created.ok || !('routine' in created)) {
        throw new Error(created.message);
      }

      const tick = await runDueRoutines(
        paths,
        new Date('2026-07-06T09:00:00.000Z'),
      );

      expect(tick).toMatchObject({
        outcome: 'failed',
        message: expect.stringContaining('Failed to admit 1 routine run'),
        result: {
          attemptedCount: 1,
          runCount: 0,
          failureCount: 1,
          runs: [],
          failures: [
            expect.objectContaining({
              message: expect.stringContaining('dispatch unavailable'),
              run: expect.objectContaining({
                outcome: 'failed',
                error: 'dispatch unavailable',
                reportId: expect.any(String),
              }),
            }),
          ],
        },
        notifications: [
          expect.objectContaining({
            level: 'attention',
            title: 'Routine failed',
          }),
        ],
      });
      const reports = await listReports(paths, { kind: 'routine' });
      expect(reports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'Routine failed: Failing due routine',
            sourceRef: created.routine.id,
          }),
        ]),
      );
    } finally {
      restoreDispatch();
    }
  });

  it('preserves schedule updates made while a routine is active', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    let routineId = '';
    const restoreDispatch = setRoutineDispatchForTests(async () => {
      await updateRoutine(
        routineId,
        {
          scheduleKind: 'once',
          schedule: '2026-07-07T08:00:00.000Z',
        },
        paths,
      );
      return { dispatchId: 'updated-while-running' } as never;
    });
    const created = await createRoutine(
      {
        name: 'Mutable schedule',
        prompt: 'Keep the latest schedule.',
        scheduleKind: 'interval',
        schedule: '900',
        delivery: 'notification',
        createdBy: 'test',
      },
      paths,
    );
    try {
      expect(created.ok).toBe(true);
      if (!created.ok || !('routine' in created)) {
        throw new Error(created.message);
      }
      routineId = created.routine.id;

      const run = await runRoutineNow(created.routine.id, paths);
      expect(run).toMatchObject({ ok: true });

      const saved = await readRoutine(created.routine.id, paths);
      expect(saved).toMatchObject({
        ok: true,
        routine: {
          scheduleKind: 'once',
          schedule: '2026-07-07T08:00:00.000Z',
          enabled: true,
          runCount: 1,
          runningRunId: expect.any(String),
          nextRunAt: '2026-07-07T08:00:00.000Z',
        },
      });
    } finally {
      restoreDispatch();
    }
  });

  it('honors repeat limit updates made while a routine is active', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const restoreDispatch = setRoutineDispatchForTests(async () => {
      return { dispatchId: 'repeat-limit-while-running' } as never;
    });
    const created = await createRoutine(
      {
        name: 'Mutable repeat limit',
        prompt: 'Stop after this run if the limit changes.',
        scheduleKind: 'interval',
        schedule: '900',
        delivery: 'notification',
        createdBy: 'test',
      },
      paths,
    );
    try {
      expect(created.ok).toBe(true);
      if (!created.ok || !('routine' in created)) {
        throw new Error(created.message);
      }

      const run = await runRoutineNow(created.routine.id, paths);
      expect(run).toMatchObject({ ok: true });
      if (!run.ok || !('run' in run) || !run.run) throw new Error(run.message);

      await updateRoutine(
        created.routine.id,
        {
          repeatLimit: 1,
        },
        paths,
      );
      await recordRoutineFlueObservation(
        {
          v: 3,
          eventIndex: 2,
          timestamp: '2026-07-06T09:02:00.000Z',
          type: 'agent_end',
          instanceId: run.run.sessionId as string,
          dispatchId: run.run.dispatchId as string,
          messages: [],
        } as never,
        paths,
      );

      await expect(
        readRoutine(created.routine.id, paths),
      ).resolves.toMatchObject({
        ok: true,
        routine: {
          repeatLimit: 1,
          enabled: false,
          runCount: 1,
          runningRunId: null,
          nextRunAt: null,
        },
      });
    } finally {
      restoreDispatch();
    }
  });

  it('auto-pauses after repeated Flue-settled routine failures', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    let dispatchCount = 0;
    const restoreDispatch = setRoutineDispatchForTests(async () => {
      dispatchCount += 1;
      return { dispatchId: `failing-flue-${dispatchCount}` } as never;
    });
    const created = await createRoutine(
      {
        name: 'Repeated failures',
        prompt: 'This routine fails in Flue.',
        scheduleKind: 'interval',
        schedule: '900',
        delivery: 'notification',
        createdBy: 'test',
      },
      paths,
    );
    try {
      expect(created.ok).toBe(true);
      if (!created.ok || !('routine' in created)) {
        throw new Error(created.message);
      }

      for (let index = 1; index <= 3; index += 1) {
        const run = await runRoutineNow(created.routine.id, paths);
        expect(run).toMatchObject({ ok: true });
        if (!run.ok || !('run' in run) || !run.run) {
          throw new Error(run.message);
        }
        await recordRoutineFlueObservation(
          {
            v: 3,
            eventIndex: index,
            timestamp: `2026-07-06T09:0${index}:00.000Z`,
            type: 'operation',
            operationId: `operation-${index}`,
            operationKind: 'prompt',
            durationMs: 1,
            isError: true,
            error: new Error(`prompt failed ${index}`),
            instanceId: run.run.sessionId as string,
            dispatchId: run.run.dispatchId as string,
          } as never,
          paths,
        );
      }

      await expect(
        readRoutine(created.routine.id, paths),
      ).resolves.toMatchObject({
        ok: true,
        routine: {
          enabled: false,
          consecutiveFailures: 3,
          runningRunId: null,
          nextRunAt: null,
        },
      });
    } finally {
      restoreDispatch();
    }
  });

  it('recovers stale active routine claims before manual admission', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    let dispatchCount = 0;
    const restoreDispatch = setRoutineDispatchForTests(async () => {
      dispatchCount += 1;
      return { dispatchId: `stale-dispatch-${dispatchCount}` } as never;
    });
    const created = await createRoutine(
      {
        name: 'Stale active run',
        prompt: 'Recover stale work.',
        scheduleKind: 'interval',
        schedule: '900',
        delivery: 'report',
        createdBy: 'test',
      },
      paths,
    );
    try {
      expect(created.ok).toBe(true);
      if (!created.ok || !('routine' in created)) {
        throw new Error(created.message);
      }

      const first = await runRoutineNow(created.routine.id, paths);
      expect(first).toMatchObject({ ok: true });
      if (!first.ok || !('run' in first) || !first.run) {
        throw new Error(first.message);
      }
      const database = openDb(paths.neondeckDatabase);
      try {
        database
          .prepare(
            'UPDATE routine_runs SET started_at = ?, created_at = ?, updated_at = ? WHERE id = ?;',
          )
          .run(
            '2000-01-01T00:00:00.000Z',
            '2000-01-01T00:00:00.000Z',
            '2000-01-01T00:00:00.000Z',
            first.run.id,
          );
      } finally {
        database.close();
      }

      const second = await runRoutineNow(created.routine.id, paths);
      expect(second).toMatchObject({
        ok: true,
        run: expect.objectContaining({
          status: 'queued',
          dispatchId: 'stale-dispatch-2',
        }),
      });
      if (!second.ok || !('run' in second) || !second.run) {
        throw new Error(second.message);
      }
      expect(dispatchCount).toBe(2);
      await expect(
        readRoutine(created.routine.id, paths),
      ).resolves.toMatchObject({
        ok: true,
        routine: {
          runningRunId: second.run.id,
          consecutiveFailures: 1,
        },
        runs: expect.arrayContaining([
          expect.objectContaining({
            id: first.run.id,
            status: 'failed',
            reportId: expect.any(String),
            error: expect.stringContaining('No Flue settlement observation'),
          }),
        ]),
      });
      const reports = await listReports(paths, { kind: 'routine' });
      expect(reports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'Routine failed: Stale active run',
            sourceRef: created.routine.id,
          }),
        ]),
      );
    } finally {
      restoreDispatch();
    }
  });

  it('preserves materialized next run time on non-schedule updates', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const created = await createRoutine(
      {
        name: 'Stable schedule',
        prompt: 'Keep the scheduled time.',
        scheduleKind: 'interval',
        schedule: '900',
        delivery: 'notification',
        createdBy: 'test',
      },
      paths,
    );
    expect(created.ok).toBe(true);
    if (!created.ok || !('routine' in created)) {
      throw new Error(created.message);
    }
    const pinnedNextRunAt = '2026-07-07T09:00:00.000Z';
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare('UPDATE routines SET next_run_at = ? WHERE id = ?;')
        .run(pinnedNextRunAt, created.routine.id);
    } finally {
      database.close();
    }

    await updateRoutine(
      created.routine.id,
      { prompt: 'Keep the scheduled time, with updated copy.' },
      paths,
    );

    await expect(readRoutine(created.routine.id, paths)).resolves.toMatchObject(
      {
        ok: true,
        routine: {
          prompt: 'Keep the scheduled time, with updated copy.',
          nextRunAt: pinnedNextRunAt,
        },
      },
    );
  });

  it('requires repo-scoped routine cwd to be a directory inside the repo', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const repoPath = join(paths.home, 'repo');
    const insidePath = join(repoPath, 'work');
    const outsidePath = join(paths.home, 'outside');
    await mkdir(insidePath, { recursive: true });
    await mkdir(outsidePath, { recursive: true });
    await writeFile(join(repoPath, 'README.md'), 'repo file\n');
    await writeRepoRegistry(paths.repos, repoPath);
    const insideRealPath = await realpath(insidePath);

    await expect(
      createRoutine(
        {
          name: 'Outside cwd',
          prompt: 'Use the repo scope.',
          scheduleKind: 'interval',
          schedule: '900',
          scopeRepoId: 'repo',
          scopeCwd: outsidePath,
          createdBy: 'test',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('must be inside repository'),
    });

    await expect(
      createRoutine(
        {
          name: 'File cwd',
          prompt: 'Use a directory.',
          scheduleKind: 'interval',
          schedule: '900',
          scopeRepoId: 'repo',
          scopeCwd: join(repoPath, 'README.md'),
          createdBy: 'test',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('is not a directory'),
    });

    await expect(
      createRoutine(
        {
          name: 'Inside cwd',
          prompt: 'Use the repo scope.',
          scheduleKind: 'interval',
          schedule: '900',
          scopeRepoId: 'repo',
          scopeCwd: insidePath,
          createdBy: 'test',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      routine: expect.objectContaining({
        scopeRepoId: 'repo',
        scopeCwd: insideRealPath,
      }),
    });
  });

  it('reports routine-only scheduler ticks as changed', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const restoreDispatch = setRoutineDispatchForTests(async () => {
      return { dispatchId: 'session-only-dispatch' } as never;
    });
    const created = await createRoutine(
      {
        name: 'Session-only routine',
        prompt: 'Open a session-only status note.',
        scheduleKind: 'once',
        schedule: '2026-07-06T08:00:00.000Z',
        delivery: 'session',
        createdBy: 'test',
      },
      paths,
    );
    try {
      expect(created.ok).toBe(true);

      const tick = await runSchedulerTick(
        paths,
        new Date('2026-07-06T09:00:00.000Z'),
      );

      expect(tick).toMatchObject({
        ok: true,
        changed: true,
        outcome: 'updated',
        message: expect.stringContaining('Admitted 1 routine run'),
        notifications: [],
        extra: {
          routines: {
            outcome: 'recorded',
            result: { runCount: 1 },
          },
        },
      });
    } finally {
      restoreDispatch();
    }
  });

  it('requires confirmation before deleting routines through the route', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const created = await createRoutine(
      {
        name: 'Route delete',
        prompt: 'Delete through route.',
        scheduleKind: 'interval',
        schedule: '900',
        createdBy: 'test',
      },
      paths,
    );
    expect(created.ok).toBe(true);
    if (!created.ok || !('routine' in created))
      throw new Error(created.message);
    const routes = createRoutineRoutes(paths);

    const rejected = await routes.request(
      `http://localhost/routines/${encodeURIComponent(created.routine.id)}`,
      { method: 'DELETE' },
    );
    const rejectedBody = (await rejected.json()) as { requires?: string[] };
    expect(rejected.status).toBe(400);
    expect(rejectedBody).toMatchObject({ requires: ['confirm'] });

    const confirmed = await routes.request(
      `http://localhost/routines/${encodeURIComponent(created.routine.id)}?confirm=true`,
      { method: 'DELETE' },
    );
    expect(confirmed.status).toBe(200);
    expect(readRoutineEvents(paths, created.routine.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'routine_created' }),
        expect.objectContaining({ eventType: 'routine_deleted' }),
      ]),
    );
  });

  it('derives route-created routine actor instead of trusting caller input', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const routes = createRoutineRoutes(paths);

    const response = await routes.request('http://localhost/routines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Spoofed actor',
        prompt: 'Create through route.',
        scheduleKind: 'interval',
        schedule: '900',
        createdBy: 'agent:spoofed',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      routine: { id: string; createdBy: string };
    };
    expect(body.routine.createdBy).toBe('user:api');
    expect(readRoutineEvents(paths, body.routine.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: 'user:api',
          eventType: 'routine_created',
        }),
      ]),
    );
  });

  it('derives agent-created routine actor and caps enabled agent routines', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const previousHome = process.env.NEONDECK_HOME;
    process.env.NEONDECK_HOME = paths.home;
    try {
      const context = {
        agentName: 'display-assistant',
        instanceId: 'session-agent',
      };
      const first = await runWithFlueExecutionContextForTests(context, () =>
        routineCreateAction.run({
          input: {
            name: 'Agent routine 1',
            prompt: 'Summarize blockers.',
            scheduleKind: 'interval',
            schedule: '900',
          },
        } as never),
      );
      expect(first).toMatchObject({
        ok: true,
        routine: {
          createdBy: 'agent:session-agent',
        },
      });
      if (!first.ok || !('routine' in first)) {
        throw new Error(first.message);
      }
      const firstRoutine = first.routine as { id: string };
      expect(readRoutineEvents(paths, firstRoutine.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actor: 'agent:session-agent',
            eventType: 'routine_created',
          }),
        ]),
      );

      for (let index = 2; index <= 10; index += 1) {
        await expect(
          runWithFlueExecutionContextForTests(context, () =>
            routineCreateAction.run({
              input: {
                name: `Agent routine ${index}`,
                prompt: `Run agent routine ${index}.`,
                scheduleKind: 'interval',
                schedule: '900',
              },
            } as never),
          ),
        ).resolves.toMatchObject({ ok: true });
      }

      await expect(
        runWithFlueExecutionContextForTests(context, () =>
          routineCreateAction.run({
            input: {
              name: 'Agent routine over cap',
              prompt: 'This should not be admitted.',
              scheduleKind: 'interval',
              schedule: '900',
            },
          } as never),
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('cap reached'),
        requires: ['routine-cap'],
      });

      await expect(
        runWithFlueExecutionContextForTests(context, () =>
          routinePauseAction.run({
            input: { id: firstRoutine.id },
          } as never),
        ),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        runWithFlueExecutionContextForTests(context, () =>
          routineCreateAction.run({
            input: {
              name: 'Agent routine replacement',
              prompt: 'Fill the freed enabled slot.',
              scheduleKind: 'interval',
              schedule: '900',
            },
          } as never),
        ),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        runWithFlueExecutionContextForTests(context, () =>
          routineResumeAction.run({
            input: { id: firstRoutine.id },
          } as never),
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('cap reached'),
        requires: ['routine-cap'],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.NEONDECK_HOME;
      } else {
        process.env.NEONDECK_HOME = previousHome;
      }
    }
  });

  it('uses the routine kill switch for due and manual admissions', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    let dispatchCount = 0;
    const restoreDispatch = setRoutineDispatchForTests(async () => {
      dispatchCount += 1;
      return { dispatchId: `kill-switch-${dispatchCount}` } as never;
    });
    try {
      const created = await createRoutine(
        {
          name: 'Switchable routine',
          prompt: 'Respect the kill switch.',
          scheduleKind: 'once',
          schedule: '2026-07-06T08:00:00.000Z',
          createdBy: 'test',
        },
        paths,
      );
      expect(created.ok).toBe(true);
      if (!created.ok || !('routine' in created)) {
        throw new Error(created.message);
      }
      await expect(
        updateRoutinesConfig({ enabled: false }, paths),
      ).resolves.toMatchObject({ ok: true, changed: true });
      await expect(readRoutineConfig(paths)).resolves.toMatchObject({
        routines: { enabled: false },
      });

      await expect(
        runDueRoutines(paths, new Date('2026-07-06T09:00:00.000Z')),
      ).resolves.toMatchObject({
        outcome: 'silent',
        result: { disabled: true, runCount: 0 },
      });
      await expect(
        runRoutineNow(created.routine.id, paths),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining('disabled'),
        requires: ['routines.enabled'],
      });
      expect(dispatchCount).toBe(0);

      await updateRoutinesConfig({ enabled: true }, paths);
      await expect(
        runRoutineNow(created.routine.id, paths),
      ).resolves.toMatchObject({
        ok: true,
        run: expect.objectContaining({
          dispatchId: 'kill-switch-1',
        }),
      });
    } finally {
      restoreDispatch();
    }
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-routines-'));
  tempRoots.push(path);
  return path;
}

async function writeSkill(
  directory: string,
  input: { name: string; description: string; body: string },
) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---
name: ${input.name}
description: ${input.description}
---

# ${input.name}

${input.body}
`,
  );
}

async function writeRepoRegistry(path: string, repoPath: string) {
  await writeFile(
    path,
    `${JSON.stringify({
      repos: [
        {
          id: 'repo',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: repoPath,
          defaultBranch: 'main',
        },
      ],
    })}\n`,
  );
}

function readRoutineEvents(
  paths: ReturnType<typeof runtimePaths>,
  routineId: string,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `
        SELECT event_type AS eventType, routine_id AS routineId, run_id AS runId, actor
        FROM routine_events
        WHERE routine_id = ?
        ORDER BY created_at ASC;
      `,
      )
      .all(routineId);
  } finally {
    database.close();
  }
}
