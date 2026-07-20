import * as v from 'valibot';
import { addNotification, type NotificationLevel } from '../app-state';
import { type PreparedDiffRecord } from '../prepared-diffs';
import { type RuntimePaths, runtimePaths } from '../../runtime-home';

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

export type AutopilotRecoveryActionId = 'inspect-worktree' | 'manual-follow-up';

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
        id: v.picklist(['inspect-worktree', 'manual-follow-up']),
        label: nonEmptyStringSchema,
        description: nonEmptyStringSchema,
      }),
    ),
  ),
  data: v.optional(v.unknown()),
});

type AutopilotNotificationInput = v.InferOutput<typeof notificationInputSchema>;

export function recoveryActionsForPreparedDiff(
  _preparedDiff: Pick<
    PreparedDiffRecord,
    'id' | 'status' | 'verificationStatus' | 'pushApprovalStatus'
  >,
): AutopilotRecoveryActionSummary[] {
  return [
    {
      id: 'inspect-worktree',
      label: 'Inspect worktree',
      description: 'Open or inspect the retained source worktree and diff.',
    },
    {
      id: 'manual-follow-up',
      label: 'Manual follow-up',
      description:
        'Use the retained worktree and current typed product surfaces to finish manually.',
    },
  ];
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
