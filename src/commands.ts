import { defineAction, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  addWorkflowSummary,
  listJobs,
  listNotifications,
  listWorkflowSummaries,
  type WorkflowSummaryRecord,
} from './app-state';
import {
  type GitHubPullRequestQueue,
  type GitHubPullRequest,
  type GitHubQueueIssue,
  fetchGitHubLogin,
  fetchPullRequestQueue,
} from './github';
import { runDevDoctor } from './dev-doctor';
import {
  readGitDiffSummary,
  readGitRepoStatus,
  readRepoRegistrySnapshot,
  repoFullName,
} from './repos';
import {
  deleteMemory,
  listMemories,
  upsertMemory,
  type MemoryScope,
} from './memory-actions';
import {
  type RuntimePaths,
  type ThinkingLevel,
  ensureRuntimeHome,
  runtimePaths,
} from './runtime-home';
import { isThinkingLevel, readAgentModelSelectionSync } from './agent-config';
import { updateAgentModels } from './config-actions';
import { createScheduleBlueprint } from './scheduler';
import { startNeonSession } from './session-actions';
import { listPrWatchRecords, addPrWatch } from './watch-actions';

export type NeonCommandName =
  | 'repo-status'
  | 'review-queue'
  | 'explain-ci'
  | 'summarize-pr'
  | 'draft-pr-description'
  | 'prepare-pr'
  | 'review-local'
  | 'briefing'
  | 'reasoning'
  | 'memory'
  | 'watch-pr'
  | 'dev-doctor'
  | 'watch-release';

export type ParsedNeonCommand = {
  name: NeonCommandName;
  args: string[];
  raw: string;
};

type NeonCommandResult = {
  ok: boolean;
  command: NeonCommandName;
  input: string;
  status: 'completed' | 'failed' | 'needs-config';
  message: string;
  data?: JsonValue;
  errors?: string[];
  requires?: string[];
  workflowSummary?: WorkflowSummaryRecord;
};

type CommandDependencies = {
  fetchPullRequestQueue?: typeof fetchPullRequestQueue;
  fetchGitHubLogin?: typeof fetchGitHubLogin;
};

type ReviewQueueAction = {
  title: string;
  reason: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  url?: string | null;
  repo?: string;
  number?: number;
};

const commandRunInputSchema = v.object({
  command: v.pipe(v.string(), v.minLength(1)),
});
const workflowSummaryRecordSchema = v.looseObject({
  id: v.string(),
  workflow: v.string(),
  runId: v.nullable(v.string()),
  status: v.string(),
  summary: v.nullable(v.unknown()),
  createdAt: v.string(),
  updatedAt: v.string(),
});
const supportedCommandSchema = v.object({
  name: v.string(),
  usage: v.string(),
  description: v.string(),
});
const commandRunOutputSchema = v.looseObject({
  ok: v.boolean(),
  command: v.string(),
  input: v.string(),
  status: v.picklist(['completed', 'failed', 'needs-config']),
  message: v.string(),
  data: v.optional(v.unknown()),
  errors: v.optional(v.array(v.string())),
  requires: v.optional(v.array(v.string())),
  workflowSummary: v.optional(workflowSummaryRecordSchema),
});
const commandActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.optional(v.string()),
  commands: v.optional(v.array(supportedCommandSchema)),
  summaries: v.optional(v.array(workflowSummaryRecordSchema)),
  errors: v.optional(v.array(v.string())),
  requires: v.optional(v.array(v.string())),
});

export const commandRunAction = defineAction({
  name: 'neondeck_command_run',
  description:
    'Run a Neon slash command such as /repo-status, /review-queue, /explain-ci, /summarize-pr, /draft-pr-description, /prepare-pr, /review-local, /briefing, /reasoning, /memory, /watch-pr, /watch-release, or /dev-doctor and persist a workflow summary.',
  input: commandRunInputSchema,
  output: commandRunOutputSchema,
  async run({ input, log, emitData }) {
    const commandId = input.command.trim() || 'unknown';
    log.info('Neon command requested', { command: input.command });
    emitData(
      'neondeck.command',
      { status: 'running', command: input.command },
      { id: commandId },
    );

    const result = await runNeonCommand(input);
    const payload = {
      status: result.status,
      ok: result.ok,
      command: result.command,
      message: result.message,
      workflowSummaryId: result.workflowSummary?.id ?? null,
    };
    emitData('neondeck.command', payload, { id: commandId });

    if (result.ok) {
      log.info('Neon command completed', payload);
    } else {
      log.warn('Neon command failed', payload);
    }

    return result;
  },
});

export const commandsListAction = defineAction({
  name: 'neondeck_commands_list',
  description: 'List supported Neon slash commands.',
  input: v.object({}),
  output: commandActionOutputSchema,
  async run() {
    return {
      ok: true,
      action: 'commands_list',
      changed: false,
      commands: supportedCommands(),
    };
  },
});

export const workflowSummariesListAction = defineAction({
  name: 'neondeck_workflow_summaries_list',
  description:
    'List recently persisted Neondeck workflow and command summaries for follow-up questions.',
  input: v.object({}),
  output: commandActionOutputSchema,
  async run() {
    return {
      ok: true,
      action: 'workflow_summaries_list',
      changed: false,
      summaries: await listWorkflowSummaries(),
    };
  },
});

export const neondeckCommandActions = [
  commandRunAction,
  commandsListAction,
  workflowSummariesListAction,
];

export function supportedCommands() {
  return [
    {
      name: 'repo-status',
      usage: '/repo-status [repo-id]',
      description: 'Inspect local git status for configured repositories.',
    },
    {
      name: 'review-queue',
      usage: '/review-queue',
      description: 'Fetch and summarize the configured GitHub PR queue.',
    },
    {
      name: 'explain-ci',
      usage: '/explain-ci [repo#number|owner/repo#number]',
      description:
        'Explain deterministic CI/check status for a PR before agent reasoning.',
    },
    {
      name: 'summarize-pr',
      usage: '/summarize-pr [repo#number|owner/repo#number]',
      description: 'Summarize PR facts from the GitHub queue.',
    },
    {
      name: 'draft-pr-description',
      usage: '/draft-pr-description [repo-id|owner/repo]',
      description:
        'Draft a PR description scaffold from local repo status and configured metadata.',
    },
    {
      name: 'prepare-pr',
      usage: '/prepare-pr [repo-id|owner/repo]',
      description:
        'Prepare a local repo for PR creation with deterministic readiness checks.',
    },
    {
      name: 'review-local',
      usage: '/review-local [repo-id|owner/repo]',
      description:
        'Review local working tree status and call out deterministic risks.',
    },
    {
      name: 'briefing',
      usage: '/briefing',
      description:
        'Summarize repos, watches, scheduled jobs, notifications, and PR queue readiness.',
    },
    {
      name: 'reasoning',
      usage: '/reasoning [off|minimal|low|medium|high|xhigh]',
      description:
        'Show or change the active Neon session reasoning level for the selected display model.',
    },
    {
      name: 'memory',
      usage:
        '/memory [scope] | /memory set <scope> <key> <json-or-text> | /memory delete <scope> <key> --confirm',
      description:
        'List or mutate durable structured memory through typed memory actions.',
    },
    {
      name: 'watch-pr',
      usage: '/watch-pr <repo#number|owner/repo#number|url>',
      description: 'Create a persistent PR watch.',
    },
    {
      name: 'dev-doctor',
      usage: '/dev-doctor',
      description:
        'Inspect local repo, package, env, port, server, and database health.',
    },
    {
      name: 'watch-release',
      usage: '/watch-release <repo-id|owner/repo>',
      description: 'Watch a configured repo until its default branch is green.',
    },
  ];
}

export function parseNeonCommand(
  input: string,
):
  | { ok: true; command: ParsedNeonCommand }
  | { ok: false; error: string; requires?: string[] } {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return {
      ok: false,
      error: 'Neon commands must start with slash.',
      requires: ['command'],
    };
  }

  const [head, ...args] = splitCommand(trimmed.slice(1));
  if (!head) {
    return {
      ok: false,
      error: 'A command name is required.',
      requires: ['command'],
    };
  }

  if (!isCommandName(head)) {
    return {
      ok: false,
      error: `Unknown Neon command "/${head}".`,
      requires: ['supportedCommand'],
    };
  }

  return {
    ok: true,
    command: {
      name: head,
      args,
      raw: trimmed,
    },
  };
}

export async function runNeonCommand(
  input: v.InferInput<typeof commandRunInputSchema>,
  paths = runtimePaths(),
  dependencies: CommandDependencies = {},
): Promise<NeonCommandResult> {
  await ensureRuntimeHome(paths);
  const parsedInput = v.safeParse(commandRunInputSchema, input);
  if (!parsedInput.success) {
    return failedCommand('repo-status', '', 'Invalid command input.', {
      errors: [v.summarize(parsedInput.issues)],
    });
  }

  const parsed = parseNeonCommand(parsedInput.output.command);
  if (!parsed.ok) {
    return failedCommand(
      'repo-status',
      parsedInput.output.command,
      parsed.error,
      {
        requires: parsed.requires,
      },
    );
  }

  const result = await executeCommand(parsed.command, paths, dependencies);
  const workflowSummary = await addWorkflowSummary(
    {
      workflow: `command:${parsed.command.name}`,
      status: result.status,
      summary: compactCommandSummary(result),
    },
    paths,
  );

  return {
    ...result,
    workflowSummary,
  };
}

async function executeCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<NeonCommandResult> {
  if (command.name === 'repo-status') {
    return repoStatusCommand(command, paths);
  }

  if (command.name === 'review-queue') {
    return reviewQueueCommand(command, paths, dependencies);
  }

  if (command.name === 'explain-ci') {
    return explainCiCommand(command, paths, dependencies);
  }

  if (command.name === 'summarize-pr') {
    return summarizePrCommand(command, paths, dependencies);
  }

  if (command.name === 'draft-pr-description') {
    return draftPrDescriptionCommand(command, paths);
  }

  if (command.name === 'prepare-pr') {
    return preparePrCommand(command, paths);
  }

  if (command.name === 'review-local') {
    return reviewLocalCommand(command, paths);
  }

  if (command.name === 'briefing') {
    return briefingCommand(command, paths, dependencies);
  }

  if (command.name === 'reasoning') {
    return reasoningCommand(command, paths);
  }

  if (command.name === 'memory') {
    return memoryCommand(command, paths);
  }

  if (command.name === 'watch-pr') {
    return watchPrCommand(command, paths);
  }

  if (command.name === 'watch-release') {
    return watchReleaseCommand(command, paths);
  }

  return devDoctorCommand(command, paths);
}

async function repoStatusCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const registry = await readRepoRegistrySnapshot(paths);
  const target = command.args[0];
  const repos = target
    ? registry.repos.filter(
        (repo) =>
          repo.id === target ||
          repoFullName(repo).toLowerCase() === target.toLowerCase(),
      )
    : registry.repos;

  if (target && repos.length === 0) {
    return failedCommand(
      command.name,
      command.raw,
      `Repository "${target}" is not configured.`,
      { requires: ['repo'] },
    );
  }

  const statuses = await Promise.all(repos.map(readGitRepoStatus));
  return completedCommand(
    command.name,
    command.raw,
    repos.length === 0
      ? 'No repositories are configured.'
      : `Checked ${statuses.length} configured repositor${
          statuses.length === 1 ? 'y' : 'ies'
        }.`,
    {
      home: registry.home,
      repos: statuses,
      attention: statuses.filter((repo) => repo.dirty || repo.error),
    },
  );
}

async function reviewQueueCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<NeonCommandResult> {
  const queue = await readReviewQueue(paths, dependencies);
  if (!queue.ok) {
    return needsConfigCommand(command.name, command.raw, queue.message, {
      requires: queue.requires,
      errors: queue.errors,
    });
  }
  const watches = await listPrWatchRecords(paths);
  const triage = triageReviewQueue(queue.queue, watches);

  return completedCommand(
    command.name,
    command.raw,
    reviewQueueMessage(triage),
    {
      fetchedAt: queue.queue.fetchedAt,
      login: queue.queue.login,
      repos: queue.queue.repos,
      count: queue.queue.items.length,
      truncated: queue.queue.truncated,
      issues: queue.queue.issues,
      items: queue.queue.items,
      triage,
      topActions: triage.topActions,
    },
  );
}

async function explainCiCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<NeonCommandResult> {
  const queue = await readReviewQueue(paths, dependencies);
  if (!queue.ok) {
    return needsConfigCommand(command.name, command.raw, queue.message, {
      requires: queue.requires,
      errors: queue.errors,
    });
  }

  const selected = selectPullRequest(queue.queue, command.args, {
    prefer: (item) =>
      item.checks?.status === 'failure' ||
      item.checkError !== undefined ||
      item.checks?.status === 'pending',
  });
  if (!selected.ok) {
    return failedCommand(command.name, command.raw, selected.message, {
      requires: selected.requires,
      data: {
        available: summarizePullRequests(queue.queue.items).slice(0, 10),
      },
    });
  }

  const pr = selected.item;
  const explanation = ciExplanation(pr);
  return completedCommand(command.name, command.raw, explanation.message, {
    pr: summarizePullRequests([pr])[0],
    checks: pr.checks,
    checkError: pr.checkError,
    explanation,
    assistantBrief:
      'Use these deterministic CI/check facts first. Separate observed facts from likely next debugging steps.',
  });
}

async function summarizePrCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<NeonCommandResult> {
  const queue = await readReviewQueue(paths, dependencies);
  if (!queue.ok) {
    return needsConfigCommand(command.name, command.raw, queue.message, {
      requires: queue.requires,
      errors: queue.errors,
    });
  }

  const selected = selectPullRequest(queue.queue, command.args);
  if (!selected.ok) {
    return failedCommand(command.name, command.raw, selected.message, {
      requires: selected.requires,
      data: {
        available: summarizePullRequests(queue.queue.items).slice(0, 10),
      },
    });
  }

  const pr = selected.item;
  const summary = {
    headline: `${pr.repo}#${pr.number}: ${pr.title}`,
    state: pr.state,
    author: pr.author,
    relations: pr.relations,
    labels: pr.labels,
    comments: pr.comments,
    ageDays: pr.ageDays,
    stale: pr.stale,
    baseRef: pr.baseRef,
    headSha: pr.headSha,
    checks: pr.checks?.status ?? 'unknown',
    url: pr.url,
  };

  return completedCommand(
    command.name,
    command.raw,
    `Summarized ${pr.repo}#${pr.number}.`,
    {
      pr: summarizePullRequests([pr])[0],
      summary,
      assistantBrief:
        'Summarize the PR from these deterministic facts. Do not invent diff contents that were not fetched.',
    },
  );
}

async function draftPrDescriptionCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const resolved = await resolveCommandRepo(command, paths);
  if (!resolved.ok) {
    return failedCommand(command.name, command.raw, resolved.message, {
      requires: resolved.requires,
      data: resolved.data,
    });
  }

  const health = await readGitRepoStatus(resolved.repo);
  const draft = {
    title: `${resolved.repo.id}: <short change summary>`,
    body: [
      '## Summary',
      '- <what changed>',
      '',
      '## Validation',
      ...validationChecklist(resolved.repo).map((item) => `- [ ] ${item}`),
      '',
      '## Risk',
      `- Working tree: ${health.dirty ? `${health.changeCount} uncommitted change${health.changeCount === 1 ? '' : 's'}` : 'clean'}`,
      `- Branch: ${health.branch ?? 'unknown'} -> ${resolved.repo.defaultBranch}`,
    ].join('\n'),
  };

  return completedCommand(
    command.name,
    command.raw,
    `Prepared a PR description scaffold for ${resolved.repo.id}.`,
    {
      repo: resolved.repo,
      health,
      draft,
      assistantBrief:
        'Use this scaffold as a draft only. Ask for diff details or run local review before making specific claims about changed behavior.',
    },
  );
}

async function preparePrCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const resolved = await resolveCommandRepo(command, paths);
  if (!resolved.ok) {
    return failedCommand(command.name, command.raw, resolved.message, {
      requires: resolved.requires,
      data: resolved.data,
    });
  }

  const health = await readGitRepoStatus(resolved.repo);
  const checks = preparePrChecks(resolved.repo, health);

  return completedCommand(
    command.name,
    command.raw,
    `Prepared PR readiness checklist for ${resolved.repo.id}.`,
    {
      repo: resolved.repo,
      health,
      checks,
      ready: checks.every((item) => item.status === 'ok'),
      assistantBrief:
        'Use these deterministic readiness checks before recommending PR creation. Do not run host commands unless a future approved action exists.',
    },
  );
}

async function reviewLocalCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const resolved = await resolveCommandRepo(command, paths);
  if (!resolved.ok) {
    return failedCommand(command.name, command.raw, resolved.message, {
      requires: resolved.requires,
      data: resolved.data,
    });
  }

  const health = await readGitRepoStatus(resolved.repo);
  const diff = await readGitDiffSummary(resolved.repo);
  const findings = localReviewFindings(resolved.repo, health, diff);

  return completedCommand(
    command.name,
    command.raw,
    findings.length > 0
      ? `Found ${findings.length} local review finding${findings.length === 1 ? '' : 's'} for ${resolved.repo.id}.`
      : `No deterministic local review findings for ${resolved.repo.id}.`,
    {
      repo: resolved.repo,
      health,
      diff,
      findings,
      assistantBrief:
        'Lead with these deterministic local findings and diff metadata. This is still not a semantic code review because file contents were not read by this command.',
    },
  );
}

async function briefingCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<NeonCommandResult> {
  const [registry, watches, jobs, notifications, queue] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    listPrWatchRecords(paths),
    listJobs(paths),
    listNotifications(paths),
    readReviewQueue(paths, dependencies),
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
    topActions,
  });
}

async function reasoningCommand(
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
    ? await startNeonSession(
        {
          label: `Reasoning ${requestedLevel}`,
          reason: `reasoning-level:${requestedLevel}`,
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
      session: session?.state ?? null,
    },
  );
}

async function memoryCommand(
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

  if (operation === 'set' || operation === 'upsert') {
    const [scope, key, ...valueParts] = rest;
    if (!isMemoryScope(scope) || !key || valueParts.length === 0) {
      return failedCommand(
        command.name,
        command.raw,
        '/memory set requires scope, key, and a JSON-safe value.',
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

  if (operation === 'delete' || operation === 'remove') {
    const [scope, key, ...flags] = rest;
    if (!isMemoryScope(scope) || !key) {
      return failedCommand(
        command.name,
        command.raw,
        '/memory delete requires scope and key.',
        {
          requires: ['scope', 'key'],
        },
      );
    }

    const result = await deleteMemory(
      {
        scope,
        key,
        confirm:
          flags.includes('--confirm') ||
          flags.includes('confirm=true') ||
          flags.includes('confirm'),
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
          '/memory [scope] | /memory set <scope> <key> <json-or-text> | /memory delete <scope> <key> --confirm',
      },
    },
  );
}

function triageReviewQueue(
  queue: GitHubPullRequestQueue,
  watches: Awaited<ReturnType<typeof listPrWatchRecords>>,
) {
  const authored = queue.items.filter((item) =>
    item.relations.includes('authored'),
  );
  const assigned = queue.items.filter((item) =>
    item.relations.includes('assigned'),
  );
  const requestedReviews = queue.items.filter((item) =>
    item.relations.includes('review-requested'),
  );
  const failedChecks = queue.items.filter(
    (item) => item.checks?.status === 'failure',
  );
  const checkErrors = queue.items.filter((item) => item.checkError);
  const stalePrs = queue.items.filter((item) => item.stale);
  const activeWatches = watches.filter((watch) =>
    ['watching', 'merged', 'attention-needed'].includes(watch.status),
  );
  const watchedPrs = queue.items.filter((item) =>
    activeWatches.some(
      (watch) =>
        watch.repoFullName === item.repo && watch.prNumber === item.number,
    ),
  );

  return {
    summary: {
      authored: authored.length,
      assigned: assigned.length,
      requestedReviews: requestedReviews.length,
      failedChecks: failedChecks.length,
      checkErrors: checkErrors.length,
      stale: stalePrs.length,
      activeWatches: activeWatches.length,
      watchedPrs: watchedPrs.length,
      truncated: queue.truncated,
      issues: queue.issues.length,
    },
    authored: summarizePullRequests(authored),
    assigned: summarizePullRequests(assigned),
    requestedReviews: summarizePullRequests(requestedReviews),
    failedChecks: summarizePullRequests(failedChecks),
    checkErrors: summarizePullRequests(checkErrors),
    stalePrs: summarizePullRequests(stalePrs),
    issues: summarizeQueueIssues(queue.issues),
    activeWatches: activeWatches.map((watch) => ({
      id: watch.id,
      repo: watch.repoFullName,
      number: watch.prNumber,
      status: watch.status,
      desiredTerminalState: watch.desiredTerminalState,
      url: watch.url,
      updatedAt: watch.updatedAt,
    })),
    topActions: rankReviewQueueActions(
      queue.items,
      activeWatches,
      failedChecks,
      checkErrors,
      requestedReviews,
      assigned,
      stalePrs,
      authored,
    ).slice(0, 3),
  };
}

function summarizePullRequests(items: GitHubPullRequest[]) {
  return items.map((item) => ({
    repo: item.repo,
    number: item.number,
    title: item.title,
    url: item.url,
    author: item.author,
    relations: item.relations,
    checks: item.checks?.status ?? 'unknown',
    checkError: item.checkError,
    stale: item.stale,
    ageDays: item.ageDays,
    updatedAt: item.updatedAt,
  }));
}

function summarizeQueueIssues(issues: GitHubQueueIssue[]) {
  return issues.map((issue) => ({
    type: issue.type,
    message: issue.message,
    query: issue.query,
    repo: issue.repo,
    number: issue.number,
  }));
}

function rankReviewQueueActions(
  items: GitHubPullRequest[],
  watches: Awaited<ReturnType<typeof listPrWatchRecords>>,
  failedChecks: GitHubPullRequest[],
  checkErrors: GitHubPullRequest[],
  requestedReviews: GitHubPullRequest[],
  assigned: GitHubPullRequest[],
  stalePrs: GitHubPullRequest[],
  authored: GitHubPullRequest[],
): ReviewQueueAction[] {
  const actions: ReviewQueueAction[] = [];
  for (const item of failedChecks) {
    actions.push(prAction(item, 'Fix failing checks', 'urgent'));
  }

  for (const item of checkErrors) {
    actions.push(prAction(item, 'Investigate unknown CI status', 'urgent'));
  }

  for (const watch of watches.filter(
    (item) => item.status === 'attention-needed',
  )) {
    actions.push({
      title: `Resolve watch ${watch.id}`,
      reason: `Watch is ${watch.status}.`,
      priority: 'urgent',
      url: watch.url,
      repo: watch.repoFullName,
      number: watch.prNumber,
    });
  }

  for (const item of requestedReviews) {
    actions.push(prAction(item, 'Review requested PR', 'high'));
  }

  for (const item of assigned) {
    actions.push(prAction(item, 'Move assigned PR forward', 'high'));
  }

  for (const item of stalePrs) {
    actions.push(prAction(item, 'Refresh stale PR', 'medium'));
  }

  for (const item of authored) {
    actions.push(prAction(item, 'Advance authored PR', 'medium'));
  }

  for (const item of items) {
    actions.push(prAction(item, 'Inspect open PR', 'low'));
  }

  return dedupeActions(actions);
}

function prAction(
  item: GitHubPullRequest,
  reason: string,
  priority: ReviewQueueAction['priority'],
): ReviewQueueAction {
  return {
    title: `${reason}: ${item.repo}#${item.number}`,
    reason:
      item.checks?.status === 'failure'
        ? `${item.checks.failed} checks failed.`
        : item.checkError
          ? `GitHub enrichment failed: ${item.checkError}`
          : reason,
    priority,
    url: item.url,
    repo: item.repo,
    number: item.number,
  };
}

function dedupeActions(actions: ReviewQueueAction[]) {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key =
      action.repo && action.number
        ? `${action.repo}#${action.number}`
        : `${action.title}:${action.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reviewQueueMessage(triage: ReturnType<typeof triageReviewQueue>) {
  const { summary } = triage;
  const partial = summary.truncated || summary.issues > 0;
  return `Triaged ${summary.authored + summary.assigned + summary.requestedReviews} user-related PR signal${summary.authored + summary.assigned + summary.requestedReviews === 1 ? '' : 's'}: ${summary.requestedReviews} review request${summary.requestedReviews === 1 ? '' : 's'}, ${summary.failedChecks} failing check set${summary.failedChecks === 1 ? '' : 's'}, ${summary.checkErrors} unknown check state${summary.checkErrors === 1 ? '' : 's'}, ${summary.stale} stale PR${summary.stale === 1 ? '' : 's'}.${partial ? ' Results are partial; inspect queue issues.' : ''}`;
}

function selectPullRequest(
  queue: GitHubPullRequestQueue,
  args: string[],
  options: { prefer?: (item: GitHubPullRequest) => boolean } = {},
):
  | { ok: true; item: GitHubPullRequest }
  | { ok: false; message: string; requires?: string[] } {
  const ref = args.join(' ').trim();
  if (ref) {
    const parsed = parsePullRequestRef(ref);
    if (!parsed) {
      return {
        ok: false,
        message:
          'Expected a PR reference like repo#123, owner/repo#123, or a GitHub pull request URL.',
        requires: ['pr'],
      };
    }

    const match = queue.items.find(
      (item) =>
        item.number === parsed.number &&
        (item.repo.toLowerCase() === parsed.repo.toLowerCase() ||
          item.repo.split('/').at(1)?.toLowerCase() ===
            parsed.repo.toLowerCase()),
    );
    if (!match) {
      return {
        ok: false,
        message: `PR ${parsed.repo}#${parsed.number} was not found in the current review queue.`,
        requires: ['queuedPr'],
      };
    }

    return { ok: true, item: match };
  }

  const preferred = options.prefer
    ? queue.items.find(options.prefer)
    : undefined;
  const item = preferred ?? queue.items[0];
  if (!item) {
    return {
      ok: false,
      message: 'No pull requests are available in the current review queue.',
      requires: ['pr'],
    };
  }

  return { ok: true, item };
}

function parsePullRequestRef(ref: string) {
  const url = ref.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
  if (url) {
    return {
      repo: `${url[1]}/${url[2].replace(/\.git$/, '')}`,
      number: Number(url[3]),
    };
  }

  const hash = ref.match(/^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)#(\d+)$/);
  if (!hash) return undefined;

  return {
    repo: hash[1],
    number: Number(hash[2]),
  };
}

function ciExplanation(pr: GitHubPullRequest) {
  if (pr.checkError) {
    return {
      status: 'unknown',
      message: `GitHub check status for ${pr.repo}#${pr.number} could not be enriched.`,
      facts: [`Enrichment error: ${pr.checkError}`],
      nextActions: [
        'Open the PR checks page in GitHub.',
        'Retry after confirming the token can read checks.',
      ],
    };
  }

  if (!pr.checks) {
    return {
      status: 'unknown',
      message: `${pr.repo}#${pr.number} has no check summary in the queue.`,
      facts: ['No check runs or commit statuses were available.'],
      nextActions: [
        'Confirm the PR head SHA and configured repository access.',
      ],
    };
  }

  const facts = [
    `${pr.checks.total} total check signal${pr.checks.total === 1 ? '' : 's'}.`,
    `${pr.checks.failed} failed, ${pr.checks.pending} pending, ${pr.checks.successful} successful.`,
    `${pr.checks.statusContexts ?? 0} legacy status context${pr.checks.statusContexts === 1 ? '' : 's'}.`,
  ];
  const nextActions =
    pr.checks.status === 'failure'
      ? [
          'Open the failing GitHub checks and inspect the first failed job log.',
          'Run the matching local validation command if the repo exposes one.',
          'After fixing, rerun failed checks or push an update.',
        ]
      : pr.checks.status === 'pending'
        ? [
            'Wait for pending checks or inspect queued jobs for capacity issues.',
          ]
        : pr.checks.status === 'success'
          ? ['No CI action is needed unless review feedback remains.']
          : ['Confirm whether this repo is expected to publish checks.'];

  return {
    status: pr.checks.status,
    message: `${pr.repo}#${pr.number} CI is ${pr.checks.status}.`,
    facts,
    nextActions,
  };
}

async function resolveCommandRepo(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<
  | {
      ok: true;
      repo: Awaited<
        ReturnType<typeof readRepoRegistrySnapshot>
      >['repos'][number];
    }
  | {
      ok: false;
      message: string;
      requires?: string[];
      data?: unknown;
    }
> {
  const registry = await readRepoRegistrySnapshot(paths);
  const target = command.args.join(' ').trim();
  if (registry.repos.length === 0) {
    return {
      ok: false,
      message: 'No repositories are configured.',
      requires: ['repo'],
    };
  }

  if (!target) {
    if (registry.repos.length === 1) {
      return { ok: true, repo: registry.repos[0] };
    }

    return {
      ok: false,
      message: 'A repository id or owner/repo is required.',
      requires: ['repo'],
      data: { repos: registry.repos.map((repo) => repo.id) },
    };
  }

  const repo = registry.repos.find(
    (item) =>
      item.id === target ||
      item.github.name === target ||
      repoFullName(item).toLowerCase() === target.toLowerCase(),
  );
  if (!repo) {
    return {
      ok: false,
      message: `Repository "${target}" is not configured.`,
      requires: ['repo'],
      data: { repos: registry.repos.map((item) => item.id) },
    };
  }

  return { ok: true, repo };
}

function validationChecklist(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
) {
  const scripts = repo.packageScripts ?? {};
  const preferred = ['format:check', 'lint', 'typecheck', 'test', 'check'];
  const available = preferred.filter((script) => scripts[script]);
  if (available.length > 0) {
    return available.map((script) => `npm run ${script}`);
  }

  return ['Run the project validation command for this repo.'];
}

function preparePrChecks(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  health: Awaited<ReturnType<typeof readGitRepoStatus>>,
) {
  return [
    {
      id: 'working-tree',
      status: health.error || health.dirty ? 'attention' : 'ok',
      message: health.error
        ? `Git status failed: ${health.error}`
        : health.dirty
          ? `${health.changeCount} local change${health.changeCount === 1 ? '' : 's'} need review before PR creation.`
          : 'Working tree is clean.',
    },
    {
      id: 'branch',
      status:
        health.branch && health.branch !== repo.defaultBranch
          ? 'ok'
          : 'attention',
      message: health.branch
        ? health.branch === repo.defaultBranch
          ? `Current branch is the default branch (${repo.defaultBranch}).`
          : `Current branch is ${health.branch}.`
        : 'Current branch is unknown.',
    },
    {
      id: 'upstream',
      status:
        health.ahead === null && health.behind === null ? 'attention' : 'ok',
      message:
        health.ahead === null && health.behind === null
          ? 'No upstream tracking branch was detected.'
          : `Ahead ${health.ahead ?? 0}, behind ${health.behind ?? 0}.`,
    },
    {
      id: 'validation',
      status: 'attention',
      message: `Run validation before opening PR: ${validationChecklist(repo).join(', ')}.`,
    },
  ];
}

function localReviewFindings(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  health: Awaited<ReturnType<typeof readGitRepoStatus>>,
  diff: Awaited<ReturnType<typeof readGitDiffSummary>>,
) {
  const findings: Array<{
    severity: 'high' | 'medium' | 'low';
    title: string;
    message: string;
  }> = [];

  if (health.error) {
    findings.push({
      severity: 'high',
      title: 'Git status unavailable',
      message: health.error,
    });
    return findings;
  }

  if (health.branch === repo.defaultBranch) {
    findings.push({
      severity: 'medium',
      title: 'Working on default branch',
      message: `Current branch is ${repo.defaultBranch}; create a topic branch before PR prep.`,
    });
  }

  if (health.behind && health.behind > 0) {
    findings.push({
      severity: 'medium',
      title: 'Branch is behind upstream',
      message: `Branch is ${health.behind} commit${health.behind === 1 ? '' : 's'} behind upstream.`,
    });
  }

  if (health.dirty) {
    findings.push({
      severity: 'low',
      title: 'Uncommitted changes present',
      message: `${health.changeCount} local change${health.changeCount === 1 ? '' : 's'} detected: ${health.changes.slice(0, 5).join(', ')}`,
    });
  }

  if (!diff.ok) {
    findings.push({
      severity: 'medium',
      title: 'Diff summary unavailable',
      message: diff.error ?? 'Could not read git diff metadata.',
    });
  }

  if (diff.fileCount > 15) {
    findings.push({
      severity: 'medium',
      title: 'Large local diff',
      message: `${diff.fileCount} files changed with ${diff.additions} additions and ${diff.deletions} deletions.`,
    });
  }

  if (diff.binaryFiles > 0) {
    findings.push({
      severity: 'low',
      title: 'Binary files changed',
      message: `${diff.binaryFiles} changed file${diff.binaryFiles === 1 ? ' is' : 's are'} binary or uncounted by git numstat.`,
    });
  }

  return findings;
}

function compactCommandSummary(result: NeonCommandResult) {
  if (
    result.command === 'review-queue' &&
    result.data &&
    typeof result.data === 'object'
  ) {
    const data = result.data as {
      fetchedAt?: unknown;
      login?: unknown;
      repos?: unknown;
      count?: unknown;
      truncated?: unknown;
      issues?: unknown;
      triage?: unknown;
      topActions?: unknown;
    };

    return {
      ok: result.ok,
      command: result.command,
      input: result.input,
      status: result.status,
      message: result.message,
      fetchedAt: data.fetchedAt,
      login: data.login,
      repos: data.repos,
      count: data.count,
      truncated: data.truncated,
      issues: data.issues,
      triage: data.triage,
      topActions: data.topActions,
    };
  }

  return result;
}

async function watchPrCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const ref = command.args.join(' ').trim();
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

  const watch = await addPrWatch({ ref }, paths);
  if (!watch.ok) {
    return failedCommand(command.name, command.raw, watch.message, {
      errors: watch.errors,
      requires: watch.requires,
      data: { watch },
    });
  }

  return completedCommand(command.name, command.raw, watch.message, {
    watch: watch.watch,
  });
}

async function watchReleaseCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const repo = command.args.join(' ').trim();
  if (!repo) {
    return failedCommand(
      command.name,
      command.raw,
      '/watch-release requires a repository id or owner/repo.',
      {
        requires: ['repo'],
      },
    );
  }

  const result = await createScheduleBlueprint(
    {
      blueprint: 'release-watch',
      repo,
    },
    paths,
  );

  if (!result.ok) {
    return failedCommand(command.name, command.raw, result.message, {
      errors: result.errors,
      requires: result.requires,
      data: { result },
    });
  }

  return completedCommand(command.name, command.raw, result.message, {
    result,
  });
}

async function devDoctorCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const doctor = await runDevDoctor(paths);

  return completedCommand(command.name, command.raw, doctor.message, doctor);
}

async function readReviewQueue(
  paths: RuntimePaths,
  dependencies: CommandDependencies,
): Promise<
  | { ok: true; queue: GitHubPullRequestQueue }
  | { ok: false; message: string; errors?: string[]; requires?: string[] }
> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false,
      message: 'GITHUB_TOKEN is not configured.',
      requires: ['GITHUB_TOKEN'],
    };
  }

  try {
    const registry = await readRepoRegistrySnapshot(paths);
    const fetchLogin = dependencies.fetchGitHubLogin ?? fetchGitHubLogin;
    const fetchQueue =
      dependencies.fetchPullRequestQueue ?? fetchPullRequestQueue;
    const login = process.env.GITHUB_LOGIN ?? (await fetchLogin(token));
    return {
      ok: true,
      queue: await fetchQueue({
        token,
        login,
        repos: registry.repos,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      message: 'Could not fetch GitHub review queue.',
      errors: [errorMessage(error)],
    };
  }
}

function completedCommand(
  command: NeonCommandName,
  input: string,
  message: string,
  data: unknown,
): NeonCommandResult {
  return {
    ok: true,
    command,
    input,
    status: 'completed',
    message,
    data: asJsonValue(data),
  };
}

function needsConfigCommand(
  command: NeonCommandName,
  input: string,
  message: string,
  details: Pick<NeonCommandResult, 'errors' | 'requires'>,
): NeonCommandResult {
  return {
    ok: false,
    command,
    input,
    status: 'needs-config',
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

function failedCommand(
  command: NeonCommandName,
  input: string,
  message: string,
  details: Pick<NeonCommandResult, 'errors' | 'requires'> & {
    data?: unknown;
  } = {},
): NeonCommandResult {
  return {
    ok: false,
    command,
    input,
    status: 'failed',
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
    ...(details.data ? { data: asJsonValue(details.data) } : {}),
  };
}

function splitCommand(input: string) {
  const parts = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) =>
    (part.startsWith('"') && part.endsWith('"')) ||
    (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part,
  );
}

function isCommandName(value: string): value is NeonCommandName {
  return [
    'repo-status',
    'review-queue',
    'explain-ci',
    'summarize-pr',
    'draft-pr-description',
    'prepare-pr',
    'review-local',
    'briefing',
    'reasoning',
    'memory',
    'watch-pr',
    'dev-doctor',
    'watch-release',
  ].includes(value);
}

const allThinkingLevels: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

function supportedReasoningLevelsForModel(model: string): ThinkingLevel[] {
  const specifier = parseModelSpecifier(model);
  if (!specifier) return ['off'];

  if (specifier.provider === 'openai') {
    return isOpenAiReasoningModel(specifier.model)
      ? allThinkingLevels
      : ['off'];
  }

  if (specifier.provider === 'anthropic') {
    return isAnthropicReasoningModel(specifier.model)
      ? allThinkingLevels
      : ['off'];
  }

  if (specifier.provider === 'kilocode') {
    return isKilocodeReasoningModel(specifier.model)
      ? allThinkingLevels
      : ['off'];
  }

  return ['off'];
}

function parseModelSpecifier(model: string) {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return null;
  return {
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
  };
}

function isOpenAiReasoningModel(model: string) {
  return /^(gpt-5|o[1-9])(?:[.-]|$)/i.test(model);
}

function isAnthropicReasoningModel(model: string) {
  return /^claude-(?:.*-4|3-7)(?:[.-]|$)/i.test(model);
}

function isKilocodeReasoningModel(model: string) {
  const nested = parseModelSpecifier(model);
  if (nested?.provider === 'openai') {
    return isOpenAiReasoningModel(nested.model);
  }
  if (nested?.provider === 'anthropic') {
    return isAnthropicReasoningModel(nested.model);
  }

  return (
    /^kilo-auto(?:\/|$)/i.test(model) ||
    isOpenAiReasoningModel(model) ||
    isAnthropicReasoningModel(model) ||
    /(?:^|\/)(deepseek-r1|qwen.*thinking|.*reasoning.*)(?:[/:.-]|$)/i.test(
      model,
    )
  );
}

function formatList(values: string[]) {
  if (values.length === 0) return 'no';
  if (values.length === 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
}

function isMemoryScope(value: string | undefined): value is MemoryScope {
  return (
    value === 'user' ||
    value === 'project' ||
    value === 'session' ||
    value === 'watch'
  );
}

function parseMemoryValue(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

function readStringArrayProperty(
  value: unknown,
  key: string,
): string[] | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) return undefined;
  const property = (value as Record<string, unknown>)[key];
  if (!Array.isArray(property)) return undefined;
  return property.filter((item): item is string => typeof item === 'string');
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
