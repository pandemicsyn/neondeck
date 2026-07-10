import { listJobs, listNotifications } from '../../app-state';
import { readAgentModelSelectionSync, isThinkingLevel } from '../../runtime';
import { updateAgentModels } from '../../config';
import { runDevDoctor } from '../../runtime';
import { archiveMemory, listMemories, upsertMemory } from '../../memory';
import { readRepoRegistrySnapshot } from '../../repos';
import {
  readChatSession,
  readNeonSessionState,
  createChatSession,
  type ChatSessionRecord,
} from '../../sessions';
import { addPrWatch, listPrWatchRecords } from '../../watches';
import { readHygieneSummary } from '../../hygiene';
import type { RuntimePaths } from '../../../runtime-home';
import type {
  CommandExecutionContext,
  NeonCommandResult,
  ParsedNeonCommand,
  CommandDependencies,
} from '../schemas';
import { readReviewQueue, triageReviewQueue } from './queue';
import { completedCommand, failedCommand } from '../summaries';
import {
  formatList,
  isActiveMemoryScope,
  isMemoryScope,
  parseMemoryValue,
  readStringArrayProperty,
  supportedReasoningLevelsForModel,
} from '../utils';

export async function briefingCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<NeonCommandResult> {
  const [registry, watches, jobs, notifications, queue, hygiene] =
    await Promise.all([
      readRepoRegistrySnapshot(paths),
      listPrWatchRecords(paths),
      listJobs(paths),
      listNotifications(paths),
      readReviewQueue(paths, dependencies),
      readHygieneSummary(paths),
    ]);
  const unreadNotifications = notifications.filter(
    (notification) => !notification.readAt,
  );
  const activeJobs = jobs.filter((job) => job.enabled);
  const activeWatches = watches.filter((watch) =>
    ['watching', 'merged', 'attention-needed'].includes(watch.status),
  );
  const topActions = [
    ...(queue.ok ? triageReviewQueue(queue.queue, watches).topActions : []),
    ...activeWatches.slice(0, 3).map((watch) => ({
      title: `Check watch ${watch.id}`,
      status: watch.status,
      url: watch.url,
    })),
    ...unreadNotifications.slice(0, 3).map((notification) => ({
      title: notification.title,
      level: notification.level,
    })),
    ...(hygiene.worktreeCleanupCandidates > 0
      ? [
          {
            title: 'Review worktree cleanup candidates',
            count: hygiene.worktreeCleanupCandidates,
          },
        ]
      : []),
    ...(hygiene.stalledPreparedDiffs > 0
      ? [
          {
            title: 'Review stalled prepared diffs',
            count: hygiene.stalledPreparedDiffs,
          },
        ]
      : []),
  ].slice(0, 3);

  return completedCommand(command.name, command.raw, 'Prepared briefing.', {
    repos: {
      count: registry.count,
      configured: registry.repos.map((repo) => repo.id),
    },
    reviewQueue: queue.ok
      ? {
          count: queue.queue.items.length,
          fetchedAt: queue.queue.fetchedAt,
          truncated: queue.queue.truncated,
          issues: queue.queue.issues.length,
        }
      : {
          count: null,
          error: queue.message,
          requires: queue.requires,
        },
    watches: {
      total: watches.length,
      active: activeWatches.length,
      attention: watches.filter((watch) => watch.status === 'attention-needed')
        .length,
    },
    jobs: {
      total: jobs.length,
      active: activeJobs.length,
    },
    notifications: {
      unread: unreadNotifications.length,
    },
    hygiene,
    topActions,
  });
}

export async function reasoningCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const models = readAgentModelSelectionSync(paths);
  const supportedLevels = supportedReasoningLevelsForModel(
    models.displayAssistant,
  );
  const requestedLevel = command.args[0]?.toLowerCase();

  if (!requestedLevel) {
    return completedCommand(
      command.name,
      command.raw,
      `Current reasoning is ${models.displayAssistantThinkingLevel} for ${models.displayAssistant}.`,
      {
        model: models.displayAssistant,
        thinkingLevel: models.displayAssistantThinkingLevel,
        supportedLevels,
        usage: '/reasoning [off|minimal|low|medium|high|xhigh]',
      },
    );
  }

  if (!isThinkingLevel(requestedLevel)) {
    return failedCommand(
      command.name,
      command.raw,
      `Unknown reasoning level "${requestedLevel}".`,
      {
        requires: ['reasoningLevel'],
        data: {
          model: models.displayAssistant,
          currentLevel: models.displayAssistantThinkingLevel,
          supportedLevels,
        },
      },
    );
  }

  if (!supportedLevels.includes(requestedLevel)) {
    return failedCommand(
      command.name,
      command.raw,
      `${models.displayAssistant} supports ${formatList(supportedLevels)} reasoning, not "${requestedLevel}".`,
      {
        requires: ['reasoningLevel'],
        data: {
          model: models.displayAssistant,
          currentLevel: models.displayAssistantThinkingLevel,
          requestedLevel,
          supportedLevels,
        },
      },
    );
  }

  const update = await updateAgentModels(
    { displayAssistantThinkingLevel: requestedLevel },
    paths,
  );
  if (!update.ok) {
    return failedCommand(command.name, command.raw, update.message, {
      errors: update.errors,
      requires: update.requires,
    });
  }

  const session = update.changed
    ? await createChatSession(
        {
          title: `Reasoning ${requestedLevel}`,
          reason: `reasoning-level:${requestedLevel}`,
          surface: 'dashboard',
          activate: true,
        },
        paths,
      )
    : undefined;
  const nextModels = readAgentModelSelectionSync(paths);

  return completedCommand(
    command.name,
    command.raw,
    update.changed
      ? `Set reasoning to ${requestedLevel} for ${models.displayAssistant} and started a fresh Neon session.`
      : `Reasoning is already ${requestedLevel} for ${models.displayAssistant}.`,
    {
      model: models.displayAssistant,
      previousLevel: models.displayAssistantThinkingLevel,
      thinkingLevel: nextModels.displayAssistantThinkingLevel,
      supportedLevels,
      sessionStarted: Boolean(session?.ok),
      session: session && 'state' in session ? session.state : null,
    },
  );
}

export async function memoryCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const [operation, ...rest] = command.args;

  if (!operation || isMemoryScope(operation)) {
    const result = await listMemories(
      {
        scope: isMemoryScope(operation) ? operation : undefined,
      },
      paths,
    );
    return completedCommand(
      command.name,
      command.raw,
      result.memories.length === 0
        ? 'No durable memory entries matched.'
        : `Listed ${result.memories.length} durable memory entr${result.memories.length === 1 ? 'y' : 'ies'}.`,
      result,
    );
  }

  if (operation === 'learn') {
    const [scope, key, ...valueParts] = rest;
    if (!isActiveMemoryScope(scope) || !key || valueParts.length === 0) {
      return failedCommand(
        command.name,
        command.raw,
        '/memory learn requires user, local, or project scope, key, and a JSON-safe value.',
        {
          requires: ['scope', 'key', 'value'],
        },
      );
    }

    const result = await upsertMemory(
      {
        scope,
        key,
        value: parseMemoryValue(valueParts.join(' ')),
      },
      paths,
    );
    if (!result.ok) {
      return failedCommand(command.name, command.raw, result.message, {
        requires: readStringArrayProperty(result, 'requires'),
        errors: readStringArrayProperty(result, 'errors'),
        data: result,
      });
    }

    return completedCommand(command.name, command.raw, result.message, result);
  }

  if (operation === 'archive') {
    const [scope, key] = rest;
    if (!isMemoryScope(scope) || !key) {
      return failedCommand(
        command.name,
        command.raw,
        '/memory archive requires scope and key.',
        {
          requires: ['scope', 'key'],
        },
      );
    }

    const result = await archiveMemory(
      {
        scope,
        key,
      },
      paths,
    );
    if (!result.ok) {
      return failedCommand(command.name, command.raw, result.message, {
        requires: readStringArrayProperty(result, 'requires'),
        data: result,
      });
    }

    return completedCommand(command.name, command.raw, result.message, result);
  }

  return failedCommand(
    command.name,
    command.raw,
    `Unknown /memory operation "${operation}".`,
    {
      requires: ['memoryOperation'],
      data: {
        usage:
          '/memory [scope] | /memory learn <user|local|project> <key> <json-or-text> | /memory archive <scope> <key>',
      },
    },
  );
}

export async function watchPrCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies = {},
  context: CommandExecutionContext = {},
): Promise<NeonCommandResult> {
  const explicitRef = command.args.join(' ').trim();
  const inferredRef = explicitRef
    ? null
    : await inferWatchPrReferenceFromContext(paths, context);
  const ref = explicitRef || inferredRef;
  if (!ref) {
    return failedCommand(
      command.name,
      command.raw,
      '/watch-pr requires a PR reference.',
      {
        requires: ['ref'],
      },
    );
  }

  const watch = await (dependencies.addPrWatch ?? addPrWatch)({ ref }, paths);
  if (!watch.ok) {
    return failedCommand(command.name, command.raw, watch.message, {
      errors: watch.errors,
      requires: watch.requires,
      data: { watch },
    });
  }

  return completedCommand(command.name, command.raw, watch.message, {
    watch: watch.watch,
    ...(inferredRef ? { inferredRef } : {}),
  });
}

async function inferWatchPrReferenceFromContext(
  paths: RuntimePaths,
  context: CommandExecutionContext,
) {
  const session = await readWatchPrContextSession(paths, context);
  return session ? inferWatchPrReferenceFromSession(session) : null;
}

async function readWatchPrContextSession(
  paths: RuntimePaths,
  context: CommandExecutionContext,
) {
  if (context.sessionId) {
    const result = await readChatSession(
      {
        id: context.sessionId,
        reason: 'watch-pr-command-context',
      },
      paths,
    );
    return result.ok && 'session' in result ? result.session : undefined;
  }

  if (context.surface) {
    const state = await readNeonSessionState(paths, context.surface);
    return state.activeChatSession;
  }

  return undefined;
}

export function inferWatchPrReferenceFromSession(
  session: Pick<
    ChatSessionRecord,
    'linkedTaskId' | 'uiMetadata' | 'title' | 'summary'
  >,
) {
  const linkedTaskMatch = session.linkedTaskId
    ?.trim()
    .match(/^github-pr:([^#\s]+\/[^#\s]+#\d+)$/);
  if (linkedTaskMatch) return linkedTaskMatch[1];

  if (isRecord(session.uiMetadata)) {
    const repo =
      readMetadataString(session.uiMetadata.repo) ??
      readMetadataString(session.uiMetadata.repoFullName);
    const prNumber = readMetadataPrNumber(session.uiMetadata.prNumber);
    if (repo && prNumber) return `${repo}#${prNumber}`;

    const url = readMetadataString(session.uiMetadata.url);
    if (
      url &&
      /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/i.test(url)
    ) {
      return url;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readMetadataString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readMetadataPrNumber(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

export async function devDoctorCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const doctor = await runDevDoctor(paths);

  return completedCommand(command.name, command.raw, doctor.message, doctor);
}
