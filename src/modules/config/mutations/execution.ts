import * as v from 'valibot';
import { parseActionInput, failResult, okResult } from '../result';
import { recordConfigChange } from '../history';
import { writeJson } from '../files';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import {
  asExecutionPolicyData,
  executionPolicyFromConfig,
  executionPolicyUpdateSchema,
  hasExecutionPolicyUpdate,
  mergeExecutionConfig,
} from '../../../execution-policy';
import type { ConfigActionResult } from '../schemas';

export async function updateExecutionPolicy(
  rawInput: v.InferInput<typeof executionPolicyUpdateSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    executionPolicyUpdateSchema,
    rawInput,
    'config_update_execution_policy',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (!hasExecutionPolicyUpdate(input)) {
    return failResult('config_update_execution_policy', paths, [paths.config], {
      message: 'At least one execution policy setting is required.',
      requires: [
        'defaultBackend',
        'enabledBackends',
        'approvalMode',
        'unattended',
        'preapprovedCommands',
        'exeDev',
      ],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextExecution = mergeExecutionConfig(config.execution, input);
  const next = parseAppConfig(
    {
      ...config,
      execution: nextExecution,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.execution ?? {}) !==
    JSON.stringify(next.execution ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_execution_policy',
      file: paths.config,
      target: 'execution',
      before: config,
      after: next,
    });
  }

  const policy = executionPolicyFromConfig({ execution: next.execution });
  return okResult(
    'config_update_execution_policy',
    changed,
    paths,
    [paths.config],
    {
      message: changed
        ? 'Updated execution approval policy. Approved execution actions will use the new policy immediately when they read config.'
        : 'Execution approval policy already matched the requested values.',
      data: {
        execution: next.execution,
        policy: asExecutionPolicyData(policy),
      },
    },
  );
}
