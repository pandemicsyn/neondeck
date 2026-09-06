import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  factoryCodingReadinessSchema,
  type FactoryCodingConfig,
} from '../../../shared/factory-coding';
import { inspectCodexReadiness, localHostCapability } from '../coding-runs';
import type { RuntimePaths } from '../../runtime-home';
import { codingConfig } from './coding-context';
export const supportedCodingVersion = 'codex-cli 0.150.1';
export function localCodingConfig(config: FactoryCodingConfig) {
  if (!config.executable || !config.model)
    throw new Error('Select an absolute Codex executable and model.');
  return {
    executable: config.executable,
    model: config.model,
    path: config.path,
    sandbox: config.sandbox,
    wallTimeMs: config.wallTimeMs,
    maxOutputBytes: config.maxOutputBytes,
    maxLineBytes: 1048576,
    termGraceMs: 5000,
  };
}
export function selectedCodingAuth(config: FactoryCodingConfig) {
  if (!config.auth)
    throw new Error('Select a credential environment reference.');
  const value = process.env[config.auth.env];
  if (!value || value.length > 131072)
    throw new Error('Selected credential reference is unavailable or invalid.');
  if (config.auth.kind === 'auth-json') {
    try {
      v.parse(v.record(v.string(), v.unknown()), JSON.parse(value));
    } catch {
      throw new Error('Selected credential JSON is invalid.');
    }
  } else if (value.length > 16384)
    throw new Error('Selected credential is invalid.');
  return { kind: config.auth.kind, value };
}
export async function codingReadiness(paths: RuntimePaths) {
  const { coding, factoryEnabled } = codingConfig(paths);
  const blockers: string[] = [];
  if (!factoryEnabled) blockers.push('Factory is disabled.');
  if (!coding.enabled) blockers.push('Coding is disabled.');
  if (!localHostCapability().supported)
    blockers.push('Local supervisor platform is unsupported.');
  let installedVersion: string | null = null;
  try {
    selectedCodingAuth(coding);
  } catch {
    blockers.push('Selected credential reference is unavailable or invalid.');
  }
  if (!coding.executable || !coding.model)
    blockers.push('Select an absolute Codex executable and model.');
  else {
    await mkdir(join(paths.home, 'coding-readiness'), {
      recursive: true,
      mode: 0o700,
    });
    const home = await mkdtemp(join(paths.home, 'coding-readiness', 'probe-'));
    try {
      const result = await inspectCodexReadiness(
        localCodingConfig(coding),
        home,
      );
      installedVersion = result.version;
      if (!result.ready) blockers.push(result.reason ?? 'CLI is unavailable.');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
  return v.parse(factoryCodingReadinessSchema, {
    ready: blockers.length === 0,
    enabled: factoryEnabled && coding.enabled,
    supportedVersion: supportedCodingVersion,
    installedVersion,
    blockers,
  });
}
