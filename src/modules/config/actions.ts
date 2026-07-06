import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { executionPolicyUpdateSchema } from '../execution-policy';
import { dashboardConfigSchema } from '../../runtime-home';
import {
  addRepoInputSchema,
  configActionOutputSchema,
  configTargetSchema,
  dashboardPresetSchema,
  nonEmptyStringSchema,
  removeRepoInputSchema,
  scheduleInputSchema,
  updateAgentModelsInputSchema,
  updateLearningConfigInputSchema,
  updateProviderInputSchema,
  updateRepoInputSchema,
  updateRoutinesConfigInputSchema,
  updateScheduleInputSchema,
  updateSkillRootsInputSchema,
  updateWorktreePolicyInputSchema,
} from './schemas';
import { readConfig, reloadConfig, validateConfig } from './read';
import {
  updateDashboardLayout,
  applyDashboardPreset,
} from './mutations/dashboard';
import { updateExecutionPolicy } from './mutations/execution';
import {
  updateAgentModels,
  updateLearningConfig,
  updateSkillRoots,
  updateWorktreePolicy,
} from './mutations/models';
import {
  readProviderConfig,
  updateProviderConfig,
} from './mutations/providers';
import { addRepo, removeRepo, updateRepo } from './mutations/repos';
import { updateRoutinesConfig } from './mutations/routines';
import {
  addSchedule,
  removeSchedule,
  updateSchedule,
} from './mutations/schedules';

export const configReadAction = defineAction({
  name: 'neondeck_config_read',
  description:
    'Read validated Neondeck runtime config files without mutating them.',
  input: v.object({
    target: configTargetSchema,
  }),
  output: configActionOutputSchema,
  async run({ input }) {
    return readConfig(input);
  },
});

export const configValidateAction = defineAction({
  name: 'neondeck_config_validate',
  description:
    'Validate Neondeck runtime config files and report schema errors.',
  input: v.object({
    target: configTargetSchema,
  }),
  output: configActionOutputSchema,
  async run({ input }) {
    return validateConfig(input);
  },
});

export const configReloadAction = defineAction({
  name: 'neondeck_config_reload',
  description:
    'Reload Neondeck runtime config by validating files and returning the active config snapshot.',
  input: v.object({}),
  output: configActionOutputSchema,
  async run() {
    return reloadConfig();
  },
});

export const updateAgentModelsAction = defineAction({
  name: 'neondeck_config_update_agent_models',
  description:
    'Update display-assistant, utility, self-improvement, and subagent model names in runtime config.json. Provider registration is not changed by this action.',
  input: updateAgentModelsInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateAgentModels(input);
  },
});

export const updateSkillRootsAction = defineAction({
  name: 'neondeck_config_update_skill_roots',
  description:
    'Update external runtime skill roots in config.json with schema validation and config history.',
  input: updateSkillRootsInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateSkillRoots(input);
  },
});

export const updateLearningConfigAction = defineAction({
  name: 'neondeck_config_update_learning',
  description:
    'Update Neondeck learning and memory-curation policy in runtime config.json.',
  input: updateLearningConfigInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateLearningConfig(input);
  },
});

export const updateRoutinesConfigAction = defineAction({
  name: 'neondeck_config_update_routines',
  description:
    'Enable or disable the global routines subsystem in runtime config.json. When disabled, routine scheduling and run-now admission are paused immediately.',
  input: updateRoutinesConfigInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateRoutinesConfig(input);
  },
});

export const updateWorktreePolicyAction = defineAction({
  name: 'neondeck_config_update_worktree_policy',
  description:
    'Update Neondeck worktree storage default and cleanup policy in runtime config.json. Does not create or delete worktrees.',
  input: updateWorktreePolicyInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateWorktreePolicy(input);
  },
});

export const readProvidersAction = defineAction({
  name: 'neondeck_config_read_providers',
  description:
    'Read validated allowlisted provider configuration without exposing secret values.',
  input: v.object({}),
  output: configActionOutputSchema,
  async run() {
    return readProviderConfig();
  },
});

export const updateProviderAction = defineAction({
  name: 'neondeck_config_update_provider',
  description:
    'Update allowlisted provider configuration in config.json using secret environment variable references only. Does not accept raw secrets or arbitrary base URLs.',
  input: updateProviderInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateProviderConfig(input);
  },
});

export const updateExecutionPolicyAction = defineAction({
  name: 'neondeck_config_update_execution_policy',
  description:
    'Update Neondeck host execution approval policy in config.json, including preapproved local or exe.dev commands. Does not execute commands.',
  input: executionPolicyUpdateSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateExecutionPolicy(input);
  },
});

export const updateDashboardLayoutAction = defineAction({
  name: 'neondeck_config_update_dashboard_layout',
  description:
    'Replace dashboard.json with a validated stacked-region dashboard layout.',
  input: dashboardConfigSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateDashboardLayout(input);
  },
});

export const applyDashboardPresetAction = defineAction({
  name: 'neondeck_config_apply_dashboard_preset',
  description:
    'Apply a known dashboard layout preset such as classic or cockpit.',
  input: dashboardPresetSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return applyDashboardPreset(input);
  },
});

export const addRepoAction = defineAction({
  name: 'neondeck_config_add_repo',
  description:
    'Add a local git repository to Neondeck repos.json after path, git, GitHub, and schema validation.',
  input: addRepoInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return addRepo(input);
  },
});

export const updateRepoAction = defineAction({
  name: 'neondeck_config_update_repo',
  description:
    'Update an existing Neondeck repository entry in repos.json with schema validation.',
  input: updateRepoInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateRepo(input);
  },
});

export const removeRepoAction = defineAction({
  name: 'neondeck_config_remove_repo',
  description:
    'Remove an existing Neondeck repository entry from repos.json after explicit confirmation.',
  input: removeRepoInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return removeRepo(input);
  },
});

export const addScheduleAction = defineAction({
  name: 'neondeck_config_add_schedule',
  description:
    'Add a Neondeck schedule entry to schedules.json with schema validation.',
  input: scheduleInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return addSchedule(input);
  },
});

export const updateScheduleAction = defineAction({
  name: 'neondeck_config_update_schedule',
  description:
    'Update an existing Neondeck schedule entry in schedules.json with schema validation.',
  input: updateScheduleInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateSchedule(input);
  },
});

export const removeScheduleAction = defineAction({
  name: 'neondeck_config_remove_schedule',
  description:
    'Remove an existing Neondeck schedule entry from schedules.json after explicit confirmation.',
  input: v.object({
    id: nonEmptyStringSchema,
    confirm: v.optional(v.boolean()),
  }),
  output: configActionOutputSchema,
  async run({ input }) {
    return removeSchedule(input);
  },
});

export const neondeckConfigActions = [
  configReadAction,
  configValidateAction,
  configReloadAction,
  updateAgentModelsAction,
  updateSkillRootsAction,
  updateLearningConfigAction,
  updateRoutinesConfigAction,
  updateWorktreePolicyAction,
  readProvidersAction,
  updateProviderAction,
  updateExecutionPolicyAction,
  updateDashboardLayoutAction,
  applyDashboardPresetAction,
  addRepoAction,
  updateRepoAction,
  removeRepoAction,
  addScheduleAction,
  updateScheduleAction,
  removeScheduleAction,
];
