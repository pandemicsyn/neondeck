// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowRunRecord } from '../../api';
import { WorkflowRunInspectorView } from './WorkflowRunInspectorPage';
import {
  formatWorkflowPayload,
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
    act(() => root.render(<WorkflowRunInspectorView run={run} />));

    expect(container.textContent).toContain('command-run');
    expect(container.textContent).toContain('run_123');
    expect(
      Array.from(container.querySelectorAll('h2')).map((heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(['ERROR', 'RESULT', 'INPUT']);
    expect(container.querySelector('code')?.textContent).toBe(
      '{\n  "message": "provider unavailable"\n}',
    );
    expect(container.querySelector('button')?.textContent).toBe('copy JSON');
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
