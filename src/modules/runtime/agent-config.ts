import {
  type AppConfig,
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type RuntimePaths,
  type ThinkingLevel,
} from '../../runtime-home';
import {
  defaultPrReviewTimeoutMs,
  maxPrReviewTimeoutMs,
} from '../../../shared/pr-review-policy';

export const defaultAgentModel = 'kilocode/kilo-auto/balanced';
export const defaultThinkingLevel: ThinkingLevel = 'medium';
export { defaultPrReviewTimeoutMs } from '../../../shared/pr-review-policy';

export type NeondeckSubagentKey =
  'explore' | 'repoResearcher' | 'ciInvestigator' | 'releaseReviewer';

export type AgentModelSelection = {
  displayAssistant: string;
  displayAssistantThinkingLevel: ThinkingLevel;
  prReview: string;
  prReviewConfigured: boolean;
  prReviewThinkingLevel: ThinkingLevel;
  prReviewTimeoutMs: number;
  utility: string;
  utilityConfigured: boolean;
  utilityThinkingLevel: ThinkingLevel;
  selfImprovement: string;
  selfImprovementConfigured: boolean;
  selfImprovementThinkingLevel: ThinkingLevel;
  exploreConfigured: boolean;
  exploreThinkingConfigured: boolean;
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
  const configuredPrReview = firstOptionalModel(
    config?.models?.prReview,
    env.FLUE_PR_REVIEW_MODEL,
  );
  const prReview = configuredPrReview ?? displayAssistant;
  const prReviewThinkingLevel = firstThinkingLevel(
    config?.models?.prReviewThinkingLevel,
    env.FLUE_PR_REVIEW_THINKING_LEVEL,
    displayAssistantThinkingLevel,
  );
  const prReviewTimeoutMs = Math.min(
    config?.models?.prReviewTimeoutMs ?? defaultPrReviewTimeoutMs,
    maxPrReviewTimeoutMs,
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
  const configuredExplore = firstOptionalModel(
    config?.models?.subagents?.explore,
    env.FLUE_EXPLORE_SUBAGENT_MODEL,
  );
  const configuredExploreThinkingLevel = firstOptionalThinkingLevel(
    config?.models?.subagents?.exploreThinkingLevel,
    env.FLUE_EXPLORE_SUBAGENT_THINKING_LEVEL,
  );

  return {
    displayAssistant,
    displayAssistantThinkingLevel,
    prReview,
    prReviewConfigured: Boolean(configuredPrReview),
    prReviewThinkingLevel,
    prReviewTimeoutMs,
    utility,
    utilityConfigured: Boolean(configuredUtility),
    utilityThinkingLevel,
    selfImprovement,
    selfImprovementConfigured: Boolean(configuredSelfImprovement),
    selfImprovementThinkingLevel,
    exploreConfigured: Boolean(configuredExplore),
    exploreThinkingConfigured: Boolean(configuredExploreThinkingLevel),
    subagents: {
      explore: firstModel(configuredExplore, displayAssistant),
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
      explore: firstThinkingLevel(
        configuredExploreThinkingLevel,
        defaultThinkingLevel,
      ),
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
  return firstOptionalThinkingLevel(...values) ?? defaultThinkingLevel;
}

function firstOptionalThinkingLevel(...values: Array<string | undefined>) {
  const value = values
    .find((item) => item && isThinkingLevel(item.trim()))
    ?.trim();
  return value ? (value as ThinkingLevel) : undefined;
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
