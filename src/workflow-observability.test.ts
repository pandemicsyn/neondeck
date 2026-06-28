import { type FlueObservation } from '@flue/runtime';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from './runtime-home';
import {
  readWorkflowObservability,
  recordFlueObservation,
} from './workflow-observability';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('workflow observability', () => {
  it('records sanitized active run, data, log, and tool events', async () => {
    const paths = runtimePaths(await tempHome());
    await recordFlueObservation(
      event({
        type: 'run_start',
        runId: 'run_1',
        workflowName: 'command-run',
        startedAt: '2026-06-27T20:00:00Z',
        input: { command: '/review-queue', secret: 'not persisted raw' },
      }),
      paths,
    );
    await recordFlueObservation(
      event({
        type: 'data',
        runId: 'run_1',
        name: 'neondeck.command',
        id: '/review-queue',
        data: { status: 'running', command: '/review-queue' },
      }),
      paths,
    );
    await recordFlueObservation(
      event({
        type: 'log',
        runId: 'run_1',
        level: 'info',
        message: 'Neon command requested',
        attributes: { command: '/review-queue', nested: { omitted: true } },
      }),
      paths,
    );
    await recordFlueObservation(
      event({
        type: 'tool',
        runId: 'run_1',
        toolName: 'neondeck_runtime_status_lookup',
        toolCallId: 'tool_1',
        isError: false,
        durationMs: 42,
        result: { ok: true, veryLarge: { omitted: true } },
      }),
      paths,
    );

    const snapshot = await readWorkflowObservability(paths);

    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({
        runId: 'run_1',
        workflow: 'command-run',
        runUrl: '/api/flue/runs/run_1?meta',
      }),
    ]);
    expect(snapshot.recentData).toEqual([
      expect.objectContaining({
        eventType: 'data',
        name: 'neondeck.command',
      }),
    ]);
    expect(snapshot.recentLogs).toEqual([
      expect.objectContaining({
        eventType: 'log',
        message: 'Neon command requested',
      }),
    ]);
    expect(snapshot.recentTools).toEqual([
      expect.objectContaining({
        eventType: 'tool',
        name: 'neondeck_runtime_status_lookup',
      }),
    ]);
    expect(snapshot.recentData[0]?.summary).toMatchObject({
      data: {
        type: 'object',
        keys: ['status', 'command'],
      },
    });
    expect(snapshot.recentLogs[0]?.summary).toMatchObject({
      attributes: {
        command: {
          type: 'string',
          length: 13,
          preview: '/review-queue',
        },
      },
    });
  });

  it('records only failed run_end events as recent failures and closes active runs', async () => {
    const paths = runtimePaths(await tempHome());
    await recordFlueObservation(
      event({
        type: 'run_start',
        runId: 'run_failed',
        workflowName: 'command-run',
        startedAt: '2026-06-27T20:00:00Z',
        input: { command: '/review-queue' },
      }),
      paths,
    );
    await recordFlueObservation(
      event({
        type: 'operation',
        runId: 'run_failed',
        operationId: 'op_recovered',
        operationKind: 'prompt',
        isError: true,
        error: new Error('Recovered model error'),
        durationMs: 25,
      }),
      paths,
    );
    await recordFlueObservation(
      event({
        type: 'run_end',
        runId: 'run_failed',
        isError: true,
        error: new Error('GitHub unavailable'),
        durationMs: 1_500,
      }),
      paths,
    );

    const snapshot = await readWorkflowObservability(paths);

    expect(snapshot.activeRuns).toEqual([]);
    expect(snapshot.recentFailures).toEqual([
      expect.objectContaining({
        eventType: 'run_end',
        isError: true,
        message: 'Workflow failed after 1.5s.',
      }),
    ]);
    expect(snapshot.recentOperations).toEqual([
      expect.objectContaining({
        eventType: 'operation',
        isError: true,
      }),
    ]);
  });

  it('keeps active runs from the durable projection after old events leave the read window', async () => {
    const paths = runtimePaths(await tempHome());
    await recordFlueObservation(
      event({
        type: 'run_start',
        runId: 'run_long',
        workflowName: 'command-run',
        startedAt: '2026-06-27T20:00:00Z',
        input: { command: '/review-queue' },
      }),
      paths,
    );
    for (let index = 0; index < 130; index += 1) {
      await recordFlueObservation(
        event({
          type: 'data',
          runId: 'run_long',
          eventIndex: index + 2,
          timestamp: `2026-06-27T20:${String(index % 60).padStart(2, '0')}:00Z`,
          name: 'neondeck.command',
          data: { status: 'running', index },
        }),
        paths,
      );
    }

    const snapshot = await readWorkflowObservability(paths);

    expect(snapshot.activeRuns).toEqual([
      expect.objectContaining({
        runId: 'run_long',
        workflow: 'command-run',
        eventCount: 131,
      }),
    ]);
  });

  it('redacts sensitive scalar summaries', async () => {
    const paths = runtimePaths(await tempHome());
    await recordFlueObservation(
      event({
        type: 'data',
        runId: 'run_secret',
        name: 'neondeck.secret',
        data: 'token=abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
      }),
      paths,
    );

    const snapshot = await readWorkflowObservability(paths);

    expect(snapshot.recentData[0]?.summary).toMatchObject({
      data: '[redacted]',
    });
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-observability-'));
  tempRoots.push(home);
  return home;
}

function event(input: Partial<FlueObservation>): FlueObservation {
  return {
    v: 3,
    eventIndex: input.eventIndex ?? 1,
    timestamp: input.timestamp ?? '2026-06-27T20:00:00Z',
    ...input,
  } as FlueObservation;
}
