/// <reference types="node" />
import { afterEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import {
  factoryDiagnosticExportSchema,
  factoryHealthSchema,
  factoryTimelineSchema,
  type FactoryDiagnosticExport,
  type FactoryHealth,
  type FactoryTimeline,
} from '../../../shared/factory-diagnostics';
import {
  getFactoryDiagnosticPreview,
  getFactoryHealth,
  getFactoryTimeline,
} from './factory-diagnostics';
import { getJson } from './http';
import { createDiagnosticExport } from '../../../src/modules/factory-diagnostics/export';

vi.mock('./http', () => ({ getJson: vi.fn<typeof getJson>() }));
afterEach(() => vi.resetAllMocks());
const workId = 'task / requested';
const foreignToken = 'id:bbbbbbbbbbbbbbbbbbbbbbbb';
const generatedAt = '2026-09-07T00:00:00.000Z';
function timeline(): FactoryTimeline {
  return {
    workId,
    entries: [
      {
        id: 'entry',
        kind: 'task',
        recordType: 'record',
        occurredAt: null,
        timeBasis: 'unknown',
        actor: null,
        summary: 'Task created',
        correlation: { workItemId: workId },
        revision: null,
        evidenceRefs: [],
      },
    ],
    nextCursor: 'opaque-next-cursor',
    coverage: {
      bounded: true,
      limit: 200,
      truncated: false,
      note: 'Bounded records',
    },
  };
}
function health(): FactoryHealth {
  return {
    generatedAt,
    status: 'healthy',
    summary: 'No fault detected',
    workers: [],
    truncated: false,
    tasks: [
      {
        workId,
        status: 'queued',
        pendingSince: null,
        pendingAgeMs: null,
        nextRetryAt: null,
        nextStep: 'Inspect coding readiness',
        truncated: false,
        budgets: [],
        unresolvedEffects: [],
      },
    ],
  };
}
function preview(): FactoryDiagnosticExport {
  return createDiagnosticExport(health(), timeline(), {
    records: [
      {
        sequence: 1,
        id: 'span',
        traceId: 'trace',
        parentSpanId: null,
        operation: 'coding.inspect',
        correlation: { workItemId: workId },
        error: null,
        kind: 'phase',
        startedAt: generatedAt,
        finishedAt: generatedAt,
        durationMs: 0,
        outcome: 'success',
      },
    ],
    nextBefore: null,
  });
}

it.each([undefined, 'cursor / +?'])(
  'accepts the requested timeline page with cursor %s',
  async (cursor) => {
    const response = timeline();
    vi.mocked(getJson).mockResolvedValue(response);
    await expect(getFactoryTimeline(workId, cursor)).resolves.toEqual(response);
    const query = new URLSearchParams({ limit: '25' });
    if (cursor) query.set('cursor', cursor);
    expect(getJson).toHaveBeenCalledWith(
      `/api/factory/diagnostics/tasks/${encodeURIComponent(workId)}/timeline?${query}`,
    );
  },
);
it.each([undefined, 'opaque-next-cursor'])(
  'rejects a schema-valid foreign timeline page with cursor %s',
  async (cursor) => {
    const response = timeline();
    response.workId = 'foreign';
    response.entries[0].correlation.workItemId = 'foreign';
    expect(v.safeParse(factoryTimelineSchema, response).success).toBe(true);
    vi.mocked(getJson).mockResolvedValue(response);
    await expect(getFactoryTimeline(workId, cursor)).rejects.toThrow(
      'Diagnostic timeline does not match this task.',
    );
  },
);
it('rejects a foreign entry inside a correctly bound timeline', async () => {
  const response = timeline();
  response.entries[0].correlation.workItemId = 'foreign';
  expect(v.safeParse(factoryTimelineSchema, response).success).toBe(true);
  vi.mocked(getJson).mockResolvedValue(response);
  await expect(getFactoryTimeline(workId)).rejects.toThrow('does not match');
});
it('accepts exactly the requested health task', async () => {
  const response = health();
  vi.mocked(getJson).mockResolvedValue(response);
  await expect(getFactoryHealth(workId)).resolves.toEqual(response);
  expect(getJson).toHaveBeenCalledWith(
    `/api/factory/diagnostics/health?workId=${encodeURIComponent(workId)}`,
  );
});
it.each(['foreign', 'mixed', 'empty', 'duplicate'])(
  'rejects schema-valid %s scoped health',
  async (kind) => {
    const response = health();
    if (kind === 'foreign') response.tasks[0].workId = 'foreign';
    if (kind === 'mixed')
      response.tasks.push({ ...response.tasks[0], workId: 'foreign' });
    if (kind === 'duplicate') response.tasks.push({ ...response.tasks[0] });
    if (kind === 'empty') response.tasks = [];
    expect(v.safeParse(factoryHealthSchema, response).success).toBe(true);
    vi.mocked(getJson).mockResolvedValue(response);
    await expect(getFactoryHealth(workId)).rejects.toThrow(
      'Diagnostic health does not match this task.',
    );
  },
);
it('allows arbitrary tasks and empty global health', async () => {
  const response = health();
  response.tasks.push({ ...response.tasks[0], workId: 'another-task' });
  vi.mocked(getJson)
    .mockResolvedValueOnce(response)
    .mockResolvedValueOnce({ ...response, tasks: [] });
  await expect(getFactoryHealth()).resolves.toEqual(response);
  await expect(getFactoryHealth()).resolves.toEqual({ ...response, tasks: [] });
  expect(getJson).toHaveBeenCalledWith('/api/factory/diagnostics/health');
});
it('preserves missing-task HTTP errors', async () => {
  const error = new Error('Task not found.');
  vi.mocked(getJson).mockRejectedValue(error);
  await expect(getFactoryHealth(workId)).rejects.toBe(error);
});
it('accepts internally consistent preview pseudonyms distinct from the raw requested ID', async () => {
  const response = preview();
  vi.mocked(getJson).mockResolvedValue(response);
  await expect(getFactoryDiagnosticPreview(workId)).resolves.toEqual(response);
  expect(getJson).toHaveBeenCalledWith(
    `/api/factory/diagnostics/tasks/${encodeURIComponent(workId)}/preview`,
  );
});
it.each(['root', 'health', 'timeline', 'span'])(
  'rejects schema-valid inconsistent preview %s identity',
  async (field) => {
    const response = preview();
    if (field === 'root') response.workId = foreignToken;
    if (field === 'health') response.health.tasks[0].workId = foreignToken;
    if (field === 'timeline')
      response.timeline.entries[0].correlation.workItemId = foreignToken;
    if (field === 'span')
      response.diagnostics.spans[0].correlation.workItemId = foreignToken;
    expect(v.safeParse(factoryDiagnosticExportSchema, response).success).toBe(
      true,
    );
    vi.mocked(getJson).mockResolvedValue(response);
    await expect(getFactoryDiagnosticPreview(workId)).rejects.toThrow(
      'Diagnostic preview contains inconsistent task identities.',
    );
  },
);
it.each([
  () => getFactoryTimeline(workId),
  () => getFactoryTimeline(workId, 'cursor'),
  () => getFactoryHealth(workId),
  () => getFactoryHealth(),
  () => getFactoryDiagnosticPreview(workId),
])('rejects malformed successful responses %#', async (operation) => {
  vi.mocked(getJson).mockResolvedValue({ unexpected: 'response' });
  await expect(operation()).rejects.toThrow(v.ValiError);
});

it.each(['empty-health', 'missing-timeline-task', 'missing-span-task'])(
  'rejects schema-valid preview with %s',
  async (kind) => {
    const response = preview();
    if (kind === 'empty-health') response.health.tasks = [];
    if (kind === 'missing-timeline-task')
      delete response.timeline.entries[0].correlation.workItemId;
    if (kind === 'missing-span-task')
      delete response.diagnostics.spans[0].correlation.workItemId;
    expect(v.safeParse(factoryDiagnosticExportSchema, response).success).toBe(
      true,
    );
    vi.mocked(getJson).mockResolvedValue(response);
    await expect(getFactoryDiagnosticPreview(workId)).rejects.toThrow(
      'inconsistent task identities',
    );
  },
);
