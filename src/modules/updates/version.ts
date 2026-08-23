export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
};

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(value: string): ParsedVersion | null {
  const match = semverPattern.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4]
          .split('.')
          .map((identifier) =>
            /^0$|^[1-9]\d*$/.test(identifier) ? Number(identifier) : identifier,
          )
      : [],
  };
}

export function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    throw new Error(`Cannot compare invalid versions ${left} and ${right}.`);
  }

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aIdentifier = a.prerelease[index];
    const bIdentifier = b.prerelease[index];
    if (aIdentifier === undefined) return -1;
    if (bIdentifier === undefined) return 1;
    if (aIdentifier === bIdentifier) continue;
    if (typeof aIdentifier === 'number' && typeof bIdentifier === 'string') {
      return -1;
    }
    if (typeof aIdentifier === 'string' && typeof bIdentifier === 'number') {
      return 1;
    }
    return aIdentifier < bIdentifier ? -1 : 1;
  }
  return 0;
}

export function updateChannelForVersion(version: string) {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`Invalid installed version ${version}.`);
  return parsed.prerelease.length > 0 ? ('next' as const) : ('latest' as const);
}
