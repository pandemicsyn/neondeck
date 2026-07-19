import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import {
  exedevTargetInputSchema,
  remoteParent,
  resolveExeDevCheckoutTarget,
  shellArg,
} from './context';
import { runApprovedExecution } from '../run';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const safeGitRefSchema = v.pipe(
  nonEmptyStringSchema,
  v.check((value) => {
    return (
      !value.startsWith('-') &&
      !value.includes('\u0000') &&
      !/[\s\\~^:?*[\]]/.test(value)
    );
  }, 'Expected a safe git ref or SHA.'),
);
const syncStepSchema = v.picklist([
  'mkdir-parent',
  'probe',
  'clone',
  'fetch',
  'fetch-worktree-head',
  'verify-ref',
  'checkout',
  'head',
]);
const syncInputSchema = v.object({
  ...exedevTargetInputSchema(),
  ref: v.optional(safeGitRefSchema),
  fetch: v.optional(v.boolean()),
  approvals: v.optional(v.record(syncStepSchema, nonEmptyStringSchema)),
  context: v.optional(v.picklist(['interactive', 'unattended'])),
  sessionId: v.optional(nonEmptyStringSchema),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxOutputBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const exedevCheckoutSyncAction = defineAction({
  name: 'neondeck_exedev_checkout_sync',
  description:
    'Checkout or sync a declared repo or Neondeck-managed worktree on the configured existing exe.dev VM through the execution approval policy.',
  input: syncInputSchema,
  output: outputSchema,
  async run({ input }) {
    return syncExeDevCheckout(input);
  },
});

export const neondeckExeDevCheckoutActions = [exedevCheckoutSyncAction];

type SyncDependencies = {
  runExecution?: (
    rawInput: unknown,
    paths?: RuntimePaths,
  ) => Promise<Record<string, unknown>>;
};

export async function syncExeDevCheckout(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: SyncDependencies = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(syncInputSchema, rawInput);
  if (!parsed.success) {
    return failure(
      `Invalid exe.dev checkout sync input: ${v.summarize(parsed.issues)}`,
      ['repoId'],
    );
  }
  const input = parsed.output;
  if (!input.repoId && !input.worktreeId) {
    return failure('A repoId or worktreeId is required.', ['repoId']);
  }

  try {
    const target = await resolveExeDevCheckoutTarget(input, paths);
    if (!target)
      return failure('A repoId or worktreeId is required.', ['repoId']);
    const runExecution = dependencies.runExecution ?? runApprovedExecution;
    const ref = input.ref ?? checkoutRefForTarget(target);
    const steps: unknown[] = [];
    const runStep = async (
      step: v.InferOutput<typeof syncStepSchema>,
      command: string,
    ) => {
      const result = await runExecution(
        {
          command,
          backend: 'exe.dev',
          approvalId: input.approvals?.[step],
          context: input.context ?? 'interactive',
          sessionId: input.sessionId,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          forwardEnv: false,
          requestContext: {
            action: 'exedev_checkout_sync',
            step,
            repoId: target.repo.id,
            repoFullName: target.repoFullName,
            worktreeId: target.worktree?.id ?? null,
            remotePath: target.remotePath,
          },
        },
        paths,
      );
      steps.push({
        step,
        command,
        ok: Boolean(result.ok),
        approvalId: approvalId(result),
        message: stringField(result, 'message'),
      });
      return result;
    };

    const mkdir = await runStep(
      'mkdir-parent',
      `mkdir -p ${shellArg(remoteParent(target.remotePath))}`,
    );
    if (!mkdir.ok) return blocked('mkdir-parent', mkdir, target, steps);

    const probe = await runStep(
      'probe',
      `git -C ${shellArg(target.remotePath)} rev-parse --is-inside-work-tree`,
    );
    if (!probe.ok && !executionFinished(probe)) {
      return blocked('probe', probe, target, steps);
    }
    const exists = Boolean(probe.ok);
    if (!exists) {
      const clone = await runStep(
        'clone',
        unattendedRemoteGit(
          `git clone ${shellArg(target.remoteUrl)} ${shellArg(target.remotePath)}`,
        ),
      );
      if (!clone.ok) return blocked('clone', clone, target, steps);
    }

    if (exists && input.fetch !== false) {
      const fetch = await runStep(
        'fetch',
        unattendedRemoteGit(
          `git -C ${shellArg(target.remotePath)} fetch --all --prune`,
        ),
      );
      if (!fetch.ok) return blocked('fetch', fetch, target, steps);
    }

    if (target.worktree && shouldFetchWorktreeHead(target)) {
      const fetchHead = await runStep(
        'fetch-worktree-head',
        unattendedRemoteGit(
          `git -C ${shellArg(target.remotePath)} fetch ${shellArg(
            worktreeHeadRemoteUrl(target),
          )} ${shellArg(target.worktree.headRef)}`,
        ),
      );
      if (!fetchHead.ok) {
        return blocked('fetch-worktree-head', fetchHead, target, steps);
      }
    }

    if (target.worktree?.headSha && !input.ref) {
      const verifyRef = await runStep(
        'verify-ref',
        `git -C ${shellArg(target.remotePath)} cat-file -e ${shellArg(
          `${target.worktree.headSha}^{commit}`,
        )}`,
      );
      if (!verifyRef.ok) {
        if (executionFinished(verifyRef)) {
          return unreachableWorktreeHead(verifyRef, target, steps);
        }
        return blocked('verify-ref', verifyRef, target, steps);
      }
    }

    const checkout = await runStep(
      'checkout',
      `git -C ${shellArg(target.remotePath)} checkout --detach ${shellArg(ref)}`,
    );
    if (!checkout.ok) return blocked('checkout', checkout, target, steps);

    const head = await runStep(
      'head',
      `git -C ${shellArg(target.remotePath)} rev-parse HEAD`,
    );
    if (!head.ok) return blocked('head', head, target, steps);

    return {
      ok: true,
      action: 'exedev_checkout_sync',
      changed: !exists || input.fetch !== false,
      message: `Synced exe.dev checkout for ${target.repoFullName}.`,
      checkout: {
        repoId: target.repo.id,
        repoFullName: target.repoFullName,
        worktreeId: target.worktree?.id ?? null,
        remotePath: target.remotePath,
        ref,
        headSha: stdout(head).trim() || null,
      },
      steps,
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), [
      'exe.dev',
    ]);
  }
}

function unattendedRemoteGit(command: string) {
  return `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=Never SSH_ASKPASS_REQUIRE=never GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-\${GIT_SSH:-ssh}} -oBatchMode=yes -oConnectTimeout=15" ${command}`;
}

function blocked(
  step: string,
  result: Record<string, unknown>,
  target: NonNullable<Awaited<ReturnType<typeof resolveExeDevCheckoutTarget>>>,
  steps: unknown[],
) {
  return {
    ok: false,
    action: 'exedev_checkout_sync',
    changed: true,
    message: `exe.dev checkout sync stopped at ${step}: ${stringField(
      result,
      'message',
    )}`,
    requires: Array.isArray(result.requires) ? result.requires : ['approval'],
    checkout: {
      repoId: target.repo.id,
      repoFullName: target.repoFullName,
      worktreeId: target.worktree?.id ?? null,
      remotePath: target.remotePath,
    },
    blockedStep: step,
    execution: result,
    steps,
  };
}

function failure(message: string, requires: string[]) {
  return {
    ok: false,
    action: 'exedev_checkout_sync',
    changed: false,
    message,
    requires,
  };
}

function shouldFetchWorktreeHead(
  target: NonNullable<Awaited<ReturnType<typeof resolveExeDevCheckoutTarget>>>,
) {
  const worktree = target.worktree;
  if (!worktree?.headOwner || !worktree.headName) return false;
  return (
    worktree.headOwner !== target.repo.github.owner ||
    worktree.headName !== target.repo.github.name
  );
}

function checkoutRefForTarget(
  target: NonNullable<Awaited<ReturnType<typeof resolveExeDevCheckoutTarget>>>,
) {
  if (target.worktree) {
    if (target.worktree.headSha) return target.worktree.headSha;
    if (shouldFetchWorktreeHead(target)) return 'FETCH_HEAD';
    return `origin/${target.worktree.headRef}`;
  }
  return `origin/${target.defaultRef}`;
}

function worktreeHeadRemoteUrl(
  target: NonNullable<Awaited<ReturnType<typeof resolveExeDevCheckoutTarget>>>,
) {
  const worktree = target.worktree;
  if (!worktree?.headOwner || !worktree.headName) return target.remoteUrl;
  return `https://github.com/${worktree.headOwner}/${worktree.headName}.git`;
}

function unreachableWorktreeHead(
  result: Record<string, unknown>,
  target: NonNullable<Awaited<ReturnType<typeof resolveExeDevCheckoutTarget>>>,
  steps: unknown[],
) {
  return {
    ok: false,
    action: 'exedev_checkout_sync',
    changed: true,
    message: `Worktree "${target.worktree?.id}" head SHA "${target.worktree?.headSha}" is not reachable on the exe.dev checkout after fetching GitHub refs. Push or transfer the local worktree commit before syncing to exe.dev.`,
    requires: ['reachable-ref'],
    checkout: {
      repoId: target.repo.id,
      repoFullName: target.repoFullName,
      worktreeId: target.worktree?.id ?? null,
      remotePath: target.remotePath,
    },
    blockedStep: 'verify-ref',
    execution: result,
    steps,
  };
}

function executionFinished(result: unknown) {
  const approval = objectField(result, 'approval');
  if (
    approval?.status === 'executed' ||
    approval?.status === 'failed' ||
    approval?.executedAt
  ) {
    return true;
  }
  const executionResult = objectField(result, 'result');
  return typeof executionResult?.exitCode === 'number';
}

function approvalId(result: unknown) {
  const approval = objectField(result, 'approval');
  return typeof approval?.id === 'string' ? approval.id : null;
}

function stdout(result: unknown) {
  const executionResult = objectField(result, 'result');
  return typeof executionResult?.stdout === 'string'
    ? executionResult.stdout
    : '';
}

function stringField(value: unknown, key: string) {
  const object = objectField(value, undefined);
  const field = key && object ? object[key] : undefined;
  return typeof field === 'string' ? field : '';
}

function objectField(value: unknown, key: string | undefined) {
  const object =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  if (!object || key === undefined) return object;
  const field = object[key];
  return field && typeof field === 'object'
    ? (field as Record<string, unknown>)
    : null;
}
