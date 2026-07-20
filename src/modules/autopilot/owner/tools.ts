import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { RuntimePaths } from '../../../runtime-home';
import {
  commitInteractiveRepo,
  patchRepoFiles,
  pushInteractiveRepo,
  readRepoCheckoutStatus,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
  searchRepoFiles,
  writeRepoFile,
} from '../../../repo-edit';
import { gitCurrentSha } from '../../../repo-edit/git';
import { runApprovedExecution } from '../../execution';
import { postGitHubPrComment } from '../../pr-events';
import { readManagedWorktree, syncWorktree } from '../../worktrees';
import { readWatch, type PrWatch } from '../../watches';
import type { AutopilotOwnerCapability } from './capabilities';
import { configuredAutopilotChecks } from './checks';
import { safePushAutopilotOwner } from './safe-push';
import {
  readPendingAutopilotTurn,
  type AutopilotOwnerTurnSource,
} from './pending';

export function autopilotOwnerCapabilitySet(input: {
  mode: PrWatch['autopilotMode'];
  source: AutopilotOwnerTurnSource;
  status: PrWatch['autopilotStatus'];
}) {
  const prepare: AutopilotOwnerCapability[] = [
    'read',
    'edit',
    'diagnose',
    'commit',
  ];
  if (
    input.mode === 'autofix-with-approval' &&
    input.source === 'direct-human' &&
    input.status === 'waiting'
  ) {
    return [...prepare, 'push', 'respond'];
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
}) {
  const { watch, source, paths } = input;
  if (!watch.worktreeId) return { capabilities: [], tools: [] };
  const worktreeId = watch.worktreeId;
  const sessionId = watch.ownerInstanceId ?? undefined;
  const capabilities = autopilotOwnerCapabilitySet({
    mode: watch.autopilotMode,
    source,
    status: watch.autopilotStatus,
  });
  const enabled = new Set(capabilities);
  const tools: ToolDefinition[] = [];

  if (enabled.has('read')) {
    tools.push(
      defineTool({
        name: 'neondeck_owner_file_read',
        description: 'Read one file in this PR owner managed worktree.',
        input: v.object({
          path: v.string(),
          offset: v.optional(v.number()),
          limit: v.optional(v.number()),
        }),
        async run({ input: toolInput }) {
          return readRepoFile(
            {
              ...toolInput,
              repoId: watch.repoId,
              worktreeId,
              sessionId,
              includeLineNumbers: true,
            },
            paths,
          );
        },
      }),
      defineTool({
        name: 'neondeck_owner_file_search',
        description: 'Search text in this PR owner managed worktree.',
        input: v.object({
          query: v.string(),
          globs: v.optional(v.array(v.string())),
          maxResults: v.optional(v.number()),
        }),
        async run({ input: toolInput }) {
          return searchRepoFiles(
            { ...toolInput, repoId: watch.repoId, worktreeId },
            paths,
          );
        },
      }),
      defineTool({
        name: 'neondeck_owner_diff',
        description:
          'Read the current committed or uncommitted diff in this PR owner worktree.',
        input: v.object({ includePatch: v.optional(v.boolean()) }),
        async run({ input: toolInput }) {
          const currentWorktree = await readManagedWorktree(
            worktreeId,
            watch.repoId,
            paths,
          );
          return readRepoDiff(
            {
              ...toolInput,
              repoId: watch.repoId,
              worktreeId,
              base: currentWorktree.headSha ?? undefined,
            },
            paths,
          );
        },
      }),
      defineTool({
        name: 'neondeck_owner_status',
        description: 'Read git status for this PR owner worktree.',
        input: v.object({}),
        async run() {
          return readRepoCheckoutStatus(
            { repoId: watch.repoId, worktreeId },
            paths,
          );
        },
      }),
    );
  }

  if (enabled.has('edit')) {
    tools.push(
      defineTool({
        name: 'neondeck_owner_file_replace',
        description: 'Apply a bounded exact replacement in this worktree.',
        input: v.object({
          path: v.string(),
          oldString: v.string(),
          newString: v.string(),
          replaceAll: v.optional(v.boolean()),
          reason: v.optional(v.string()),
        }),
        async run({ input: toolInput }) {
          return replaceRepoFile(
            {
              ...toolInput,
              repoId: watch.repoId,
              worktreeId,
              sessionId,
              fuzzy: 'safe',
            },
            paths,
          );
        },
      }),
      defineTool({
        name: 'neondeck_owner_file_patch',
        description: 'Apply a bounded V4A patch in this worktree.',
        input: v.object({
          patch: v.string(),
          reason: v.optional(v.string()),
        }),
        async run({ input: toolInput }) {
          return patchRepoFiles(
            {
              ...toolInput,
              repoId: watch.repoId,
              worktreeId,
              sessionId,
            },
            paths,
          );
        },
      }),
      defineTool({
        name: 'neondeck_owner_file_write',
        description: 'Write one complete text file in this worktree.',
        input: v.object({
          path: v.string(),
          content: v.string(),
          reason: v.optional(v.string()),
        }),
        async run({ input: toolInput }) {
          return writeRepoFile(
            {
              ...toolInput,
              repoId: watch.repoId,
              worktreeId,
              sessionId,
              createParentDirectories: true,
            },
            paths,
          );
        },
      }),
    );
    if (source === 'direct-human' && watch.autopilotStatus === 'waiting') {
      tools.push(
        defineTool({
          name: 'neondeck_owner_discard_prepared_commit',
          description:
            'Discard the held prepared commit only when the human explicitly asks to discard it.',
          input: v.object({ confirm: v.literal(true) }),
          async run() {
            return syncWorktree(
              {
                worktreeId,
                headSha: watch.lastSnapshot?.headSha,
                headRef: watch.lastSnapshot?.headSha,
                force: true,
              },
              paths,
            );
          },
        }),
      );
    }
  }

  if (enabled.has('diagnose')) {
    tools.push(
      defineTool({
        name: 'neondeck_owner_run_targeted_check',
        description:
          'Run one configured targeted check in this worktree. Arbitrary commands are refused.',
        input: v.object({ command: v.string() }),
        async run({ input: toolInput }) {
          const configured = await configuredAutopilotChecks(watch, paths);
          if (!configured.checks.includes(toolInput.command)) {
            return {
              ok: false,
              action: 'autopilot_owner_check',
              changed: false,
              message:
                'The requested command is not a configured targeted check.',
              requires: ['configuredCheck'],
            };
          }
          const worktree = await readManagedWorktree(
            worktreeId,
            watch.repoId,
            paths,
          );
          return runApprovedExecution(
            {
              command: toolInput.command,
              cwd: worktree.localPath,
              context: source === 'direct-human' ? 'interactive' : 'unattended',
              requestContext: {
                source: 'autopilot',
                watchId: watch.id,
                repoId: watch.repoId,
                worktreeId,
                operation: 'owner-targeted-check',
              },
            },
            paths,
          );
        },
      }),
    );
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
        async run({ input: toolInput }) {
          return commitInteractiveRepo(
            {
              ...toolInput,
              repoId: watch.repoId,
              worktreeId,
              sessionId,
            },
            paths,
          );
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
            ? 'Run every configured targeted check and push only when all immediate safety gates pass.'
            : 'Push this held worktree to its linked PR head after the direct human instruction.',
        input: v.object({
          acknowledgeExpansion: v.optional(v.boolean()),
          confirmationToken: v.optional(v.string()),
        }),
        async run({ input: toolInput }) {
          if (source === 'watch-event') {
            return safePushAutopilotOwner({ ...watch, worktreeId }, paths);
          }
          if (!directHumanAuthorityCurrent(watch, paths)) {
            return staleDirectHumanAuthority();
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
          );
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
        async run({ input: toolInput }) {
          if (source === 'watch-event') {
            const current = readWatch(paths, watch.id);
            if (
              !current ||
              current.autopilotMode !== 'autofix-push-when-safe' ||
              current.autopilotStatus !== 'working'
            ) {
              return {
                ok: false,
                action: 'autopilot_owner_pr_respond',
                changed: false,
                message:
                  'The current watch mode no longer authorizes an autonomous PR response.',
                requires: ['currentSafeMode'],
              };
            }
            const currentWorktree = await readManagedWorktree(
              worktreeId,
              watch.repoId,
              paths,
            );
            if (
              !currentWorktree.lastPushedSha ||
              (await gitCurrentSha(currentWorktree.localPath)) !==
                currentWorktree.lastPushedSha
            ) {
              return {
                ok: false,
                action: 'autopilot_owner_pr_respond',
                changed: false,
                message:
                  'Autopilot must safely push the current commit before posting an autonomous PR response.',
                requires: ['safePush'],
              };
            }
          } else if (!directHumanAuthorityCurrent(watch, paths)) {
            return staleDirectHumanAuthority();
          }
          const turnFingerprint = watch.ownerInstanceId
            ? readPendingAutopilotTurn(paths.home, watch.ownerInstanceId)
            : undefined;
          const responseIdentity =
            turnFingerprint?.source === 'direct-human'
              ? `human-turn:${turnFingerprint.turnId}`
              : `watch-event:${turnFingerprint?.eventFingerprint ?? watch.lastEventFingerprint ?? 'current'}`;
          return (input.postPrComment ?? postGitHubPrComment)(
            {
              watchId: watch.id,
              body: toolInput.body,
              idempotencyKey: `autopilot-owner:${watch.id}:${responseIdentity}`,
            },
            paths,
          );
        },
      }),
    );
  }

  return { capabilities, tools };
}

function directHumanAuthorityCurrent(watch: PrWatch, paths: RuntimePaths) {
  if (!watch.ownerInstanceId) return false;
  const current = readWatch(paths, watch.id);
  const pending = readPendingAutopilotTurn(paths.home, watch.ownerInstanceId);
  return (
    current?.autopilotMode === 'autofix-with-approval' &&
    current.autopilotStatus === 'working' &&
    pending?.source === 'direct-human'
  );
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
