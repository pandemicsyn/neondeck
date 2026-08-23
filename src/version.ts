import { readPackageVersion } from './package-version';

declare const __NEONDECK_VERSION__: string | undefined;

export const unknownNeondeckVersion = '0.0.0-unknown';

export function resolveRuntimeVersion(
  embeddedVersion: string | undefined,
  readInstalledVersion = () =>
    readPackageVersion(new URL('../package.json', import.meta.url)),
) {
  if (embeddedVersion) return embeddedVersion;
  try {
    return readInstalledVersion();
  } catch {
    return unknownNeondeckVersion;
  }
}

export const neondeckVersion = resolveRuntimeVersion(
  typeof __NEONDECK_VERSION__ === 'string' ? __NEONDECK_VERSION__ : undefined,
);
