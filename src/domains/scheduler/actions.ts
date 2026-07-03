import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { createScheduleBlueprint, listSchedulerJobs, runSchedulerTick } from './service';
import { createBlueprintInputSchema, schedulerActionOutputSchema } from './schemas';

export const scheduleBlueprintCreateAction = defineAction({
  name: 'neondeck_schedule_blueprint_create',
  description:
    'Create a blueprint-backed automation for morning briefing, watch PR, release watch, or review queue digest.',
  input: createBlueprintInputSchema,
  output: schedulerActionOutputSchema,
  async run({ input }) {
    return createScheduleBlueprint(input);
  },
});

export const schedulerTickAction = defineAction({
  name: 'neondeck_scheduler_tick',
  description:
    'Synchronize configured schedules into durable jobs and run jobs that are due.',
  input: v.object({}),
  output: schedulerActionOutputSchema,
  async run({ log }) {
    log.info('Scheduler tick requested');

    const result = await runSchedulerTick();
    const payload = {
      ok: result.ok,
      outcome: result.outcome ?? null,
      changed: result.changed,
      message: result.message,
      jobs: result.jobs?.length ?? 0,
      notifications: result.notifications?.length ?? 0,
    };
    if (result.ok) {
      log.info('Scheduler tick completed', payload);
    } else {
      log.warn('Scheduler tick failed', payload);
    }

    return result;
  },
});

export const schedulerListJobsAction = defineAction({
  name: 'neondeck_scheduler_list_jobs',
  description: 'List durable Neondeck scheduler jobs and last run state.',
  input: v.object({}),
  output: schedulerActionOutputSchema,
  async run() {
    return listSchedulerJobs();
  },
});

export const neondeckSchedulerActions = [
  scheduleBlueprintCreateAction,
  schedulerTickAction,
  schedulerListJobsAction,
];
