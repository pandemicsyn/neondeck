import { createHash } from 'node:crypto';
import type {
  LinearConnection,
  LinearIssue,
} from '../../../shared/factory-linear';
import {
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJsonSync,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { loadNeondeckEnv } from '../runtime';
import { FactoryError } from './service';
export const linearFingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function linearConnections(paths = runtimePaths()) {
  return (
    readRuntimeJsonSync(paths.config, parseAppConfig).factory?.linear ?? []
  );
}
export function linearMappings(
  connections: LinearConnection[],
  organizationId: string,
  teamId: string,
  projectId: string | null,
) {
  return connections.filter(
    (c) =>
      c.enabled &&
      c.organizationId === organizationId &&
      c.teamId === teamId &&
      (c.projectId === null || c.projectId === projectId),
  );
}
export type LinearCapability =
  'overview' | 'ingress' | 'provider' | 'writeback';
export function linearReadiness(
  connection: LinearConnection,
  paths: RuntimePaths,
  capability: LinearCapability = 'overview',
) {
  const reasons: string[] = [];
  if (!readRuntimeJsonSync(paths.config, parseAppConfig).factory?.enabled)
    reasons.push('Factory is disabled.');
  if (!connection.enabled) reasons.push('Connection is disabled.');
  if (
    !readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos.some(
      (r) => r.id === connection.repoId,
    )
  )
    reasons.push('Select a registered repository.');
  if (connection.admission.mode !== 'all' && !connection.admission.value)
    reasons.push('Select an admission label or state ID.');
  if (
    linearConnections(paths).some(
      (c) =>
        c.id !== connection.id &&
        c.enabled &&
        c.organizationId === connection.organizationId &&
        c.teamId === connection.teamId &&
        (c.projectId === null ||
          connection.projectId === null ||
          c.projectId === connection.projectId),
    )
  )
    reasons.push(
      'Ambiguous team/project mapping. Enable only one matching connection.',
    );
  const needsToken = capability !== 'ingress';
  const needsSecret = capability === 'overview' || capability === 'ingress';
  if (
    (needsToken && !process.env[connection.tokenEnv]) ||
    (needsSecret && !process.env[connection.webhookSecretEnv])
  )
    loadNeondeckEnv(paths, { includeDevFallback: false });
  if (needsToken && !process.env[connection.tokenEnv])
    reasons.push('Linear credential reference is unavailable.');
  if (needsSecret && !process.env[connection.webhookSecretEnv])
    reasons.push('Linear webhook secret reference is unavailable.');
  if (capability === 'writeback' && !connection.writeback.enabled)
    reasons.push('Linear writeback is disabled.');
  return reasons;
}
export function readyLinearConnection(
  id: string,
  paths: RuntimePaths,
  capability: LinearCapability = 'provider',
) {
  const connection = linearConnections(paths).find((c) => c.id === id);
  if (!connection) throw new FactoryError(404, 'Unknown Linear connection.');
  const reasons = linearReadiness(connection, paths, capability);
  if (reasons.length) throw new FactoryError(409, reasons.join(' '));
  return connection;
}
export function linearEligible(
  connection: LinearConnection,
  issue: LinearIssue,
) {
  return (
    connection.admission.mode === 'all' ||
    (connection.admission.mode === 'state'
      ? issue.state.id === connection.admission.value
      : issue.labels.some((l) => l.id === connection.admission.value))
  );
}
