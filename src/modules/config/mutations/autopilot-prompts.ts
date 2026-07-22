import * as v from 'valibot';
import {
  autopilotOwnerPromptTokens,
  defaultAutopilotOwnerPromptTemplates,
  effectiveAutopilotOwnerPromptTemplates,
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import { writeJson } from '../files';
import { recordConfigChange } from '../history';
import { okResult, parseActionInput } from '../result';
import {
  updateAutopilotPromptInputSchema,
  type ConfigActionResult,
} from '../schemas';

export async function readAutopilotPrompts(
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const config = await readRuntimeJson(paths.config, parseAppConfig);

  return okResult(
    'config_read_autopilot_prompts',
    false,
    paths,
    [paths.config],
    {
      message: 'Read Autopilot owner prompt templates.',
      data: autopilotPromptData(config),
    },
  );
}

export async function updateAutopilotPrompt(
  rawInput: v.InferInput<typeof updateAutopilotPromptInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateAutopilotPromptInputSchema,
    rawInput,
    'config_update_autopilot_prompt',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const prompts = { ...config.autopilot?.prompts };
  if (parsed.input.prompt === null) {
    delete prompts[parsed.input.mode];
  } else {
    prompts[parsed.input.mode] = parsed.input.prompt;
  }

  const next = parseAppConfig(
    {
      ...config,
      autopilot: {
        ...config.autopilot,
        prompts,
      },
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.autopilot?.prompts ?? {}) !==
    JSON.stringify(next.autopilot?.prompts ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_autopilot_prompt',
      file: paths.config,
      target: `autopilot.prompts.${parsed.input.mode}`,
      before: config,
      after: next,
    });
  }

  return okResult(
    'config_update_autopilot_prompt',
    changed,
    paths,
    [paths.config],
    {
      message: changed
        ? `Updated the ${parsed.input.mode} owner prompt. Existing owners use it on their next turn.`
        : 'The Autopilot owner prompt already matched the requested value.',
      data: autopilotPromptData(next),
    },
  );
}

function autopilotPromptData(config: ReturnType<typeof parseAppConfig>) {
  return {
    prompts: effectiveAutopilotOwnerPromptTemplates(config),
    defaults: defaultAutopilotOwnerPromptTemplates,
    overrides: config.autopilot?.prompts ?? {},
    tokens: autopilotOwnerPromptTokens,
    appliesAfter: 'next-owner-turn',
  };
}
