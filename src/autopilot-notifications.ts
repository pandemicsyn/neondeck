import * as v from 'valibot';
import { addNotification, type NotificationLevel } from './app-state';
import { type PreparedDiffRecord } from './prepared-diffs';
import { type RuntimePaths, runtimePaths } from './runtime-home';

export type AutopilotNotificationState =
  | 'review-fix'
  | 'ci-fix'
  | 'verify'
  | 'push-blocked'
  | 'pushed'
  | 'comment-result'
  | 'failed-workflow';

export type AutopilotNotificationOutcome =
  'prepared' | 'passed' | 'failed' | 'blocked' | 'pushed' | 'posted';

export type AutopilotRecoveryActionId =
  | 'inspect-worktree'
  | 'retry-after-new-commit'
  | 'rebase-resync-worktree'
  | 'retry-verify'
  | 'retry-push'
  | 'retry-comment'
  | 'request-revision'
  | 'cleanup-worktree'
  | 'abandon'
  | 'manual-follow-up';

export type AutopilotRecoveryActionSummary = {
  id: AutopilotRecoveryActionId;
  label: string;
  description: string;
};

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

const notificationInputSchema = v.object({
  state: v.picklist([
    'review-fix',
    'ci-fix',
    'verify',
    'push-blocked',
    'pushed',
    'comment-result',
    'failed-workflow',
  ]),
  outcome: v.picklist([
    'prepared',
    'passed',
    'failed',
    'blocked',
    'pushed',
    'posted',
  ]),
  preparedDiffId: v.optional(nonEmptyStringSchema),
  worktreeId: v.optional(nonEmptyStringSchema),
  repoFullName: v.optional(nonEmptyStringSchema),
  prNumber: v.optional(v.nullable(v.number())),
  workflow: v.optional(nonEmptyStringSchema),
  title: v.optional(nonEmptyStringSchema),
  message: nonEmptyStringSchema,
  recoveryOptions: v.optional(v.array(nonEmptyStringSchema)),
  recoveryActions: v.optional(
    v.array(
      v.object({
        id: v.picklist([
          'inspect-worktree',
          'retry-after-new-commit',
          'rebase-resync-worktree',
          'retry-verify',
          'retry-push',
          'retry-comment',
          'request-revision',
          'cleanup-worktree',
          'abandon',
          'manual-follow-up',
        ]),
        label: nonEmptyStringSchema,
        description: nonEmptyStringSchema,
      }),
    ),
  ),
  data: v.optional(v.unknown()),
});

type AutopilotNotificationInput = v.InferOutput<typeof notificationInputSchema>;

export function recoveryActionsForPreparedDiff(
  preparedDiff: Pick<
    PreparedDiffRecord,
    'id' | 'status' | 'verificationStatus' | 'pushApprovalStatus'
  >,
): AutopilotRecoveryActionSummary[] {
  const actions: AutopilotRecoveryActionSummary[] = [
    {
      id: 'inspect-worktree',
      label: 'Inspect worktree',
      description: 'Open or inspect the retained source worktree and diff.',
    },
  ];

  if (
    [
      'prepared',
      'verification-requested',
      'revision-requested',
      'push-approved',
      'push-blocked',
    ].includes(preparedDiff.status)
  ) {
    actions.push(
      {
        id: 'retry-after-new-commit',
        label: 'Retry after new commit',
        description:
          'Fetch and rebase/resync the retained worktree before retrying verification or push.',
      },
      {
        id: 'rebase-resync-worktree',
        label: 'Rebase/resync worktree',
        description:
          'Rebase the prepared worktree onto the configured PR head ref and reset stale push decisions.',
      },
    );
    actions.push({
      id: 'retry-verify',
      label: 'Retry verify',
      description: 'Run verify_pr_worktree again through execution policy.',
    });
  }

  if (
    ['push-approved', 'push-blocked'].includes(preparedDiff.status) &&
    preparedDiff.pushApprovalStatus === 'approved' &&
    preparedDiff.verificationStatus === 'passed'
  ) {
    actions.push({
      id: 'retry-push',
      label: 'Retry push',
      description: 'Retry push_pr_autofix if policy and branch gates allow it.',
    });
  }

  if (
    ['prepared', 'verification-requested', 'push-blocked', 'pushed'].includes(
      preparedDiff.status,
    )
  ) {
    actions.push({
      id: 'retry-comment',
      label: 'Retry comment',
      description: 'Post or retry the deterministic PR autofix result comment.',
    });
  }

  if (!['abandoned', 'pushed'].includes(preparedDiff.status)) {
    if (preparedDiff.status !== 'revision-requested') {
      actions.push({
        id: 'request-revision',
        label: 'Request revision',
        description:
          'Record an operator revision request while retaining the worktree.',
      });
    }
    actions.push({
      id: 'abandon',
      label: 'Abandon',
      description:
        'Abandon the prepared-diff record and leave cleanup to worktree policy.',
    });
  }

  actions.push({
    id: 'cleanup-worktree',
    label: 'Clean up worktree',
    description:
      'Run worktree cleanup with explicit confirmation for prepared-diff retention.',
  });

  actions.push({
    id: 'manual-follow-up',
    label: 'Manual follow-up',
    description:
      'Use the retained worktree path and recovery notes to finish manually.',
  });

  return actions;
}

export async function notifyAutopilotState(
  rawInput: AutopilotNotificationInput,
  paths: RuntimePaths = runtimePaths(),
) {
  const input = v.parse(notificationInputSchema, rawInput);
  const subject = input.preparedDiffId
    ? `prepared-diff:${input.preparedDiffId}`
    : input.worktreeId
      ? `worktree:${input.worktreeId}`
      : input.workflow
        ? `workflow:${input.workflow}`
        : 'autopilot';
  const sourceId = `${subject}:${input.state}:${input.outcome}`;
  return addNotification(
    {
      level: levelForState(input.state, input.outcome),
      title: input.title ?? titleForState(input.state, input.outcome),
      message: input.message,
      source: 'autopilot',
      sourceId,
      data: {
        policy: 'autopilot-v1',
        state: input.state,
        outcome: input.outcome,
        preparedDiffId: input.preparedDiffId ?? null,
        worktreeId: input.worktreeId ?? null,
        repoFullName: input.repoFullName ?? null,
        prNumber: input.prNumber ?? null,
        workflow: input.workflow ?? null,
        recoveryOptions: input.recoveryOptions ?? [],
        recoveryActions: input.recoveryActions ?? [],
        details: input.data ?? null,
      },
    },
    paths,
  );
}

function levelForState(
  state: AutopilotNotificationState,
  outcome: AutopilotNotificationOutcome,
): NotificationLevel {
  if (state === 'failed-workflow') return 'attention';
  if (state === 'push-blocked') return 'attention';
  if (outcome === 'failed' || outcome === 'blocked') return 'attention';
  return 'ready';
}

function titleForState(
  state: AutopilotNotificationState,
  outcome: AutopilotNotificationOutcome,
) {
  if (state === 'review-fix') return 'Review fix prepared';
  if (state === 'ci-fix') return 'CI fix prepared';
  if (state === 'verify') {
    return outcome === 'passed'
      ? 'Autopilot verification passed'
      : 'Autopilot verification needs attention';
  }
  if (state === 'push-blocked') return 'Autofix push blocked';
  if (state === 'pushed') return 'Autofix pushed';
  if (state === 'comment-result') {
    return outcome === 'posted'
      ? 'Autofix result commented'
      : 'Autofix result comment needs attention';
  }
  return 'Autopilot workflow failed';
}
