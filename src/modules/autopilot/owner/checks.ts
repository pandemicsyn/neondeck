import {
  parseAppConfig,
  readRuntimeJson,
  type RuntimePaths,
} from '../../../runtime-home';
import { readRepoRegistrySnapshot } from '../../repos';
import { repoGuardrails } from '../../autopilot-policy';
import type { PrWatch } from '../../watches';

export async function configuredAutopilotChecks(
  watch: Pick<PrWatch, 'repoId'>,
  paths: RuntimePaths,
) {
  const [registry, appConfig] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === watch.repoId,
  );
  if (!repo) throw new Error(`Repository "${watch.repoId}" is not configured.`);
  return {
    repo,
    checks: [...repoGuardrails(repo, appConfig).requiredChecks],
  };
}
