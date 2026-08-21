import * as v from 'valibot';
import { parseActionInput, failResult, okResult } from '../result';
import { recordConfigChange } from '../history';
import { writeJson } from '../files';
import {
  type AgentModelConfig,
  type AppConfig,
  type HandoffConfig,
  type LearningConfig,
  type WorktreeCleanupConfig,
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import { isRegisteredProvider } from '../../repos';
import {
  updateAgentModelsInputSchema,
  updateHandoffConfigInputSchema,
  updateLearningConfigInputSchema,
  updateSkillRootsInputSchema,
  updateWorktreePolicyInputSchema,
  type ConfigActionResult,
  type ConfigExternalValue,
  unknownRecordSchema,
} from '../schemas';

export async function updateAgentModels(
  rawInput: v.InferInput<typeof updateAgentModelsInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateAgentModelsInputSchema,
    rawInput,
    'config_update_agent_models',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (!hasAgentModelUpdate(input)) {
    return failResult('config_update_agent_models', paths, [paths.config], {
      message: 'At least one model value is required.',
      requires: ['model'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const unknownProviders = Array.from(
    new Set(
      modelValues(input)
        .map((model) => model.slice(0, model.indexOf('/')))
        .filter(
          (provider) =>
            !isRegisteredProvider(provider, {
              providers: config.providers,
            }),
        ),
    ),
  );
  if (unknownProviders.length > 0) {
    return failResult('config_update_agent_models', paths, [paths.config], {
      message: `Model strings reference unconfigured providers: ${unknownProviders.join(', ')}.`,
      requires: ['registered-provider'],
    });
  }
  const nextModels = mergeAgentModelConfig(config.models, input);
  const next = parseAppConfig(
    {
      ...config,
      models: nextModels,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.models ?? {}) !== JSON.stringify(next.models ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_agent_models',
      file: paths.config,
      target: 'models',
      before: config,
      after: next,
    });
  }

  return okResult(
    'config_update_agent_models',
    changed,
    paths,
    [paths.config],
    {
      message: changed
        ? 'Updated agent model configuration. Start a new session or restart the server for active agents to pick up the change.'
        : 'Agent model configuration already matched the requested values.',
      data: {
        models: next.models,
        appliesAfter: 'new-session-or-server-restart',
        providerRegistration:
          'Model strings must reference providers already registered by Neondeck or Flue runtime configuration.',
      },
    },
  );
}

function modelValues(value: ConfigExternalValue): string[] {
  const parsedString = v.safeParse(v.string(), value);
  if (parsedString.success) return [parsedString.output];
  if (Array.isArray(value)) return value.flatMap(modelValues);
  const parsedRecord = v.safeParse(unknownRecordSchema, value);
  if (!parsedRecord.success) return [];
  return Object.entries(parsedRecord.output).flatMap(([key, nested]) =>
    key.toLowerCase().includes('think') || key.endsWith('TimeoutMs')
      ? []
      : modelValues(nested),
  );
}

export async function updateSkillRoots(
  rawInput: v.InferInput<typeof updateSkillRootsInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateSkillRootsInputSchema,
    rawInput,
    'config_update_skill_roots',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextSkillRoots = Array.from(new Set(parsed.input.skillRoots));
  const next = parseAppConfig(
    {
      ...config,
      skillRoots: nextSkillRoots,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.skillRoots ?? []) !==
    JSON.stringify(next.skillRoots ?? []);

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_skill_roots',
      file: paths.config,
      target: 'skillRoots',
      before: config,
      after: next,
    });
  }

  return okResult('config_update_skill_roots', changed, paths, [paths.config], {
    message: changed
      ? 'Updated runtime skill roots. Start a new session for active agents to load changed skills.'
      : 'Runtime skill roots already matched the requested values.',
    data: {
      skillRoots: next.skillRoots ?? [],
      appliesAfter: 'new-session',
    },
  });
}

export async function updateLearningConfig(
  rawInput: v.InferInput<typeof updateLearningConfigInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateLearningConfigInputSchema,
    rawInput,
    'config_update_learning',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  if (!hasLearningConfigUpdate(parsed.input)) {
    return failResult('config_update_learning', paths, [paths.config], {
      message: 'At least one learning config value is required.',
      requires: ['learning'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextLearning = mergeLearningConfig(config.learning, parsed.input);
  const next = parseAppConfig(
    {
      ...config,
      learning: nextLearning,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.learning ?? {}) !==
    JSON.stringify(next.learning ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_learning',
      file: paths.config,
      target: 'learning',
      before: config,
      after: next,
    });
  }

  return okResult('config_update_learning', changed, paths, [paths.config], {
    message: changed
      ? 'Updated learning configuration. Existing sessions keep their loaded memory context until a new session or explicit refresh.'
      : 'Learning configuration already matched the requested values.',
    data: {
      learning: next.learning,
      appliesAfter: 'new-session',
    },
  });
}

export async function updateHandoffConfig(
  rawInput: v.InferInput<typeof updateHandoffConfigInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateHandoffConfigInputSchema,
    rawInput,
    'config_update_handoff',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  if (!hasHandoffConfigUpdate(parsed.input)) {
    return failResult('config_update_handoff', paths, [paths.config], {
      message: 'At least one handoff config value is required.',
      requires: ['handoff'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextHandoff = mergeHandoffConfig(config.handoff, parsed.input);
  const next = parseAppConfig(
    {
      ...config,
      handoff: nextHandoff,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.handoff ?? {}) !== JSON.stringify(next.handoff ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_handoff',
      file: paths.config,
      target: 'handoff',
      before: config,
      after: next,
    });
  }

  return okResult('config_update_handoff', changed, paths, [paths.config], {
    message: changed
      ? 'Updated external agent handoff configuration.'
      : 'External agent handoff configuration already matched the requested values.',
    data: {
      handoff: next.handoff,
    },
  });
}

export async function updateWorktreePolicy(
  rawInput: v.InferInput<typeof updateWorktreePolicyInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateWorktreePolicyInputSchema,
    rawInput,
    'config_update_worktree_policy',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const { confirm, ...input } = parsed.input;
  if (!hasWorktreePolicyUpdate(input)) {
    return failResult('config_update_worktree_policy', paths, [paths.config], {
      message: 'At least one worktree policy setting is required.',
      requires: ['defaultStorage', 'cleanup'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  if (worktreePolicyDeletesSooner(config.worktrees, input) && !confirm) {
    return failResult('config_update_worktree_policy', paths, [paths.config], {
      message:
        'Changing worktree cleanup policy toward faster deletion requires explicit confirmation.',
      requires: ['confirm'],
    });
  }
  const nextWorktrees = {
    ...config.worktrees,
    ...input,
    cleanup:
      input.cleanup || config.worktrees?.cleanup
        ? {
            ...config.worktrees?.cleanup,
            ...input.cleanup,
          }
        : undefined,
  };
  const next = parseAppConfig(
    {
      ...config,
      worktrees: nextWorktrees,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.worktrees ?? {}) !==
    JSON.stringify(next.worktrees ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_worktree_policy',
      file: paths.config,
      target: 'worktrees',
      before: config,
      after: next,
    });
  }

  return okResult(
    'config_update_worktree_policy',
    changed,
    paths,
    [paths.config],
    {
      message: changed
        ? 'Updated worktree storage and cleanup policy.'
        : 'Worktree policy already matched the requested values.',
      data: {
        worktrees: next.worktrees,
        policy:
          'Cleanup keeps failed, prepared-diff, and adopted worktrees unless policy or explicit confirmation allows removal.',
      },
    },
  );
}

function hasAgentModelUpdate(
  input: v.InferOutput<typeof updateAgentModelsInputSchema>,
) {
  return Boolean(
    input.default ||
    input.defaultThinkingLevel ||
    input.displayAssistant ||
    input.displayAssistantThinkingLevel ||
    input.prReview !== undefined ||
    input.prReviewThinkingLevel ||
    input.prReviewTimeoutMs !== undefined ||
    input.utility !== undefined ||
    input.utilityThinkingLevel ||
    input.selfImprovement !== undefined ||
    input.selfImprovementThinkingLevel ||
    input.subagents?.default ||
    input.subagents?.defaultThinkingLevel ||
    input.subagents?.explore !== undefined ||
    input.subagents?.exploreThinkingLevel !== undefined ||
    input.subagents?.repoResearcher ||
    input.subagents?.repoResearcherThinkingLevel ||
    input.subagents?.ciInvestigator ||
    input.subagents?.ciInvestigatorThinkingLevel ||
    input.subagents?.releaseReviewer ||
    input.subagents?.releaseReviewerThinkingLevel,
  );
}

function hasLearningConfigUpdate(
  input: v.InferOutput<typeof updateLearningConfigInputSchema>,
) {
  return Object.values(input).some((value) => value !== undefined);
}

function hasHandoffConfigUpdate(
  input: v.InferOutput<typeof updateHandoffConfigInputSchema>,
) {
  return Object.values(input).some((value) => value !== undefined);
}

function hasWorktreePolicyUpdate(
  input: Omit<v.InferOutput<typeof updateWorktreePolicyInputSchema>, 'confirm'>,
) {
  const cleanup = input.cleanup;
  return Boolean(
    input.defaultStorage !== undefined ||
    cleanup?.retainFailed !== undefined ||
    cleanup?.retainPreparedDiff !== undefined ||
    cleanup?.successfulGraceHours !== undefined ||
    cleanup?.staleAgeHours !== undefined,
  );
}

function worktreePolicyDeletesSooner(
  current: AppConfig['worktrees'] | undefined,
  input: Omit<v.InferOutput<typeof updateWorktreePolicyInputSchema>, 'confirm'>,
) {
  const currentCleanup: WorktreeCleanupConfig = current?.cleanup ?? {};
  const nextCleanup: WorktreeCleanupConfig = input.cleanup ?? {};
  if (
    currentCleanup.retainFailed !== false &&
    nextCleanup.retainFailed === false
  ) {
    return true;
  }
  if (
    currentCleanup.retainPreparedDiff !== false &&
    nextCleanup.retainPreparedDiff === false
  ) {
    return true;
  }
  const currentSuccessfulGrace = currentCleanup.successfulGraceHours ?? 24;
  const currentStaleAge = currentCleanup.staleAgeHours ?? 168;
  return (
    Boolean(
      nextCleanup.successfulGraceHours !== undefined &&
      nextCleanup.successfulGraceHours < currentSuccessfulGrace,
    ) ||
    Boolean(
      nextCleanup.staleAgeHours !== undefined &&
      nextCleanup.staleAgeHours < currentStaleAge,
    )
  );
}

function mergeAgentModelConfig(
  current: AppConfig['models'] | undefined,
  input: v.InferOutput<typeof updateAgentModelsInputSchema>,
): AgentModelConfig {
  const currentModels = { ...current };
  if (input.prReview === null) delete currentModels.prReview;
  if (input.utility === null) delete currentModels.utility;
  if (input.selfImprovement === null) delete currentModels.selfImprovement;
  const subagents: NonNullable<AgentModelConfig['subagents']> = {
    ...current?.subagents,
  };
  const inputSubagents = input.subagents;
  if (inputSubagents?.default !== undefined) {
    subagents.default = inputSubagents.default;
  }
  if (inputSubagents?.defaultThinkingLevel !== undefined) {
    subagents.defaultThinkingLevel = inputSubagents.defaultThinkingLevel;
  }
  if (inputSubagents?.explore === null) delete subagents.explore;
  else if (inputSubagents?.explore !== undefined) {
    subagents.explore = inputSubagents.explore;
  }
  if (inputSubagents?.exploreThinkingLevel === null) {
    delete subagents.exploreThinkingLevel;
  } else if (inputSubagents?.exploreThinkingLevel !== undefined) {
    subagents.exploreThinkingLevel = inputSubagents.exploreThinkingLevel;
  }
  if (inputSubagents?.repoResearcher !== undefined) {
    subagents.repoResearcher = inputSubagents.repoResearcher;
  }
  if (inputSubagents?.repoResearcherThinkingLevel !== undefined) {
    subagents.repoResearcherThinkingLevel =
      inputSubagents.repoResearcherThinkingLevel;
  }
  if (inputSubagents?.ciInvestigator !== undefined) {
    subagents.ciInvestigator = inputSubagents.ciInvestigator;
  }
  if (inputSubagents?.ciInvestigatorThinkingLevel !== undefined) {
    subagents.ciInvestigatorThinkingLevel =
      inputSubagents.ciInvestigatorThinkingLevel;
  }
  if (inputSubagents?.releaseReviewer !== undefined) {
    subagents.releaseReviewer = inputSubagents.releaseReviewer;
  }
  if (inputSubagents?.releaseReviewerThinkingLevel !== undefined) {
    subagents.releaseReviewerThinkingLevel =
      inputSubagents.releaseReviewerThinkingLevel;
  }

  if (input.default !== undefined) currentModels.default = input.default;
  if (input.defaultThinkingLevel !== undefined) {
    currentModels.defaultThinkingLevel = input.defaultThinkingLevel;
  }
  if (input.displayAssistant !== undefined) {
    currentModels.displayAssistant = input.displayAssistant;
  }
  if (input.displayAssistantThinkingLevel !== undefined) {
    currentModels.displayAssistantThinkingLevel =
      input.displayAssistantThinkingLevel;
  }
  if (input.prReview !== undefined && input.prReview !== null) {
    currentModels.prReview = input.prReview;
  }
  if (input.prReviewThinkingLevel !== undefined) {
    currentModels.prReviewThinkingLevel = input.prReviewThinkingLevel;
  }
  if (input.prReviewTimeoutMs !== undefined) {
    currentModels.prReviewTimeoutMs = input.prReviewTimeoutMs;
  }
  if (input.utility !== undefined && input.utility !== null) {
    currentModels.utility = input.utility;
  }
  if (input.utilityThinkingLevel !== undefined) {
    currentModels.utilityThinkingLevel = input.utilityThinkingLevel;
  }
  if (input.selfImprovement !== undefined && input.selfImprovement !== null) {
    currentModels.selfImprovement = input.selfImprovement;
  }
  if (input.selfImprovementThinkingLevel !== undefined) {
    currentModels.selfImprovementThinkingLevel =
      input.selfImprovementThinkingLevel;
  }
  if (Object.keys(subagents).length > 0) currentModels.subagents = subagents;
  return currentModels;
}

function mergeLearningConfig(
  current: AppConfig['learning'] | undefined,
  input: v.InferOutput<typeof updateLearningConfigInputSchema>,
): LearningConfig {
  return {
    ...current,
    ...input,
  };
}

function mergeHandoffConfig(
  current: AppConfig['handoff'] | undefined,
  input: v.InferOutput<typeof updateHandoffConfigInputSchema>,
): HandoffConfig {
  return {
    ...current,
    ...input,
  };
}
