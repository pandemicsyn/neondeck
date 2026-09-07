import { createHash } from 'node:crypto';
import { withFactoryMutationLock } from '../factory-mutation-lock';
import { invalidateFactoryConfig } from '../../factory';
import * as v from 'valibot';
import { factoryConfigSchema } from '../../../../shared/factory';
import {
  parseAppConfig,
  parseRepoRegistry,
  type AppConfig,
  type RepoConfig,
  type RuntimePaths,
  readRuntimeJsonSync,
  runtimePaths,
} from '../../../runtime-home';
import { writeJsonAtomicSync } from '../../../runtime-home/files';
import { recordConfigChange } from '../history';

export function factoryConfigSnapshotFingerprint(
  config: AppConfig,
  repos: readonly RepoConfig[],
) {
  return createHash('sha256')
    .update(JSON.stringify({ config, repos }))
    .digest('hex');
}

export function updateFactoryConfig(
  input: unknown,
  paths = runtimePaths(),
  options: {
    expectedFingerprint?: string;
    precondition?: (before: AppConfig) => undefined;
  } = {},
) {
  return withFactoryMutationLock(paths.config, () => {
    const before = readRuntimeJsonSync(paths.config, parseAppConfig);
    if (
      options.expectedFingerprint !== undefined &&
      v.parse(
        v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
        options.expectedFingerprint,
      ) !==
        factoryConfigSnapshotFingerprint(
          before,
          readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos,
        )
    ) {
      throw new Error(
        'Configuration or repositories changed during setup. Run factory setup again to review current settings.',
      );
    }
    options.precondition?.(before);
    return updateLockedFactoryConfig(input, paths, before);
  });
}
function updateLockedFactoryConfig(
  input: unknown,
  paths: RuntimePaths,
  before: AppConfig,
) {
  const factory = v.parse(factoryConfigSchema, {
    ...before.factory,
    ...v.parse(v.record(v.string(), v.unknown()), input),
  });
  const after = parseAppConfig({ ...before, factory }, paths.config);
  // The shared factory lock serializes CLI/server factory mutation processes.
  // Revoke affected authority before replacing the file. If the file write fails,
  // conservative revocation remains visible; no cross-store atomicity is assumed.
  invalidateFactoryConfig(before, after, paths);
  writeJsonAtomicSync(paths.config, after);
  recordConfigChange(paths, {
    action: 'config_update_factory',
    file: paths.config,
    target: 'factory',
    before,
    after,
  });
  return factory;
}
