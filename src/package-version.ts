import { readFileSync } from 'node:fs';
import { parseVersion } from './modules/updates/version.ts';

export function readPackageVersion(packageJsonUrl: URL) {
  let parsed: { version?: unknown };
  try {
    parsed = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as {
      version?: unknown;
    };
  } catch (error) {
    throw new Error(`Could not read ${packageJsonUrl.pathname}.`, {
      cause: error,
    });
  }
  const version =
    typeof parsed.version === 'string' ? parsed.version.trim() : '';
  if (!parseVersion(version)) {
    throw new Error(
      `${packageJsonUrl.pathname} does not contain a valid semantic version.`,
    );
  }
  return version;
}

export function resolveBuildVersion(
  packageJsonUrl: URL,
  releaseVersion = process.env.NEONDECK_RELEASE_VERSION,
) {
  const override = releaseVersion?.trim();
  if (override) {
    if (!parseVersion(override)) {
      throw new Error(
        `NEONDECK_RELEASE_VERSION must be a valid semantic version, got ${JSON.stringify(override)}.`,
      );
    }
    return override;
  }
  return readPackageVersion(packageJsonUrl);
}
