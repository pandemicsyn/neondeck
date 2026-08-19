import { describe, expect, it, vi } from 'vitest';
import {
  currentFlueExecutionContext,
  neondeckFlueExecutionInterceptor,
  runWithFlueTaskDelegationBlocked,
} from './modules/flue';

describe('Flue execution context policy', () => {
  it('tracks the active Flue context while allowing ordinary tools', async () => {
    const next = vi.fn<() => Promise<string | undefined>>(async () => {
      return currentFlueExecutionContext()?.submissionId;
    });

    await expect(
      neondeckFlueExecutionInterceptor(
        {
          type: 'tool',
          toolCallId: 'tool-call',
          toolName: 'neondeck_review_workspace_read',
        },
        { submissionId: 'review-run' },
        next,
      ),
    ).resolves.toBe('review-run');
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows task delegation outside a bounded policy scope', async () => {
    const next = vi.fn<() => Promise<string>>(async () => 'delegated');

    await expect(
      neondeckFlueExecutionInterceptor(
        { type: 'tool', toolCallId: 'tool-call', toolName: 'task' },
        { submissionId: 'chat-run' },
        next,
      ),
    ).resolves.toBe('delegated');
    expect(next).toHaveBeenCalledOnce();
  });

  it('preserves submission correlation across nested Flue scopes', async () => {
    await expect(
      neondeckFlueExecutionInterceptor(
        { type: 'agent', operationId: 'submission-1', operationKind: 'prompt' },
        { submissionId: 'submission-1', agentName: 'pr-review-assistant' },
        () =>
          neondeckFlueExecutionInterceptor(
            { type: 'tool', toolCallId: 'tool-call', toolName: 'review' },
            { conversationId: 'scratch-review', operationId: 'operation-1' },
            async () => currentFlueExecutionContext(),
          ),
      ),
    ).resolves.toMatchObject({
      submissionId: 'submission-1',
      agentName: 'pr-review-assistant',
      conversationId: 'scratch-review',
      operationId: 'operation-1',
    });
  });

  it.each([
    { type: 'tool', toolCallId: 'tool-call', toolName: 'task' } as const,
    {
      type: 'tool',
      toolCallId: 'recursive-review',
      toolName: 'neondeck_pr_review_for_human',
    } as const,
    { type: 'task', taskId: 'task-id' } as const,
  ])(
    'blocks $type task execution inside a bounded PR review',
    async (operation) => {
      const next = vi.fn<() => Promise<string>>(async () => 'delegated');

      await expect(
        runWithFlueTaskDelegationBlocked(async () => {
          await Promise.resolve();
          return neondeckFlueExecutionInterceptor(
            operation,
            { submissionId: 'review-run' },
            next,
          );
        }),
      ).rejects.toThrow('disabled inside the bounded review prompt');
      expect(next).not.toHaveBeenCalled();
    },
  );
});
