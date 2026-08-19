import { describe, expect, it } from 'vitest';
import type { ActivityEventRecord } from '../api';
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
  overrides: Partial<ActivityEventRecord> & Pick<ActivityEventRecord, 'id'>,
): ActivityEventRecord {
  return {
    id: overrides.id,
    submissionId: overrides.submissionId ?? 'run-1',
    eventType: overrides.eventType ?? 'log',
    eventIndex: overrides.eventIndex ?? overrides.id,
    level: overrides.level ?? 'info',
    message: overrides.message ?? 'event message',
    name: overrides.name ?? null,
    operationKind: overrides.operationKind ?? null,
    operationId: overrides.operationId ?? null,
    agentName: overrides.agentName ?? null,
    instanceId: overrides.instanceId ?? null,
    conversationId: overrides.conversationId ?? null,
    durationMs: overrides.durationMs ?? null,
    isError: overrides.isError ?? false,
    summary: overrides.summary ?? null,
    createdAt: overrides.createdAt ?? '2026-07-05T12:00:00.000Z',
    detailUrl: overrides.detailUrl ?? '/activity?submissionId=run-1',
  };
}
