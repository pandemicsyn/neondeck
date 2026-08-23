import * as v from 'valibot';
import { randomUUID } from 'node:crypto';
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
} from '../../execution-policy';
import type { ConfigActionResult } from '../schemas';
import {
  acquireWorkspaceProviderCoordinator,
  releaseWorkspaceProviderCoordinator,
  superviseWorkspaceProviderCoordinator,
} from '../../scheduled-tasks/workspace-store';

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

  const coordinatorOwner = `execution-config:${randomUUID()}`;
  if (!(await acquireWorkspaceProviderCoordinator(coordinatorOwner, paths))) {
    return failResult('config_update_execution_policy', paths, [paths.config], {
      message:
        'Execution and workspace provider configuration is busy. Retry shortly.',
      requires: ['retry'],
    });
  }
  const coordinatorLease = superviseWorkspaceProviderCoordinator(
    coordinatorOwner,
    paths,
  );
  try {
    coordinatorLease.assertLease();
    const config = await readRuntimeJson(paths.config, parseAppConfig);
    const nextExecution = mergeExecutionConfig(config.execution, input);
    const supportedBackends = new Set([
      'local',
      'exe.dev',
      ...Object.keys(config.workspaces?.providers ?? {}),
    ]);
    const referencedBackends = [
      ...(nextExecution.defaultBackend ? [nextExecution.defaultBackend] : []),
      ...(nextExecution.enabledBackends ?? []),
      ...(nextExecution.preapprovedCommands ?? []).flatMap(
        (command) => command.backends ?? [],
      ),
    ];
    const unknownBackends = [...new Set(referencedBackends)].filter(
      (backend) => !supportedBackends.has(backend),
    );
    if (unknownBackends.length > 0) {
      return failResult(
        'config_update_execution_policy',
        paths,
        [paths.config],
        {
          message: `Execution policy references unconfigured workspace providers: ${unknownBackends.join(', ')}.`,
          requires: ['workspaceProvider'],
        },
      );
    }
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
      coordinatorLease.assertLease();
      await writeJson(paths.config, next);
      coordinatorLease.assertLease();
      recordConfigChange(paths, {
        action: 'config_update_execution_policy',
        file: paths.config,
        target: 'execution',
        before: config,
        after: next,
      });
    }

    const policy = executionPolicyFromConfig({
      execution: next.execution,
      workspaces: next.workspaces,
    });
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
  } finally {
    coordinatorLease.stop();
    await releaseWorkspaceProviderCoordinator(coordinatorOwner, paths);
  }
}
