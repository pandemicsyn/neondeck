import { invalidateFactoryConfig } from '../../factory';
import * as v from 'valibot';
import { factoryConfigSchema } from '../../../../shared/factory';
import {
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
} from '../../../runtime-home';
import { writeJsonAtomicSync } from '../../../runtime-home/files';
import { recordConfigChange } from '../history';

export function updateFactoryConfig(input: unknown, paths = runtimePaths()) {
  const before = readRuntimeJsonSync(paths.config, parseAppConfig);
  const factory = v.parse(factoryConfigSchema, {
    ...before.factory,
    ...v.parse(v.record(v.string(), v.unknown()), input),
  });
  const after = parseAppConfig({ ...before, factory }, paths.config);
  // Synchronous read/replace avoids yielding between sibling local config writes.
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
