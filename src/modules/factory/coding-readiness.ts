import { statSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  factoryCodingReadinessSchema,
  type FactoryCodingConfig,
} from '../../../shared/factory-coding';
import { inspectCodexReadiness, localHostCapability } from '../coding-runs';
import type { RuntimePaths } from '../../runtime-home';
import { codingConfig, codingDigest } from './coding-context';
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
type Readiness = v.InferOutput<typeof factoryCodingReadinessSchema>;
type ReadinessEntry = {
  fingerprint: string;
  pending: Promise<Readiness>;
  settled: boolean;
};
// Failure-only, process-local cache. Restart/eviction probes afresh. No credential
// contents or hashes enter this cache, app metadata, or the public response.
const readinessFailures = new Map<string, ReadinessEntry>();
const maxReadinessHomes = 32;

function executableStamp(path: string | null) {
  if (!path) return null;
  try {
    // Follow symlinks so replacing their target or fixing permissions retries.
    const file = statSync(path);
    return {
      dev: file.dev,
      ino: file.ino,
      size: file.size,
      mtime: file.mtimeMs,
      ctime: file.ctimeMs,
      mode: file.mode,
    };
  } catch {
    return null;
  }
}
function readinessInput(paths: RuntimePaths) {
  const { coding, factoryEnabled } = codingConfig(paths);
  let authAvailable = false;
  try {
    selectedCodingAuth(coding);
    authAvailable = true;
  } catch {
    /* Missing or invalid selected credential is a local blocker. */
  }
  const supported = localHostCapability().supported;
  return {
    coding,
    factoryEnabled,
    authAvailable,
    supported,
    fingerprint: codingDigest({
      coding,
      factoryEnabled,
      authAvailable,
      supported,
      executable: executableStamp(coding.executable),
    }),
  };
}
function blockedReadiness(
  input: ReturnType<typeof readinessInput>,
  blockers: string[],
): Readiness {
  return v.parse(factoryCodingReadinessSchema, {
    ready: false,
    enabled: input.factoryEnabled && input.coding.enabled,
    supportedVersion: supportedCodingVersion,
    installedVersion: null,
    blockers,
  });
}
export async function codingReadiness(paths: RuntimePaths): Promise<Readiness> {
  const input = readinessInput(paths);
  const key = JSON.stringify([paths.home, paths.config]);
  let entry = readinessFailures.get(key);
  if (entry && entry.fingerprint !== input.fingerprint) {
    // Drain a probe for old settings before starting another for this home. A
    // concurrent config/auth change must neither overlap probes nor return ready
    // from stale settings. Re-read current inputs after that probe settles.
    if (!entry.settled) {
      await entry.pending.catch(() => undefined);
      return codingReadiness(paths);
    }
    readinessFailures.delete(key);
    entry = undefined;
  }
  if (!entry) {
    if (readinessFailures.size >= maxReadinessHomes) {
      const oldestSettled = [...readinessFailures].find(
        ([, value]) => value.settled,
      );
      if (oldestSettled) readinessFailures.delete(oldestSettled[0]);
      else
        return blockedReadiness(input, [
          'Readiness probes are busy. Retry shortly.',
        ]);
    }
    const created: ReadinessEntry = {
      fingerprint: input.fingerprint,
      pending: probeCodingReadiness(paths, input),
      settled: false,
    };
    entry = created;
    readinessFailures.set(key, created);
    void created.pending.then(
      (result) => {
        created.settled = true;
        // Success is only shared with concurrent callers; launch retains its own
        // real readiness checks. Unexpected I/O errors are not cached either.
        if (result.ready && readinessFailures.get(key) === created)
          readinessFailures.delete(key);
      },
      () => {
        created.settled = true;
        if (readinessFailures.get(key) === created)
          readinessFailures.delete(key);
      },
    );
  }
  const result = await entry.pending;
  if (readinessInput(paths).fingerprint !== entry.fingerprint)
    return codingReadiness(paths);
  // Return a fresh validated projection so callers cannot mutate cached blockers.
  return v.parse(factoryCodingReadinessSchema, result);
}
async function probeCodingReadiness(
  paths: RuntimePaths,
  input: ReturnType<typeof readinessInput>,
): Promise<Readiness> {
  const { coding, factoryEnabled, authAvailable, supported } = input;
  const blockers: string[] = [];
  if (!factoryEnabled) blockers.push('Factory is disabled.');
  if (!coding.enabled) blockers.push('Coding is disabled.');
  if (!supported) blockers.push('Local supervisor platform is unsupported.');
  if (!authAvailable)
    blockers.push('Selected credential reference is unavailable or invalid.');
  if (!coding.executable || !coding.model)
    blockers.push('Select an absolute Codex executable and model.');
  if (blockers.length) return blockedReadiness(input, blockers);
  await mkdir(join(paths.home, 'coding-readiness'), {
    recursive: true,
    mode: 0o700,
  });
  const home = await mkdtemp(join(paths.home, 'coding-readiness', 'probe-'));
  try {
    const result = await inspectCodexReadiness(localCodingConfig(coding), home);
    return v.parse(factoryCodingReadinessSchema, {
      ready: result.ready,
      enabled: true,
      supportedVersion: supportedCodingVersion,
      // The host accepts empty stdout as an unsupported version. Keep that
      // ordinary failure schema-valid so unchanged polls reuse it.
      installedVersion: result.version?.trim() || null,
      blockers: result.ready ? [] : [result.reason ?? 'CLI is unavailable.'],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
