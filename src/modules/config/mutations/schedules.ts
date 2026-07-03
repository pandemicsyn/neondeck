import * as v from 'valibot';
import { parseActionInput, failResult, okResult } from '../result';
import { recordConfigChange } from '../history';
import { writeJson } from '../files';
import {
  type ScheduleEntry,
  ensureRuntimeHome,
  parseScheduleConfig,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import {
  nonEmptyStringSchema,
  scheduleInputSchema,
  updateScheduleInputSchema,
  type ConfigActionResult,
} from '../schemas';

export async function addSchedule(
  rawInput: v.InferInput<typeof scheduleInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    scheduleInputSchema,
    rawInput,
    'config_add_schedule',
    paths,
    [paths.schedules],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  const config = await readRuntimeJson(paths.schedules, parseScheduleConfig);

  if (config.schedules.some((schedule) => schedule.id === input.id)) {
    return failResult('config_add_schedule', paths, [paths.schedules], {
      message: `Schedule "${input.id}" already exists.`,
    });
  }

  const schedule: ScheduleEntry = {
    id: input.id,
    type: input.type,
    enabled: input.enabled ?? true,
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.cron ? { cron: input.cron } : {}),
    ...(input.preset ? { preset: input.preset } : {}),
    ...(input.config ? { config: input.config } : {}),
  };
  const next = parseScheduleConfig(
    { ...config, schedules: [...config.schedules, schedule] },
    paths.schedules,
  );

  await writeJson(paths.schedules, next);
  recordConfigChange(paths, {
    action: 'config_add_schedule',
    file: paths.schedules,
    target: input.id,
    before: config,
    after: next,
  });

  return okResult('config_add_schedule', true, paths, [paths.schedules], {
    message: `Added schedule "${input.id}".`,
    data: { schedule },
  });
}

export async function updateSchedule(
  rawInput: v.InferInput<typeof updateScheduleInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateScheduleInputSchema,
    rawInput,
    'config_update_schedule',
    paths,
    [paths.schedules],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  const config = await readRuntimeJson(paths.schedules, parseScheduleConfig);
  const index = config.schedules.findIndex(
    (schedule) => schedule.id === input.id,
  );

  if (index === -1) {
    return failResult('config_update_schedule', paths, [paths.schedules], {
      message: `Schedule "${input.id}" does not exist.`,
    });
  }

  const schedule: ScheduleEntry = {
    ...config.schedules[index],
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.cron !== undefined ? { cron: input.cron } : {}),
    ...(input.preset !== undefined ? { preset: input.preset } : {}),
    ...(input.config !== undefined ? { config: input.config } : {}),
  };
  const schedules = config.schedules.with(index, schedule);
  const next = parseScheduleConfig({ ...config, schedules }, paths.schedules);

  await writeJson(paths.schedules, next);
  recordConfigChange(paths, {
    action: 'config_update_schedule',
    file: paths.schedules,
    target: input.id,
    before: config,
    after: next,
  });

  return okResult('config_update_schedule', true, paths, [paths.schedules], {
    message: `Updated schedule "${input.id}".`,
    data: { schedule },
  });
}

export async function removeSchedule(
  rawInput: { id: string; confirm?: boolean },
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    v.object({
      id: nonEmptyStringSchema,
      confirm: v.optional(v.boolean()),
    }),
    rawInput,
    'config_remove_schedule',
    paths,
    [paths.schedules],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (input.confirm !== true) {
    return failResult('config_remove_schedule', paths, [paths.schedules], {
      message: `Removing schedule "${input.id}" requires confirmation.`,
      requires: ['confirm'],
    });
  }

  const config = await readRuntimeJson(paths.schedules, parseScheduleConfig);
  const schedules = config.schedules.filter(
    (schedule) => schedule.id !== input.id,
  );

  if (schedules.length === config.schedules.length) {
    return failResult('config_remove_schedule', paths, [paths.schedules], {
      message: `Schedule "${input.id}" does not exist.`,
    });
  }

  const next = parseScheduleConfig({ ...config, schedules }, paths.schedules);
  await writeJson(paths.schedules, next);
  recordConfigChange(paths, {
    action: 'config_remove_schedule',
    file: paths.schedules,
    target: input.id,
    before: config,
    after: next,
  });

  return okResult('config_remove_schedule', true, paths, [paths.schedules], {
    message: `Removed schedule "${input.id}".`,
  });
}
