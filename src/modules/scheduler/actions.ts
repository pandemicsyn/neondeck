import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { runtimePaths } from '../../runtime-home';
import { runSchedulerTick } from './service';
import { schedulerActionOutputSchema } from './schemas';

export const schedulerTickAction = defineAction({
  name: 'neondeck_scheduler_tick',
  description:
    'Synchronize configured schedules into durable jobs and run jobs that are due.',
  input: v.object({ runtimeHome: v.optional(v.string()) }),
  output: schedulerActionOutputSchema,
  async run({ input, log }) {
    log.info('Scheduler tick requested');

    const result = await runSchedulerTick(
      input.runtimeHome ? runtimePaths(input.runtimeHome) : runtimePaths(),
    );
    const payload = {
      ok: result.ok,
      outcome: result.outcome ?? null,
      changed: result.changed,
      message: result.message,
      tasks: result.tasks?.length ?? 0,
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

export const neondeckSchedulerActions = [];
