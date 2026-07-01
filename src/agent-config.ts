import {
  type AppConfig,
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type RuntimePaths,
  type ThinkingLevel,
} from './runtime-home';

export const defaultAgentModel = 'kilocode/kilo-auto/balanced';
export const defaultThinkingLevel: ThinkingLevel = 'medium';

export type NeondeckSubagentKey =
  'repoResearcher' | 'ciInvestigator' | 'releaseReviewer';

export type AgentModelSelection = {
  displayAssistant: string;
  displayAssistantThinkingLevel: ThinkingLevel;
  utility: string;
  utilityConfigured: boolean;
  utilityThinkingLevel: ThinkingLevel;
  selfImprovement: string;
  selfImprovementConfigured: boolean;
  selfImprovementThinkingLevel: ThinkingLevel;
  subagents: Record<NeondeckSubagentKey, string>;
  subagentThinkingLevels: Record<NeondeckSubagentKey, ThinkingLevel>;
};

export function readAgentModelSelectionSync(
  paths: RuntimePaths = runtimePaths(),
): AgentModelSelection {
  ensureRuntimeHomeSync(paths);

  try {
    const config = readRuntimeJsonSync(paths.config, parseAppConfig);
    return resolveAgentModelSelection(config);
  } catch (error) {
    console.warn('[neondeck] failed to read agent model config', error);
    return resolveAgentModelSelection();
  }
}

export function resolveAgentModelSelection(
  config?: Pick<AppConfig, 'models'>,
  env: NodeJS.ProcessEnv = process.env,
): AgentModelSelection {
  const displayAssistant = firstModel(
    config?.models?.displayAssistant,
    config?.models?.default,
    env.FLUE_AGENT_MODEL,
    defaultAgentModel,
  );
  const displayAssistantThinkingLevel = firstThinkingLevel(
    config?.models?.displayAssistantThinkingLevel,
    config?.models?.defaultThinkingLevel,
    env.FLUE_AGENT_THINKING_LEVEL,
    defaultThinkingLevel,
  );
  const configuredUtility = firstOptionalModel(
    config?.models?.utility,
    env.FLUE_UTILITY_MODEL,
  );
  const utility = configuredUtility ?? displayAssistant;
  const utilityThinkingLevel = firstThinkingLevel(
    config?.models?.utilityThinkingLevel,
    env.FLUE_UTILITY_THINKING_LEVEL,
    'low',
  );
  const configuredSelfImprovement = firstOptionalModel(
    config?.models?.selfImprovement,
    env.FLUE_SELF_IMPROVEMENT_MODEL,
  );
  const selfImprovement = firstModel(
    configuredSelfImprovement,
    configuredUtility,
    env.FLUE_UTILITY_MODEL,
    displayAssistant,
  );
  const selfImprovementThinkingLevel = firstThinkingLevel(
    config?.models?.selfImprovementThinkingLevel,
    env.FLUE_SELF_IMPROVEMENT_THINKING_LEVEL,
    config?.models?.utilityThinkingLevel,
    env.FLUE_UTILITY_THINKING_LEVEL,
    'low',
  );
  const subagentDefault = firstModel(
    config?.models?.subagents?.default,
    env.FLUE_SUBAGENT_MODEL,
    config?.models?.default,
    displayAssistant,
  );
  const subagentThinkingDefault = firstThinkingLevel(
    config?.models?.subagents?.defaultThinkingLevel,
    env.FLUE_SUBAGENT_THINKING_LEVEL,
    config?.models?.defaultThinkingLevel,
    displayAssistantThinkingLevel,
  );

  return {
    displayAssistant,
    displayAssistantThinkingLevel,
    utility,
    utilityConfigured: Boolean(configuredUtility),
    utilityThinkingLevel,
    selfImprovement,
    selfImprovementConfigured: Boolean(configuredSelfImprovement),
    selfImprovementThinkingLevel,
    subagents: {
      repoResearcher: firstModel(
        config?.models?.subagents?.repoResearcher,
        subagentDefault,
      ),
      ciInvestigator: firstModel(
        config?.models?.subagents?.ciInvestigator,
        subagentDefault,
      ),
      releaseReviewer: firstModel(
        config?.models?.subagents?.releaseReviewer,
        subagentDefault,
      ),
    },
    subagentThinkingLevels: {
      repoResearcher: firstThinkingLevel(
        config?.models?.subagents?.repoResearcherThinkingLevel,
        subagentThinkingDefault,
      ),
      ciInvestigator: firstThinkingLevel(
        config?.models?.subagents?.ciInvestigatorThinkingLevel,
        subagentThinkingDefault,
      ),
      releaseReviewer: firstThinkingLevel(
        config?.models?.subagents?.releaseReviewerThinkingLevel,
        subagentThinkingDefault,
      ),
    },
  };
}

export function firstModel(...values: Array<string | undefined>) {
  return firstOptionalModel(...values) ?? defaultAgentModel;
}

function firstOptionalModel(...values: Array<string | undefined>) {
  return values.find((value) => value && value.trim().length > 0)?.trim();
}

export function firstThinkingLevel(
  ...values: Array<string | undefined>
): ThinkingLevel {
  const value = values
    .find((item) => item && isThinkingLevel(item.trim()))
    ?.trim();

  return value ? (value as ThinkingLevel) : defaultThinkingLevel;
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (
    value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  );
}
