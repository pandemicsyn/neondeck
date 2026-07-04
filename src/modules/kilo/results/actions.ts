import { defineAction, defineTool } from '@flue/runtime';
import {
  listKiloResultStates,
  promoteKiloResult,
  reviewKiloResult,
  verifyKiloResult,
} from './service';
import {
  outputSchema,
  promoteInputSchema,
  stateListInputSchema,
  taskIdInputSchema,
  verifyInputSchema,
} from './schemas';

export const kiloResultStateLookupTool = defineTool({
  name: 'neondeck_kilo_result_state_lookup',
  description:
    'Read persisted Kilo review, verification, promotion, and pending approval state without mutating tasks.',
  input: stateListInputSchema,
  output: outputSchema,
  async run({ input }) {
    return listKiloResultStates(input);
  },
});

export const reviewKiloResultAction = defineAction({
  name: 'neondeck_kilo_result_review',
  description:
    'Inspect a Kilo task workspace diff, classify risk with autopilot policy, and persist Kilo result review state.',
  input: taskIdInputSchema,
  output: outputSchema,
  async run({ input }) {
    return reviewKiloResult(input);
  },
});

export const verifyKiloResultAction = defineAction({
  name: 'neondeck_kilo_result_verify',
  description:
    'Run configured checks for a Kilo task worktree through Neondeck execution approval policy and persist verification state.',
  input: verifyInputSchema,
  output: outputSchema,
  async run({ input }) {
    return verifyKiloResult(input);
  },
});

export const promoteKiloResultAction = defineAction({
  name: 'neondeck_kilo_result_promote',
  description:
    'Decide whether a Kilo result is admissible for promotion. This records the safe decision layer and does not commit, push, or comment.',
  input: promoteInputSchema,
  output: outputSchema,
  async run({ input }) {
    return promoteKiloResult(input);
  },
});

export const neondeckKiloResultActions = [
  reviewKiloResultAction,
  verifyKiloResultAction,
  promoteKiloResultAction,
];

export const neondeckKiloResultTools = [kiloResultStateLookupTool];
