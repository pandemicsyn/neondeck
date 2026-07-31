import { describe, expect, it, vi } from 'vitest';
import {
  currentFlueExecutionContext,
  neondeckFlueExecutionInterceptor,
  runWithFlueTaskDelegationBlocked,
} from './modules/flue';

describe('Flue execution context policy', () => {
  it('tracks the active Flue context while allowing ordinary tools', async () => {
    const next = vi.fn<() => Promise<string | undefined>>(async () => {
      return currentFlueExecutionContext()?.runId;
    });

    await expect(
      neondeckFlueExecutionInterceptor(
        {
          type: 'tool',
          toolCallId: 'tool-call',
          toolName: 'neondeck_review_workspace_read',
        },
        { runId: 'review-run' },
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
        { runId: 'chat-run' },
        next,
      ),
    ).resolves.toBe('delegated');
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    { type: 'tool', toolCallId: 'tool-call', toolName: 'task' } as const,
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
            { runId: 'review-run' },
            next,
          );
        }),
      ).rejects.toThrow(
        'Task delegation is disabled for this bounded PR review.',
      );
      expect(next).not.toHaveBeenCalled();
    },
  );
});
