import { defineAction, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  addWorkflowSummary,
  listJobs,
  listNotifications,
  type WorkflowSummaryRecord,
} from './app-state';
import {
  type GitHubPullRequestQueue,
  fetchGitHubLogin,
  fetchPullRequestQueue,
} from './github';
import { runDevDoctor } from './dev-doctor';
import {
  readGitRepoStatus,
  readRepoRegistrySnapshot,
  repoFullName,
} from './repos';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from './runtime-home';
import { createScheduleBlueprint } from './scheduler';
import { listPrWatchRecords, addPrWatch } from './watch-actions';

export type NeonCommandName =
  | 'repo-status'
  | 'review-queue'
  | 'briefing'
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

const commandRunInputSchema = v.object({
  command: v.pipe(v.string(), v.minLength(1)),
});

export const commandRunAction = defineAction({
  name: 'neondeck_command_run',
  description:
    'Run a Neon slash command such as /repo-status, /review-queue, /briefing, /watch-pr, /watch-release, or /dev-doctor and persist a workflow summary.',
  input: commandRunInputSchema,
  async run({ input }) {
    return runNeonCommand(input);
  },
});

export const commandsListAction = defineAction({
  name: 'neondeck_commands_list',
  description: 'List supported Neon slash commands.',
  input: v.object({}),
  async run() {
    return {
      ok: true,
      action: 'commands_list',
      changed: false,
      commands: supportedCommands(),
    };
  },
});

export const neondeckCommandActions = [commandRunAction, commandsListAction];

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
      name: 'briefing',
      usage: '/briefing',
      description:
        'Summarize repos, watches, scheduled jobs, notifications, and PR queue readiness.',
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
      summary: result,
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

  if (command.name === 'briefing') {
    return briefingCommand(command, paths, dependencies);
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

  return completedCommand(
    command.name,
    command.raw,
    `Fetched ${queue.queue.items.length} pull requests for review triage.`,
    {
      fetchedAt: queue.queue.fetchedAt,
      login: queue.queue.login,
      repos: queue.queue.repos,
      count: queue.queue.items.length,
      items: queue.queue.items,
      topActions: queue.queue.items.slice(0, 3).map((item) => ({
        title: `Review ${item.repo}#${item.number}`,
        url: item.url,
        updatedAt: item.updatedAt,
      })),
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
    ...(queue.ok
      ? queue.queue.items.slice(0, 3).map((item) => ({
          title: `Review ${item.repo}#${item.number}`,
          url: item.url,
        }))
      : []),
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
    'briefing',
    'watch-pr',
    'dev-doctor',
    'watch-release',
  ].includes(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
