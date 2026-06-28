import {
  type AppConfig,
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';

export const defaultAgentModel = 'kilocode/kilo-auto/balanced';

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
  const subagentDefault = firstModel(
    config?.models?.subagents?.default,
    env.FLUE_SUBAGENT_MODEL,
    config?.models?.default,
    displayAssistant,
  );

  return {
    displayAssistant,
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
  };
}

export function firstModel(...values: Array<string | undefined>) {
  return (
    values.find((value) => value && value.trim().length > 0)?.trim() ??
    defaultAgentModel
  );
}
