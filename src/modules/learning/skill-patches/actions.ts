import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { runtimePaths } from '../../../runtime-home';
import {
  applySkillPatchCandidate,
  listSkillPatchCandidates,
  proposeSkillPatch,
  rejectSkillPatchCandidate,
  restoreSkillPatchCandidate,
} from './service';
import {
  skillPatchActionOutputSchema,
  skillPatchDecideInputSchema,
  skillPatchListInputSchema,
  skillPatchProposeInputSchema,
  skillPatchRestoreInputSchema,
} from './schemas';

export const skillPatchProposeAction = defineAction({
  name: 'neondeck_learning_skill_patch_propose',
  description:
    'Create an audited Neondeck-owned runtime skill patch candidate without applying it.',
  input: skillPatchProposeInputSchema,
  output: skillPatchActionOutputSchema,
  async run({ input }) {
    return proposeSkillPatch(input, runtimePaths(), { source: 'neon' });
  },
});

export const skillPatchApplyAction = defineAction({
  name: 'neondeck_learning_skill_patch_apply',
  description:
    'Apply one proposed Neondeck-owned runtime skill patch after explicit decision or auto learning policy.',
  input: skillPatchDecideInputSchema,
  output: skillPatchActionOutputSchema,
  async run({ input }) {
    return applySkillPatchCandidate(input, runtimePaths(), { source: 'neon' });
  },
});

export const skillPatchRejectAction = defineAction({
  name: 'neondeck_learning_skill_patch_reject',
  description:
    'Reject one proposed Neondeck-owned runtime skill patch candidate with audit history.',
  input: skillPatchDecideInputSchema,
  output: skillPatchActionOutputSchema,
  async run({ input }) {
    return rejectSkillPatchCandidate(input, runtimePaths(), { source: 'neon' });
  },
});

export const skillPatchListAction = defineAction({
  name: 'neondeck_learning_skill_patch_list',
  description: 'List Neondeck skill patch candidates and decisions.',
  input: skillPatchListInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    changed: v.boolean(),
    candidates: v.array(v.unknown()),
  }),
  async run({ input }) {
    return listSkillPatchCandidates(input);
  },
});

export const skillPatchRestoreAction = defineAction({
  name: 'neondeck_learning_skill_patch_restore',
  description:
    'Restore an applied skill patch from its audited before-content when the current file still matches the applied patch.',
  input: skillPatchRestoreInputSchema,
  output: skillPatchActionOutputSchema,
  async run({ input }) {
    return restoreSkillPatchCandidate(input, runtimePaths(), {
      source: 'neon',
    });
  },
});

export const neondeckSkillPatchActions = [
  skillPatchProposeAction,
  skillPatchApplyAction,
  skillPatchRejectAction,
  skillPatchListAction,
  skillPatchRestoreAction,
];
