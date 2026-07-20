import type { JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../../lib/action-result';
import type { RuntimePaths } from '../../../runtime-home';
import { gitCurrentSha, gitStatus } from '../../../repo-edit/git';
import { addNotification } from '../../app-state';
import {
  bindWatchAutopilotOwner,
  claimWatchAutopilotTurn,
  readWatch,
  transitionWatchAutopilot,
} from '../../watches';
import { readManagedWorktree } from '../../worktrees';
import { preparePrWorktree } from '../worktree';
import { autopilotOwnerCapabilitySet } from './tools';
import { configuredAutopilotChecks } from './checks';
import { dispatchAutopilotOwnerTurn } from './dispatch';
import { buildAutopilotOwnerEnvelope } from './envelope';
import { autopilotOwnerInstanceId } from './instance';
import {
  clearPendingAutopilotTurn,
  registerPendingAutopilotTurn,
} from './pending';

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
  if (watch.autopilotStatus === 'complete') {
    return loopResult('complete', false, 'The watch is complete.');
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
    transitionWatchAutopilot(paths, watch.id, {
      from: 'watching',
      to: 'watching',
      eventFingerprint: event.eventFingerprint,
    });
    return loopResult(
      'terminal-pending',
      false,
      'The pull request is closed; Autopilot is only waiting for terminal checks.',
    );
  }

  if (!event.reasoningRequired) {
    transitionWatchAutopilot(paths, watch.id, {
      from: 'watching',
      to: 'watching',
      eventFingerprint: event.eventFingerprint,
    });
    return loopResult(
      'observed',
      false,
      'The deterministic event did not require an owner turn.',
    );
  }

  if (watch.autopilotMode === 'notify-only') {
    transitionWatchAutopilot(paths, watch.id, {
      from: 'watching',
      to: 'watching',
      eventFingerprint: event.eventFingerprint,
    });
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
      transitionWatchAutopilot(paths, watch.id, {
        from: 'watching',
        to: reviewable ? 'waiting' : 'blocked',
        ...(reviewable ? { eventFingerprint: event.eventFingerprint } : {}),
      });
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
        configuredTargetedChecks: configured.checks,
        worktree: {
          id: worktree.id,
          path: worktree.localPath,
          exactPrHead: worktree.headSha,
        },
      }),
      availableCapabilities: capabilities,
    });
    registerPendingAutopilotTurn(
      paths.home,
      instanceId,
      event.eventFingerprint,
      bound.autopilotMode,
      'watch-event',
    );
    try {
      const receipt = await (
        dependencies.dispatch ?? dispatchAutopilotOwnerTurn
      )({ instanceId, envelope });
      return {
        ...loopResult(
          'dispatched',
          true,
          `Dispatched the event to continuing owner ${instanceId}.`,
        ),
        instanceId,
        worktreeId: worktree.id,
        dispatchId: receipt.dispatchId,
      };
    } catch (error) {
      clearPendingAutopilotTurn(paths.home, instanceId);
      throw error;
    }
  } catch (error) {
    transitionWatchAutopilot(paths, claimed.id, {
      from: 'working',
      to: 'blocked',
    });
    const message = `Autopilot could not start the owner turn: ${errorMessage(error)}`;
    await addNotification(
      {
        level: 'attention',
        title: 'Autopilot owner turn blocked',
        message,
        source: 'autopilot-owner',
        sourceId: `${claimed.id}:dispatch-blocked`,
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

function nestedString(value: unknown, objectKey: string, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const nested = (value as Record<string, unknown>)[objectKey];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested))
    return undefined;
  const result = (nested as Record<string, unknown>)[key];
  return typeof result === 'string' && result ? result : undefined;
}

function loopResult(state: string, changed: boolean, message: string) {
  return { ok: state !== 'missing', state, changed, message };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
