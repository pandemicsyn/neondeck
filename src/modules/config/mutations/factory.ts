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
  const factory = v.parse(factoryConfigSchema, input);
  const before = readRuntimeJsonSync(paths.config, parseAppConfig);
  const after = parseAppConfig({ ...before, factory }, paths.config);
  // Synchronous read/replace avoids yielding between sibling local config writes.
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
