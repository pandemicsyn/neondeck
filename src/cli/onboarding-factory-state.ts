import * as v from 'valibot';
import { factoryConfigSchema } from '../../shared/factory';
import {
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJsonSync,
  type RuntimePaths,
} from '../runtime-home';
import {
  updateFactoryConfig,
  factoryConfigSnapshotFingerprint,
} from '../modules/config';
import { isRegisteredProvider } from '../modules/repos';
import { resolveAgentModelSelection } from '../modules/runtime/agent-config';

export function readFactorySetup(paths: RuntimePaths) {
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  const repos = readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos;
  const factory = v.parse(factoryConfigSchema, config.factory ?? {});
  const models = resolveAgentModelSelection(config);
  const modelIssues = [models.displayAssistant, models.utility].filter(
    (model) => {
      const slash = model.indexOf('/');
      return (
        slash < 1 ||
        !model.slice(slash + 1).trim() ||
        !isRegisteredProvider(model.slice(0, slash), {
          providers: config.providers,
        })
      );
    },
  );
  return {
    config,
    repos,
    factory,
    models,
    modelIssues,
    fingerprint: factoryConfigSnapshotFingerprint(config, repos),
  };
}

export function applyFactorySetup(
  paths: RuntimePaths,
  fingerprint: string,
  proposal: unknown,
) {
  const current = readFactorySetup(paths);
  if (current.fingerprint !== fingerprint)
    throw new Error(
      'Configuration or repositories changed during setup. Run factory setup again to review current settings.',
    );
  const next = v.parse(factoryConfigSchema, proposal);
  if (current.factory.enabled && !next.enabled)
    throw new Error('Setup cannot disable an existing factory.');
  if (next.coding.enabled !== current.factory.coding.enabled)
    throw new Error('Setup cannot change coding authority.');
  if (next.enabled && current.modelIssues.length)
    throw new Error(
      'Configure registered planning and utility model references before enabling intake.',
    );
  if (JSON.stringify(next) === JSON.stringify(current.factory))
    return current.factory;
  return updateFactoryConfig(next, paths, { expectedFingerprint: fingerprint });
}
