import {
  codingWorktreeOwner,
  type FactoryWorkspaceClaim,
} from './coding-guard';
import {
  getDeliveryPipeline,
  sameDeliveryRevision,
} from '../factory-delivery/store';
import { getCodingRun } from '../coding-runs';
import { gitCurrentSha } from '../../repo-edit/git';
import { readFileSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import { activeLocksForWorktree } from './locks';
import { exists, repoContext } from './paths';
import type { WorktreeRecord } from './schemas';
import { isGitClean } from './git';

export async function cleanupDecision(
  record: WorktreeRecord,
  input: {
    confirmAdopted?: boolean;
    confirmPreparedDiff?: boolean;
    force?: boolean;
  },
  paths: RuntimePaths,
  claim?: FactoryWorkspaceClaim,
): Promise<{ delete: boolean; reason: string }> {
  if (record.owningWorkflowRunId?.startsWith('factory-delivery:')) {
    const id = record.owningWorkflowRunId.slice('factory-delivery:'.length);
    const pipeline = getDeliveryPipeline(id, paths);
    const latest = pipeline?.commits.at(-1);
    const run = pipeline ? getCodingRun(pipeline.revision.runId, paths) : null;
    if (
      !pipeline ||
      !claim ||
      !('pipelineId' in claim) ||
      claim.pipelineId !== id ||
      claim.expectedVersion !== pipeline.version ||
      !['merged', 'closed'].includes(pipeline.outcome ?? '') ||
      !pipeline.pr ||
      !latest ||
      !pipeline.effects.some(
        (effect) =>
          effect.kind === 'push' &&
          effect.state === 'delivered' &&
          sameDeliveryRevision(effect.revision, latest.revision),
      ) ||
      !run?.deadProof ||
      !pipeline.coordinator.terminalObservedAt ||
      Date.now() - Date.parse(pipeline.coordinator.terminalObservedAt) <
        86400000 ||
      pipeline.effects.some((e) => e.state !== 'delivered') ||
      pipeline.repairs.some((r) => r.status === 'reserved') ||
      activeLocksForWorktree(record, paths).some(
        (l) => Date.parse(l.expiresAt) > Date.now(),
      ) ||
      record.adopted ||
      !(await isGitClean(record.localPath).catch(() => false)) ||
      (await gitCurrentSha(record.localPath).catch(() => null)) !==
        latest.publishedHeadSha
    )
      return {
        delete: false,
        reason: 'Factory publication cleanup proof is incomplete; retained.',
      };
    try {
      if (
        dirname(latest.evidenceRef) !==
          join(paths.home, 'factory-delivery', pipeline.pipelineId) ||
        statSync(latest.evidenceRef).size > 16384
      )
        throw new Error('Publication receipt location is invalid.');
      const body = readFileSync(latest.evidenceRef, 'utf8');
      if (
        basename(latest.evidenceRef) !==
        `${createHash('sha256').update(body).digest('hex')}.json`
      )
        throw new Error('Publication receipt content changed.');
      const proof = v.parse(
        v.object({
          root: v.string(),
          worktreeId: v.string(),
          branch: v.string(),
          publishedHeadSha: v.string(),
        }),
        JSON.parse(body),
      );
      if (
        proof.root !== record.localPath ||
        proof.worktreeId !== record.id ||
        proof.branch !== record.headRef ||
        proof.publishedHeadSha !== latest.publishedHeadSha
      )
        throw new Error('Publication receipt belongs to another workspace.');
    } catch {
      return {
        delete: false,
        reason: 'Exact published workspace receipt is unavailable; retained.',
      };
    }
    return {
      delete: true,
      reason:
        'Terminal published revision, dead writer, clean checkout and 24-hour grace verified.',
    };
  }
  const codingOwner = codingWorktreeOwner(record, paths);
  if (codingOwner)
    return {
      delete: false,
      reason:
        'Factory-owned work is retained, including active, uncertain and unpublished candidates.',
    };
  const policy = await currentCleanupPolicy(record, paths);
  if (record.lifecycleStatus === 'deleted') {
    return { delete: false, reason: 'already deleted' };
  }
  if (record.adopted && !input.confirmAdopted) {
    return {
      delete: false,
      reason: 'adopted worktrees require explicit confirmation',
    };
  }
  if (record.lifecycleStatus === 'failed' && policy.retainFailed) {
    return { delete: false, reason: 'failed worktrees are retained by policy' };
  }
  if (
    record.lifecycleStatus === 'prepared-diff' &&
    policy.retainPreparedDiff &&
    !input.confirmPreparedDiff
  ) {
    return {
      delete: false,
      reason: 'prepared-diff worktrees are retained by policy',
    };
  }
  const activeLock = activeLocksForWorktree(record, paths).find(
    (lock) => Date.parse(lock.expiresAt) > Date.now(),
  );
  if (activeLock) {
    return { delete: false, reason: `active lock ${activeLock.id} is held` };
  }
  if (await exists(record.localPath)) {
    const clean = await isGitClean(record.localPath).catch(() => false);
    if (!clean) return { delete: false, reason: 'worktree is dirty' };
  }
  if (input.force) {
    const forceCleanupStatuses = [
      'ready',
      'stale',
      'needs-sync',
      'cleanup-pending',
      'succeeded',
      ...(policy.retainFailed ? [] : ['failed']),
      ...(record.lifecycleStatus === 'prepared-diff' &&
      input.confirmPreparedDiff
        ? ['prepared-diff']
        : []),
    ];
    if (forceCleanupStatuses.includes(record.lifecycleStatus)) {
      return { delete: true, reason: 'explicit cleanup requested' };
    }
  }
  const ageHours =
    (Date.now() - Date.parse(record.updatedAt)) / (60 * 60 * 1000);
  if (
    record.lifecycleStatus === 'succeeded' &&
    ageHours >= policy.successfulGraceHours
  ) {
    return { delete: true, reason: 'successful grace period elapsed' };
  }
  const staleCleanupStatuses = [
    'stale',
    'needs-sync',
    'cleanup-pending',
    ...(policy.retainFailed ? [] : ['failed']),
    ...(policy.retainPreparedDiff ? [] : ['prepared-diff']),
  ];
  if (
    staleCleanupStatuses.includes(record.lifecycleStatus) &&
    ageHours >= policy.staleAgeHours
  ) {
    return { delete: true, reason: 'stale age threshold elapsed' };
  }
  return { delete: false, reason: 'cleanup policy retained worktree' };
}

async function currentCleanupPolicy(
  record: WorktreeRecord,
  paths: RuntimePaths,
) {
  try {
    return (await repoContext(record.repoId, paths)).appCleanup;
  } catch {
    return record.cleanupPolicy;
  }
}
