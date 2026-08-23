import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import { openDb } from '../../../lib/sqlite';
import { randomUUID } from 'node:crypto';
import {
  acquireWorkspaceProviderCoordinator,
  releaseWorkspaceProviderCoordinator,
  superviseWorkspaceProviderCoordinator,
} from '../../scheduled-tasks/workspace-store';
import { recordConfigChange } from '../history';
import { writeJson } from '../files';
import { parseActionInput, failResult, okResult } from '../result';
import {
  updateWorkspaceProviderInputSchema,
  type ConfigActionResult,
} from '../schemas';

export async function updateWorkspaceProviderConfig(
  rawInput: unknown,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateWorkspaceProviderInputSchema,
    rawInput,
    'config_update_workspace_provider',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  if (!input.remove && !input.config && !input.makeDefaultRemote) {
    return failResult(
      'config_update_workspace_provider',
      paths,
      [paths.config],
      {
        message:
          'Provide a provider config, remove=true, or makeDefaultRemote=true.',
        requires: ['config'],
      },
    );
  }
  if (input.remove && input.makeDefaultRemote) {
    return failResult(
      'config_update_workspace_provider',
      paths,
      [paths.config],
      {
        message:
          'A workspace provider cannot be removed and selected as the default remote in the same update.',
        requires: ['chooseOneMutation'],
      },
    );
  }
  if (input.id === 'local' && (input.remove || input.config)) {
    return failResult(
      'config_update_workspace_provider',
      paths,
      [paths.config],
      {
        message:
          'The built-in local workspace provider cannot be replaced or removed.',
        requires: ['remoteProviderId'],
      },
    );
  }
  if (input.id === 'exe.dev' && input.remove) {
    return failResult(
      'config_update_workspace_provider',
      paths,
      [paths.config],
      {
        message:
          'The built-in exe.dev compatibility provider cannot be removed. Leave it unselected or replace its explicit configuration.',
        requires: ['config'],
      },
    );
  }
  if (input.confirm !== true) {
    return failResult(
      'config_update_workspace_provider',
      paths,
      [paths.config],
      {
        message:
          'Workspace provider configuration changes require explicit confirmation.',
        requires: ['confirm'],
      },
    );
  }
  const coordinatorOwner = `workspace-provider-config:${randomUUID()}`;
  if (!(await acquireWorkspaceProviderCoordinator(coordinatorOwner, paths))) {
    return failResult(
      'config_update_workspace_provider',
      paths,
      [paths.config],
      {
        message:
          'Workspace provider configuration is busy with a scheduled workspace admission. Retry shortly.',
        requires: ['retry'],
      },
    );
  }
  const coordinatorLease = superviseWorkspaceProviderCoordinator(
    coordinatorOwner,
    paths,
  );
  try {
    coordinatorLease.assertLease();
    const current = await readRuntimeJson(paths.config, parseAppConfig);
    const providers = { ...current.workspaces?.providers };
    if (
      input.remove &&
      executionReferencesProvider(current.execution, input.id)
    ) {
      return failResult(
        'config_update_workspace_provider',
        paths,
        [paths.config],
        {
          message: `Workspace provider "${input.id}" is still referenced by execution.defaultBackend, enabledBackends, or command preapprovals. Update execution policy before removing it.`,
          requires: ['executionPolicy'],
        },
      );
    }
    const providerDefinitionChanges =
      input.remove ||
      (input.config !== undefined &&
        JSON.stringify(providers[input.id]) !== JSON.stringify(input.config));
    if (
      providerDefinitionChanges &&
      executionApprovalsReferenceProvider(input.id, paths.neondeckDatabase)
    ) {
      return failResult(
        'config_update_workspace_provider',
        paths,
        [paths.config],
        {
          message: `Workspace provider "${input.id}" cannot be removed or replaced while pending or reusable execution approvals are bound to its exact configuration and target. Resolve, deny, or exhaust those approvals first.`,
          requires: ['executionApprovals'],
        },
      );
    }
    if (
      providerDefinitionChanges &&
      hasMaterialWorkspaceResources(input.id, paths.neondeckDatabase)
    ) {
      return failResult(
        'config_update_workspace_provider',
        paths,
        [paths.config],
        {
          message: `Workspace provider "${input.id}" cannot be removed or replaced while retained or cleanup-pending resources still depend on its adapter configuration. Clean up or detach those resources first.`,
          requires: ['workspaceCleanup'],
        },
      );
    }
    if (
      input.remove &&
      scheduledTasksReferenceProvider(input.id, paths.neondeckDatabase)
    ) {
      return failResult(
        'config_update_workspace_provider',
        paths,
        [paths.config],
        {
          message: `Workspace provider "${input.id}" is still referenced by a scheduled task. Update or delete those task specifications before removing it.`,
          requires: ['scheduledTasks'],
        },
      );
    }
    if (input.remove) delete providers[input.id];
    if (input.config) providers[input.id] = input.config;
    if (
      input.makeDefaultRemote &&
      input.id !== 'exe.dev' &&
      !providers[input.id]
    ) {
      return failResult(
        'config_update_workspace_provider',
        paths,
        [paths.config],
        {
          message: `Workspace provider "${input.id}" must be configured before it can be the default remote.`,
          requires: ['config'],
        },
      );
    }
    const defaultRemoteProvider = input.makeDefaultRemote
      ? input.id
      : current.workspaces?.defaultRemoteProvider === input.id && input.remove
        ? undefined
        : current.workspaces?.defaultRemoteProvider;
    const next = parseAppConfig(
      {
        ...current,
        workspaces: {
          ...(defaultRemoteProvider ? { defaultRemoteProvider } : {}),
          providers,
        },
      },
      paths.config,
    );
    const changed =
      JSON.stringify(current.workspaces ?? {}) !==
      JSON.stringify(next.workspaces ?? {});
    if (changed) {
      coordinatorLease.assertLease();
      await writeJson(paths.config, next);
      coordinatorLease.assertLease();
      recordConfigChange(paths, {
        action: 'config_update_workspace_provider',
        file: paths.config,
        target: `workspaces.providers.${input.id}`,
        before: current,
        after: next,
      });
    }
    return okResult(
      'config_update_workspace_provider',
      changed,
      paths,
      [paths.config],
      {
        message: changed
          ? 'Updated workspace provider configuration. New scheduled admissions will use it immediately.'
          : 'Workspace provider configuration already matched the requested values.',
        data: { workspaces: next.workspaces, appliesAfter: 'next-admission' },
      },
    );
  } finally {
    coordinatorLease.stop();
    await releaseWorkspaceProviderCoordinator(coordinatorOwner, paths);
  }
}

function scheduledTasksReferenceProvider(
  providerId: string,
  databasePath: string,
) {
  const database = openDb(databasePath, { readOnly: true });
  try {
    return Boolean(
      database
        .prepare(
          `SELECT 1 FROM scheduled_tasks
           WHERE json_valid(payload_json)
             AND json_extract(payload_json, '$.workspace.kind') = 'repository'
             AND json_extract(payload_json, '$.workspace.providerId') = ?
           LIMIT 1;`,
        )
        .get(providerId),
    );
  } finally {
    database.close();
  }
}

function executionReferencesProvider(
  execution: ReturnType<typeof parseAppConfig>['execution'],
  providerId: string,
) {
  return Boolean(
    execution?.defaultBackend === providerId ||
    execution?.enabledBackends?.includes(providerId) ||
    execution?.preapprovedCommands?.some((command) =>
      command.backends?.includes(providerId),
    ),
  );
}

function executionApprovalsReferenceProvider(
  providerId: string,
  databasePath: string,
) {
  const database = openDb(databasePath, { readOnly: true });
  try {
    return Boolean(
      database
        .prepare(
          `SELECT 1 FROM execution_approvals
           WHERE status IN ('pending', 'approved')
             AND json_valid(request_context_json)
             AND json_extract(
               request_context_json,
               '$.neondeckExecutionScope.backend'
             ) = ?
           LIMIT 1;`,
        )
        .get(providerId),
    );
  } finally {
    database.close();
  }
}

function hasMaterialWorkspaceResources(
  providerId: string,
  databasePath: string,
) {
  const database = openDb(databasePath, { readOnly: true });
  try {
    return Boolean(
      database
        .prepare(
          `SELECT 1 FROM task_workspaces
           WHERE provider_id = ? AND status <> 'deleted'
           LIMIT 1;`,
        )
        .get(providerId),
    );
  } finally {
    database.close();
  }
}
