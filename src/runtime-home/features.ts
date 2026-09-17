import { readRuntimeJsonSync } from './files';
import { runtimePaths, type RuntimePaths } from './paths';
import { parseAppConfig, type AppConfig } from './schemas';

/** Runtime flags come only from saved config. Environment defaults are seeded once. */
export function resolveFeatures(config: Pick<AppConfig, 'features'>) {
  return { factory: config.features?.factory === true };
}

export function readFeatures(paths: RuntimePaths = runtimePaths()) {
  return resolveFeatures(readRuntimeJsonSync(paths.config, parseAppConfig));
}

/** Guard Flue-owned recovery as well as submissions started by app services. */
export function assertFactoryEnabled() {
  if (!readFeatures().factory)
    throw new Error('Software Factory is disabled in runtime config.');
}
