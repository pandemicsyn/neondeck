import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { asJsonValue } from '../../../lib/action-result';
import { isTransientFlueRuntimeFailure } from '../../../lib/flue-errors';
import type { RuntimePaths } from '../../../runtime-home';
import { gitCurrentSha, gitStatus } from '../../../repo-edit/git';
import { addNotification } from '../../app-state';
import {
  bindWatchAutopilotOwner,
  canonicalizePrWatchRepoId,
  claimWatchAutopilotTurn,
  readWatch,
  transitionWatchAutopilot,
} from '../../watches';
import { readManagedWorktree } from '../../worktrees';
import { preparePrWorktree } from '../worktree';
import { errorMessage } from '../utils';
import { autopilotOwnerCapabilitySet } from './tools';
import { configuredAutopilotChecks } from './checks';
import { dispatchAutopilotOwnerTurn } from './dispatch';
import { buildAutopilotOwnerEnvelope } from './envelope';
import { autopilotOwnerInstanceId } from './instance';
import {
  clearPendingAutopilotTurnIfMatches,
  recordPendingAutopilotTurnCorrelationId,
  recordPendingAutopilotTurnError,
  registerPendingAutopilotTurn,
} from './pending';
import {
  autopilotDispatchBlockedSourceId,
  reconcileTransientAutopilotRuntimeBlocks,
} from './runtime-recovery';
import { watchAutopilotOwnerSettlement } from './settlement';

export type AutopilotWatchEvent = {
  watchId: string;
  eventFingerprint: string;
  reasoningRequired: boolean;
  changedCategories: string[];
  deltas: JsonValue[];
  currentFacts: JsonValue;
};

export type AutopilotLoopDependencies = {
  prepare?: typeof preparePrWorktree;
  dispatch?: typeof dispatchAutopilotOwnerTurn;
};

export async function runAutopilotWatchEvent(
  event: AutopilotWatchEvent,
  paths: RuntimePaths,
  dependencies: AutopilotLoopDependencies = {},
) {
  let watch = readWatch(paths, event.watchId);
  if (!watch)
    return loopResult('missing', false, 'The watch no longer exists.');
  watch = (await canonicalizePrWatchRepoId(paths, watch.id)) ?? watch;
  if (
    watch.autopilotStatus === 'complete' ||
    watch.autopilotStatus === 'stopping'
  ) {
    return loopResult(
      'complete',
      false,
      watch.autopilotStatus === 'stopping'
        ? 'The watch is stopping and cleanup is in progress.'
        : 'The watch is complete.',
    );
  }
  if (watch.lastEventFingerprint === event.eventFingerprint) {
    return loopResult('duplicate', false, 'This event was already handled.');
  }
  if (watch.autopilotStatus === 'working') {
    return loopResult(
      'busy',
      false,
      'The continuing owner is already working.',
    );
  }
  if (watch.autopilotStatus === 'waiting') {
    return loopResult(
      'waiting',
      false,
      'The managed worktree is held for human review.',
    );
  }
  if (watch.autopilotStatus === 'blocked') {
    return loopResult(
      'blocked',
      false,
      'Human inspection and an explicit retry are required.',
    );
  }
  if (watch.prState === 'closed' || watch.lastSnapshot?.merged === true) {
    return loopResult(
      'terminal-pending',
      false,
      'The pull request is closed; Autopilot is only waiting for terminal checks.',
    );
  }

  if (!event.reasoningRequired) {
    return loopResult(
      'observed',
      false,
      'The deterministic event did not require an owner turn.',
    );
  }

  if (watch.autopilotMode === 'notify-only') {
    return loopResult(
      'notified',
      false,
      'Notify-only mode recorded the event without creating a worktree.',
    );
  }

  let heldSafeWorktree: Awaited<ReturnType<typeof readManagedWorktree>> | null =
    null;
  if (watch.worktreeId) {
    const existing = await readManagedWorktree(
      watch.worktreeId,
      watch.repoId,
      paths,
    );
    const [status, currentSha] = await Promise.all([
      gitStatus(existing.localPath),
      gitCurrentSha(existing.localPath),
    ]);
    const unpublishedCommit =
      currentSha !== existing.headSha && currentSha !== existing.lastPushedSha;
    if (
      status.clean &&
      unpublishedCommit &&
      watch.autopilotMode === 'autofix-push-when-safe'
    ) {
      heldSafeWorktree = existing;
    } else if (!status.clean || unpublishedCommit) {
      const reviewable =
        status.clean &&
        unpublishedCommit &&
        (watch.autopilotMode === 'prepare-only' ||
          watch.autopilotMode === 'autofix-with-approval');
      if (reviewable) {
        transitionWatchAutopilot(paths, watch.id, {
          from: 'watching',
          to: 'waiting',
          eventFingerprint: event.eventFingerprint,
        });
      } else {
        transitionWatchAutopilot(paths, watch.id, {
          from: 'watching',
          to: 'blocked',
        });
      }
      await addNotification(
        {
          level: 'attention',
          title: reviewable
            ? 'Autopilot change is ready for review'
            : 'Autopilot worktree needs human inspection',
          message: reviewable
            ? `${watch.repoFullName}#${watch.prNumber} already has a committed unpublished change. The worktree was held steady.`
            : `${watch.repoFullName}#${watch.prNumber} has unpublished or uncommitted work, so current PR facts were not synced over it.`,
          source: 'autopilot-owner',
          sourceId: `${watch.id}:held-worktree`,
          data: { watchId: watch.id, worktreeId: existing.id, currentSha },
        },
        paths,
      );
      return loopResult(
        reviewable ? 'waiting' : 'blocked',
        false,
        'The existing worktree was held steady.',
      );
    }
  }

  const claimed = claimWatchAutopilotTurn(
    paths,
    watch.id,
    event.eventFingerprint,
  );
  if (!claimed) {
    return loopResult('busy', false, 'Another poll claimed this owner turn.');
  }

  try {
    let prepared: Awaited<ReturnType<typeof preparePrWorktree>> | null = null;
    let worktree = heldSafeWorktree;
    if (!worktree) {
      prepared = await (dependencies.prepare ?? preparePrWorktree)(
        {
          repoId: claimed.repoId,
          prNumber: claimed.prNumber,
          worktreeId: claimed.worktreeId ?? undefined,
          eventId: event.eventFingerprint,
        },
        paths,
      );
      if (!prepared.ok) {
        throw new Error(prepared.message);
      }
      const worktreeId = preparedWorktreeId(prepared.data);
      if (!worktreeId) throw new Error('Worktree preparation returned no id.');
      worktree = await readManagedWorktree(worktreeId, claimed.repoId, paths);
    }
    const instanceId =
      claimed.ownerInstanceId ?? autopilotOwnerInstanceId(claimed.id);
    const bound = bindWatchAutopilotOwner(paths, claimed.id, {
      ownerInstanceId: instanceId,
      worktreeId: worktree.id,
    });
    if (!bound)
      throw new Error('The claimed watch disappeared before dispatch.');
    const configured = await configuredAutopilotChecks(bound, paths);
    const capabilities = autopilotOwnerCapabilitySet({
      mode: bound.autopilotMode,
      source: 'watch-event',
      status: 'working',
    });
    const envelope = buildAutopilotOwnerEnvelope({
      watchId: bound.id,
      repoId: bound.repoId,
      repoFullName: bound.repoFullName,
      prNumber: bound.prNumber,
      worktreeId: worktree.id,
      worktreePath: worktree.localPath,
      headSha:
        worktree.headSha ??
        (prepared ? preparedHeadSha(prepared.data) : 'unknown'),
      baseSha:
        (prepared ? preparedBaseSha(prepared.data) : undefined) ??
        worktree.baseRef,
      eventFingerprint: event.eventFingerprint,
      mode: bound.autopilotMode,
      facts: asJsonValue({
        event: event.currentFacts,
        changedCategories: event.changedCategories,
        deltas: event.deltas,
        configuredValidationHints: configured.checks,
        worktree: {
          id: worktree.id,
          path: worktree.localPath,
          exactPrHead: worktree.headSha,
        },
      }),
      availableCapabilities: capabilities,
    });
    const pendingTurn = registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      event.eventFingerprint,
      bound.autopilotMode,
      'watch-event',
      undefined,
      { envelope, watchId: bound.id },
    );
    try {
      const { buildPrAutopilotOwnerRuntime } =
        await import('../../../agents/pr-autopilot-owner');
      await buildPrAutopilotOwnerRuntime(instanceId, paths);
    } catch (caught) {
      clearPendingAutopilotTurnIfMatches(
        paths.home,
        instanceId,
        pendingTurn.turnId,
      );
      throw caught;
    }
    try {
      const receipt = await (
        dependencies.dispatch ?? dispatchAutopilotOwnerTurn
      )({ instanceId, envelope, idempotencyKey: pendingTurn.turnId });
      recordPendingAutopilotTurnCorrelationId(
        paths.home,
        instanceId,
        pendingTurn.turnId,
        receipt.submissionId,
      );
      if (!dependencies.dispatch) {
        void watchAutopilotOwnerSettlement(
          instanceId,
          receipt.submissionId,
          paths,
          undefined,
          pendingTurn.turnId,
        );
      }
      await reconcileTransientRuntimeNotificationQuietly(paths, claimed.id);
      return {
        ...loopResult(
          'dispatched',
          true,
          `Dispatched the event to continuing owner ${instanceId}.`,
        ),
        instanceId,
        worktreeId: worktree.id,
        dispatchId: receipt.submissionId,
      };
    } catch (caught) {
      if (isTransientFlueRuntimeFailure(caught)) {
        clearPendingAutopilotTurnIfMatches(
          paths.home,
          instanceId,
          pendingTurn.turnId,
        );
        transitionWatchAutopilot(paths, claimed.id, {
          from: 'working',
          to: 'watching',
        });
        await reconcileTransientRuntimeNotificationQuietly(paths, claimed.id);
        return loopResult(
          'deferred',
          false,
          'The local runtime is temporarily unavailable; the owner turn will retry on the next eligible poll.',
        );
      }
      recordPendingAutopilotTurnError(
        paths.home,
        instanceId,
        pendingTurn.turnId,
        errorMessage(caught),
      );
      return {
        ...loopResult(
          'deferred',
          false,
          'The owner admission outcome is uncertain. The durable reservation remains claimed and will retry with the same idempotency key.',
        ),
        instanceId,
        worktreeId: worktree.id,
      };
    }
  } catch (caught) {
    if (isTransientFlueRuntimeFailure(caught)) {
      transitionWatchAutopilot(paths, claimed.id, {
        from: 'working',
        to: 'watching',
      });
      await reconcileTransientRuntimeNotificationQuietly(paths, claimed.id);
      return loopResult(
        'deferred',
        false,
        'The local runtime is temporarily unavailable; the owner turn will retry on the next eligible poll.',
      );
    }
    transitionWatchAutopilot(paths, claimed.id, {
      from: 'working',
      to: 'blocked',
    });
    const message = `Autopilot could not start the owner turn: ${errorMessage(caught)}`;
    await addNotification(
      {
        level: 'attention',
        title: 'Autopilot owner turn blocked',
        message,
        source: 'autopilot-owner',
        sourceId: autopilotDispatchBlockedSourceId(claimed.id),
        data: { watchId: claimed.id, eventFingerprint: event.eventFingerprint },
      },
      paths,
    );
    return loopResult('blocked', false, message);
  }
}

function preparedWorktreeId(data: JsonValue | undefined) {
  return nestedString(data, 'worktree', 'id');
}

function preparedHeadSha(data: JsonValue | undefined) {
  return nestedString(data, 'pr', 'headSha') ?? 'unknown';
}

function preparedBaseSha(data: JsonValue | undefined) {
  return nestedString(data, 'pr', 'baseSha');
}

function nestedString(
  value: JsonValue | undefined,
  objectKey: string,
  key: string,
) {
  const parsed = v.safeParse(
    v.object({
      [objectKey]: v.optional(v.object({ [key]: v.optional(v.string()) })),
    }),
    value,
  );
  if (!parsed.success) return undefined;
  const nested = parsed.output[objectKey];
  return nested?.[key] || undefined;
}

function loopResult(state: string, changed: boolean, message: string) {
  return { ok: state !== 'missing', state, changed, message };
}

async function reconcileTransientRuntimeNotificationQuietly(
  paths: RuntimePaths,
  watchId: string,
) {
  try {
    await reconcileTransientAutopilotRuntimeBlocks(paths, { watchId });
  } catch (caught) {
    const parsedError = v.safeParse(
      v.union([v.instance(Error), v.string()]),
      caught,
    );
    console.warn(
      '[neondeck] failed to resolve a transient Autopilot runtime notification',
      parsedError.success ? parsedError.output : caught,
    );
  }
}
