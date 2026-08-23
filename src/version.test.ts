import { describe, expect, it, vi } from 'vitest';
import { resolveBuildVersion } from './package-version';
import { resolveRuntimeVersion, unknownNeondeckVersion } from './version';

describe('Neondeck runtime version', () => {
  it('uses an embedded version without reading package metadata', () => {
    const readInstalledVersion = vi.fn<() => string>();

    expect(resolveRuntimeVersion('1.2.3', readInstalledVersion)).toBe('1.2.3');
    expect(readInstalledVersion).not.toHaveBeenCalled();
  });

  it('falls back to a valid sentinel when package metadata is unreadable', () => {
    expect(
      resolveRuntimeVersion(undefined, () => {
        throw new Error('package.json is unreadable');
      }),
    ).toBe(unknownNeondeckVersion);
  });

  it('validates release overrides before embedding them', () => {
    const packageJsonUrl = new URL('file:///missing/package.json');

    expect(resolveBuildVersion(packageJsonUrl, '2.0.0-beta.1')).toBe(
      '2.0.0-beta.1',
    );
    expect(() => resolveBuildVersion(packageJsonUrl, 'not-semver')).toThrow(
      'NEONDECK_RELEASE_VERSION must be a valid semantic version',
    );
  });
});
