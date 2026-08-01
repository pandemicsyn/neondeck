'use agent';

import {
  useAgentFinish,
  useInitialData,
  useModel,
  useSandbox,
  useTool,
} from '@flue/runtime';
import { createReviewPrForHumanTool } from '../modules/pr-review-assist/actions';
import {
  prReviewAssistInputSchema,
  type PrReviewAssistInput,
} from '../modules/pr-review-assist/schemas';
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

export function PrReviewAssistant() {
  const runtime = buildPrReviewAssistantRuntime();
  const input = useInitialData<PrReviewAssistInput>();
  const executionState: { failure?: Error } = {};
  useModel(runtime.model, {
    thinkingLevel: runtime.thinkingLevel,
  });
  useSandbox(runtime.sandbox, { cwd: runtime.cwd });
  useTool(createReviewPrForHumanTool(input, executionState));
  useAgentFinish(({ append, response }) => {
    if (executionState.failure) throw executionState.failure;
    const call = response.toolCalls.find(
      (candidate) => candidate.tool === 'neondeck_pr_review_for_human',
    );
    if (call?.isError) {
      throw new Error('The bounded PR review tool failed.');
    }
    if (!call) {
      append({
        kind: 'signal',
        type: 'neondeck.pr-review.required',
        body: 'Call neondeck_pr_review_for_human now. The bounded review cannot settle without it.',
      });
    }
  });
  return `${runtime.instructions}\n\nThis is a bounded review operation. Call neondeck_pr_review_for_human exactly once with an empty object. Do not answer conversationally or delegate the review.`;
}

PrReviewAssistant.agentName = 'pr-review-assistant';
PrReviewAssistant.initialData = prReviewAssistInputSchema;
