import { createHash } from 'node:crypto';
import { renameSync, writeFileSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import {
  repoFactoryWorkflowsSchema,
  saveRepoWorkflowsInputSchema,
  type RepoWorkflowsSnapshot,
  type RepoWorkflowProfile,
} from '../../../shared/repo-workflows';
import {
  readRuntimeJsonSync,
  parseRepoRegistry,
  parseAppConfig,
  type RuntimePaths,
  type RepoConfig,
  type AppConfig,
} from '../../runtime-home';
import { repoGuardrails } from '../repo-guardrails';
import { withFactoryMutationLock, recordConfigChange } from '../config';
import { invalidateFactoryRepoContext } from '../factory';

export class RepoWorkflowError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function readRepoWorkflows(
  repoId: string,
  paths: RuntimePaths,
): RepoWorkflowsSnapshot {
  const registry = readRuntimeJsonSync(paths.repos, parseRepoRegistry);
  const repo = registry.repos.find((entry) => entry.id === repoId);
  if (!repo) throw new RepoWorkflowError('Repository not found.', 404);
  const app = readRuntimeJsonSync(paths.config, parseAppConfig);
  return {
    repoId,
    fingerprint: digest({
      repo,
      requiredChecks: repoGuardrails(repo, app).requiredChecks,
    }),
    workflows: repo.factoryWorkflows ?? null,
  };
}
export function assertRepoWorkflowFingerprint(
  repoId: string,
  expected: string,
  paths: RuntimePaths,
) {
  const snapshot = readRepoWorkflows(repoId, paths);
  if (snapshot.fingerprint !== expected)
    throw new RepoWorkflowError(
      'Repository workflow context changed. Reload and retry.',
      409,
    );
  return snapshot;
}
export function saveRepoWorkflows(
  repoId: string,
  raw: unknown,
  paths: RuntimePaths,
): RepoWorkflowsSnapshot {
  return withFactoryMutationLock(paths.config, () => {
    const input = v.parse(saveRepoWorkflowsInputSchema, raw);
    assertRepoWorkflowFingerprint(repoId, input.expectedFingerprint, paths);
    const registry = readRuntimeJsonSync(paths.repos, parseRepoRegistry);
    const repo = registry.repos.find((entry) => entry.id === repoId)!;
    const nextRepo = { ...repo };
    if (input.workflows === null) delete nextRepo.factoryWorkflows;
    else nextRepo.factoryWorkflows = input.workflows;
    const next = parseRepoRegistry(
      {
        ...registry,
        repos: registry.repos.map((entry) =>
          entry.id === repoId ? nextRepo : entry,
        ),
      },
      paths.repos,
    );
    if (JSON.stringify(repo) !== JSON.stringify(nextRepo)) {
      // Like repo registry mutations, check + revoke + atomic replacement are
      // synchronous under the shared Factory lock. Legacy repo writers do not
      // acquire that lock, so no multi-process registry CAS is claimed.
      assertRepoWorkflowFingerprint(repoId, input.expectedFingerprint, paths);
      if (
        !isDeepStrictEqual(
          registry,
          readRuntimeJsonSync(paths.repos, parseRepoRegistry),
        )
      )
        throw new RepoWorkflowError(
          'Repository registry changed. Reload and retry.',
          409,
        );
      invalidateFactoryRepoContext(repoId, paths);
      const temporary = `${paths.repos}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
        });
        renameSync(temporary, paths.repos);
      } finally {
        rmSync(temporary, { force: true });
      }
      recordConfigChange(paths, {
        action: 'config_update_repo_factory_workflows',
        file: paths.repos,
        target: repoId,
        before: registry,
        after: next,
      });
    }
    return readRepoWorkflows(repoId, paths);
  });
}
export function resolveRepoWorkflow(
  repo: RepoConfig,
  app: AppConfig,
  profileId?: string | null,
): RepoWorkflowProfile | null {
  if (!repo.factoryWorkflows) {
    if (profileId)
      throw new RepoWorkflowError('Selected workflow is no longer configured.');
    return null;
  }
  const config = v.parse(repoFactoryWorkflowsSchema, repo.factoryWorkflows);
  const selectedId = profileId ?? config.defaultProfileId;
  if (!selectedId)
    throw new RepoWorkflowError(
      'Select a workflow explicitly or configure a default.',
    );
  const profile = config.profiles.find((entry) => entry.id === selectedId);
  if (!profile)
    throw new RepoWorkflowError('Selected workflow is no longer configured.');
  const resolved = structuredClone(profile);
  for (const command of repoGuardrails(repo, app).requiredChecks) {
    if (
      !resolved.validationCommands.some(
        (entry) => entry.command === command && entry.cwd === '.',
      )
    )
      resolved.validationCommands.push({ command, cwd: '.' });
  }
  if (!resolved.validationCommands.length)
    throw new RepoWorkflowError(
      'Configure at least one validation command or mandatory repository check.',
    );
  if (resolved.validationCommands.length > 16)
    throw new RepoWorkflowError(
      'Workflow and mandatory checks exceed the 16 validation command limit.',
    );
  return resolved;
}
