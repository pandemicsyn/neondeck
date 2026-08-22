import { describe, expect, it, vi } from 'vitest';
import {
  buildAutopilotOwnerEnvelope,
  dispatchAutopilotOwnerTurn,
  autopilotOwnerInstanceId,
} from './modules/autopilot';
import {
  approvedResponseStateCurrent,
  autopilotOwnerCapabilitySet,
  buildAutopilotOwnerToolRegistry,
} from './modules/autopilot/owner/tools';
import type { PrWatch } from './modules/watches';
import { repoAutopilotPolicyForWatch } from './modules/autopilot-policy';
import { runtimePaths } from './runtime-home';

describe('continuing Autopilot owner foundations', () => {
  it('retains valid watch overrides beside malformed entries', () => {
    const policy = repoAutopilotPolicyForWatch(
      {
        metadata: {
          autopilot: {
            mode: 'notify-only',
            watchOverrides: [
              { prNumber: 'invalid', mode: 'autofix-push-when-safe' },
              { prNumber: 164, mode: 'prepare-only' },
            ],
          },
        },
      } as never,
      {} as never,
      { prNumber: 164 },
    );

    expect(policy.mode).toBe('prepare-only');
  });

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
      availableCapabilities: ['workspace', 'commit'],
    });

    await dispatchAutopilotOwnerTurn({
      instanceId: 'pr-owner-stable',
      envelope,
      idempotencyKey: 'owner-turn-1',
      dispatchOwner: dispatchOwner as never,
    });

    expect(dispatchOwner).toHaveBeenCalledWith({
      agent: 'pr-autopilot-owner',
      id: 'pr-owner-stable',
      input: JSON.stringify(envelope),
      idempotencyKey: 'owner-turn-1',
    });
  });

  it('builds the exact capability ceiling for each mode and turn source', () => {
    expect(
      autopilotOwnerCapabilitySet({
        mode: 'notify-only',
        source: 'watch-event',
        status: 'working',
      }),
    ).toEqual([]);
    expect(
      autopilotOwnerCapabilitySet({
        mode: 'prepare-only',
        source: 'watch-event',
        status: 'working',
      }),
    ).toEqual(['workspace', 'commit']);
    expect(
      autopilotOwnerCapabilitySet({
        mode: 'autofix-with-approval',
        source: 'watch-event',
        status: 'working',
      }),
    ).toEqual(['workspace', 'commit']);
    expect(
      autopilotOwnerCapabilitySet({
        mode: 'autofix-with-approval',
        source: 'direct-human',
        status: 'waiting',
      }),
    ).toEqual(['workspace', 'commit']);
    expect(
      autopilotOwnerCapabilitySet({
        approvedRevisionKey: 'worktree-diff:approved',
        mode: 'autofix-with-approval',
        source: 'direct-human',
        status: 'waiting',
      }),
    ).toEqual(['workspace', 'commit', 'push', 'respond']);
    expect(
      autopilotOwnerCapabilitySet({
        mode: 'autofix-push-when-safe',
        source: 'watch-event',
        status: 'working',
      }),
    ).toEqual(['workspace', 'commit', 'push', 'respond']);
    expect(
      autopilotOwnerCapabilitySet({
        mode: 'autofix-push-when-safe',
        source: 'watch-event',
        status: 'blocked',
      }),
    ).toEqual([]);
  });

  it('does not let a watcher turn gain push authority from an interactive-looking instance', () => {
    const watcher = buildAutopilotOwnerToolRegistry({
      watch: ownerWatch({
        autopilotMode: 'autofix-with-approval',
        autopilotStatus: 'working',
        ownerInstanceId: 'interactive-session-shaped-id',
      }),
      source: 'watch-event',
      paths: runtimePaths('/tmp/neondeck-owner-tools'),
    });
    const directHuman = buildAutopilotOwnerToolRegistry({
      watch: ownerWatch({
        autopilotMode: 'autofix-with-approval',
        autopilotStatus: 'waiting',
      }),
      source: 'direct-human',
      paths: runtimePaths('/tmp/neondeck-owner-tools'),
    });
    const approvedDirectHuman = buildAutopilotOwnerToolRegistry({
      watch: ownerWatch({
        autopilotMode: 'autofix-with-approval',
        autopilotStatus: 'waiting',
      }),
      source: 'direct-human',
      paths: runtimePaths('/tmp/neondeck-owner-tools'),
      approvedRevisionKey: 'worktree-diff:approved',
    });

    expect(watcher.tools.map((tool) => tool.name)).not.toContain(
      'neondeck_owner_push',
    );
    expect(watcher.tools.map((tool) => tool.name)).not.toContain(
      'neondeck_owner_pr_respond',
    );
    expect(directHuman.tools.map((tool) => tool.name)).not.toContain(
      'neondeck_owner_push',
    );
    expect(directHuman.tools.map((tool) => tool.name)).not.toContain(
      'neondeck_owner_pr_respond',
    );
    expect(approvedDirectHuman.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'neondeck_owner_push',
        'neondeck_owner_discard_prepared_commit',
        'neondeck_owner_pr_respond',
      ]),
    );
    expect(watcher.tools.map((tool) => tool.name)).toEqual([
      'neondeck_owner_commit',
    ]);
    expect(watcher.tools.every((tool) => tool.durable)).toBe(true);
    expect(approvedDirectHuman.tools.every((tool) => tool.durable)).toBe(true);
  });

  it('rejects an approval response before the approved commit is pushed', () => {
    expect(
      approvedResponseStateCurrent({
        approvedRevisionKey: 'worktree-diff:approved',
        currentRevisionKey: 'worktree-diff:approved',
        currentSha: 'a'.repeat(40),
        diffHasFiles: true,
        diffIsCurrent: true,
        lastPushedSha: null,
      }),
    ).toBe(false);
  });

  it('rejects an approval response after the approved revision or pushed commit diverges', () => {
    expect(
      approvedResponseStateCurrent({
        approvedRevisionKey: 'worktree-diff:approved',
        currentRevisionKey: 'worktree-diff:replacement',
        currentSha: 'b'.repeat(40),
        diffHasFiles: true,
        diffIsCurrent: false,
        lastPushedSha: 'a'.repeat(40),
      }),
    ).toBe(false);
  });

  it('allows an approval response for the exact approved current pushed commit', () => {
    const pushedSha = 'a'.repeat(40);
    expect(
      approvedResponseStateCurrent({
        approvedRevisionKey: 'worktree-diff:approved',
        currentRevisionKey: 'worktree-diff:approved',
        currentSha: pushedSha,
        diffHasFiles: true,
        diffIsCurrent: true,
        lastPushedSha: pushedSha,
        remoteHeadSha: pushedSha,
      }),
    ).toBe(true);
  });

  it('rejects an approval response after the remote PR head moves', () => {
    const pushedSha = 'a'.repeat(40);
    expect(
      approvedResponseStateCurrent({
        approvedRevisionKey: 'worktree-diff:approved',
        currentRevisionKey: 'worktree-diff:approved',
        currentSha: pushedSha,
        diffHasFiles: true,
        diffIsCurrent: true,
        lastPushedSha: pushedSha,
        remoteHeadSha: 'b'.repeat(40),
      }),
    ).toBe(false);
  });
});

function ownerWatch(overrides: Partial<PrWatch>): PrWatch {
  return {
    id: 'pandemicsyn/neondeck#172',
    repoId: 'neondeck',
    repoFullName: 'pandemicsyn/neondeck',
    githubOwner: 'pandemicsyn',
    githubName: 'neondeck',
    prNumber: 172,
    desiredTerminalState: 'merged',
    status: 'watching',
    prState: 'open',
    title: 'Autopilot simplification',
    url: 'https://github.com/pandemicsyn/neondeck/pull/172',
    mergeCommitSha: null,
    lastSnapshot: {
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      checks: null,
      title: 'Autopilot simplification',
      url: 'https://github.com/pandemicsyn/neondeck/pull/172',
      updatedAt: '2026-07-20T00:00:00.000Z',
      headSha: 'a'.repeat(40),
      baseRef: 'main',
    },
    lastOutcome: 'created',
    lastCheckedAt: '2026-07-20T00:00:00.000Z',
    createdBy: 'autopilot',
    processExisting: false,
    initialEventProcessedAt: null,
    eventWatermarkVersion: 2,
    autopilotMode: 'prepare-only',
    autopilotStatus: 'working',
    ownerInstanceId: 'owner-172',
    worktreeId: 'worktree-172',
    lastEventFingerprint: null,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}
