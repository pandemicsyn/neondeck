import {
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';

export const defaultAgentModel = 'kilocode/kilo/auto';

export type NeondeckSubagentKey =
  'repoResearcher' | 'ciInvestigator' | 'releaseReviewer';

export type AgentModelSelection = {
  displayAssistant: string;
  subagents: Record<NeondeckSubagentKey, string>;
};

export function readAgentModelSelectionSync(
  paths: RuntimePaths = runtimePaths(),
): AgentModelSelection {
  ensureRuntimeHomeSync(paths);

  try {
    const config = readRuntimeJsonSync(paths.config, parseAppConfig);
    const displayAssistant = firstModel(
      config.models?.displayAssistant,
      config.models?.default,
      process.env.FLUE_AGENT_MODEL,
      defaultAgentModel,
    );
    const subagentDefault = firstModel(
      config.models?.subagents?.default,
      process.env.FLUE_SUBAGENT_MODEL,
      config.models?.default,
      displayAssistant,
    );

    return {
      displayAssistant,
      subagents: {
        repoResearcher: firstModel(
          config.models?.subagents?.repoResearcher,
          subagentDefault,
        ),
        ciInvestigator: firstModel(
          config.models?.subagents?.ciInvestigator,
          subagentDefault,
        ),
        releaseReviewer: firstModel(
          config.models?.subagents?.releaseReviewer,
          subagentDefault,
        ),
      },
    };
  } catch (error) {
    console.warn('[neondeck] failed to read agent model config', error);
    const fallback = firstModel(
      process.env.FLUE_AGENT_MODEL,
      defaultAgentModel,
    );
    const subagent = firstModel(process.env.FLUE_SUBAGENT_MODEL, fallback);
    return {
      displayAssistant: fallback,
      subagents: {
        repoResearcher: subagent,
        ciInvestigator: subagent,
        releaseReviewer: subagent,
      },
    };
  }
}

function firstModel(...values: Array<string | undefined>) {
  return (
    values.find((value) => value && value.trim().length > 0)?.trim() ??
    defaultAgentModel
  );
}
