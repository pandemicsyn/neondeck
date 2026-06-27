import { defineAction, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  addNotification,
  addWorkflowSummary,
  disableStaleScheduleJobs,
  listJobs,
  type JobRecord,
  type NotificationLevel,
  updateJobRun,
  upsertJob,
} from './app-state';
import { addSchedule } from './config-actions';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  parseScheduleConfig,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';
import {
  addPrWatch,
  listPrWatchRecords,
  refreshPrWatch,
  type WatchActionResult,
} from './watch-actions';

type SchedulerResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  outcome?: string;
  jobs?: JsonValue[];
  notifications?: JsonValue[];
  extra?: JsonValue;
  errors?: string[];
  requires?: string[];
};

type BlueprintKind =
  'morning-briefing' | 'watch-pr' | 'release-watch' | 'review-queue-digest';

type JobExecutionResult = {
  outcome: 'silent' | 'updated' | 'recorded' | 'failed';
  message: string;
  result?: unknown;
  notifications?: Array<{
    level: NotificationLevel;
    title: string;
    message: string;
    source?: string;
    sourceId?: string;
    data?: unknown;
  }>;
};

type SchedulerDependencies = {
  addPrWatch?: (
    input: Parameters<typeof addPrWatch>[0],
    paths: RuntimePaths,
  ) => Promise<WatchActionResult>;
  refreshPrWatch?: (
    input: Parameters<typeof refreshPrWatch>[0],
    paths: RuntimePaths,
  ) => Promise<WatchActionResult>;
};

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const blueprintSchema = v.picklist([
  'morning-briefing',
  'watch-pr',
  'release-watch',
  'review-queue-digest',
]);
const createBlueprintInputSchema = v.object({
  blueprint: blueprintSchema,
  id: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  repo: v.optional(nonEmptyStringSchema),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
  config: v.optional(v.record(v.string(), v.unknown())),
});

export const scheduleBlueprintCreateAction = defineAction({
  name: 'neondeck_schedule_blueprint_create',
  description:
    'Create a blueprint-backed automation for morning briefing, watch PR, release watch, or review queue digest.',
  input: createBlueprintInputSchema,
  async run({ input }) {
    return createScheduleBlueprint(input);
  },
});

export const schedulerTickAction = defineAction({
  name: 'neondeck_scheduler_tick',
  description:
    'Synchronize configured schedules into durable jobs and run jobs that are due.',
  input: v.object({}),
  async run() {
    return runSchedulerTick();
  },
});

export const schedulerListJobsAction = defineAction({
  name: 'neondeck_scheduler_list_jobs',
  description: 'List durable Neondeck scheduler jobs and last run state.',
  input: v.object({}),
  async run() {
    return listSchedulerJobs();
  },
});

export const neondeckSchedulerActions = [
  scheduleBlueprintCreateAction,
  schedulerTickAction,
  schedulerListJobsAction,
];

export async function createScheduleBlueprint(
  rawInput: v.InferInput<typeof createBlueprintInputSchema>,
  paths = runtimePaths(),
  dependencies: SchedulerDependencies = {},
): Promise<SchedulerResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    createBlueprintInputSchema,
    rawInput,
    'schedule_blueprint_create',
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (input.blueprint === 'watch-pr' && !input.ref) {
    return failResult(
      'schedule_blueprint_create',
      'The watch-pr blueprint requires a PR reference.',
      { requires: ['ref'] },
    );
  }

  if (input.blueprint === 'release-watch' && !input.repo) {
    return failResult(
      'schedule_blueprint_create',
      'The release-watch blueprint requires a repo.',
      { requires: ['repo'] },
    );
  }

  const id =
    input.id ?? defaultBlueprintId(input.blueprint, input.ref ?? input.repo);
  const config = {
    ...input.config,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.repo ? { repo: input.repo } : {}),
    intervalSeconds:
      input.intervalSeconds ?? defaultIntervalSeconds(input.blueprint),
  };

  if (input.blueprint === 'watch-pr' && input.ref) {
    const addWatch = dependencies.addPrWatch ?? addPrWatch;
    const watchResult = await addWatch(
      {
        ref: input.ref,
        desiredTerminalState: 'checks',
        intervalSeconds:
          input.intervalSeconds ?? defaultIntervalSeconds(input.blueprint),
      },
      paths,
    );
    if (!watchResult.ok) {
      return failResult('schedule_blueprint_create', watchResult.message, {
        errors: watchResult.errors,
        requires: watchResult.requires,
      });
    }

    return okResult(
      'schedule_blueprint_create',
      true,
      'created',
      `Created watch-pr automation "${id}".`,
      {
        jobs: await listJobs(paths),
        extra: { watch: watchResult },
      },
    );
  }

  const scheduleResult = await addSchedule(
    {
      id,
      type: input.blueprint,
      enabled: true,
      preset: input.blueprint,
      config,
    },
    paths,
  );

  if (!scheduleResult.ok) {
    return failResult('schedule_blueprint_create', scheduleResult.message, {
      errors: scheduleResult.errors,
      requires: scheduleResult.requires,
    });
  }

  await syncScheduledJobs(paths);

  return okResult(
    'schedule_blueprint_create',
    true,
    'created',
    `Created ${input.blueprint} schedule "${id}".`,
    {
      jobs: await listJobs(paths),
      extra: { schedule: scheduleResult.data },
    },
  );
}

export async function listSchedulerJobs(paths = runtimePaths()) {
  return okResult(
    'scheduler_list_jobs',
    false,
    undefined,
    'Listed scheduler jobs.',
    { jobs: await listJobs(paths) },
  );
}

export async function syncScheduledJobs(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const scheduleConfig = await readRuntimeJson(
    paths.schedules,
    parseScheduleConfig,
  );
  const jobs: JobRecord[] = [];

  for (const schedule of scheduleConfig.schedules) {
    jobs.push(
      await upsertJob(
        {
          id: `schedule:${schedule.id}`,
          type: schedule.type,
          blueprint: schedule.preset ?? schedule.type,
          enabled: schedule.enabled ?? true,
          intervalSeconds: readIntervalSeconds(
            schedule.config,
            schedule.type as BlueprintKind,
          ),
          config: {
            ...schedule.config,
            scheduleId: schedule.id,
          },
        },
        paths,
      ),
    );
  }

  await disableStaleScheduleJobs(
    jobs.map((job) => job.id),
    paths,
  );

  return jobs;
}

export async function runSchedulerTick(
  paths = runtimePaths(),
  now = new Date(),
  dependencies: SchedulerDependencies = {},
): Promise<SchedulerResult> {
  await ensureRuntimeHome(paths);
  await syncScheduledJobs(paths);
  const jobs = (await listJobs(paths)).filter(
    (job) =>
      job.enabled &&
      (!job.nextRunAt || Date.parse(job.nextRunAt) <= now.getTime()),
  );
  const notifications = [];

  for (const job of jobs) {
    const result = await executeJob(job, paths, dependencies);
    const nextRunAt = new Date(
      now.getTime() + job.intervalSeconds * 1000,
    ).toISOString();

    await updateJobRun(
      job.id,
      {
        outcome: result.outcome,
        message: result.message,
        result: result.result,
        nextRunAt,
      },
      paths,
    );

    for (const notification of result.notifications ?? []) {
      notifications.push(await addNotification(notification, paths));
    }
  }

  const changed = notifications.length > 0;
  return okResult(
    'scheduler_tick',
    changed,
    changed ? 'updated' : 'silent',
    jobs.length === 0
      ? 'No scheduled jobs were due.'
      : `Ran ${jobs.length} scheduled job${jobs.length === 1 ? '' : 's'}.`,
    {
      jobs: await listJobs(paths),
      notifications,
    },
  );
}

export function startSchedulerLoop(
  paths = runtimePaths(),
  intervalMs = 60_000,
) {
  const timer = setInterval(() => {
    void runSchedulerTick(paths).catch((error) => {
      console.error('[neondeck] scheduler tick failed', error);
    });
  }, intervalMs);

  timer.unref?.();
  return timer;
}

async function executeJob(
  job: JobRecord,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
): Promise<JobExecutionResult> {
  if (job.type === 'watch-pr') {
    return refreshWatchJob(job, paths, dependencies.refreshPrWatch);
  }

  if (job.type === 'morning-briefing') {
    await addWorkflowSummary(
      {
        workflow: 'morning-briefing',
        status: 'queued',
        summary: {
          activeWatches: (await listPrWatchRecords(paths)).length,
          note: 'Briefing workflow placeholder recorded by scheduler.',
        },
      },
      paths,
    );
    return {
      outcome: 'recorded',
      message: 'Recorded morning briefing job.',
      notifications: [
        {
          level: 'info',
          title: 'Morning briefing queued',
          message: 'A morning briefing job was recorded for Neon.',
          source: 'scheduler',
          sourceId: job.id,
        },
      ],
    };
  }

  if (job.type === 'review-queue-digest') {
    return {
      outcome: 'recorded',
      message: 'Recorded review queue digest job.',
      notifications: [
        {
          level: 'info',
          title: 'Review queue digest due',
          message: 'A review queue digest job is due.',
          source: 'scheduler',
          sourceId: job.id,
        },
      ],
    };
  }

  if (job.type === 'release-watch') {
    return {
      outcome: 'recorded',
      message: 'Recorded release watch job.',
      notifications: [
        {
          level: 'info',
          title: 'Release watch due',
          message: 'A release watch job is due for configured deploy status.',
          source: 'scheduler',
          sourceId: job.id,
          data: job.config,
        },
      ],
    };
  }

  return {
    outcome: 'silent',
    message: `No executor is registered for job type "${job.type}".`,
  };
}

async function refreshWatchJob(
  job: JobRecord,
  paths: RuntimePaths,
  refreshWatch: SchedulerDependencies['refreshPrWatch'] = refreshPrWatch,
): Promise<JobExecutionResult> {
  const config = readObjectConfig(job.config);
  const target =
    typeof config.id === 'string'
      ? { id: config.id }
      : typeof config.ref === 'string'
        ? { ref: config.ref }
        : undefined;

  const results = [];
  if (target) {
    results.push(await refreshWatch(target, paths));
  } else {
    const watches = await listPrWatchRecords(paths);
    for (const watch of watches) {
      results.push(await refreshWatch({ id: watch.id }, paths));
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    return {
      outcome: 'failed',
      message: `Failed to refresh ${failures.length} PR watch${failures.length === 1 ? '' : 'es'}.`,
      result: { results },
      notifications: failures.map((result) => ({
        level: 'attention',
        title: 'PR watch refresh failed',
        message: result.message,
        source: 'watch-pr',
        data: result,
      })),
    };
  }

  const changed = results.filter((result) => result.changed);
  const notifications = changed.map((result) => {
    const watch = result.watch as { id?: string; status?: string } | undefined;
    const level: NotificationLevel =
      watch?.status === 'closed' || watch?.status === 'attention-needed'
        ? 'attention'
        : watch?.status === 'merged' || watch?.status === 'green'
          ? 'ready'
          : 'info';
    const title =
      watch?.status === 'green'
        ? 'PR watch green'
        : watch?.status === 'attention-needed'
          ? 'PR watch needs attention'
          : watch?.status === 'merged'
            ? 'PR watch merged'
            : watch?.status === 'closed'
              ? 'PR watch closed'
              : 'PR watch changed';

    return {
      level,
      title,
      message: result.message,
      source: 'watch-pr',
      sourceId: watch?.id,
      data: result.watch,
    };
  });

  return {
    outcome: changed.length > 0 ? 'updated' : 'silent',
    message:
      changed.length > 0
        ? `Updated ${changed.length} PR watch${changed.length === 1 ? '' : 'es'}.`
        : 'PR watch refresh had no changes.',
    result: { results },
    notifications,
  };
}

function readIntervalSeconds(config: unknown, type: BlueprintKind | string) {
  const record = readObjectConfig(config);
  const value = record.intervalSeconds;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 60) {
    return value;
  }

  return defaultIntervalSeconds(type);
}

function defaultIntervalSeconds(type: BlueprintKind | string) {
  if (type === 'watch-pr') return 300;
  if (type === 'release-watch') return 900;
  if (type === 'review-queue-digest') return 3_600;
  return 86_400;
}

function defaultBlueprintId(blueprint: BlueprintKind, target?: string) {
  const suffix = target
    ? target
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    : 'default';
  return `${blueprint}-${suffix}`;
}

function readObjectConfig(config: unknown) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return config as Record<string, unknown>;
}

function parseActionInput<T>(
  schema: v.GenericSchema<unknown, T>,
  input: unknown,
  action: string,
) {
  const result = v.safeParse(schema, input);
  if (result.success) return { ok: true as const, input: result.output };

  return {
    ok: false as const,
    result: failResult(action, 'Invalid action input.', {
      errors: [v.summarize(result.issues)],
    }),
  };
}

function okResult(
  action: string,
  changed: boolean,
  outcome: string | undefined,
  message: string,
  data: {
    jobs?: JobRecord[];
    notifications?: unknown[];
    extra?: unknown;
  } = {},
): SchedulerResult {
  return {
    ok: true,
    action,
    changed,
    ...(outcome ? { outcome } : {}),
    message,
    ...(data.jobs ? { jobs: data.jobs.map(asJsonValue) } : {}),
    ...(data.notifications
      ? { notifications: data.notifications.map(asJsonValue) }
      : {}),
    ...(data.extra ? { extra: asJsonValue(data.extra) } : {}),
  } as SchedulerResult;
}

function failResult(
  action: string,
  message: string,
  details: Pick<SchedulerResult, 'errors' | 'requires'> = {},
): SchedulerResult {
  return {
    ok: false,
    action,
    changed: false,
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
