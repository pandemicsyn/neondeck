import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { RuntimePaths } from '../../../runtime-home';
import { commitInteractiveRepo, pushInteractiveRepo } from '../../../repo-edit';
import { gitCurrentSha } from '../../../repo-edit/git';
import { postGitHubPrComment } from '../../pr-events';
import { readManagedWorktree, syncWorktree } from '../../worktrees';
import { readWatch, type PrWatch } from '../../watches';
import type { AutopilotOwnerCapability } from './capabilities';
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
  const prepare: AutopilotOwnerCapability[] = ['workspace', 'commit'];
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
  readWorktree?: typeof readManagedWorktree;
  currentSha?: typeof gitCurrentSha;
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

  if (enabled.has('workspace')) {
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
            ? 'Push the committed change after you judge it sound and sufficiently validated. Mechanical authority and race guards are rechecked immediately before delivery.'
            : 'Push this held worktree to its linked PR head after the direct human instruction.',
        input:
          source === 'watch-event'
            ? v.object({})
            : v.object({
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
            if (!autonomousResponseAuthorityCurrent(watch, paths)) {
              return staleAutonomousResponseAuthority();
            }
            const currentWorktree = await (
              input.readWorktree ?? readManagedWorktree
            )(worktreeId, watch.repoId, paths);
            if (
              !currentWorktree.lastPushedSha ||
              (await (input.currentSha ?? gitCurrentSha)(
                currentWorktree.localPath,
              )) !== currentWorktree.lastPushedSha
            ) {
              return {
                ok: false,
                action: 'autopilot_owner_pr_respond',
                changed: false,
                message:
                  'Autopilot must push the current commit before posting an autonomous PR response.',
                requires: ['currentPushedCommit'],
              };
            }
            if (!autonomousResponseAuthorityCurrent(watch, paths)) {
              return staleAutonomousResponseAuthority();
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
