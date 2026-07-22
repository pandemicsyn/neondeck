import * as v from 'valibot';
import {
  defaultPrReviewPromptTemplates,
  effectivePrReviewPromptTemplates,
  ensureRuntimeHome,
  parseAppConfig,
  prReviewPromptTokens,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import { writeJson } from '../files';
import { recordConfigChange } from '../history';
import { okResult, parseActionInput } from '../result';
import {
  updatePrReviewPromptInputSchema,
  type ConfigActionResult,
} from '../schemas';

export async function readPrReviewPrompts(
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const config = await readRuntimeJson(paths.config, parseAppConfig);
  return okResult(
    'config_read_pr_review_prompts',
    false,
    paths,
    [paths.config],
    {
      message: 'Read PR reviewer prompt templates.',
      data: prReviewPromptData(config),
    },
  );
}

export async function updatePrReviewPrompt(
  rawInput: v.InferInput<typeof updatePrReviewPromptInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updatePrReviewPromptInputSchema,
    rawInput,
    'config_update_pr_review_prompt',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const prompts = { ...config.prReview?.prompts };
  if (parsed.input.prompt === null) {
    delete prompts[parsed.input.kind];
  } else {
    prompts[parsed.input.kind] = parsed.input.prompt;
  }
  const next = parseAppConfig(
    {
      ...config,
      prReview: { ...config.prReview, prompts },
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.prReview?.prompts ?? {}) !==
    JSON.stringify(next.prReview?.prompts ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_pr_review_prompt',
      file: paths.config,
      target: `prReview.prompts.${parsed.input.kind}`,
      before: config,
      after: next,
    });
  }

  return okResult(
    'config_update_pr_review_prompt',
    changed,
    paths,
    [paths.config],
    {
      message: changed
        ? parsed.input.kind === 'initial-review'
          ? 'Updated the initial-review prompt. The change applies to the next review run.'
          : 'Updated the follow-up-reviewer prompt. The change applies to the next reviewer turn.'
        : 'The PR reviewer prompt already matched the requested value.',
      data: prReviewPromptData(next),
    },
  );
}

function prReviewPromptData(config: ReturnType<typeof parseAppConfig>) {
  return {
    prompts: effectivePrReviewPromptTemplates(config),
    defaults: defaultPrReviewPromptTemplates,
    overrides: config.prReview?.prompts ?? {},
    tokens: prReviewPromptTokens,
    appliesAfter: {
      'initial-review': 'next-review-run',
      'follow-up-reviewer': 'next-reviewer-turn',
    },
  };
}
