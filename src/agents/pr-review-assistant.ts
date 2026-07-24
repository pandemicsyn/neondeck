import { defineAgent } from '@flue/runtime';
import { readAgentModelSelectionSync } from '../modules/runtime';
import {
  effectivePrReviewPromptTemplates,
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type RuntimePaths,
} from '../runtime-home';
import { noWorkspace } from '../sandboxes/no-workspace';

export function buildPrReviewAssistantRuntime(
  paths: RuntimePaths = runtimePaths(),
) {
  ensureRuntimeHomeSync(paths);
  const models = readAgentModelSelectionSync(paths);
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);

  return {
    model: models.prReview,
    thinkingLevel: models.prReviewThinkingLevel,
    sandbox: noWorkspace(),
    cwd: '/workspace',
    instructions: effectivePrReviewPromptTemplates(config)['initial-review'],
    skills: [],
    tools: [],
    actions: [],
    subagents: [],
  };
}

export default defineAgent(() => buildPrReviewAssistantRuntime());
