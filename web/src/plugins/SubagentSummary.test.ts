import { describe, expect, it } from 'vitest';
import type { WorkflowEventRecord } from '../api';
import { subagentEvents } from './SubagentSummary';

describe('subagentEvents', () => {
  it('uses structured fields first but still falls back for generic operations', () => {
    const genericPrompt = event({
      id: 1,
      operationKind: 'prompt',
      name: 'assistant_turn',
      message: 'delegated repo_researcher to inspect the checkout',
    });
    const structured = event({
      id: 2,
      operationKind: 'subagent',
      name: 'repo_researcher',
      message: 'started',
    });
    const ordinary = event({
      id: 3,
      operationKind: 'tool',
      name: 'shell',
      message: 'ran npm test',
    });

    expect(subagentEvents([genericPrompt, structured, ordinary])).toEqual([
      genericPrompt,
      structured,
    ]);
  });
});

function event(
  overrides: Partial<WorkflowEventRecord> & Pick<WorkflowEventRecord, 'id'>,
): WorkflowEventRecord {
  return {
    id: overrides.id,
    runId: overrides.runId ?? 'run-1',
    workflow: overrides.workflow ?? 'command-run',
    eventType: overrides.eventType ?? 'log',
    eventIndex: overrides.eventIndex ?? overrides.id,
    level: overrides.level ?? 'info',
    message: overrides.message ?? 'event message',
    name: overrides.name ?? null,
    operationKind: overrides.operationKind ?? null,
    operationId: overrides.operationId ?? null,
    durationMs: overrides.durationMs ?? null,
    isError: overrides.isError ?? false,
    summary: overrides.summary ?? null,
    createdAt: overrides.createdAt ?? '2026-07-05T12:00:00.000Z',
    runUrl: overrides.runUrl ?? '/api/flue/runs/run-1?meta',
  };
}
