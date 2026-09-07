import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { openDb } from '../../lib/sqlite';
import {
  getFactoryWorkerHealth,
  startFactoryWorker,
  withFactorySpan,
  listFactoryDiagnostics,
  classifyFactoryError,
  bindFactorySpanCorrelation,
} from './index';
import { saveWorker } from './store';
let paths: RuntimePaths;
let stops: Array<() => void> = [];
beforeEach(() => {
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'factory-observability-')));
  mkdirSync(paths.data, { recursive: true });
  initializeAppDatabase(paths.neondeckDatabase);
});
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  vi.useRealTimers();
  rmSync(paths.home, { recursive: true, force: true });
});
it('correlates real nested operations and preserves errors without storing arbitrary payloads', async () => {
  const error = Object.assign(new Error('secret-token /private/example'), {
    code: 'ECONNRESET',
  });
  await expect(
    withFactorySpan(
      paths,
      'coding.tick',
      { workItemId: 'work-1', releaseId: 'release-1' },
      () =>
        withFactorySpan(
          paths,
          'coding.launch',
          { runId: 'run-1', attemptId: 'attempt-1' },
          async () => {
            throw error;
          },
        ),
      'phase',
    ),
  ).rejects.toBe(error);
  const { records } = listFactoryDiagnostics(paths, { workItemId: 'work-1' });
  expect(records).toHaveLength(2);
  expect(records[0].traceId).toBe(records[1].traceId);
  expect(records[1].parentSpanId).toBe(records[0].id);
  expect(records[1].correlation).toEqual({
    workItemId: 'work-1',
    releaseId: 'release-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
  });
  expect(records[1].error).toEqual({ class: 'io', code: 'ECONNRESET' });
  expect(JSON.stringify(records)).not.toContain('secret-token');
  expect(JSON.stringify(records)).not.toContain('/private/');
});
it('does not replace results or exceptions when diagnostics cannot persist', async () => {
  const db = openDb(paths.neondeckDatabase);
  db.exec('DROP TABLE factory_diagnostics');
  db.close();
  const error = new Error('business failure');
  await expect(
    withFactorySpan(paths, 'coding.launch', {}, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  await expect(
    withFactorySpan(paths, 'coding.inspect', {}, async () => 42),
  ).resolves.toBe(42);
  const worker = startFactoryWorker(paths, 'coding', 3000);
  stops.push(() => worker.stopped());
  expect(getFactoryWorkerHealth(paths)[1].diagnosticsDegraded).toBe(true);
});
it('rejects arbitrary error codes and throwing getters', () => {
  expect(classifyFactoryError({ code: 'secret-token' })).toEqual({
    class: 'unknown',
    code: 'UNKNOWN',
  });
  expect(
    classifyFactoryError({
      get code() {
        throw new Error('secret');
      },
    }),
  ).toEqual({ class: 'unknown', code: 'UNKNOWN' });
});
it('bounds retention independently from domain audit and paginates without duplicates', async () => {
  const db = openDb(paths.neondeckDatabase);
  await withFactorySpan(
    paths,
    'coding.inspect',
    { workItemId: 'work-1' },
    async () => {},
  );
  const first = db
    .prepare('SELECT finished_at,record_json FROM factory_diagnostics')
    .get()!;
  db.exec('BEGIN');
  const insert = db.prepare(
    'INSERT INTO factory_diagnostics(work_item_id,finished_at,record_json) VALUES(?,?,?)',
  );
  for (let i = 0; i < 10002; i++)
    insert.run('work-1', first.finished_at!, first.record_json!);
  insert.run(
    'work-1',
    '2000-01-01T00:00:00.000Z',
    JSON.stringify({
      ...JSON.parse(String(first.record_json)),
      finishedAt: '2000-01-01T00:00:00.000Z',
    }),
  );
  db.exec('COMMIT');
  const before = db
    .prepare('SELECT count(*) AS count FROM factory_audit')
    .get();
  await withFactorySpan(
    paths,
    'coding.inspect',
    { workItemId: 'work-1' },
    async () => {},
  );
  expect(
    db.prepare('SELECT count(*) AS count FROM factory_diagnostics').get()
      ?.count,
  ).toBe(10000);
  expect(
    db.prepare('SELECT count(*) AS count FROM factory_audit').get(),
  ).toEqual(before);
  const a = listFactoryDiagnostics(paths, { limit: 2 });
  const b = listFactoryDiagnostics(paths, { limit: 2, before: a.nextBefore });
  expect(a.records[1].sequence).toBeGreaterThan(b.records[0].sequence);
  expect(() => listFactoryDiagnostics(paths, { limit: 501 })).toThrow(/500/);
  db.close();
});
it('persists failures, scheduling and stopped status across restarts', async () => {
  const worker = startFactoryWorker(paths, 'coding', 3000);
  stops.push(() => worker.stopped());
  const error = Object.assign(new Error('secret'), { code: 'ENOSPC' });
  await worker.tick(async () => {
    throw error;
  });
  worker.scheduled();
  let row = getFactoryWorkerHealth(paths)[1];
  expect(row).toMatchObject({
    status: 'waiting',
    consecutiveFailures: 1,
    totalFailures: 1,
    lastError: { code: 'ENOSPC' },
  });
  expect(row.nextTickAt).not.toBeNull();
  worker.stopped();
  expect(getFactoryWorkerHealth(paths)[1].status).toBe('stopped');
  const restarted = startFactoryWorker(paths, 'coding', 3000);
  stops.push(() => restarted.stopped());
  await restarted.tick(async () => {});
  restarted.scheduled();
  const next = getFactoryWorkerHealth(paths)[1];
  expect(next.instanceId).not.toBe(row.instanceId);
  expect(next).toMatchObject({ consecutiveFailures: 0, totalFailures: 1 });
  expect(next.lastSuccessAt).not.toBeNull();
});
it('heartbeats through a long in-flight tick and reports a stale persisted heartbeat honestly', async () => {
  vi.useFakeTimers();
  const worker = startFactoryWorker(paths, 'delivery', 3000);
  stops.push(() => worker.stopped());
  let finish = () => {};
  const pending = worker.tick(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(45 * 60000);
  expect(getFactoryWorkerHealth(paths)[2].status).toBe('running');
  const row = getFactoryWorkerHealth(paths)[2];
  saveWorker(paths, {
    ...row,
    lastHeartbeatAt: new Date(Date.now() - 120000).toISOString(),
  });
  expect(getFactoryWorkerHealth(paths)[2].status).toBe('stale');
  finish();
  await pending;
  worker.stopped();
});
it('a separate doctor process sees the live server worker, then absence of its process', () => {
  const worker = startFactoryWorker(paths, 'github', 15000);
  stops.push(() => worker.stopped());
  const script = `import {runtimePaths} from './src/runtime-home/index.ts';import {getFactoryWorkerHealth} from './src/modules/factory-observability/index.ts';console.log(JSON.stringify(getFactoryWorkerHealth(runtimePaths(process.argv[1]))));`;
  const output = execFileSync(
    process.execPath,
    ['--import=tsx', '--input-type=module', '-e', script, paths.home],
    { encoding: 'utf8' },
  );
  expect(JSON.parse(output)[0].status).toBe('waiting');
  const row = getFactoryWorkerHealth(paths)[0];
  saveWorker(paths, { ...row, ownerPid: 2147483647 });
  expect(getFactoryWorkerHealth(paths)[0].status).toBe('not-running');
});
it('does not let fresh heartbeats hide an overdue scheduled tick', async () => {
  vi.useFakeTimers();
  const worker = startFactoryWorker(paths, 'coding', 3000);
  stops.push(() => worker.stopped());
  await worker.tick(async () => {});
  worker.scheduled();
  await vi.advanceTimersByTimeAsync(90000);
  const row = getFactoryWorkerHealth(paths)[1];
  expect(row.lastHeartbeatAt).toBe(new Date().toISOString());
  expect(row.status).toBe('stale');
});
it('emits bounded structured failure/recovery logs and safe storage warnings', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const failure = () =>
    withFactorySpan(
      paths,
      'coding.launch',
      { workItemId: 'work-log' },
      async () => {
        throw Object.assign(new Error('private-secret'), { code: 'ENOENT' });
      },
    ).catch(() => {});
  await failure();
  await failure();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
    event: 'factory.operation.failed',
    operation: 'coding.launch',
    correlation: { workItemId: 'work-log' },
    error: { code: 'ENOENT' },
  });
  await vi.advanceTimersByTimeAsync(60001);
  await withFactorySpan(
    paths,
    'coding.launch',
    { workItemId: 'work-log' },
    async () => {},
  );
  expect(info).toHaveBeenCalledTimes(1);
  const db = openDb(paths.neondeckDatabase);
  db.exec('DROP TABLE factory_diagnostics');
  db.close();
  await withFactorySpan(paths, 'coding.inspect', {}, async () => {});
  await withFactorySpan(paths, 'coding.inspect', {}, async () => {});
  expect(warn).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private-secret');
  warn.mockRestore();
  info.mockRestore();
});

it('binds the actual admitted submission to its enclosing app span', async () => {
  await withFactorySpan(
    paths,
    'delivery.review',
    {
      workItemId: 'work-1',
      deliveryId: 'delivery-1',
      effectId: 'review:revision-1',
    },
    async () => {
      bindFactorySpanCorrelation({ submissionId: 'submission-1' });
    },
  );
  expect(listFactoryDiagnostics(paths).records[0].correlation).toEqual({
    workItemId: 'work-1',
    deliveryId: 'delivery-1',
    effectId: 'review:revision-1',
    submissionId: 'submission-1',
  });
});

it('only recovers the same effect operation after an unrelated effect succeeds', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    await withFactorySpan(
      paths,
      'github.writeback',
      { effectId: 'effect-a' },
      async (span) => {
        span.finish(new Error('failed'));
      },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60001);
    await withFactorySpan(
      paths,
      'github.writeback',
      { effectId: 'effect-b' },
      async () => {},
    );
    await withFactorySpan(paths, 'github.writeback', {}, async () => {});
    expect(info).not.toHaveBeenCalled();
    await withFactorySpan(
      paths,
      'github.writeback',
      { effectId: 'effect-a' },
      async () => {},
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      event: 'factory.operation.recovered',
      operation: 'github.writeback',
      correlation: { effectId: 'effect-a' },
    });
  } finally {
    warn.mockRestore();
    info.mockRestore();
  }
});

it.each(['runId', 'deliveryId', 'workItemId'] as const)(
  'only recovers the same %s identity without an effect ID',
  async (identityKey) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const correlation = { [identityKey]: 'identity-a' };
    try {
      await withFactorySpan(
        paths,
        'coding.launch',
        correlation,
        async (span) => {
          span.finish(new Error('failed'));
        },
      );
      expect(warn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60001);
      await withFactorySpan(
        paths,
        'coding.launch',
        { [identityKey]: 'identity-b' },
        async () => {},
      );
      // Even the same raw ID in a more specific identity scope is unrelated.
      await withFactorySpan(
        paths,
        'coding.launch',
        { effectId: 'identity-a' },
        async () => {},
      );
      await withFactorySpan(paths, 'coding.launch', {}, async () => {});
      expect(info).not.toHaveBeenCalled();
      await withFactorySpan(
        paths,
        'coding.launch',
        correlation,
        async () => {},
      );
      expect(info).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
        event: 'factory.operation.recovered',
        operation: 'coding.launch',
        correlation,
      });
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  },
);
