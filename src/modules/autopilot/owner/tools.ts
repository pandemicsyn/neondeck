import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { RuntimePaths } from '../../../runtime-home';
import {
  commitInteractiveRepo,
  pushInteractiveRepo,
  readRepoDiff,
} from '../../../repo-edit';
import { gitCurrentSha } from '../../../repo-edit/git';
import { fetchPullRequestDetail } from '../../github';
import { postGitHubPrComment } from '../../pr-events';
import {
  readManagedWorktree,
  recordWorktreePushSucceeded,
  syncWorktree,
} from '../../worktrees';
import { readWatch, type PrWatch } from '../../watches';
import type { AutopilotOwnerCapability } from './capabilities';
import { safePushAutopilotOwner } from './safe-push';
import {
  readPendingAutopilotTurn,
  type AutopilotOwnerTurnSource,
} from './pending';

export function autopilotOwnerCapabilitySet(input: {
  approvedRevisionKey?: string;
  mode: PrWatch['autopilotMode'];
  source: AutopilotOwnerTurnSource;
  status: PrWatch['autopilotStatus'];
}) {
  const prepare: AutopilotOwnerCapability[] = ['workspace', 'commit'];
  if (
    input.mode === 'autofix-with-approval' &&
    input.source === 'direct-human' &&
    input.status === 'waiting'
  ) {
    return input.approvedRevisionKey
      ? [...prepare, 'push', 'respond']
      : prepare;
  }
  if (input.source !== 'watch-event' || input.status !== 'working') {
    return [];
  }
  if (input.mode === 'notify-only') return [];
  if (input.mode === 'autofix-push-when-safe') {
    return [...prepare, 'push', 'respond'];
  }
  return prepare;
}

export function buildAutopilotOwnerToolRegistry(input: {
  watch: PrWatch;
  source: AutopilotOwnerTurnSource;
  paths: RuntimePaths;
  postPrComment?: typeof postGitHubPrComment;
  pushInteractive?: typeof pushInteractiveRepo;
  readWorktree?: typeof readManagedWorktree;
  currentSha?: typeof gitCurrentSha;
  fetchPrDetail?: typeof fetchPullRequestDetail;
  githubToken?: string;
  capabilities?: string[];
  approvedRevisionKey?: string;
}) {
  const { watch, source, paths } = input;
  if (!watch.worktreeId) return { capabilities: [], tools: [] };
  const worktreeId = watch.worktreeId;
  const sessionId = watch.ownerInstanceId ?? undefined;
  const capabilityCeiling = autopilotOwnerCapabilitySet({
    approvedRevisionKey: input.approvedRevisionKey,
    mode: watch.autopilotMode,
    source,
    status: watch.autopilotStatus,
  });
  const capabilities = input.capabilities
    ? input.capabilities.filter((capability) =>
        capabilityCeiling.includes(capability as AutopilotOwnerCapability),
      )
    : capabilityCeiling;
  const enabled = new Set(capabilities);
  const tools: ToolDefinition[] = [];

  if (enabled.has('workspace')) {
    if (source === 'direct-human' && watch.autopilotStatus === 'waiting') {
      tools.push(
        defineTool({
          name: 'neondeck_owner_discard_prepared_commit',
          description:
            'Discard the held prepared commit only when the human explicitly asks to discard it.',
          input: v.object({ confirm: v.literal(true) }),
          durable: true,
          async run({ step }) {
            return {
              output: await step.do('discard-prepared-commit', () =>
                syncWorktree(
                  {
                    worktreeId,
                    headSha: watch.lastSnapshot?.headSha,
                    headRef: watch.lastSnapshot?.headSha,
                    force: true,
                  },
                  paths,
                ),
              ),
            };
          },
        }),
      );
    }
  }

  if (enabled.has('commit')) {
    tools.push(
      defineTool({
        name: 'neondeck_owner_commit',
        description: 'Commit the focused change in this managed worktree.',
        input: v.object({
          message: v.string(),
          paths: v.optional(v.array(v.string())),
        }),
        durable: true,
        async run({ data: toolInput, step }) {
          return {
            output: await step.do('commit-workspace', () =>
              commitInteractiveRepo(
                {
                  ...toolInput,
                  repoId: watch.repoId,
                  worktreeId,
                  sessionId,
                },
                paths,
              ),
            ),
          };
        },
      }),
    );
  }

  if (enabled.has('push')) {
    tools.push(
      defineTool({
        name:
          source === 'watch-event'
            ? 'neondeck_owner_safe_push'
            : 'neondeck_owner_push',
        description:
          source === 'watch-event'
            ? 'Push the committed change after you judge it sound and sufficiently validated. Mechanical authority and race guards are rechecked immediately before delivery.'
            : 'Push this held worktree to its linked PR head after the direct human instruction.',
        input:
          source === 'watch-event'
            ? v.object({})
            : v.object({
                acknowledgeExpansion: v.optional(v.boolean()),
                confirmationToken: v.optional(v.string()),
              }),
        durable: true,
        async run({ data: toolInput, step }) {
          if (source === 'watch-event') {
            return {
              output: await step.do('safe-push-current-commit', () =>
                safePushAutopilotOwner({ ...watch, worktreeId }, paths),
              ),
            };
          }
          if (!directHumanAuthorityCurrent(watch, paths)) {
            return { output: await staleDirectHumanAuthority() };
          }
          return {
            output: await step.do('push-approved-commit', async () => {
              const preflight = await directHumanPushPreflight(
                watch,
                worktreeId,
                input.approvedRevisionKey,
                paths,
                {
                  fetchPrDetail: input.fetchPrDetail,
                  githubToken: input.githubToken,
                },
              );
              if (!preflight) {
                return staleDirectHumanPushHead();
              }
              if (preflight.kind === 'already-pushed') {
                if (!preflight.recorded) {
                  await recordWorktreePushSucceeded(
                    worktreeId,
                    {
                      commitSha: preflight.commitSha,
                      message: `Autopilot reconciled the already-pushed approved commit ${preflight.commitSha}.`,
                      data: { recovered: true },
                    },
                    paths,
                  );
                }
                return {
                  ok: true,
                  action: 'autopilot_owner_push',
                  changed: false,
                  message: `The linked PR head already contains the exact approved commit ${preflight.commitSha}; recovered the interrupted push record without pushing again.`,
                  commitSha: preflight.commitSha,
                  recovered: true,
                };
              }
              return (input.pushInteractive ?? pushInteractiveRepo)(
                {
                  sessionId,
                  repoId: watch.repoId,
                  worktreeId,
                  prNumber: watch.prNumber,
                  ...toolInput,
                },
                paths,
                {
                  expectedRemoteSha: preflight.expectedRemoteSha,
                  authorizePush: () =>
                    directHumanPushAuthorityCurrent(
                      watch,
                      worktreeId,
                      input.approvedRevisionKey,
                      paths,
                    ),
                },
              );
            }),
          };
        },
      }),
    );
  }

  if (enabled.has('respond')) {
    tools.push(
      defineTool({
        name: 'neondeck_owner_pr_respond',
        description:
          'Post a concise response to this PR after grounded work has completed.',
        input: v.object({ body: v.string() }),
        durable: true,
        async run({ data: toolInput, step }) {
          if (source === 'watch-event') {
            if (
              !(await autonomousResponseDeliveryCurrent(
                watch,
                worktreeId,
                paths,
                {
                  currentSha: input.currentSha,
                  fetchPrDetail: input.fetchPrDetail,
                  githubToken: input.githubToken,
                  readWorktree: input.readWorktree,
                },
              ))
            ) {
              return { output: await staleAutonomousResponseAuthority() };
            }
          } else if (
            !(await directHumanResponseAuthorityCurrent(
              watch,
              worktreeId,
              input.approvedRevisionKey,
              paths,
              {
                currentSha: input.currentSha,
                fetchPrDetail: input.fetchPrDetail,
                githubToken: input.githubToken,
                readWorktree: input.readWorktree,
              },
            ))
          ) {
            return { output: await staleDirectHumanResponseAuthority() };
          }
          const turnFingerprint = watch.ownerInstanceId
            ? readPendingAutopilotTurn(paths.home, watch.ownerInstanceId)
            : undefined;
          const responseIdentity =
            turnFingerprint?.source === 'direct-human'
              ? `human-turn:${turnFingerprint.turnId}`
              : `watch-event:${turnFingerprint?.eventFingerprint ?? watch.lastEventFingerprint ?? 'current'}`;
          return {
            output: await step.do('post-grounded-pr-response', () =>
              (input.postPrComment ?? postGitHubPrComment)(
                {
                  watchId: watch.id,
                  body: toolInput.body,
                  idempotencyKey: `autopilot-owner:${watch.id}:${responseIdentity}`,
                },
                paths,
                {
                  authorizeComment: async () => {
                    if (source === 'watch-event') {
                      return (await autonomousResponseDeliveryCurrent(
                        watch,
                        worktreeId,
                        paths,
                        {
                          currentSha: input.currentSha,
                          fetchPrDetail: input.fetchPrDetail,
                          githubToken: input.githubToken,
                          readWorktree: input.readWorktree,
                        },
                      ))
                        ? undefined
                        : staleAutonomousResponseAuthority();
                    }
                    return (await directHumanResponseAuthorityCurrent(
                      watch,
                      worktreeId,
                      input.approvedRevisionKey,
                      paths,
                      {
                        currentSha: input.currentSha,
                        fetchPrDetail: input.fetchPrDetail,
                        githubToken: input.githubToken,
                        readWorktree: input.readWorktree,
                      },
                    ))
                      ? undefined
                      : staleDirectHumanResponseAuthority();
                  },
                },
              ),
            ),
          };
        },
      }),
    );
  }

  return { capabilities, tools };
}

function directHumanAuthorityCurrent(
  watch: PrWatch,
  paths: RuntimePaths,
  expectedRevisionKey?: string,
) {
  if (!watch.ownerInstanceId) return false;
  const current = readWatch(paths, watch.id);
  const pending = readPendingAutopilotTurn(paths.home, watch.ownerInstanceId);
  return (
    current?.ownerInstanceId === watch.ownerInstanceId &&
    current?.autopilotMode === 'autofix-with-approval' &&
    current.autopilotStatus === 'working' &&
    pending?.source === 'direct-human' &&
    Boolean(pending.approvedRevisionKey) &&
    (!expectedRevisionKey ||
      pending.approvedRevisionKey === expectedRevisionKey)
  );
}

async function directHumanPushAuthorityCurrent(
  watch: PrWatch,
  worktreeId: string,
  approvedRevisionKey: string | undefined,
  paths: RuntimePaths,
) {
  if (!directHumanAuthorityCurrent(watch, paths, approvedRevisionKey)) {
    return false;
  }
  const pending = watch.ownerInstanceId
    ? readPendingAutopilotTurn(paths.home, watch.ownerInstanceId)
    : undefined;
  if (!pending?.approvedRevisionKey) return false;
  try {
    const worktree = await readManagedWorktree(worktreeId, watch.repoId, paths);
    if (!worktree.headSha) return false;
    const diff = await readRepoDiff(
      {
        repoId: watch.repoId,
        worktreeId,
        base: worktree.headSha,
        includePatch: false,
        expectedRevisionKey: pending.approvedRevisionKey,
      },
      paths,
    );
    return (
      diff.ok &&
      Boolean(diff.files?.length) &&
      directHumanAuthorityCurrent(watch, paths, approvedRevisionKey)
    );
  } catch {
    return false;
  }
}

async function directHumanPushPreflight(
  watch: PrWatch,
  worktreeId: string,
  approvedRevisionKey: string | undefined,
  paths: RuntimePaths,
  dependencies: {
    fetchPrDetail?: typeof fetchPullRequestDetail;
    githubToken?: string;
  },
) {
  if (
    !(await directHumanPushAuthorityCurrent(
      watch,
      worktreeId,
      approvedRevisionKey,
      paths,
    ))
  ) {
    return undefined;
  }
  const token = dependencies.githubToken ?? process.env.GITHUB_TOKEN;
  if (!token) return undefined;
  try {
    const [worktree, detail] = await Promise.all([
      readManagedWorktree(worktreeId, watch.repoId, paths),
      (dependencies.fetchPrDetail ?? fetchPullRequestDetail)({
        token,
        owner: watch.githubOwner,
        repo: watch.githubName,
        number: watch.prNumber,
      }),
    ]);
    if (
      !worktree.headSha ||
      !directHumanAuthorityCurrent(watch, paths, approvedRevisionKey)
    ) {
      return undefined;
    }
    if (detail.headSha === worktree.headSha) {
      return {
        kind: 'push-required' as const,
        expectedRemoteSha: detail.headSha,
      };
    }
    const currentSha = await gitCurrentSha(worktree.localPath);
    if (
      currentSha !== worktree.headSha &&
      detail.headSha === currentSha &&
      (await directHumanPushAuthorityCurrent(
        watch,
        worktreeId,
        approvedRevisionKey,
        paths,
      ))
    ) {
      return {
        kind: 'already-pushed' as const,
        commitSha: currentSha,
        recorded: worktree.lastPushedSha === currentSha,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function approvedResponseStateCurrent(input: {
  approvedRevisionKey?: string;
  currentRevisionKey?: string;
  currentSha?: string | null;
  diffHasFiles: boolean;
  diffIsCurrent: boolean;
  lastPushedSha?: string | null;
  remoteHeadSha?: string | null;
}) {
  return Boolean(
    input.approvedRevisionKey &&
    input.currentRevisionKey === input.approvedRevisionKey &&
    input.diffIsCurrent &&
    input.diffHasFiles &&
    input.currentSha &&
    input.lastPushedSha === input.currentSha &&
    input.remoteHeadSha === input.currentSha,
  );
}

async function directHumanResponseAuthorityCurrent(
  watch: PrWatch,
  worktreeId: string,
  approvedRevisionKey: string | undefined,
  paths: RuntimePaths,
  dependencies: {
    currentSha?: typeof gitCurrentSha;
    fetchPrDetail?: typeof fetchPullRequestDetail;
    githubToken?: string;
    readWorktree?: typeof readManagedWorktree;
  } = {},
) {
  if (!directHumanAuthorityCurrent(watch, paths, approvedRevisionKey)) {
    return false;
  }
  const pending = watch.ownerInstanceId
    ? readPendingAutopilotTurn(paths.home, watch.ownerInstanceId)
    : undefined;
  if (!pending?.approvedRevisionKey || !approvedRevisionKey) return false;
  const token = dependencies.githubToken ?? process.env.GITHUB_TOKEN;
  if (!token) return false;
  try {
    const worktree = await (dependencies.readWorktree ?? readManagedWorktree)(
      worktreeId,
      watch.repoId,
      paths,
    );
    if (!worktree.headSha) return false;
    const [currentSha, diff, detail] = await Promise.all([
      (dependencies.currentSha ?? gitCurrentSha)(worktree.localPath),
      readRepoDiff(
        {
          repoId: watch.repoId,
          worktreeId,
          base: worktree.headSha,
          includePatch: false,
          expectedRevisionKey: approvedRevisionKey,
        },
        paths,
      ),
      (dependencies.fetchPrDetail ?? fetchPullRequestDetail)({
        token,
        owner: watch.githubOwner,
        repo: watch.githubName,
        number: watch.prNumber,
      }),
    ]);
    return (
      approvedResponseStateCurrent({
        approvedRevisionKey,
        currentRevisionKey: pending.approvedRevisionKey,
        currentSha,
        diffHasFiles: Boolean(diff.ok && diff.files?.length),
        diffIsCurrent: diff.ok,
        lastPushedSha: worktree.lastPushedSha,
        remoteHeadSha: detail.headSha,
      }) && directHumanAuthorityCurrent(watch, paths, approvedRevisionKey)
    );
  } catch {
    return false;
  }
}

function staleDirectHumanPushHead() {
  return {
    ok: false,
    action: 'autopilot_owner_push',
    changed: false,
    message:
      'The exact approved worktree revision is no longer based on the current PR head; no push was performed.',
    requires: ['currentPrHead'],
  };
}

function staleDirectHumanAuthority() {
  return {
    ok: false,
    action: 'autopilot_owner_human_effect',
    changed: false,
    message:
      'The approval-mode human turn is no longer current; no external effect was performed.',
    requires: ['currentHumanTurn'],
  };
}

function staleDirectHumanResponseAuthority() {
  return {
    ok: false,
    action: 'autopilot_owner_pr_respond',
    changed: false,
    message:
      'The exact approved worktree revision is not the current successfully pushed commit; no PR response was posted.',
    requires: ['currentApprovedPushedRevision'],
  };
}

function autonomousResponseAuthorityCurrent(
  watch: PrWatch,
  paths: RuntimePaths,
) {
  if (!watch.ownerInstanceId) return false;
  const current = readWatch(paths, watch.id);
  const pending = readPendingAutopilotTurn(paths.home, watch.ownerInstanceId);
  return (
    current?.ownerInstanceId === watch.ownerInstanceId &&
    current.autopilotMode === 'autofix-push-when-safe' &&
    current.autopilotStatus === 'working' &&
    pending?.source === 'watch-event' &&
    pending.mode === 'autofix-push-when-safe'
  );
}

async function autonomousResponseDeliveryCurrent(
  watch: PrWatch,
  worktreeId: string,
  paths: RuntimePaths,
  dependencies: {
    currentSha?: typeof gitCurrentSha;
    fetchPrDetail?: typeof fetchPullRequestDetail;
    githubToken?: string;
    readWorktree?: typeof readManagedWorktree;
  } = {},
) {
  if (!autonomousResponseAuthorityCurrent(watch, paths)) return false;
  const token = dependencies.githubToken ?? process.env.GITHUB_TOKEN;
  if (!token) return false;
  try {
    const detail = await (dependencies.fetchPrDetail ?? fetchPullRequestDetail)(
      {
        token,
        owner: watch.githubOwner,
        repo: watch.githubName,
        number: watch.prNumber,
      },
    );
    const worktree = await (dependencies.readWorktree ?? readManagedWorktree)(
      worktreeId,
      watch.repoId,
      paths,
    );
    const currentSha = await (dependencies.currentSha ?? gitCurrentSha)(
      worktree.localPath,
    );
    return Boolean(
      worktree.lastPushedSha &&
      currentSha === worktree.lastPushedSha &&
      detail.headSha === currentSha &&
      autonomousResponseAuthorityCurrent(watch, paths),
    );
  } catch {
    return false;
  }
}

function staleAutonomousResponseAuthority() {
  return {
    ok: false,
    action: 'autopilot_owner_pr_respond',
    changed: false,
    message:
      'The current watch mode or turn source no longer authorizes an autonomous PR response.',
    requires: ['currentSafeMode'],
  };
}
