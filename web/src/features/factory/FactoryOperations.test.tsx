import {
  progressDetail,
  progressContent,
} from './FactoryDeliveryProgress.fixtures';
import { FactoryTimelineEvidence } from './FactoryTimelineEvidence';
import { codingRun } from './FactoryCoding.fixtures';
import { deliveryDetail } from './FactoryDelivery.fixtures';
import type { FactoryTimelineEntry } from '../../../../shared/factory-diagnostics';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryOperations } from './FactoryOperations';
import { FactoryTimeline } from './FactoryTimeline';
import { FactoryOperationsPreview } from './FactoryOperationsPreview';
import type {
  FactoryHealth,
  FactoryDiagnosticExport,
} from '../../../../shared/factory-diagnostics';
const health: FactoryHealth = {
  generatedAt: '2026-09-07T14:00:00.000Z',
  status: 'attention',
  summary: 'Worker needs reconciliation.',
  workers: [],
  tasks: [],
  truncated: false,
};
const preview: FactoryDiagnosticExport = {
  schemaVersion: 1,
  generatedAt: health.generatedAt,
  workId: 'work:aaaaaaaaaaaaaaaaaaaaaaaa',
  notice:
    'Local diagnostic summary. IDs are pseudonymized; no raw logs, prompts, paths, credentials or actor identities. Authority records and retained diagnostic spans are distinct; this is not a complete execution trace.',
  health: {
    status: 'attention',
    workers: [],
    tasks: [
      {
        workId: 'work:aaaaaaaaaaaaaaaaaaaaaaaa',
        pendingAgeMs: null,
        remainingExecutionMs: null,
        repairsRemaining: null,
        unresolvedEffectCount: 0,
        truncated: false,
      },
    ],
    truncated: false,
  },
  timeline: { entries: [], truncated: false },
  diagnostics: { spans: [], truncated: false },
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function render(ui: React.ReactNode) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
    ),
  );
  await settle();
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  )!;
  await act(async () => button.click());
  await settle();
}
it('renders backend diagnosis and retains explicitly stale health on refresh failure', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(response(health));
  await render(<FactoryOperations />);
  expect(container.textContent).toContain(health.summary);
  fetch.mockResolvedValue(response({ error: 'offline' }, 503));
  await click('Refresh health');
  expect(container.textContent).toContain('may be stale');
  expect(container.textContent).toContain(health.summary);
});
it('downloads the exact held preview without refetch and keeps it after failure', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(response(preview));
  const create = vi.fn<(blob: Blob) => string>(() => 'blob:fixture');
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: create,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn<() => void>(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await render(<FactoryOperationsPreview workId="task /?" />);
  await click('Preview diagnostics');
  const shown = container.querySelector('pre')!.textContent;
  await click('Download shown JSON');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0][0])).toContain('task%20%2F%3F/preview');
  expect(create.mock.calls[0]).toHaveLength(1);
  const blob = create.mock.calls[0][0] as unknown as Blob;
  const downloaded = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });
  expect(downloaded).toBe(shown);
  fetch.mockResolvedValue(response({ error: 'offline' }, 503));
  await click('Refresh preview');
  expect(container.querySelector('pre')!.textContent).toBe(shown);
  expect(container.textContent).toContain('previous preview is retained');
});
it('paginates bounded records, preserves unknown attribution, and refreshes invalid cursors', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/health')) return response(health);
      if (url.includes('cursor='))
        return response({ error: 'Snapshot changed' }, 409);
      return response({
        workId: 'task',
        entries: [
          {
            id: 'record',
            kind: 'release',
            recordType: 'audit',
            occurredAt: null,
            timeBasis: 'unknown',
            actor: null,
            summary: 'Released revision',
            correlation: { workItemId: 'task', specVersion: 2 },
            revision: null,
            evidenceRefs: ['receipt:one'],
          },
        ],
        nextCursor: 'opaque/+?',
        coverage: {
          bounded: true,
          limit: 25,
          truncated: false,
          note: 'Retained records only.',
        },
      });
    });
  await render(<FactoryTimeline workId="task" />);
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => {
    const details = container.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  await settle();
  expect(container.textContent).toContain('Time not recorded');
  expect(container.textContent).toContain('Actor: Not recorded');
  expect(container.textContent).toContain('Specification v2');
  expect(container.querySelector('a')).toBeNull();
  await click('Next page');
  expect(container.textContent).toContain('Snapshot changed');
  expect(
    fetch.mock.calls.some(([url]) =>
      String(url).includes('cursor=opaque%2F%2B%3F'),
    ),
  ).toBe(true);
  await click('Refresh timeline');
  expect(container.textContent).toContain('Released revision');
  expect(container.textContent).toContain('Page 1');
});
it('reports download failure and clears preview when reused for another task', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(preview));
  const revoke = vi.fn<(url: string) => void>();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn<(blob: Blob) => string>(() => 'blob:failed'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revoke,
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
    throw new Error('blocked');
  });
  await render(<FactoryOperationsPreview workId="first" />);
  await click('Preview diagnostics');
  await click('Download shown JSON');
  expect(container.textContent).toContain('Download could not start');
  expect(container.querySelector('pre')).not.toBeNull();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1050));
  });
  expect(revoke).toHaveBeenCalledWith('blob:failed');
  await render(<FactoryOperationsPreview workId="second" />);
  expect(container.querySelector('pre')).toBeNull();
  expect(container.textContent).toContain('Preview diagnostics');
});
it('rejects invalid preview payloads and disables download while loading', async () => {
  let finish!: (value: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render(<FactoryOperationsPreview workId="task" />);
  await click('Preview diagnostics');
  expect(
    [...container.querySelectorAll('button')].every(
      (button) => button.disabled,
    ),
  ).toBe(true);
  await act(async () =>
    finish(
      response({ schemaVersion: 1, credential: 'synthetic-invalid-field' }),
    ),
  );
  await settle();
  expect(container.querySelector('pre')).toBeNull();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain('synthetic-invalid-field');
});
const evidenceEntry = (
  correlation: FactoryTimelineEntry['correlation'],
): FactoryTimelineEntry => ({
  id: 'bound-entry',
  kind: 'coding',
  recordType: 'record',
  occurredAt: null,
  timeBasis: 'unknown',
  actor: null,
  summary: 'Retained coding',
  correlation,
  revision: null,
  evidenceRefs: ['reference'],
});
async function openEvidence() {
  await act(async () => {
    const details = container.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  await settle();
}
it('loads bound coding evidence read-only and rejects another task', async () => {
  const run = codingRun('candidate-awaiting-review');
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => response(run));
  const entry = evidenceEntry({
    workItemId: 'work-demo',
    runId: 'run-demo',
    specVersion: 4,
  });
  await render(<FactoryTimelineEvidence entry={entry} />);
  expect(fetch).not.toHaveBeenCalled();
  await openEvidence();
  expect(container.textContent).toContain('not a frozen historical diff');
  expect(container.textContent).toContain('Review retained worktree');
  expect(container.textContent).not.toContain('Cancel run');
  await render(
    <FactoryTimelineEvidence
      key="other"
      entry={{
        ...entry,
        correlation: { ...entry.correlation, workItemId: 'other' },
      }}
    />,
  );
  await openEvidence();
  expect(container.textContent).toContain('binding does not match');
  expect(container.textContent).not.toContain('Review retained worktree');
});
it('shows matching delivery evidence without authority controls and rejects unmatched historical revisions', async () => {
  const detail = deliveryDetail();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    response(detail),
  );
  const entry = {
    ...evidenceEntry({
      workItemId: 'work-demo',
      deliveryId: detail.pipeline.pipelineId,
    }),
    revision: detail.pipeline.revision,
  };
  await render(<FactoryTimelineEvidence entry={entry} />);
  await openEvidence();
  expect(container.textContent).toContain('matches this entry');
  expect(container.textContent).toContain('Independent checks and review');
  expect(container.textContent).not.toContain('Grant');
  await render(
    <FactoryTimelineEvidence
      key="history"
      entry={{
        ...entry,
        revision: { ...entry.revision, treeSha: '9'.repeat(40) },
      }}
    />,
  );
  await openEvidence();
  expect(container.textContent).toContain('current pipeline differs');
  expect(container.textContent).not.toContain('Independent checks and review');
});
it('keeps assessment reservations reference-only even after settlement', async () => {
  const detail = progressDetail();
  const assessment = detail.pipeline.progress.assessments[0];
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(response(detail));
  const entry: FactoryTimelineEntry = {
    ...evidenceEntry({
      workItemId: detail.pipeline.workItemId,
      deliveryId: detail.pipeline.pipelineId,
    }),
    id: `judge-reserved:${assessment.assessmentId}`,
    kind: 'judge',
    summary: 'A label that does not identify the reservation',
    revision: assessment.revision,
    evidenceRefs: assessment.evidenceRefs,
  };
  expect(assessment.state).toBe('settled');
  await render(<FactoryTimelineEvidence entry={entry} />);
  expect(container.textContent).toContain('Reference-only');
  expect(container.textContent).toContain('inputs recorded');
  expect(container.querySelector('details, summary, button')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it('opens settled progress history only for matching recorded result and revision', async () => {
  const detail = progressDetail();
  const content = progressContent();
  const assessment = detail.pipeline.progress.assessments[0];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    response(String(input).includes('/evidence/') ? content : detail),
  );
  const entry = {
    ...evidenceEntry({
      workItemId: detail.pipeline.workItemId,
      deliveryId: detail.pipeline.pipelineId,
    }),
    kind: 'judge' as const,
    id: `judge-result:${assessment.assessmentId}`,
    revision: assessment.revision,
    evidenceRefs: [assessment.resultId!],
  };
  await render(<FactoryTimelineEvidence entry={entry} />);
  await openEvidence();
  expect(container.textContent).toContain(
    'Assessed evidence and repair history',
  );
  expect(container.textContent).not.toContain('Grant');
});
it.each(['task', 'revision', 'result'] as const)(
  'rejects settled judge evidence with a mismatched %s binding',
  async (mismatch) => {
    const detail = progressDetail();
    const assessment = detail.pipeline.progress.assessments[0];
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response(detail));
    const entry: FactoryTimelineEntry = {
      ...evidenceEntry({
        workItemId:
          mismatch === 'task' ? 'other-task' : detail.pipeline.workItemId,
        deliveryId: detail.pipeline.pipelineId,
      }),
      id: `judge-result:${assessment.assessmentId}`,
      kind: 'judge',
      revision: {
        ...assessment.revision,
        ...(mismatch === 'revision' ? { treeSha: '9'.repeat(40) } : {}),
      },
      evidenceRefs: [
        mismatch === 'result' ? 'other-result' : assessment.resultId!,
      ],
    };
    await render(<FactoryTimelineEvidence entry={entry} />);
    await openEvidence();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain(
      'Assessed evidence and repair history',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).not.toContain('/evidence/');
  },
);
it('inspects a repair target proven by its pipeline while retaining the distinct historical source', async () => {
  const detail = deliveryDetail();
  const source = detail.pipeline.revision;
  const run = codingRun('candidate-awaiting-review');
  run.record.runId = 'repair-target';
  run.record.attemptId = 'repair-attempt';
  Object.assign(run.record.snapshot, {
    requestId: 'repair-request',
    repoId: detail.pipeline.repoId,
    releaseId: source.releaseId,
    specVersion: source.specVersion,
    specHash: source.specHash,
  });
  detail.pipeline.repairs.push({
    runId: run.record.runId,
    attemptId: run.record.attemptId,
    requestId: 'repair-request',
    fromRevision: source,
    status: 'reserved',
    revision: null,
    reason: 'Fix check failure',
    reservedExecutionMs: 60000,
    executionMs: null,
    progressAssessmentId: null,
    progressInputDigest: null,
    progressEvidenceDigest: null,
  });
  const entry: FactoryTimelineEntry = {
    ...evidenceEntry({
      workItemId: detail.pipeline.workItemId,
      deliveryId: detail.pipeline.pipelineId,
      runId: source.runId,
      attemptId: source.attemptId,
      releaseId: source.releaseId,
      specVersion: source.specVersion,
      specHash: source.specHash,
    }),
    id: `repair:${detail.pipeline.pipelineId}:${run.record.runId}`,
    kind: 'repair',
    revision: source,
    repairTarget: { runId: run.record.runId, attemptId: run.record.attemptId },
  };
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) =>
      response(String(input).includes('/coding/runs/') ? run : detail),
    );
  await render(<FactoryTimelineEvidence entry={entry} />);
  await openEvidence();
  expect(container.textContent).toContain('Repair target run repair-target');
  expect(container.textContent).toContain(
    `Historical source candidate: ${source.runId}`,
  );
  expect(container.textContent).toContain('Review retained worktree');
  expect(
    fetch.mock.calls.some(([url]) =>
      String(url).endsWith('/coding/runs/repair-target'),
    ),
  ).toBe(true);
  await render(
    <FactoryTimelineEvidence
      key="unbound"
      entry={{
        ...entry,
        repairTarget: { runId: 'unbound', attemptId: 'repair-attempt' },
      }}
    />,
  );
  await openEvidence();
  expect(container.textContent).toContain('Repair target is not bound');
  expect(container.textContent).not.toContain('Review retained worktree');
});
