import * as v from 'valibot';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  resolveRoutinesConfig,
  runtimePaths,
} from '../../../runtime-home';
import { writeJson } from '../files';
import { recordConfigChange } from '../history';
import { failResult, okResult, parseActionInput } from '../result';
import {
  updateRoutinesConfigInputSchema,
  type ConfigActionResult,
} from '../schemas';

export async function updateRoutinesConfig(
  rawInput: v.InferInput<typeof updateRoutinesConfigInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateRoutinesConfigInputSchema,
    rawInput,
    'config_update_routines',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  if (parsed.input.enabled === undefined) {
    return failResult('config_update_routines', paths, [paths.config], {
      message: 'At least one routines config value is required.',
      requires: ['enabled'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const next = parseAppConfig(
    {
      ...config,
      routines: {
        ...config.routines,
        enabled: parsed.input.enabled,
      },
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.routines ?? {}) !==
    JSON.stringify(next.routines ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_routines',
      file: paths.config,
      target: 'routines',
      before: config,
      after: next,
    });
  }

  return okResult('config_update_routines', changed, paths, [paths.config], {
    message: changed
      ? `Routines are now ${resolveRoutinesConfig(next).enabled ? 'enabled' : 'disabled'}.`
      : 'Routine configuration already matched the requested values.',
    data: {
      routines: resolveRoutinesConfig(next),
      appliesAfter: 'immediate',
    },
  });
}
