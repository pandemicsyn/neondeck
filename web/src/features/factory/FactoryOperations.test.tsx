import {
  progressDetail,
  progressContent,
} from './FactoryDeliveryProgress.fixtures';
import { FactoryDeliveryEvidenceContent } from './FactoryDeliveryEvidenceContent';
import { FactoryTimelineEvidence } from './FactoryTimelineEvidence';
import { codingRun } from './FactoryCoding.fixtures';
import {
  deliveryDetail,
  deliveryEvidenceContent,
  deliveryFeedbackContent,
} from './FactoryDelivery.fixtures';
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
  id: 'coding-event:1',
  kind: 'coding',
  recordType: 'record',
  occurredAt: '2026-09-06T12:00:00.000Z',
  timeBasis: 'recorded',
  actor: null,
  summary: 'Retained coding',
  correlation,
  revision: null,
  evidenceRefs: [],
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
    .mockImplementation(async (input) =>
      response(
        String(input).includes('/events?')
          ? {
              items: [
                {
                  sequence: 1,
                  runId: run.record.runId,
                  version: 1,
                  type: 'reserved',
                  status: 'reserved',
                  createdAt: run.record.createdAt,
                },
              ],
              nextCursor: null,
            }
          : run,
      ),
    );
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
    id: `authorization:${detail.pipeline.authorization.id}`,
    kind: 'authorization' as const,
    evidenceRefs: [],
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
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
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
it.each([
  'task',
  'revision',
  'result',
  'id',
  'extra-reference',
  'submission',
] as const)(
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
    if (mismatch === 'id') entry.id = 'judge-result:other';
    if (mismatch === 'extra-reference') entry.evidenceRefs.push('extra');
    if (mismatch === 'submission') entry.correlation.submissionId = 'other';
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
    baseSha: source.baseSha,
    repoId: detail.pipeline.repoId,
    releaseId: source.releaseId,
    specVersion: source.specVersion,
    specHash: source.specHash,
  });
  run.record.candidate!.baseSha = source.baseSha;
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

function validationTimelineFixture(historical: boolean) {
  const detail = deliveryDetail();
  const revision = detail.pipeline.revision;
  detail.pipeline.evidence[1].result = 'failed';
  if (historical) {
    detail.pipeline.revision = {
      ...revision,
      runId: 'repair-run',
      attemptId: 'repair-attempt',
      headSha: '8'.repeat(40),
      treeSha: '9'.repeat(40),
    };
    detail.pipeline.repairs = [
      {
        requestId: 'repair-request',
        runId: 'repair-run',
        attemptId: 'repair-attempt',
        fromRevision: revision,
        status: 'candidate',
        revision: detail.pipeline.revision,
        reason: 'Repair failed review',
        reservedExecutionMs: 60000,
        executionMs: 1000,
        progressAssessmentId: null,
        progressInputDigest: null,
        progressEvidenceDigest: null,
      },
    ];
  }
  const entries = detail.pipeline.evidence.map(
    (item): FactoryTimelineEntry => ({
      ...evidenceEntry({
        workItemId: detail.pipeline.workItemId,
        deliveryId: detail.pipeline.pipelineId,
        effectId: item.effectId,
      }),
      id: `evidence:${detail.pipeline.pipelineId}:${item.id}`,
      kind: item.kind,
      revision: item.revision,
      evidenceRefs: [item.evidenceRef],
    }),
  );
  return { detail, entries };
}
it.each([true, false])(
  'isolates selected verification and failed review evidence (historical=%s)',
  async (historical) => {
    const { detail, entries } = validationTimelineFixture(historical);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        const item = detail.pipeline.evidence.find((item) =>
          url.endsWith(`/evidence/${item.id}`),
        );
        return response(
          item
            ? {
                ...deliveryEvidenceContent(item.id),
                result: item.result,
                revision: item.revision,
                currentRevision: detail.pipeline.revision,
                isCurrent: !historical,
                summary: `Only ${item.id} receipt content`,
                checks: [],
                findings: [],
              }
            : detail,
        );
      });
    for (const [index, entry] of entries.entries()) {
      fetch.mockClear();
      await render(<FactoryTimelineEvidence key={entry.id} entry={entry} />);
      await openEvidence();
      const selected = detail.pipeline.evidence[index];
      const other = detail.pipeline.evidence[1 - index];
      expect(container.textContent).toContain(
        `${selected.kind} · ${selected.result}`,
      );
      expect(container.textContent).not.toContain(
        `${other.kind} · ${other.result}`,
      );
      expect(container.textContent).not.toContain(
        'Independent checks and review',
      );
      await act(async () => {
        const nested = container.querySelector(
          'details details',
        )! as HTMLDetailsElement;
        nested.open = true;
        nested.dispatchEvent(new Event('toggle'));
      });
      await settle();
      expect(container.textContent).toContain(
        `Only ${selected.id} receipt content`,
      );
      expect(container.textContent).not.toContain(
        `Only ${other.id} receipt content`,
      );
      expect(
        fetch.mock.calls.some(([url]) =>
          String(url).endsWith(`/evidence/${selected.id}`),
        ),
      ).toBe(true);
      expect(
        fetch.mock.calls.some(([url]) =>
          String(url).endsWith(`/evidence/${other.id}`),
        ),
      ).toBe(false);
    }
  },
);
it.each([
  'reference',
  'id',
  'kind',
  'effect',
  'revision',
  'task',
  'delivery',
  'ambiguous',
  'extra-reference',
  'validation-kind',
] as const)(
  'rejects selected validation evidence with mismatched or ambiguous %s',
  async (mismatch) => {
    for (const historical of [true, false]) {
      const { detail, entries } = validationTimelineFixture(historical);
      const entry = structuredClone(entries[0]);
      if (mismatch === 'reference')
        entry.evidenceRefs = entries[1].evidenceRefs;
      if (mismatch === 'extra-reference') entry.evidenceRefs.push('extra');
      if (mismatch === 'id') entry.id = entries[1].id;
      if (mismatch === 'kind') entry.kind = 'effect';
      if (mismatch === 'validation-kind') entry.kind = 'review';
      if (mismatch === 'effect') entry.correlation.effectId = 'other';
      if (mismatch === 'revision') entry.revision!.treeSha = '0'.repeat(40);
      if (mismatch === 'task') entry.correlation.workItemId = 'other';
      if (mismatch === 'delivery') entry.correlation.deliveryId = 'other';
      if (mismatch === 'ambiguous')
        detail.pipeline.evidence.push(detail.pipeline.evidence[0]);
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(response(detail));
      await render(
        <FactoryTimelineEvidence key={String(historical)} entry={entry} />,
      );
      await openEvidence();
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.textContent).toContain('Retry evidence');
      expect(container.querySelector('details details')).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  },
);

it.each([
  'assessment',
  'result',
  'revision',
  'submission',
  'result-assessment',
  'result-revision',
] as const)(
  'rejects fetched judge content with foreign %s',
  async (mismatch) => {
    const detail = progressDetail();
    const content = progressContent();
    const assessment = detail.pipeline.progress.assessments[0];
    if (mismatch === 'assessment') content.assessment.assessmentId = 'foreign';
    if (mismatch === 'result') content.assessment.resultId = 'foreign';
    if (mismatch === 'revision')
      content.assessment.revision.treeSha = '9'.repeat(40);
    if (mismatch === 'submission') content.assessment.submissionId = 'foreign';
    if (mismatch === 'result-assessment')
      content.assessment.result!.assessmentId = 'foreign';
    if (mismatch === 'result-revision')
      content.assessment.result!.revision = {
        ...assessment.revision,
        treeSha: '9'.repeat(40),
      };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      response(String(input).includes('/evidence/') ? content : detail),
    );
    await render(
      <FactoryTimelineEvidence
        entry={{
          ...evidenceEntry({
            workItemId: detail.pipeline.workItemId,
            deliveryId: detail.pipeline.pipelineId,
          }),
          kind: 'judge',
          id: `judge-result:${assessment.assessmentId}`,
          revision: assessment.revision,
          evidenceRefs: [assessment.resultId!],
        }}
      />,
    );
    await openEvidence();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain(
      'Assessed evidence and repair history',
    );
  },
);
it('accepts settled judge content after the pipeline moves to another revision', async () => {
  const detail = progressDetail();
  const content = progressContent();
  const assessment = detail.pipeline.progress.assessments[0];
  content.currentRevision = { ...assessment.revision, treeSha: '9'.repeat(40) };
  content.isCurrent = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    response(String(input).includes('/evidence/') ? content : detail),
  );
  await render(
    <FactoryTimelineEvidence
      entry={{
        ...evidenceEntry({
          workItemId: detail.pipeline.workItemId,
          deliveryId: detail.pipeline.pipelineId,
        }),
        kind: 'judge',
        id: `judge-result:${assessment.assessmentId}`,
        revision: assessment.revision,
        evidenceRefs: [assessment.resultId!],
      }}
    />,
  );
  await openEvidence();
  expect(container.textContent).toContain(
    'Assessed evidence and repair history',
  );
});
function repairBindingFixture(pending = false) {
  const detail = deliveryDetail();
  const source = detail.pipeline.revision;
  const run = codingRun(pending ? 'running' : 'candidate-awaiting-review');
  Object.assign(run.record.snapshot, {
    requestId: 'repair-request',
    repoId: detail.pipeline.repoId,
    releaseId: source.releaseId,
    specVersion: source.specVersion,
    specHash: source.specHash,
    baseSha: source.baseSha,
  });
  if (run.record.candidate) run.record.candidate.baseSha = source.baseSha;
  const revision = pending
    ? null
    : {
        ...source,
        runId: run.record.runId,
        attemptId: run.record.attemptId,
        headSha: run.record.candidate!.headSha,
      };
  detail.pipeline.repairs = [
    {
      runId: run.record.runId,
      attemptId: run.record.attemptId,
      requestId: 'repair-request',
      fromRevision: source,
      status: pending ? 'reserved' : 'candidate',
      revision,
      reason: 'Repair',
      reservedExecutionMs: 60000,
      executionMs: pending ? null : 1000,
      progressAssessmentId: null,
      progressInputDigest: null,
      progressEvidenceDigest: null,
    },
  ];
  const entry: FactoryTimelineEntry = {
    ...evidenceEntry({
      workItemId: detail.pipeline.workItemId,
      deliveryId: detail.pipeline.pipelineId,
    }),
    id: `repair:${detail.pipeline.pipelineId}:${run.record.runId}`,
    kind: 'repair',
    revision: source,
    repairTarget: { runId: run.record.runId, attemptId: run.record.attemptId },
    evidenceRefs: [],
  };
  return { detail, run, entry };
}
it.each([false, true])(
  'accepts an exactly bound repair (pending=%s)',
  async (pending) => {
    const { detail, run, entry } = repairBindingFixture(pending);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      response(String(input).includes('/coding/runs/') ? run : detail),
    );
    await render(<FactoryTimelineEvidence entry={entry} />);
    await openEvidence();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(
      'Execution history and bounded logs',
    );
    expect(container.textContent).toContain(
      pending ? 'No retained worktree diff' : 'Review retained worktree',
    );
  },
);
it.each([
  'event',
  'run',
  'attempt',
  'request',
  'source-base',
  'base',
  'head',
  'release',
  'spec',
  'hash',
  'target-run',
  'target-attempt',
  'target-release',
  'target-spec',
  'target-hash',
  'target-base',
  'target-head',
  'missing-candidate',
  'worktree',
] as const)('rejects a repair with foreign %s identity', async (mismatch) => {
  const { detail, run, entry } = repairBindingFixture();
  const revision = detail.pipeline.repairs[0].revision!;
  if (mismatch === 'event') entry.id = 'repair:foreign';
  if (mismatch === 'run') run.record.runId = 'foreign';
  if (mismatch === 'attempt') run.record.attemptId = 'foreign';
  if (mismatch === 'request') run.record.snapshot.requestId = 'foreign';
  if (mismatch === 'source-base') run.record.snapshot.baseSha = '9'.repeat(40);
  if (mismatch === 'base') run.record.candidate!.baseSha = '9'.repeat(40);
  if (mismatch === 'head') run.record.candidate!.headSha = '9'.repeat(40);
  if (mismatch === 'release') run.record.snapshot.releaseId = 'foreign';
  if (mismatch === 'spec') run.record.snapshot.specVersion++;
  if (mismatch === 'hash') run.record.snapshot.specHash = '9'.repeat(64);
  if (mismatch === 'target-run') revision.runId = 'foreign';
  if (mismatch === 'target-attempt') revision.attemptId = 'foreign';
  if (mismatch === 'target-release') revision.releaseId = 'foreign';
  if (mismatch === 'target-spec') revision.specVersion++;
  if (mismatch === 'target-hash') revision.specHash = '9'.repeat(64);
  if (mismatch === 'target-base') revision.baseSha = '9'.repeat(40);
  if (mismatch === 'target-head') revision.headSha = '9'.repeat(40);
  if (mismatch === 'missing-candidate') run.record.candidate = null;
  if (mismatch === 'worktree') run.diff!.worktreeId = 'foreign';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    response(String(input).includes('/coding/runs/') ? run : detail),
  );
  await render(<FactoryTimelineEvidence entry={entry} />);
  await openEvidence();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Review retained worktree');
  expect(container.textContent).not.toContain(
    'Execution history and bounded logs',
  );
});

it.each([
  'valid',
  'event-id',
  'event-run',
  'event-sequence',
  'event-time',
  'event-reference',
  'run',
  'attempt',
  'release',
  'spec',
  'hash',
  'source-base',
  'base',
  'head',
  'worktree',
] as const)(
  'binds direct coding evidence to the retained event and available candidate identity: %s',
  async (mismatch) => {
    const run = codingRun('candidate-awaiting-review');
    const revision = {
      ...deliveryDetail().pipeline.revision,
      runId: run.record.runId,
      attemptId: run.record.attemptId,
      releaseId: run.record.snapshot.releaseId,
      specVersion: run.record.snapshot.specVersion,
      specHash: run.record.snapshot.specHash,
      baseSha: run.record.candidate!.baseSha,
      headSha: run.record.candidate!.headSha,
    };
    const entry: FactoryTimelineEntry = {
      ...evidenceEntry({
        workItemId: run.record.snapshot.workItemId,
        runId: run.record.runId,
      }),
      revision,
    };
    const event = {
      sequence: 1,
      runId: run.record.runId,
      version: 1,
      type: 'reserved',
      status: 'reserved',
      createdAt: run.record.createdAt,
    };
    if (mismatch === 'event-id') entry.id = 'coding-event:01';
    if (mismatch === 'event-run') event.runId = 'foreign';
    if (mismatch === 'event-sequence') event.sequence = 2;
    if (mismatch === 'event-time') event.createdAt = '2026-09-06T12:01:00.000Z';
    if (mismatch === 'event-reference') entry.evidenceRefs = ['foreign'];
    if (mismatch === 'run') run.record.runId = 'foreign';
    if (mismatch === 'attempt') run.record.attemptId = 'foreign';
    if (mismatch === 'release') run.record.snapshot.releaseId = 'foreign';
    if (mismatch === 'spec') run.record.snapshot.specVersion++;
    if (mismatch === 'hash') run.record.snapshot.specHash = '9'.repeat(64);
    if (mismatch === 'source-base')
      run.record.snapshot.baseSha = '9'.repeat(40);
    if (mismatch === 'base') run.record.candidate!.baseSha = '9'.repeat(40);
    if (mismatch === 'head') run.record.candidate!.headSha = '9'.repeat(40);
    if (mismatch === 'worktree') run.diff!.worktreeId = 'foreign';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      response(
        String(input).includes('/events?')
          ? { items: [event], nextCursor: null }
          : run,
      ),
    );
    await render(<FactoryTimelineEvidence entry={entry} />);
    await openEvidence();
    expect(container.querySelector('[role="alert"]') === null).toBe(
      mismatch === 'valid',
    );
    expect(container.textContent?.includes('Review retained worktree')).toBe(
      mismatch === 'valid',
    );
  },
);
it.each(['failed', 'cancelled'] as const)(
  'preserves logs and current workspace diff for a %s run without a candidate',
  async (status) => {
    const run = codingRun(status);
    run.diff = {
      worktreeId: run.record.workspace!.worktreeId,
      preparedDiffId: 'retained-diff',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      response(
        String(input).includes('/events?')
          ? {
              items: [
                {
                  sequence: 1,
                  runId: run.record.runId,
                  version: 1,
                  type: 'reserved',
                  status: 'reserved',
                  createdAt: run.record.createdAt,
                },
              ],
              nextCursor: null,
            }
          : run,
      ),
    );
    await render(
      <FactoryTimelineEvidence
        entry={evidenceEntry({
          workItemId: run.record.snapshot.workItemId,
          runId: run.record.runId,
        })}
      />,
    );
    await openEvidence();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(
      'Execution history and bounded logs',
    );
    expect(container.textContent).toContain('Review retained worktree');
    expect(container.textContent).toContain('not a frozen historical diff');
  },
);
it.each([
  'inputDigest',
  'evidenceDigest',
  'grantId',
  'requestId',
  'repairOrdinal',
] as const)(
  'rejects foreign judge input %s even without a result',
  async (field) => {
    const detail = progressDetail('error');
    const content = progressContent('error');
    const assessment = detail.pipeline.progress.assessments[0];
    if (field === 'repairOrdinal') content.assessment.repairOrdinal = 2;
    else content.assessment[field] = '9'.repeat(64);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      response(String(input).includes('/evidence/') ? content : detail),
    );
    await render(
      <FactoryTimelineEvidence
        entry={{
          ...evidenceEntry({
            workItemId: detail.pipeline.workItemId,
            deliveryId: detail.pipeline.pipelineId,
          }),
          kind: 'judge',
          id: `judge-result:${assessment.assessmentId}`,
          revision: assessment.revision,
          evidenceRefs: [assessment.resultId!],
        }}
      />,
    );
    await openEvidence();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain(
      'Assessed evidence and repair history',
    );
  },
);

it.each([
  'kind',
  'result',
  'runId',
  'attemptId',
  'releaseId',
  'specVersion',
  'specHash',
  'candidateDigest',
  'baseSha',
  'headSha',
  'treeSha',
] as const)(
  'rejects nested validation content with a foreign %s despite matching endpoint IDs',
  async (field) => {
    const { detail, entries } = validationTimelineFixture(false);
    const selected = detail.pipeline.evidence[0];
    const content = deliveryEvidenceContent(selected.id);
    content.result = selected.result;
    content.summary = 'FOREIGN RECEIPT CONTENT';
    if (field === 'kind') content.kind = 'review';
    else if (field === 'result') content.result = 'failed';
    else if (field === 'specVersion') content.revision.specVersion++;
    else
      content.revision[field] = ['specHash', 'candidateDigest'].includes(field)
        ? '9'.repeat(64)
        : ['baseSha', 'headSha', 'treeSha'].includes(field)
          ? '9'.repeat(40)
          : 'foreign';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      response(String(input).includes('/evidence/') ? content : detail),
    );
    await render(<FactoryTimelineEvidence entry={entries[0]} />);
    await openEvidence();
    await act(async () => {
      const nested = container.querySelector(
        'details details',
      )! as HTMLDetailsElement;
      nested.open = true;
      nested.dispatchEvent(new Event('toggle'));
    });
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain('FOREIGN RECEIPT CONTENT');
  },
);
it.each(['passed', 'failed', 'blocked'] as const)(
  'renders bound %s validation despite concurrent pipeline state changes',
  async (result) => {
    const detail = deliveryDetail();
    const selected = { ...detail.pipeline.evidence[0], result };
    const content = deliveryEvidenceContent(selected.id);
    content.result = result;
    content.currentRevision = { ...content.revision, treeSha: '9'.repeat(40) };
    content.isCurrent = false;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(content));
    await render(
      <FactoryDeliveryEvidenceContent
        deliveryId={detail.pipeline.pipelineId}
        evidence={selected}
        version={1}
        label="Selected"
        initiallyOpen
      />,
    );
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(content.summary);
  },
);
it('does not reuse cached content when the selected receipt binding changes', async () => {
  const detail = deliveryDetail();
  const selected = detail.pipeline.evidence[0];
  const content = deliveryEvidenceContent(selected.id);
  content.result = selected.result;
  content.summary = 'OLD BOUND RECEIPT';
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(response(content));
  await render(
    <FactoryDeliveryEvidenceContent
      deliveryId={detail.pipeline.pipelineId}
      evidence={selected}
      version={1}
      label="Selected"
      initiallyOpen
    />,
  );
  await settle();
  expect(container.textContent).toContain(content.summary);
  fetch.mockResolvedValue(response({ error: 'unavailable' }, 409));
  await render(
    <FactoryDeliveryEvidenceContent
      deliveryId={detail.pipeline.pipelineId}
      evidence={{ ...selected, evidenceRef: 'other-receipt' }}
      version={1}
      label="Selected"
      initiallyOpen
    />,
  );
  await settle();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain(content.summary);
});

it.each([
  'fingerprint',
  'publishedHeadSha',
  'ciFailed',
  'hasReviewFeedback',
] as const)(
  'rejects fetched feedback with foreign %s provenance',
  async (field) => {
    const detail = deliveryDetail('intervention');
    const selected = detail.pipeline.feedback[0];
    const content = deliveryFeedbackContent(selected.id);
    if (field === 'fingerprint') content.feedback[field] = '9'.repeat(64);
    else if (field === 'publishedHeadSha')
      content.feedback[field] = '9'.repeat(40);
    else content.feedback[field] = !content.feedback[field];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(content));
    await render(
      <FactoryDeliveryEvidenceContent
        deliveryId={detail.pipeline.pipelineId}
        evidence={selected}
        version={1}
        label="Selected feedback"
        initiallyOpen
      />,
    );
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain(content.summary);
  },
);
it('allows feedback classification to settle after the selected observation was fetched', async () => {
  const detail = deliveryDetail('intervention');
  const selected = { ...detail.pipeline.feedback[0], classification: null };
  const content = deliveryFeedbackContent(selected.id);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(content));
  await render(
    <FactoryDeliveryEvidenceContent
      deliveryId={detail.pipeline.pipelineId}
      evidence={selected}
      version={1}
      label="Selected feedback"
      initiallyOpen
    />,
  );
  await settle();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain(content.summary);
});
