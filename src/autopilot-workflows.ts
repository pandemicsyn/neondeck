import { defineAction, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  type GitHubCheckSummary,
  type GitHubPullRequestDetail,
  fetchCheckSummary,
  fetchPullRequestDetail,
} from './github';
import {
  checkAutopilotConcurrency,
  checkAutopilotPolicy,
  repoAutopilotPolicy,
  withAutopilotLocalExecutionSlot,
} from './autopilot-policy';
import { runApprovedExecution } from './execution-actions';
import { readRepoRegistrySnapshot, repoFullName } from './repos';
import {
  type RuntimePaths,
  parseAppConfig,
  ensureRuntimeHome,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';
import {
  createWorktree,
  listWorktrees,
  lockWorktree,
  readWorktreeStatus,
  releaseWorktreeLock,
  syncWorktree,
} from './worktrees';

export type AutopilotTriageClass =
  | 'no-op'
  | 'notify-only'
  | 'explain-only'
  | 'draft-fix'
  | 'auto-fix-no-push'
  | 'auto-fix-push-after-checks';

type AutopilotActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: JsonValue;
  error?: JsonValue;
  requires?: string[];
  errors?: string[];
};

type AutopilotDependencies = {
  fetchPullRequestDetail?: typeof fetchPullRequestDetail;
  fetchCheckSummary?: typeof fetchCheckSummary;
  runExecution?: typeof runApprovedExecution;
  token?: string;
};

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const autopilotModeSchema = v.picklist([
  'notify-only',
  'draft-fix',
  'auto-fix-no-push',
  'auto-fix-push-after-checks',
]);
const prEventDeltaSchema = v.object({
  type: v.picklist([
    'new-commit',
    'review-comment',
    'requested-changes',
    'review-thread-resolved',
    'check-failure',
    'check-recovery',
    'merge-conflict',
    'branch-out-of-date',
    'metadata',
    'unknown',
  ]),
  id: v.optional(nonEmptyStringSchema),
  summary: v.optional(nonEmptyStringSchema),
  actionable: v.optional(v.boolean()),
  requiresExplanation: v.optional(v.boolean()),
  severity: v.optional(v.picklist(['low', 'medium', 'high', 'urgent'])),
});
const prEventSnapshotSchema = v.object({
  state: v.optional(nonEmptyStringSchema),
  draft: v.optional(v.boolean()),
  merged: v.optional(v.boolean()),
  mergeable: v.optional(v.boolean()),
  outOfDate: v.optional(v.boolean()),
  headSha: v.optional(nonEmptyStringSchema),
  baseRef: v.optional(nonEmptyStringSchema),
  checkStatus: v.optional(
    v.picklist(['success', 'failure', 'pending', 'none']),
  ),
});
const triagePrEventInputSchema = v.object({
  repoId: v.optional(nonEmptyStringSchema),
  repoFullName: v.optional(nonEmptyStringSchema),
  prNumber: positiveIntegerSchema,
  watchId: v.optional(nonEmptyStringSchema),
  eventId: v.optional(nonEmptyStringSchema),
  source: v.optional(v.picklist(['watch', 'api', 'fixture'])),
  autopilotMode: v.optional(autopilotModeSchema),
  previous: v.optional(prEventSnapshotSchema),
  current: v.optional(prEventSnapshotSchema),
  deltas: v.optional(v.array(prEventDeltaSchema)),
});

const prFactsSchema = v.object({
  number: positiveIntegerSchema,
  title: nonEmptyStringSchema,
  repo: nonEmptyStringSchema,
  url: nonEmptyStringSchema,
  state: nonEmptyStringSchema,
  draft: v.optional(v.boolean()),
  merged: v.optional(v.boolean()),
  mergeCommitSha: v.optional(v.nullable(nonEmptyStringSchema)),
  headSha: nonEmptyStringSchema,
  headRef: v.optional(nonEmptyStringSchema),
  headOwner: v.optional(nonEmptyStringSchema),
  headName: v.optional(nonEmptyStringSchema),
  baseRef: nonEmptyStringSchema,
  updatedAt: nonEmptyStringSchema,
  maintainerCanModify: v.optional(v.boolean()),
});
const checkSummarySchema = v.object({
  status: v.picklist(['success', 'failure', 'pending', 'none']),
  total: v.number(),
  successful: v.number(),
  failed: v.number(),
  pending: v.number(),
  statusContexts: v.optional(v.number()),
  checkedAt: nonEmptyStringSchema,
});
const preparePrWorktreeInputSchema = v.strictObject({
  repoId: nonEmptyStringSchema,
  prNumber: positiveIntegerSchema,
  eventId: v.optional(nonEmptyStringSchema),
  createWorktree: v.optional(v.boolean()),
  sync: v.optional(v.boolean()),
  fetch: v.optional(v.boolean()),
  lock: v.optional(v.boolean()),
  lockOwner: v.optional(nonEmptyStringSchema),
  lockTtlSeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400)),
  ),
});
const verifyPrWorktreeInputSchema = v.strictObject({
  worktreeId: nonEmptyStringSchema,
  checks: v.optional(v.array(nonEmptyStringSchema)),
  diffBaseRef: v.optional(nonEmptyStringSchema),
  backend: v.optional(v.picklist(['local', 'exe.dev'])),
  context: v.optional(v.picklist(['interactive', 'unattended'])),
  lock: v.optional(v.boolean()),
  lockOwner: v.optional(nonEmptyStringSchema),
  lockTtlSeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400)),
  ),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxOutputBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const autopilotOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const triagePrEventAction = defineAction({
  name: 'neondeck_autopilot_triage_pr_event',
  description:
    'Classify a structured PR watch delta into no-op, notify-only, explain-only, draft-fix, auto-fix-no-push, or auto-fix-push-after-checks without applying fixes.',
  input: triagePrEventInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return triagePrEvent(input);
  },
});

export const preparePrWorktreeAction = defineAction({
  name: 'neondeck_autopilot_prepare_pr_worktree',
  description:
    'Create, sync, lock, and inspect an isolated PR worktree while gathering deterministic PR and check facts.',
  input: preparePrWorktreeInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return preparePrWorktree(input);
  },
});

export const autopilotPolicyCheckAction = defineAction({
  name: 'neondeck_autopilot_policy_check',
  description:
    'Classify an autopilot worktree diff against repo policy limits, high-risk file classes, push destination rules, and concurrency settings.',
  input: v.strictObject({
    repoId: v.optional(nonEmptyStringSchema),
    worktreeId: v.optional(nonEmptyStringSchema),
    diffBaseRef: v.optional(nonEmptyStringSchema),
    pushDestination: v.optional(nonEmptyStringSchema),
    forcePush: v.optional(v.boolean()),
  }),
  output: autopilotOutputSchema,
  async run({ input }) {
    const result = await checkAutopilotPolicy(input);
    return {
      ok: result.ok,
      action: result.action,
      changed: false,
      message: result.message,
      data: asJsonValue(result),
      requires: result.requires,
    };
  },
});

export const verifyPrWorktreeAction = defineAction({
  name: 'neondeck_autopilot_verify_pr_worktree',
  description:
    'Run configured repo checks for a PR worktree through Neondeck execution approval policy and summarize pass, fail, or approval-blocked results.',
  input: verifyPrWorktreeInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return verifyPrWorktree(input);
  },
});

export const neondeckAutopilotActions = [
  triagePrEventAction,
  preparePrWorktreeAction,
  autopilotPolicyCheckAction,
  verifyPrWorktreeAction,
];

export async function triagePrEvent(
  rawInput: unknown,
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    triagePrEventInputSchema,
    rawInput,
    'autopilot_triage_pr_event',
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  const deltas = input.deltas ?? [];
  const mode = input.autopilotMode ?? 'draft-fix';
  const signals = classifySignals(input.current, deltas);
  const classification = classificationFor(mode, signals);
  const shouldPrepareWorktree =
    classification === 'draft-fix' ||
    classification === 'auto-fix-no-push' ||
    classification === 'auto-fix-push-after-checks';
  const reasons = reasonsFor(classification, mode, signals, deltas);

  return {
    ok: true,
    action: 'autopilot_triage_pr_event',
    changed: classification !== 'no-op',
    message:
      classification === 'no-op'
        ? 'PR event does not require autopilot action.'
        : `PR event classified as ${classification}.`,
    data: asJsonValue({
      classification,
      autopilotMode: mode,
      shouldPrepareWorktree,
      nextWorkflow: shouldPrepareWorktree ? 'prepare_pr_worktree' : null,
      source: input.source ?? 'api',
      eventId: input.eventId ?? null,
      watchId: input.watchId ?? null,
      repoId: input.repoId ?? null,
      repoFullName: input.repoFullName ?? null,
      prNumber: input.prNumber,
      reasons,
      deltas,
      previous: input.previous ?? null,
      current: input.current ?? null,
    }),
  };
}

export async function preparePrWorktree(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    preparePrWorktreeInputSchema,
    rawInput,
    'autopilot_prepare_pr_worktree',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    await ensureRuntimeHome(paths);
    const registry = await readRepoRegistrySnapshot(paths);
    const repo = registry.repos.find((item) => item.id === input.repoId);
    if (!repo) {
      return failResult(
        'autopilot_prepare_pr_worktree',
        `Repository "${input.repoId}" is not configured.`,
        { requires: ['repo'] },
      );
    }

    const pr = await fetchPreparedPrFacts(
      repo.github.owner,
      repo.github.name,
      input.prNumber,
      dependencies,
    );
    if ('ok' in pr && !pr.ok) return pr;

    const prFacts = pr as v.InferOutput<typeof prFactsSchema>;
    const checks = await fetchPreparedCheckFacts(
      repo.github.owner,
      repo.github.name,
      prFacts.headSha,
      dependencies,
    );
    if ('ok' in checks && !checks.ok) return checks;

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: repo.id,
        prNumber: input.prNumber,
        workflow: 'prepare_pr_worktree',
        mutation: true,
      },
      paths,
    );
    if (!concurrency.allowed) {
      return {
        ok: false,
        action: 'autopilot_prepare_pr_worktree',
        changed: false,
        message: concurrency.message,
        data: asJsonValue({ concurrency }),
        errors: concurrency.reasons,
        requires: ['concurrency'],
      };
    }

    let worktree: unknown = null;
    let lock: unknown = null;
    let status: unknown = null;
    const createEnabled = input.createWorktree ?? true;

    if (createEnabled) {
      const created = await createWorktree(
        {
          repoId: repo.id,
          prNumber: input.prNumber,
          baseRef: prFacts.baseRef || repo.defaultBranch,
          headOwner: prFacts.headOwner,
          headName: prFacts.headName,
          headRef: prFacts.headRef ?? prFacts.headSha,
          headSha: prFacts.headSha,
          directPushAllowed: Boolean(prFacts.maintainerCanModify),
        },
        paths,
      );
      if (!created.ok) {
        return lowerLevelFailure(
          'autopilot_prepare_pr_worktree',
          'worktree_create',
          created,
        );
      }
      worktree = objectField(created, 'worktree');
      const worktreeId = stringField(worktree, 'id');
      if (!worktreeId) {
        return failResult(
          'autopilot_prepare_pr_worktree',
          'Worktree creation did not return a worktree id.',
          { errors: ['Missing worktree id.'] },
        );
      }

      if (input.sync ?? true) {
        const synced = await syncWorktree(
          {
            worktreeId,
            headRef: prFacts.headRef ?? prFacts.headSha,
            headSha: prFacts.headSha,
            fetch: input.fetch,
          },
          paths,
        );
        if (!synced.ok) {
          return lowerLevelFailure(
            'autopilot_prepare_pr_worktree',
            'worktree_sync',
            synced,
          );
        }
        worktree = objectField(synced, 'worktree') ?? worktree;
      }

      if (input.lock ?? true) {
        const locked = await lockWorktree(
          {
            worktreeId,
            scope: 'pr',
            owner: input.lockOwner ?? 'prepare_pr_worktree',
            ttlSeconds: input.lockTtlSeconds ?? 1_800,
          },
          paths,
        );
        if (!locked.ok) {
          return lowerLevelFailure(
            'autopilot_prepare_pr_worktree',
            'worktree_lock',
            locked,
          );
        }
        lock = objectField(locked, 'lock');
      }

      status = await readWorktreeStatus({ worktreeId }, paths);
    }

    return {
      ok: true,
      action: 'autopilot_prepare_pr_worktree',
      changed: Boolean(worktree),
      message: worktree
        ? `Prepared PR worktree for ${repoFullName(repo)}#${input.prNumber}.`
        : `Gathered PR facts for ${repoFullName(repo)}#${input.prNumber}.`,
      data: asJsonValue({
        repo: {
          id: repo.id,
          fullName: repoFullName(repo),
          path: repo.path,
          defaultBranch: repo.defaultBranch,
        },
        pr: prFacts,
        checks,
        concurrency,
        worktree,
        lock,
        status,
        eventId: input.eventId ?? null,
        runLinkage: {
          owningWorkflowRunIdAttached: false,
          reason:
            'Flue ActionContext does not expose workflow identity; caller-supplied run ids are not accepted.',
        },
      }),
    };
  } catch (error) {
    return failResult(
      'autopilot_prepare_pr_worktree',
      'Could not prepare PR worktree.',
      { errors: [errorMessage(error)] },
    );
  }
}

export async function verifyPrWorktree(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    verifyPrWorktreeInputSchema,
    rawInput,
    'autopilot_verify_pr_worktree',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  let acquiredLockId: string | undefined;
  const lockOwner = input.lockOwner ?? 'verify_pr_worktree';
  let finalLockStatus: 'ready' | 'prepared-diff' = 'ready';

  try {
    await ensureRuntimeHome(paths);
    const [registry, appConfig, worktreeSnapshot] = await Promise.all([
      readRepoRegistrySnapshot(paths),
      readRuntimeJson(paths.config, parseAppConfig),
      listWorktrees(paths),
    ]);
    const worktree = worktreeSnapshot.worktrees.find(
      (candidate) => candidate.id === input.worktreeId,
    );
    if (!worktree || worktree.lifecycleStatus === 'deleted') {
      return failResult(
        'autopilot_verify_pr_worktree',
        `Worktree "${input.worktreeId}" was not found.`,
        { requires: ['worktreeId'] },
      );
    }
    finalLockStatus =
      worktree.lifecycleStatus === 'prepared-diff' ? 'prepared-diff' : 'ready';
    const repo = registry.repos.find(
      (candidate) => candidate.id === worktree.repoId,
    );
    if (!repo) {
      return failResult(
        'autopilot_verify_pr_worktree',
        `Repository "${worktree.repoId}" is not configured.`,
        { requires: ['repo'] },
      );
    }

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: repo.id,
        prNumber: worktree.prNumber,
        workflow: 'verify_pr_worktree',
        mutation: true,
      },
      paths,
    );
    if (!concurrency.allowed) {
      return {
        ok: false,
        action: 'autopilot_verify_pr_worktree',
        changed: false,
        message: concurrency.message,
        data: asJsonValue({ concurrency }),
        errors: concurrency.reasons,
        requires: ['concurrency'],
      };
    }

    const lockEnabled = input.lock ?? true;
    if (lockEnabled) {
      const locked = await lockWorktree(
        {
          worktreeId: worktree.id,
          scope: 'pr',
          owner: lockOwner,
          ttlSeconds: input.lockTtlSeconds ?? 3_600,
        },
        paths,
      );
      if (!locked.ok) {
        return lowerLevelFailure(
          'autopilot_verify_pr_worktree',
          'worktree_lock',
          locked,
        );
      }
      acquiredLockId = stringField(objectField(locked, 'lock'), 'id');
    }

    const policy = await checkAutopilotPolicy(
      {
        worktreeId: worktree.id,
        diffBaseRef: input.diffBaseRef,
        pushDestination: 'pull-request-head',
      },
      paths,
    );
    if (!policy.ok || policy.blocked) {
      return {
        ok: false,
        action: 'autopilot_verify_pr_worktree',
        changed: false,
        message: policy.message,
        data: asJsonValue({ policy, concurrency }),
        errors: policy.reasons,
        requires: policy.requires,
      };
    }
    if (policy.diff.filesChanged > 0) {
      finalLockStatus = 'prepared-diff';
    }

    const checks = resolveVerificationChecks(
      input.checks,
      repo,
      repoAutopilotPolicy(repo, appConfig).limits.requiredChecks,
    );
    if (checks.length === 0) {
      return failResult(
        'autopilot_verify_pr_worktree',
        'No repo checks are configured for this worktree.',
        {
          requires: ['autopilot.limits.requiredChecks', 'repo.packageScripts'],
        },
      );
    }

    const runExecution = dependencies.runExecution ?? runApprovedExecution;
    const results = [];
    for (const command of checks) {
      const slot = await withAutopilotLocalExecutionSlot(
        policy.concurrency,
        () =>
          runExecution(
            {
              command,
              backend: input.backend,
              cwd: worktree.localPath,
              context: input.context ?? 'unattended',
              timeoutMs: input.timeoutMs,
              maxOutputBytes: input.maxOutputBytes,
              requestContext: {
                source: 'autopilot',
                workflow: 'verify_pr_worktree',
                repoId: repo.id,
                repoFullName: repoFullName(repo),
                prNumber: worktree.prNumber,
                worktreeId: worktree.id,
              },
            },
            paths,
          ),
      );
      if ('blocked' in slot) {
        results.push({
          command,
          ok: false,
          message: slot.message,
          requires: ['localExecutionLimit'],
        });
        break;
      }
      results.push({
        command,
        ok: Boolean(slot.ok),
        message: stringField(slot, 'message') ?? 'Execution completed.',
        requires: arrayField(slot, 'requires'),
        approvalId: stringField(objectField(slot, 'approval'), 'id') ?? null,
        exitCode: numberField(objectField(slot, 'result'), 'exitCode') ?? null,
      });
      if (!slot.ok) break;
    }

    const passed =
      results.length === checks.length && results.every((item) => item.ok);
    const blocked = results.some((item) => item.requires.length > 0);
    const status = await readWorktreeStatus({ worktreeId: worktree.id }, paths);

    return {
      ok: passed,
      action: 'autopilot_verify_pr_worktree',
      changed: true,
      message: passed
        ? `Verified ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'} with ${results.length} check(s).`
        : blocked
          ? 'Verification is blocked by execution approval or concurrency policy.'
          : 'One or more verification checks failed.',
      data: asJsonValue({
        repo: {
          id: repo.id,
          fullName: repoFullName(repo),
          path: repo.path,
          defaultBranch: repo.defaultBranch,
        },
        worktree,
        policy,
        concurrency,
        checks,
        results,
        status,
      }),
      ...(passed
        ? {}
        : {
            errors: results
              .filter((item) => !item.ok)
              .map((item) => item.message),
          }),
      ...(blocked ? { requires: ['approval'] } : {}),
    };
  } catch (error) {
    return failResult(
      'autopilot_verify_pr_worktree',
      'Could not verify PR worktree.',
      { errors: [errorMessage(error)] },
    );
  } finally {
    if (acquiredLockId) {
      await releaseWorktreeLock(
        {
          lockId: acquiredLockId,
          owner: lockOwner,
          finalStatus: finalLockStatus,
        },
        paths,
      ).catch(() => undefined);
    }
  }
}

async function fetchPreparedPrFacts(
  owner: string,
  repo: string,
  number: number,
  dependencies: AutopilotDependencies,
): Promise<v.InferOutput<typeof prFactsSchema> | AutopilotActionResult> {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'autopilot_prepare_pr_worktree',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const detail = await (
    dependencies.fetchPullRequestDetail ?? fetchPullRequestDetail
  )({ token, owner, repo, number });
  return prFactsFromDetail(detail);
}

async function fetchPreparedCheckFacts(
  owner: string,
  repo: string,
  ref: string,
  dependencies: AutopilotDependencies,
): Promise<GitHubCheckSummary | AutopilotActionResult> {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'autopilot_prepare_pr_worktree',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const checks = await (dependencies.fetchCheckSummary ?? fetchCheckSummary)({
    token,
    owner,
    repo,
    ref,
  });
  return v.parse(checkSummarySchema, checks);
}

function prFactsFromDetail(
  detail: GitHubPullRequestDetail,
): v.InferOutput<typeof prFactsSchema> {
  const [owner, name] = detail.repo.split('/');
  return {
    number: detail.number,
    title: detail.title,
    repo: detail.repo,
    url: detail.url,
    state: detail.state,
    draft: detail.draft,
    merged: detail.merged,
    mergeCommitSha: detail.mergeCommitSha,
    headSha: detail.headSha,
    headRef: detail.headRef ?? detail.headSha,
    headOwner: detail.headOwner ?? owner,
    headName: detail.headName ?? name,
    baseRef: detail.baseRef,
    updatedAt: detail.updatedAt,
    maintainerCanModify: detail.maintainerCanModify ?? false,
  };
}

function classifySignals(
  current: v.InferOutput<typeof prEventSnapshotSchema> | undefined,
  deltas: Array<v.InferOutput<typeof prEventDeltaSchema>>,
) {
  return {
    noChange: deltas.length === 0,
    closed: current?.state === 'closed' || current?.merged === true,
    draft: current?.draft === true,
    failingChecks:
      current?.checkStatus === 'failure' ||
      deltas.some((delta) => delta.type === 'check-failure'),
    requestedChanges: deltas.some(
      (delta) => delta.type === 'requested-changes',
    ),
    reviewFeedback: deltas.some((delta) => delta.type === 'review-comment'),
    mergeBlocked:
      current?.mergeable === false ||
      current?.outOfDate === true ||
      deltas.some(
        (delta) =>
          delta.type === 'merge-conflict' ||
          delta.type === 'branch-out-of-date',
      ),
    recoveryOnly:
      deltas.length > 0 &&
      deltas.every(
        (delta) =>
          delta.type === 'check-recovery' ||
          delta.type === 'review-thread-resolved' ||
          delta.type === 'metadata',
      ),
    explanatory: deltas.some(
      (delta) => delta.requiresExplanation || delta.type === 'new-commit',
    ),
    actionable: deltas.some((delta) => delta.actionable === true),
  };
}

function classificationFor(
  mode: v.InferOutput<typeof autopilotModeSchema>,
  signals: ReturnType<typeof classifySignals>,
): AutopilotTriageClass {
  if (signals.noChange) return 'no-op';
  if (signals.closed || signals.recoveryOnly || signals.draft) {
    return 'notify-only';
  }
  if (signals.mergeBlocked) return 'explain-only';
  if (
    signals.failingChecks ||
    signals.requestedChanges ||
    signals.reviewFeedback ||
    signals.actionable
  ) {
    return mode;
  }
  if (signals.explanatory) return 'explain-only';
  return 'notify-only';
}

function reasonsFor(
  classification: AutopilotTriageClass,
  mode: v.InferOutput<typeof autopilotModeSchema>,
  signals: ReturnType<typeof classifySignals>,
  deltas: Array<v.InferOutput<typeof prEventDeltaSchema>>,
) {
  const reasons: string[] = [];
  if (classification === 'no-op') {
    reasons.push('No structured PR deltas were supplied.');
  }
  if (signals.closed) reasons.push('PR is closed or merged.');
  if (signals.draft) reasons.push('Draft PRs are not prepared for autofix.');
  if (signals.recoveryOnly) {
    reasons.push('Only recovery or metadata deltas were present.');
  }
  if (signals.mergeBlocked) {
    reasons.push('Merge conflict or out-of-date branch needs explanation.');
  }
  if (signals.failingChecks) reasons.push('Failing checks are actionable.');
  if (signals.requestedChanges)
    reasons.push('Requested changes are actionable.');
  if (signals.reviewFeedback) reasons.push('Review feedback is actionable.');
  if (signals.actionable)
    reasons.push('At least one delta is marked actionable.');
  if (
    classification === 'draft-fix' ||
    classification === 'auto-fix-no-push' ||
    classification === 'auto-fix-push-after-checks'
  ) {
    reasons.push(`Autopilot mode allows ${mode}.`);
  }
  if (reasons.length === 0 && deltas.length > 0) {
    reasons.push(
      'Delta should be surfaced but does not justify worktree prep.',
    );
  }
  return reasons;
}

function parseInput<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  schema: TSchema,
  rawInput: unknown,
  action: string,
):
  | { ok: true; input: v.InferOutput<TSchema> }
  | { ok: false; result: AutopilotActionResult } {
  const parsed = v.safeParse(schema, rawInput);
  if (parsed.success) return { ok: true, input: parsed.output };
  return {
    ok: false,
    result: failResult(action, 'Invalid autopilot input.', {
      errors: [v.summarize(parsed.issues)],
    }),
  };
}

function failResult(
  action: string,
  message: string,
  details: Pick<AutopilotActionResult, 'errors' | 'requires'> = {},
): AutopilotActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

function lowerLevelFailure(
  action: string,
  sourceAction: string,
  result: unknown,
): AutopilotActionResult {
  const message =
    stringField(result, 'message') ??
    `Could not prepare PR worktree because ${sourceAction} failed.`;
  return {
    ok: false,
    action,
    changed: Boolean(booleanField(result, 'changed')),
    message,
    errors: [message],
    error: asJsonValue({
      sourceAction,
      sourceMessage: message,
      sourceError:
        result && typeof result === 'object'
          ? (result as Record<string, unknown>).error
          : undefined,
    }),
  };
}

function resolveVerificationChecks(
  inputChecks: string[] | undefined,
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  policyChecks: string[],
) {
  if (policyChecks.length > 0) {
    return unique([...policyChecks, ...(inputChecks ?? [])]);
  }
  if (inputChecks && inputChecks.length > 0) return unique(inputChecks);

  const scripts = repo.packageScripts ?? {};
  const preferred = ['check', 'test', 'typecheck', 'lint'];
  return preferred
    .filter((script) => scripts[script])
    .map((script) => `npm run ${script}`);
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function objectField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' ? field : undefined;
}

function stringField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function booleanField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'boolean' ? field : undefined;
}

function numberField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' ? field : undefined;
}

function arrayField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === 'string')
    : [];
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
