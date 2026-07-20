import { defineAction } from '@flue/runtime';
import {
  ciFixRunInputSchema,
  ciFixRunOutputSchema,
  fixPrCiRun,
} from './ci-fix-run';

export const ciFixRunAction = defineAction({
  name: 'neondeck_autopilot_ci_fix_run',
  description:
    'Create a local CI failure dossier report, prepare a managed PR worktree, and start a bounded Kilo CI fix handoff without pushing or commenting.',
  input: ciFixRunInputSchema,
  output: ciFixRunOutputSchema,
  async run({ input }) {
    return fixPrCiRun(input);
  },
});
