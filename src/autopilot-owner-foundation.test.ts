import { describe, expect, it, vi } from 'vitest';
import {
  buildAutopilotOwnerEnvelope,
  dispatchAutopilotOwnerTurn,
  autopilotOwnerInstanceId,
} from './modules/autopilot';

describe('continuing Autopilot owner foundations', () => {
  it('derives one stable Flue instance id per watch without generations', () => {
    const first = autopilotOwnerInstanceId('pandemicsyn/neondeck#164');
    expect(first).toBe(autopilotOwnerInstanceId('pandemicsyn/neondeck#164'));
    expect(first).not.toBe(
      autopilotOwnerInstanceId('pandemicsyn/neondeck#165'),
    );
    expect(first).toMatch(/^pr-owner-[a-f0-9]{24}$/);
  });

  it('dispatches the current envelope to the exact continuing instance', async () => {
    const dispatchOwner = vi.fn(async () => ({
      dispatchId: 'dispatch-1',
      acceptedAt: '2026-07-19T00:00:00.000Z',
    }));
    const envelope = buildAutopilotOwnerEnvelope({
      watchId: 'pandemicsyn/neondeck#164',
      repoId: 'neondeck',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 164,
      worktreeId: 'worktree-164',
      worktreePath: '/tmp/neondeck-pr-164',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      eventFingerprint: 'feedback-fingerprint',
      mode: 'prepare-only',
      facts: { feedback: ['Please cover the restart path.'] },
      availableCapabilities: ['read', 'edit', 'commit'],
    });

    await dispatchAutopilotOwnerTurn({
      instanceId: 'pr-owner-stable',
      envelope,
      dispatchOwner: dispatchOwner as never,
    });

    expect(dispatchOwner).toHaveBeenCalledWith({
      agent: 'pr-autopilot-owner',
      id: 'pr-owner-stable',
      input: JSON.stringify(envelope),
    });
  });
});

