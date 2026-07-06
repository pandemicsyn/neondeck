import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { currentFlueExecutionContext } from '../flue/execution-context';
import {
  createAgentRoutine,
  deleteRoutine,
  listRoutines,
  readRoutine,
  readRoutineConfig,
  routineAgentCreateInputSchema,
  runRoutineNow,
  setRoutineEnabled,
  updateRoutine,
} from './service';

const routineIdSchema = v.pipe(v.string(), v.minLength(1));
const routineActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

const routineUpdateActionInputSchema = v.object({
  id: routineIdSchema,
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(96))),
  prompt: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(8_000))),
  scheduleKind: v.optional(v.picklist(['interval', 'once', 'cron'])),
  schedule: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(120))),
  skills: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  scopeRepoId: v.optional(v.nullable(v.string())),
  scopeCwd: v.optional(v.nullable(v.string())),
  delivery: v.optional(v.picklist(['notification', 'report', 'session'])),
  sessionId: v.optional(v.nullable(v.string())),
  repeatLimit: v.optional(
    v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  ),
});

const routineDeleteInputSchema = v.object({
  id: routineIdSchema,
  confirm: v.optional(v.boolean()),
});

const routineIdInputSchema = v.object({
  id: routineIdSchema,
});

export const routineCreateAction = defineAction({
  name: 'neondeck_routine_create',
  description:
    'Create an enabled scheduled display-assistant routine with runtime skills, schedule, scope, and delivery. The actor is derived from the current Flue session.',
  input: routineAgentCreateInputSchema,
  output: routineActionOutputSchema,
  async run({ input }) {
    const sessionId = currentAgentSessionId();
    if (!sessionId) return missingAgentContext('routine_create');
    return createAgentRoutine(input, sessionId);
  },
});

export const routineListAction = defineAction({
  name: 'neondeck_routine_list',
  description: 'List durable Neondeck routines and their schedule state.',
  input: v.object({}),
  output: routineActionOutputSchema,
  async run() {
    return listRoutines();
  },
});

export const routineReadAction = defineAction({
  name: 'neondeck_routine_read',
  description: 'Read one Neondeck routine and recent run history.',
  input: routineIdInputSchema,
  output: routineActionOutputSchema,
  async run({ input }) {
    return readRoutine(input.id);
  },
});

export const routineUpdateAction = defineAction({
  name: 'neondeck_routine_update',
  description:
    'Update routine metadata, prompt, schedule, skills, scope, or delivery without running it.',
  input: routineUpdateActionInputSchema,
  output: routineActionOutputSchema,
  async run({ input }) {
    const actor = currentAgentActor();
    if (!actor) return missingAgentContext('routine_update');
    const { id, ...updates } = input;
    return updateRoutine(id, updates, undefined, actor);
  },
});

export const routineRunAction = defineAction({
  name: 'neondeck_routine_run',
  description:
    'Run a routine now by admitting one display-assistant session turn, subject to routine kill switch and concurrency caps.',
  input: routineIdInputSchema,
  output: routineActionOutputSchema,
  async run({ input }) {
    const actor = currentAgentActor();
    if (!actor) return missingAgentContext('routine_run_now');
    return runRoutineNow(input.id, undefined, actor);
  },
});

export const routinePauseAction = defineAction({
  name: 'neondeck_routine_pause',
  description: 'Pause an enabled routine without deleting its run history.',
  input: routineIdInputSchema,
  output: routineActionOutputSchema,
  async run({ input }) {
    const actor = currentAgentActor();
    if (!actor) return missingAgentContext('routine_enabled_update');
    return setRoutineEnabled(input.id, false, undefined, actor);
  },
});

export const routineResumeAction = defineAction({
  name: 'neondeck_routine_resume',
  description: 'Resume a paused routine without running it immediately.',
  input: routineIdInputSchema,
  output: routineActionOutputSchema,
  async run({ input }) {
    const actor = currentAgentActor();
    if (!actor) return missingAgentContext('routine_enabled_update');
    return setRoutineEnabled(input.id, true, undefined, actor);
  },
});

export const routineDeleteAction = defineAction({
  name: 'neondeck_routine_delete',
  description:
    'Delete a routine and local run history after explicit confirmation, when no run is active.',
  input: routineDeleteInputSchema,
  output: routineActionOutputSchema,
  async run({ input }) {
    const actor = currentAgentActor();
    if (!actor) return missingAgentContext('routine_delete');
    if (input.confirm !== true) {
      return {
        ok: false,
        action: 'routine_delete',
        changed: false,
        message: 'Routine deletion requires confirm=true.',
        errors: ['Routine deletion requires confirm=true.'],
        requires: ['confirm'],
      };
    }
    return deleteRoutine(input.id, undefined, actor);
  },
});

export const routineConfigReadAction = defineAction({
  name: 'neondeck_routine_config_read',
  description:
    'Read resolved routine configuration and guardrail constants, including the global routines kill switch.',
  input: v.object({}),
  output: routineActionOutputSchema,
  async run() {
    return readRoutineConfig();
  },
});

export const neondeckRoutineActions = [
  routineCreateAction,
  routineListAction,
  routineReadAction,
  routineUpdateAction,
  routineRunAction,
  routinePauseAction,
  routineResumeAction,
  routineDeleteAction,
  routineConfigReadAction,
];

function currentAgentSessionId() {
  const sessionId = currentFlueExecutionContext()?.instanceId?.trim();
  return sessionId || null;
}

function currentAgentActor() {
  const sessionId = currentAgentSessionId();
  return sessionId ? `agent:${sessionId}` : null;
}

function missingAgentContext(action: string) {
  const message = 'Routine mutation actions require a Flue agent session.';
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    requires: ['agentSessionId'],
  };
}
