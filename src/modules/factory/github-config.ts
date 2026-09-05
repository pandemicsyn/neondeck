import { createHash } from 'node:crypto';
import type { GitHubConnection } from '../../../shared/factory-github';
import {
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJsonSync,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { loadNeondeckEnv } from '../runtime';
import { FactoryError } from './service';
export function factoryConnections(paths = runtimePaths()) {
  return (
    readRuntimeJsonSync(paths.config, parseAppConfig).factory?.github ?? []
  );
}
export const connectionFingerprint = (connection: GitHubConnection) =>
  createHash('sha256').update(JSON.stringify(connection)).digest('hex');
export function connectionReadiness(
  connection: GitHubConnection,
  paths: RuntimePaths,
) {
  const reasons: string[] = [];
  if (!readRuntimeJsonSync(paths.config, parseAppConfig).factory?.enabled)
    reasons.push('Factory is disabled.');
  if (!connection.enabled) reasons.push('Connection is disabled.');
  const repo = readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos.find(
    (repo) => repo.id === connection.repoId,
  );
  if (
    !repo ||
    repo.github.owner.toLowerCase() !== connection.owner.toLowerCase() ||
    repo.github.name.toLowerCase() !== connection.name.toLowerCase()
  )
    reasons.push('Map this connection to the matching registered repository.');
  if (
    factoryConnections(paths).filter(
      (other) =>
        other.enabled && other.repositoryId === connection.repositoryId,
    ).length > 1
  )
    reasons.push(
      'Ambiguous repository mapping: enable only one connection for this remote repository.',
    );
  if (connection.admission.mode === 'label' && !connection.admission.label)
    reasons.push('Choose an admission label.');
  loadNeondeckEnv(paths, { includeDevFallback: false });
  if (!process.env[connection.webhookSecretEnv])
    reasons.push('Webhook secret reference is unavailable.');
  if (!process.env[connection.tokenEnv])
    reasons.push('GitHub read credential reference is unavailable.');
  return reasons;
}
export function readyConnection(id: string, paths: RuntimePaths) {
  const connection = factoryConnections(paths).find((item) => item.id === id);
  if (!connection) throw new FactoryError(404, 'Unknown GitHub connection.');
  const reasons = connectionReadiness(connection, paths);
  if (reasons.length) throw new FactoryError(409, reasons.join(' '));
  return connection;
}
