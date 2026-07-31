// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkflowEventRecord,
  WorkflowRunInspectionResponse,
  WorkflowRunRecord,
} from '../../api';
import { WorkflowRunInspectorView } from './WorkflowRunInspectorPage';
import {
  formatWorkflowPayload,
  latestWorkflowRunEventId,
  mergeWorkflowRunInspection,
  orderWorkflowRunEvents,
  terminalWorkflowRunSettleGraceMs,
  workflowRunRefreshDecision,
  workflowRunPayloads,
} from './workflow-run-inspector';

describe('WorkflowRunInspectorPage', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('separates run facts from formatted input, result, and error payloads', () => {
    const run = workflowRun();
    act(() =>
      root.render(
        <WorkflowRunInspectorView events={workflowEvents()} run={run} />,
      ),
    );

    expect(container.textContent).toContain('command-run');
    expect(container.textContent).toContain('run_123');
    expect(
      Array.from(container.querySelectorAll('h2')).map((heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(['EVENT TIMELINE', 'ERROR', 'RESULT', 'INPUT']);
    expect(
      container.querySelector('[aria-labelledby="workflow-run-error"] code')
        ?.textContent,
    ).toBe('{\n  "message": "provider unavailable"\n}');
    expect(container.querySelector('button')?.textContent).toBe(
      'copy all JSON',
    );
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Copy inspection JSON',
    );
  });

  it('renders run events from oldest to newest with expandable summaries', () => {
    act(() =>
      root.render(
        <WorkflowRunInspectorView
          events={workflowEvents().reverse()}
          run={workflowRun()}
        />,
      ),
    );

    const rows = Array.from(
      container.querySelectorAll('[data-workflow-event]'),
    );
    expect(rows.map((row) => row.getAttribute('data-workflow-event'))).toEqual([
      'run_start',
      'tool',
      'run_end',
    ]);
    expect(rows[1]?.textContent).toContain('Tool status_lookup completed');
    expect(rows[1]?.querySelector('details code')?.textContent).toContain(
      '"toolName": "status_lookup"',
    );
  });

  it('discloses when local retention truncated the run history', () => {
    act(() =>
      root.render(
        <WorkflowRunInspectorView
          eventHistory={{
            totalEventCount: 52,
            retainedEventCount: 2,
            isTruncated: true,
          }}
          events={workflowEvents().slice(0, 2)}
          run={workflowRun()}
        />,
      ),
    );

    expect(container.textContent).toContain('2 of 52');
    expect(container.querySelector('[role="note"]')?.textContent).toContain(
      'Local retention preserved 2 of 52 observed events',
    );
  });

  it('keeps stale inspection evidence visible after a refresh error', () => {
    act(() =>
      root.render(
        <WorkflowRunInspectorView
          events={workflowEvents()}
          refreshError="API temporarily unavailable."
          run={workflowRun()}
        />,
      ),
    );

    expect(container.textContent).toContain('run_123');
    expect(container.querySelector('output')?.textContent).toContain(
      'showing the last successful inspection',
    );
  });

  it('replaces settlement activity with a stable incomplete state', () => {
    act(() =>
      root.render(
        <WorkflowRunInspectorView
          events={workflowEvents().slice(0, 2)}
          run={workflowRun()}
          terminalEventUnavailable
        />,
      ),
    );

    expect(container.textContent).toContain('incomplete');
    expect(container.querySelector('[role="note"]')?.textContent).toContain(
      'final run_end observation is unavailable',
    );
    expect(container.textContent).not.toContain('settling');
  });

  it('copies the run, events, and retention metadata together', async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    act(() =>
      root.render(
        <WorkflowRunInspectorView
          events={workflowEvents()}
          run={workflowRun()}
        />,
      ),
    );

    await act(async () => {
      container.querySelector('button')?.click();
    });

    expect(writeText).toHaveBeenCalledOnce();
    const copiedInspection = JSON.parse(writeText.mock.calls[0]![0]) as Pick<
      WorkflowRunInspectionResponse,
      'run' | 'events' | 'eventHistory'
    >;
    expect(copiedInspection).toMatchObject({
      run: { runId: 'run_123' },
      eventHistory: {
        totalEventCount: 3,
        retainedEventCount: 3,
        isTruncated: false,
      },
    });
    expect(copiedInspection.events).toHaveLength(3);
    expect(copiedInspection.events[0]).toMatchObject({
      eventType: 'run_start',
    });
  });

  it('orders failure evidence before the result and original input', () => {
    expect(
      workflowRunPayloads(workflowRun()).map((item) => item.label),
    ).toEqual(['error', 'result', 'input']);
  });

  it('pretty prints nested JSON', () => {
    expect(formatWorkflowPayload({ nested: { count: 2 } })).toBe(
      '{\n  "nested": {\n    "count": 2\n  }\n}',
    );
  });

  it('polls active runs and waits briefly for a terminal run_end observation', () => {
    expect(
      workflowRunRefreshDecision(
        workflowInspection({
          run: { ...workflowRun(), status: 'active', endedAt: undefined },
        }),
        null,
        1_000,
      ),
    ).toEqual({ interval: 2_000, terminalPendingSince: null });

    const unsettled = workflowRunRefreshDecision(
      workflowInspection({ events: workflowEvents().slice(0, 2) }),
      null,
      2_000,
    );
    expect(unsettled).toEqual({
      interval: 1_000,
      terminalPendingSince: 2_000,
    });
    expect(
      workflowRunRefreshDecision(
        workflowInspection({ events: workflowEvents().slice(0, 2) }),
        unsettled.terminalPendingSince,
        2_000 + terminalWorkflowRunSettleGraceMs,
      ),
    ).toEqual({
      interval: false,
      terminalPendingSince: 2_000,
    });
    expect(
      workflowRunRefreshDecision(workflowInspection(), null, 3_000),
    ).toEqual({ interval: false, terminalPendingSince: null });
  });

  it('orders indexed events causally even when timestamps disagree', () => {
    const events = workflowEvents();
    events[0] = { ...events[0]!, createdAt: '2026-07-21T16:00:03.000Z' };
    events[1] = { ...events[1]!, createdAt: '2026-07-21T16:00:00.000Z' };
    expect(
      orderWorkflowRunEvents(events.reverse()).map((event) => event.id),
    ).toEqual([1, 2, 3]);
  });

  it('merges incremental event responses without duplicating retained history', () => {
    const previous = workflowInspection({
      events: workflowEvents().slice(0, 2),
    });
    const update = {
      ...workflowInspection({ events: workflowEvents().slice(1) }),
      eventHistory: {
        totalEventCount: 3,
        retainedEventCount: 3,
        isTruncated: false,
      },
    } satisfies WorkflowRunInspectionResponse;

    expect(latestWorkflowRunEventId(previous.events)).toBe(2);
    expect(
      mergeWorkflowRunInspection(previous, update).events.map(
        (event) => event.id,
      ),
    ).toEqual([1, 2, 3]);
  });
});

function workflowRun(): WorkflowRunRecord {
  return {
    runId: 'run_123',
    workflowName: 'command-run',
    status: 'errored',
    startedAt: '2026-07-21T16:00:00.000Z',
    endedAt: '2026-07-21T16:00:01.250Z',
    durationMs: 1_250,
    isError: true,
    input: { command: '/review-queue' },
    result: { handled: false },
    error: { message: 'provider unavailable' },
  };
}

function workflowEvents(): WorkflowEventRecord[] {
  return [
    {
      id: 1,
      runId: 'run_123',
      workflow: 'command-run',
      eventType: 'run_start',
      eventIndex: 1,
      level: null,
      message: 'Started workflow command-run.',
      name: 'command-run',
      operationKind: null,
      operationId: null,
      agentName: null,
      instanceId: null,
      durationMs: null,
      isError: false,
      summary: { workflowName: 'command-run' },
      createdAt: '2026-07-21T16:00:00.000Z',
      runUrl: '/workflow-run?runId=run_123',
    },
    {
      id: 2,
      runId: 'run_123',
      workflow: 'command-run',
      eventType: 'tool',
      eventIndex: 2,
      level: null,
      message: 'Tool status_lookup completed in 42ms.',
      name: 'status_lookup',
      operationKind: null,
      operationId: 'op_123',
      agentName: null,
      instanceId: null,
      durationMs: 42,
      isError: false,
      summary: { toolName: 'status_lookup', result: { ok: true } },
      createdAt: '2026-07-21T16:00:00.042Z',
      runUrl: '/workflow-run?runId=run_123',
    },
    {
      id: 3,
      runId: 'run_123',
      workflow: 'command-run',
      eventType: 'run_end',
      eventIndex: 3,
      level: null,
      message: 'Workflow failed after 1.3s.',
      name: 'command-run',
      operationKind: null,
      operationId: null,
      agentName: null,
      instanceId: null,
      durationMs: 1_250,
      isError: true,
      summary: { error: { message: 'provider unavailable' } },
      createdAt: '2026-07-21T16:00:01.250Z',
      runUrl: '/workflow-run?runId=run_123',
    },
  ];
}

function workflowInspection(
  overrides: {
    run?: WorkflowRunRecord;
    events?: WorkflowEventRecord[];
  } = {},
): WorkflowRunInspectionResponse {
  const events = overrides.events ?? workflowEvents();
  return {
    ok: true,
    action: 'workflow_run_inspection_read',
    run: overrides.run ?? workflowRun(),
    events,
    eventHistory: {
      totalEventCount: events.length,
      retainedEventCount: events.length,
      isTruncated: false,
    },
    fetchedAt: '2026-07-21T16:00:02.000Z',
  };
}
