import { defineAction, defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  cleanupInputSchema,
  createInputSchema,
  lockInputSchema,
  outputSchema,
  releaseInputSchema,
  statusInputSchema,
  syncInputSchema,
} from './schemas';
import {
  cleanupWorktrees,
  createWorktree,
  lockWorktree,
  readWorktreeStatus,
  releaseWorktreeLock,
  syncWorktree,
} from './service';
import { listWorktrees } from './queries';

export const worktreeCreateAction = defineAction({
  name: 'neondeck_worktree_create',
  description:
    'Create or adopt a Neondeck-managed Git worktree inside declared worktree roots for isolated repo or PR work.',
  input: createInputSchema,
  output: outputSchema,
  async run({ input }) {
    return createWorktree(input);
  },
});

export const worktreeSyncAction = defineAction({
  name: 'neondeck_worktree_sync',
  description:
    'Safely update a Neondeck-managed worktree to a requested head ref or SHA. Refuses dirty worktrees unless force is true.',
  input: syncInputSchema,
  output: outputSchema,
  async run({ input }) {
    return syncWorktree(input);
  },
});

export const worktreeStatusAction = defineAction({
  name: 'neondeck_worktree_status',
  description:
    'Read branch, dirty state, HEAD SHA, base SHA, and lock status for one Neondeck-managed worktree.',
  input: statusInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readWorktreeStatus(input);
  },
});

export const worktreeLockAction = defineAction({
  name: 'neondeck_worktree_lock',
  description:
    'Acquire a per-worktree or per-PR lock with expiration and stale-lock recovery.',
  input: lockInputSchema,
  output: outputSchema,
  async run({ input }) {
    return lockWorktree(input);
  },
});

export const worktreeReleaseAction = defineAction({
  name: 'neondeck_worktree_release',
  description:
    'Release a Neondeck worktree lock and optionally record the bounded workflow final status.',
  input: releaseInputSchema,
  output: outputSchema,
  async run({ input }) {
    return releaseWorktreeLock(input);
  },
});

export const worktreeCleanupAction = defineAction({
  name: 'neondeck_worktree_cleanup',
  description:
    'Apply Neondeck worktree cleanup policy. Retains dirty, failed, prepared-diff, and adopted worktrees unless policy/input allows cleanup.',
  input: cleanupInputSchema,
  output: outputSchema,
  async run({ input }) {
    return cleanupWorktrees(input);
  },
});

export const worktreesLookupTool = defineTool({
  name: 'neondeck_worktrees_lookup',
  description:
    'List Neondeck worktree records, active and stale locks, and cleanup failures without mutating state.',
  input: v.object({}),
  output: outputSchema,
  async run() {
    return listWorktrees();
  },
});

export const neondeckWorktreeActions = [
  worktreeCreateAction,
  worktreeSyncAction,
  worktreeStatusAction,
  worktreeLockAction,
  worktreeReleaseAction,
  worktreeCleanupAction,
];

export const neondeckWorktreeTools = [worktreesLookupTool];
