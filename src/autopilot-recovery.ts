import { defineAction, defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  recoveryActionsForPreparedDiff,
  type AutopilotRecoveryActionId,
} from './autopilot-notifications';
import {
  type GitHubPullRequestEventState,
  fetchPullRequestEventState,
} from './github';
import {
  abandonPreparedDiff,
  ensurePreparedDiffForWorktree,
  openPreparedDiffWorktree,
  readPreparedDiffChangedFiles,
  readPreparedDiffRecord,
  readPreparedDiffSummary,
  requestPreparedDiffRevision,
} from './prepared-diffs';
import {
  commentPrAutofixResult,
  pushPrAutofix,
  verifyPrWorktree,
} from './autopilot-workflows';
import { type RuntimePaths, runtimePaths } from './runtime-home';
import {
  cleanupWorktrees,
  lockWorktree,
  readWorktreeRecord,
  releaseWorktreeLock,
  syncWorktree,
} from './worktrees';

type AutopilotRecoveryResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  preparedDiffId?: string;
  options?: AutopilotRecoveryOption[];
  result?: unknown;
  data?: unknown;
  error?: { code: string; message: string };
  requires?: string[];
  errors?: string[];
};

type AutopilotRecoveryOption = {
  id: AutopilotRecoveryActionId;
  label: string;
  description: string;
  enabled: boolean;
  requires: string[];
  destructive: boolean;
  api: {
    method: 'GET' | 'POST';
    path: string;
  };
};

type AutopilotRecoveryDependencies = {
  fetchPullRequestEventState?: typeof fetchPullRequestEventState;
  token?: string;
};

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const recoveryActionSchema = v.picklist([
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
]);
const recoveryOptionsInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
});
const recoveryRunInputSchema = v.object({
  preparedDiffId: nonEmptyStringSchema,
  recoveryAction: recoveryActionSchema,
  reason: v.optional(v.string()),
  confirm: v.optional(v.boolean()),
  checks: v.optional(v.array(nonEmptyStringSchema)),
  headRef: v.optional(nonEmptyStringSchema),
  headSha: v.optional(nonEmptyStringSchema),
  fetch: v.optional(v.boolean()),
  dryRun: v.optional(v.boolean()),
  approverSurface: v.optional(nonEmptyStringSchema),
  lock: v.optional(v.boolean()),
  lockOwner: v.optional(nonEmptyStringSchema),
  timeoutMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(86_400_000)),
  ),
  maxOutputBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1_024), v.maxValue(1_048_576)),
  ),
});
const recoveryOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const autopilotRecoveryOptionsTool = defineTool({
  name: 'neondeck_autopilot_recovery_options_lookup',
  description:
    'Read bounded recovery actions available for a prepared autopilot diff.',
  input: recoveryOptionsInputSchema,
  output: recoveryOutputSchema,
  async run({ input }) {
    return readAutopilotRecoveryOptions(input);
  },
});

export const autopilotRecoveryOptionsAction = defineAction({
  name: 'neondeck_autopilot_recovery_options',
  description:
    'Read bounded recovery actions available for a prepared autopilot diff.',
  input: recoveryOptionsInputSchema,
  output: recoveryOutputSchema,
  async run({ input }) {
    return readAutopilotRecoveryOptions(input);
  },
});

export const autopilotRecoveryRunAction = defineAction({
  name: 'neondeck_autopilot_recovery_run',
  description:
    'Run one bounded recovery operation for a prepared diff by dispatching to existing prepared-diff or autopilot workflow services.',
  input: recoveryRunInputSchema,
  output: recoveryOutputSchema,
  async run({ input }) {
    return runAutopilotRecoveryAction(input);
  },
});

export const neondeckAutopilotRecoveryActions = [
  autopilotRecoveryOptionsAction,
  autopilotRecoveryRunAction,
];

export const neondeckAutopilotRecoveryTools = [autopilotRecoveryOptionsTool];

export async function readAutopilotRecoveryOptions(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<AutopilotRecoveryResult> {
  const parsed = parseInput(
    recoveryOptionsInputSchema,
    rawInput,
    'autopilot_recovery_options',
  );
  if (!parsed.ok) return parsed.result;
  const preparedDiff = readPreparedDiffRecord(
    parsed.input.preparedDiffId,
    paths,
  );
  if (!preparedDiff) {
    return notFound(parsed.input.preparedDiffId, 'autopilot_recovery_options');
  }
  return {
    ok: true,
    action: 'autopilot_recovery_options',
    changed: false,
    message: `Read recovery options for prepared diff ${preparedDiff.id}.`,
    preparedDiffId: preparedDiff.id,
    options: recoveryActionsForPreparedDiff(preparedDiff).map((action) =>
      optionFromAction(action.id, action.label, action.description),
    ),
    data: { preparedDiff },
  };
}

export async function runAutopilotRecoveryAction(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotRecoveryDependencies = {},
): Promise<AutopilotRecoveryResult> {
  const parsed = parseInput(
    recoveryRunInputSchema,
    rawInput,
    'autopilot_recovery_run',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  const preparedDiff = readPreparedDiffRecord(input.preparedDiffId, paths);
  if (!preparedDiff)
    return notFound(input.preparedDiffId, 'autopilot_recovery_run');

  const enabled = new Set(
    recoveryActionsForPreparedDiff(preparedDiff).map((action) => action.id),
  );
  if (!enabled.has(input.recoveryAction)) {
    return {
      ok: false,
      action: 'autopilot_recovery_run',
      changed: false,
      message: `Recovery action ${input.recoveryAction} is not available for prepared diff status ${preparedDiff.status}.`,
      preparedDiffId: preparedDiff.id,
      options: recoveryActionsForPreparedDiff(preparedDiff).map((action) =>
        optionFromAction(action.id, action.label, action.description),
      ),
      requires: ['validRecoveryAction'],
    };
  }

  if (input.recoveryAction === 'inspect-worktree') {
    const [worktree, summary, files] = await Promise.all([
      openPreparedDiffWorktree({ preparedDiffId: preparedDiff.id }, paths),
      readPreparedDiffSummary({ preparedDiffId: preparedDiff.id }, paths),
      readPreparedDiffChangedFiles({ preparedDiffId: preparedDiff.id }, paths),
    ]);
    return {
      ok: Boolean(worktree.ok && summary.ok && files.ok),
      action: 'autopilot_recovery_run',
      changed: false,
      message: `Read retained worktree inspection facts for prepared diff ${preparedDiff.id}.`,
      preparedDiffId: preparedDiff.id,
      result: { worktree, summary, files },
    };
  }

  if (input.recoveryAction === 'retry-verify') {
    const result = await verifyPrWorktree(
      {
        worktreeId: preparedDiff.worktreeId,
        checks: input.checks,
        lock: input.lock,
        lockOwner: input.lockOwner ?? 'autopilot_recovery_retry_verify',
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
      },
      paths,
    );
    return wrapRecoveryResult(input.recoveryAction, preparedDiff.id, result);
  }

  if (
    input.recoveryAction === 'retry-after-new-commit' ||
    input.recoveryAction === 'rebase-resync-worktree'
  ) {
    const currentHead = await resolveCurrentPrHead(
      preparedDiff,
      input,
      dependencies,
    );
    if ('ok' in currentHead) return currentHead;
    const lockOwner = input.lockOwner ?? 'autopilot_recovery_rebase_resync';
    const locked = await lockWorktree(
      {
        worktreeId: preparedDiff.worktreeId,
        owner: lockOwner,
        ttlSeconds: 3_600,
      },
      paths,
    );
    if (!locked.ok) {
      return wrapRecoveryResult(input.recoveryAction, preparedDiff.id, locked);
    }
    const lockId = stringField(locked, ['lock', 'id']);
    if (!lockId) {
      return {
        ok: false,
        action: 'autopilot_recovery_run',
        changed: true,
        message: 'Worktree lock did not return a lock id.',
        preparedDiffId: preparedDiff.id,
        result: locked,
        requires: ['worktreeLock'],
      };
    }
    const result = await syncWorktree(
      {
        worktreeId: preparedDiff.worktreeId,
        lockId,
        headRef: currentHead.headRef,
        headSha: currentHead.headSha,
        fetch: input.fetch ?? true,
        strategy: 'rebase',
      },
      paths,
    );
    if (!result.ok) {
      await releaseWorktreeLock(
        { lockId, owner: lockOwner, finalStatus: 'needs-sync' },
        paths,
      );
      return wrapRecoveryResult(input.recoveryAction, preparedDiff.id, result);
    }
    await releaseWorktreeLock(
      { lockId, owner: lockOwner, finalStatus: 'prepared-diff' },
      paths,
    );
    const worktree = readWorktreeRecord(preparedDiff.worktreeId, paths);
    const updatedPreparedDiff = await ensurePreparedDiffForWorktree(
      worktree,
      paths,
      {
        createdBy: `autopilot_recovery_${input.recoveryAction}`,
        resetDecisionState: true,
      },
    );
    return {
      ...wrapRecoveryResult(input.recoveryAction, preparedDiff.id, result),
      changed: true,
      message:
        input.recoveryAction === 'retry-after-new-commit'
          ? `Rebased/resynced prepared diff ${preparedDiff.id} after a new PR commit. Verify again before retrying push.`
          : `Rebased/resynced prepared diff ${preparedDiff.id}. Verify again before retrying push.`,
      result: {
        sync: result,
        preparedDiff: updatedPreparedDiff,
        currentPrHead: currentHead,
        nextActions: ['retry-verify', 'retry-push'],
      },
    };
  }

  if (input.recoveryAction === 'retry-push') {
    const result = await pushPrAutofix(
      {
        preparedDiffId: preparedDiff.id,
        lockOwner: input.lockOwner ?? 'autopilot_recovery_retry_push',
      },
      paths,
    );
    return wrapRecoveryResult(input.recoveryAction, preparedDiff.id, result);
  }

  if (input.recoveryAction === 'retry-comment') {
    const result = await commentPrAutofixResult(
      { preparedDiffId: preparedDiff.id },
      paths,
    );
    return wrapRecoveryResult(input.recoveryAction, preparedDiff.id, result);
  }

  if (input.recoveryAction === 'request-revision') {
    if (!input.reason?.trim()) {
      return {
        ok: false,
        action: 'autopilot_recovery_run',
        changed: false,
        message: 'Requesting a prepared-diff revision requires a reason.',
        preparedDiffId: preparedDiff.id,
        requires: ['reason'],
      };
    }
    const result = await requestPreparedDiffRevision(
      {
        preparedDiffId: preparedDiff.id,
        reason: input.reason,
        approverSurface: input.approverSurface ?? 'autopilot-recovery',
      },
      paths,
    );
    return wrapRecoveryResult(input.recoveryAction, preparedDiff.id, result);
  }

  if (input.recoveryAction === 'cleanup-worktree') {
    if (input.confirm !== true && !input.dryRun) {
      return {
        ok: false,
        action: 'autopilot_recovery_run',
        changed: false,
        message:
          'Cleaning up a prepared-diff worktree requires confirm=true, or dryRun=true for a policy preview.',
        preparedDiffId: preparedDiff.id,
        requires: ['confirm'],
      };
    }
    const result = await cleanupWorktrees(
      {
        worktreeId: preparedDiff.worktreeId,
        dryRun: input.dryRun,
        confirmPreparedDiff: input.confirm === true,
        force: input.confirm === true,
      },
      paths,
    );
    return wrapRecoveryResult(input.recoveryAction, preparedDiff.id, result);
  }

  if (input.recoveryAction === 'abandon') {
    const result = await abandonPreparedDiff(
      {
        preparedDiffId: preparedDiff.id,
        reason: input.reason,
        confirm: input.confirm,
        approverSurface: input.approverSurface ?? 'autopilot-recovery',
      },
      paths,
    );
    return wrapRecoveryResult(input.recoveryAction, preparedDiff.id, result);
  }

  return {
    ok: true,
    action: 'autopilot_recovery_run',
    changed: false,
    message:
      'Manual follow-up selected. Inspect the retained worktree and use the listed recovery notes to proceed outside autopilot.',
    preparedDiffId: preparedDiff.id,
    data: {
      worktreeId: preparedDiff.worktreeId,
      path: preparedDiff.sourceWorktreePath,
      status: preparedDiff.status,
      summary: preparedDiff.summary,
    },
  };
}

function optionFromAction(
  id: AutopilotRecoveryActionId,
  label: string,
  description: string,
): AutopilotRecoveryOption {
  return {
    id,
    label,
    description,
    enabled: true,
    requires: requirementsForAction(id),
    destructive: id === 'abandon' || id === 'cleanup-worktree',
    api: {
      method: 'POST',
      path: '/api/prepared-diffs/:id/recovery/run',
    },
  };
}

function requirementsForAction(id: AutopilotRecoveryActionId) {
  if (id === 'abandon') return ['confirm'];
  if (id === 'cleanup-worktree') return ['confirm'];
  if (id === 'request-revision') return ['reason'];
  if (id === 'retry-after-new-commit' || id === 'rebase-resync-worktree') {
    return [
      'currentPrHead',
      'worktreeLock',
      'clean-worktree',
      'retry-verification-after-sync',
    ];
  }
  if (id === 'retry-push') {
    return ['pushApprovalStatus=approved', 'verificationStatus=passed'];
  }
  if (id === 'retry-comment') return ['GITHUB_TOKEN'];
  return [];
}

async function resolveCurrentPrHead(
  preparedDiff: {
    id: string;
    repoFullName: string;
    prNumber: number | null;
  },
  input: { headRef?: string; headSha?: string },
  dependencies: AutopilotRecoveryDependencies,
): Promise<
  | {
      headRef: string;
      headSha: string;
      source: 'github-pr-event-state' | 'input';
    }
  | AutopilotRecoveryResult
> {
  const [owner, repo] = preparedDiff.repoFullName.split('/');
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (owner && repo && preparedDiff.prNumber && token) {
    try {
      const state: GitHubPullRequestEventState = await (
        dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState
      )({
        token,
        owner,
        repo,
        number: preparedDiff.prNumber,
      });
      return {
        headRef: state.headRef ?? state.headSha,
        headSha: state.headSha,
        source: 'github-pr-event-state',
      };
    } catch (error) {
      return {
        ok: false,
        action: 'autopilot_recovery_run',
        changed: false,
        message: `Could not fetch current PR head for prepared diff ${preparedDiff.id}: ${errorMessage(error)}`,
        preparedDiffId: preparedDiff.id,
        requires: ['currentPrHead'],
        errors: [errorMessage(error)],
      };
    }
  }
  if (input.headSha) {
    return {
      headRef: input.headRef ?? input.headSha,
      headSha: input.headSha,
      source: 'input',
    };
  }
  return {
    ok: false,
    action: 'autopilot_recovery_run',
    changed: false,
    message:
      'Rebase/resync recovery requires the current PR head from GitHub or an explicit headSha.',
    preparedDiffId: preparedDiff.id,
    requires: [
      'currentPrHead',
      token ? 'repoFullName/prNumber' : 'GITHUB_TOKEN',
    ],
  };
}

function wrapRecoveryResult(
  recoveryAction: AutopilotRecoveryActionId,
  preparedDiffId: string,
  result: {
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    requires?: string[];
    errors?: string[];
  },
): AutopilotRecoveryResult {
  return {
    ok: result.ok,
    action: 'autopilot_recovery_run',
    changed: result.changed,
    message: result.message,
    preparedDiffId,
    result,
    data: { recoveryAction, delegatedAction: result.action },
    ...(result.requires ? { requires: result.requires } : {}),
    ...(result.errors ? { errors: result.errors } : {}),
  };
}

function stringField(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.trim() ? current : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseInput<T>(
  schema: v.GenericSchema<T>,
  rawInput: unknown,
  action: string,
):
  | { ok: true; input: T }
  | {
      ok: false;
      result: AutopilotRecoveryResult;
    } {
  const parsed = v.safeParse(schema, rawInput);
  if (parsed.success) return { ok: true, input: parsed.output };
  return {
    ok: false,
    result: {
      ok: false,
      action,
      changed: false,
      message: `Invalid autopilot recovery input: ${v.summarize(parsed.issues)}`,
      errors: [v.summarize(parsed.issues)],
    },
  };
}

function notFound(
  preparedDiffId: string,
  action: string,
): AutopilotRecoveryResult {
  const message = `Prepared diff ${preparedDiffId} was not found.`;
  return {
    ok: false,
    action,
    changed: false,
    message,
    preparedDiffId,
    error: { code: 'PREPARED_DIFF_NOT_FOUND', message },
    requires: ['preparedDiffId'],
  };
}
