import type { JsonValue } from '@flue/runtime';
import type { PrWatch } from '../../watches';

export type OwnerSettlementOutcome = {
  eventType:
    | 'autopilot-owner-blocked'
    | 'autopilot-owner-escalated'
    | 'autopilot-owner-failed'
    | 'autopilot-owner-no-change'
    | 'autopilot-owner-prepared'
    | 'autopilot-owner-pushed'
    | 'autopilot-owner-settlement-failed';
  outcome:
    'blocked' | 'escalated' | 'failed' | 'no-change' | 'prepared' | 'pushed';
  commitSha?: string;
  summary: string;
};

type OwnerWatchTransition = {
  from: 'waiting' | 'working';
  to: 'blocked' | 'waiting' | 'watching';
  eventFingerprint?: string;
};

type OwnerSettlementNotification = {
  level: 'attention' | 'ready';
  title: string;
  message: string;
  source: 'autopilot-owner';
  sourceId: string;
  data: JsonValue;
};

export type OwnerSettlementDecision = {
  blockMessage?: string;
  notification?: OwnerSettlementNotification;
  outcome: OwnerSettlementOutcome | null;
  transition?: OwnerWatchTransition;
  worktreePushBlocked?: {
    message: string;
    data: JsonValue;
  };
};

type OwnerSettlementWatch = Pick<
  PrWatch,
  | 'autopilotMode'
  | 'autopilotStatus'
  | 'id'
  | 'ownerInstanceId'
  | 'prNumber'
  | 'repoFullName'
>;

export function failedOwnerSettlementDecision(
  watch: OwnerSettlementWatch,
): OwnerSettlementDecision {
  return {
    blockMessage: `${watch.repoFullName}#${watch.prNumber} owner turn failed. Human inspection is required before retry.`,
    outcome: {
      eventType: 'autopilot-owner-failed',
      outcome: 'failed',
      summary: 'The continuing Autopilot owner turn failed.',
    },
  };
}

export function deriveOwnerSettlementDecision(input: {
  currentSha: string;
  eventFingerprint?: string;
  statusClean: boolean;
  watch: OwnerSettlementWatch;
  worktree: {
    headSha: string | null;
    id: string;
    lastPushedSha: string | null;
  };
}): OwnerSettlementDecision {
  const { currentSha, eventFingerprint, statusClean, watch, worktree } = input;
  const pushed =
    Boolean(worktree.lastPushedSha) && currentSha === worktree.lastPushedSha;
  const prepared =
    statusClean &&
    currentSha !== worktree.headSha &&
    currentSha !== worktree.lastPushedSha;

  if (watch.autopilotStatus === 'waiting') {
    if (pushed || (statusClean && currentSha === worktree.headSha)) {
      return {
        transition: { from: 'waiting', to: 'watching' },
        outcome: pushed
          ? pushedOutcome(currentSha)
          : {
              eventType: 'autopilot-owner-no-change',
              outcome: 'no-change',
              commitSha: currentSha,
              summary:
                'The continuing Autopilot owner completed cleanly without a retained change.',
            },
      };
    }
    return {
      outcome: prepared
        ? {
            eventType: 'autopilot-owner-prepared',
            outcome: 'prepared',
            commitSha: currentSha,
            summary:
              'The continuing Autopilot owner left a committed change waiting for human review.',
          }
        : {
            eventType: 'autopilot-owner-blocked',
            outcome: 'blocked',
            commitSha: currentSha,
            summary:
              'The continuing Autopilot owner remains waiting with work that requires human inspection.',
          },
    };
  }

  if (watch.autopilotStatus === 'blocked') {
    return {
      outcome: pushed
        ? {
            ...pushedOutcome(currentSha),
            summary:
              'The continuing Autopilot owner pushed a focused change before restart recovery blocked the watch for inspection.',
          }
        : prepared
          ? {
              eventType: 'autopilot-owner-escalated',
              outcome: 'escalated',
              commitSha: currentSha,
              summary:
                'The continuing Autopilot owner retained a committed change after delivery was blocked.',
            }
          : {
              eventType: 'autopilot-owner-blocked',
              outcome: 'blocked',
              commitSha: currentSha,
              summary:
                'The continuing Autopilot owner requires human inspection.',
            },
    };
  }

  if (watch.autopilotStatus !== 'working') return { outcome: null };

  if (pushed) {
    const transition: OwnerWatchTransition = {
      from: 'working',
      to: 'watching',
    };
    if (eventFingerprint) transition.eventFingerprint = eventFingerprint;
    return {
      transition,
      notification: {
        level: 'ready',
        title: 'Autopilot pushed a focused change',
        message: `${watch.repoFullName}#${watch.prNumber} was pushed and remains watched for later feedback.`,
        source: 'autopilot-owner',
        sourceId: `${watch.id}:pushed:${currentSha}`,
        data: { watchId: watch.id, worktreeId: worktree.id, currentSha },
      },
      outcome: pushedOutcome(currentSha),
    };
  }

  if (prepared) {
    const waiting =
      watch.autopilotMode === 'prepare-only' ||
      watch.autopilotMode === 'autofix-with-approval';
    const transition: OwnerWatchTransition = {
      from: 'working',
      to: waiting ? 'waiting' : 'blocked',
    };
    if (waiting && eventFingerprint)
      transition.eventFingerprint = eventFingerprint;
    return {
      transition,
      worktreePushBlocked: {
        message: waiting
          ? 'Autopilot prepared a committed change for human review.'
          : 'The autonomous owner retained a committed change for human review after deciding not to deliver it.',
        data: { watchId: watch.id, commitSha: currentSha },
      },
      notification: {
        level: 'attention',
        title: waiting
          ? 'Autopilot change is ready for review'
          : 'Autopilot escalated a committed change for review',
        message: `${watch.repoFullName}#${watch.prNumber} has a committed change held in managed worktree ${worktree.id}.`,
        source: 'autopilot-owner',
        sourceId: `${watch.id}:prepared:${currentSha}`,
        data: {
          watchId: watch.id,
          ownerInstanceId: watch.ownerInstanceId,
          worktreeId: worktree.id,
          commitSha: currentSha,
        },
      },
      outcome: waiting
        ? {
            eventType: 'autopilot-owner-prepared',
            outcome: 'prepared',
            commitSha: currentSha,
            summary:
              'The continuing Autopilot owner prepared a committed change for human review.',
          }
        : {
            eventType: 'autopilot-owner-escalated',
            outcome: 'escalated',
            commitSha: currentSha,
            summary:
              'The continuing Autopilot owner escalated a committed change without autonomous delivery.',
          },
    };
  }

  if (!statusClean) {
    return {
      blockMessage: `${watch.repoFullName}#${watch.prNumber} owner turn ended with uncommitted work.`,
      outcome: {
        eventType: 'autopilot-owner-blocked',
        outcome: 'blocked',
        commitSha: currentSha,
        summary:
          'The continuing Autopilot owner ended with uncommitted work and requires inspection.',
      },
    };
  }

  const transition: OwnerWatchTransition = { from: 'working', to: 'watching' };
  if (eventFingerprint) transition.eventFingerprint = eventFingerprint;
  return {
    transition,
    outcome: {
      eventType: 'autopilot-owner-no-change',
      outcome: 'no-change',
      commitSha: currentSha,
      summary:
        'The continuing Autopilot owner completed cleanly without a new commit.',
    },
  };
}

function pushedOutcome(commitSha: string): OwnerSettlementOutcome {
  return {
    eventType: 'autopilot-owner-pushed',
    outcome: 'pushed',
    commitSha,
    summary: 'The continuing Autopilot owner pushed a focused change.',
  };
}
