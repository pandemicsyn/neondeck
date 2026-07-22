import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { executionPolicyUpdateSchema } from '../execution-policy';
import { dashboardConfigSchema } from '../../runtime-home';
import {
  addRepoInputSchema,
  configActionOutputSchema,
  configTargetSchema,
  dashboardPresetSchema,
  removeRepoInputSchema,
  updateAgentModelsInputSchema,
  updateAutopilotPromptInputSchema,
  updatePrReviewPromptInputSchema,
  updateHandoffConfigInputSchema,
  updateLearningConfigInputSchema,
  updateProviderInputSchema,
  updateRepoAutopilotPolicyInputSchema,
  updateRepoInputSchema,
  updateSkillRootsInputSchema,
  updateWorktreePolicyInputSchema,
} from './schemas';
import {
  readAutopilotPrompts,
  updateAutopilotPrompt,
} from './mutations/autopilot-prompts';
import {
  readPrReviewPrompts,
  updatePrReviewPrompt,
} from './mutations/pr-review-prompts';
import { readConfig, reloadConfig, validateConfig } from './read';
import {
  updateDashboardLayout,
  applyDashboardPreset,
} from './mutations/dashboard';
import { updateExecutionPolicy } from './mutations/execution';
import {
  updateAgentModels,
  updateHandoffConfig,
  updateLearningConfig,
  updateSkillRoots,
  updateWorktreePolicy,
} from './mutations/models';
import {
  readProviderConfig,
  updateProviderConfig,
} from './mutations/providers';
import {
  addRepo,
  removeRepo,
  updateRepo,
  updateRepoAutopilotPolicy,
} from './mutations/repos';

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
    'Update display-assistant, PR-review, utility, self-improvement, and subagent model settings in runtime config.json, including the bounded PR-review timeout. Provider registration is not changed by this action.',
  input: updateAgentModelsInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateAgentModels(input);
  },
});

export const readAutopilotPromptsAction = defineAction({
  name: 'neondeck_config_read_autopilot_prompts',
  description:
    'Read the effective, default, and overridden per-mode Autopilot owner prompt templates.',
  input: v.object({}),
  output: configActionOutputSchema,
  async run() {
    return readAutopilotPrompts();
  },
});

export const updateAutopilotPromptAction = defineAction({
  name: 'neondeck_config_update_autopilot_prompt',
  description:
    'Replace one full Autopilot owner system prompt, or reset it to the built-in default. Existing owners pick up changes on their next turn.',
  input: updateAutopilotPromptInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateAutopilotPrompt(input);
  },
});

export const readPrReviewPromptsAction = defineAction({
  name: 'neondeck_config_read_pr_review_prompts',
  description:
    'Read the effective, default, and overridden prompts for initial PR reviews and follow-up reviewer conversations.',
  input: v.object({}),
  output: configActionOutputSchema,
  async run() {
    return readPrReviewPrompts();
  },
});

export const updatePrReviewPromptAction = defineAction({
  name: 'neondeck_config_update_pr_review_prompt',
  description:
    'Replace one full PR reviewer prompt, or reset it to the built-in default. Initial-review changes apply to new runs; follow-up changes apply on the next reviewer turn.',
  input: updatePrReviewPromptInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updatePrReviewPrompt(input);
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

export const updateHandoffConfigAction = defineAction({
  name: 'neondeck_config_update_handoff',
  description:
    'Update external agent handoff policy in runtime config.json, including whether external registrations may queue PR review assistance.',
  input: updateHandoffConfigInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateHandoffConfig(input);
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

export const updateRepoAutopilotPolicyAction = defineAction({
  name: 'neondeck_config_update_repo_autopilot_policy',
  description:
    'Update one repository’s typed autopilot policy and shared repo guardrails. Explicit confirmation is required when the change increases autonomy, relaxes guardrails, expands push destinations, or enables force push.',
  input: updateRepoAutopilotPolicyInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateRepoAutopilotPolicy(input);
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

export const neondeckConfigActions = [
  configReadAction,
  configValidateAction,
  configReloadAction,
  updateAgentModelsAction,
  readAutopilotPromptsAction,
  updateAutopilotPromptAction,
  readPrReviewPromptsAction,
  updatePrReviewPromptAction,
  updateSkillRootsAction,
  updateLearningConfigAction,
  updateHandoffConfigAction,
  updateWorktreePolicyAction,
  readProvidersAction,
  updateProviderAction,
  updateExecutionPolicyAction,
  updateDashboardLayoutAction,
  applyDashboardPresetAction,
  addRepoAction,
  updateRepoAction,
  updateRepoAutopilotPolicyAction,
  removeRepoAction,
];
