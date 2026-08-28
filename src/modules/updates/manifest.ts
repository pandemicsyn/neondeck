import { compareVersions, parseVersion } from './version';

export const updateManifestSchema = 1 as const;
export const updateManifestMessageMaxLength = 2_000;

export type UpdateManifest = {
  schema: typeof updateManifestSchema;
  latest: string | null;
  next: string | null;
  date: string;
  msg: string;
};

type NpmPackument = {
  'dist-tags'?: unknown;
  time?: unknown;
};

export function parseUpdateManifest(value: unknown): UpdateManifest | null {
  if (!isRecord(value) || value.schema !== updateManifestSchema) return null;
  const latest = parseChannelVersion(value.latest);
  const next = parseChannelVersion(value.next);
  if (latest === undefined || next === undefined || (!latest && !next)) {
    return null;
  }
  if (!isIsoDate(value.date)) return null;
  if (
    typeof value.msg !== 'string' ||
    value.msg.length > updateManifestMessageMaxLength
  ) {
    return null;
  }
  return {
    schema: updateManifestSchema,
    latest,
    next,
    date: value.date,
    msg: value.msg,
  };
}

export function buildPublishedUpdateManifest(
  packument: NpmPackument,
  msg = '',
): UpdateManifest {
  const distTags = packument['dist-tags'];
  const times = packument.time;
  if (!isRecord(distTags) || !isRecord(times)) {
    throw new Error('npm returned incomplete Neondeck release metadata.');
  }

  const latest = publishedChannelVersion(distTags.latest);
  const next = publishedChannelVersion(distTags.next);
  if (!latest && !next) {
    throw new Error('npm returned no Neondeck latest or next dist-tag.');
  }

  const dates = [latest, next]
    .filter((version): version is string => version !== null)
    .map((version) => publishedVersionDate(times[version], version));

  const manifest = parseUpdateManifest({
    schema: updateManifestSchema,
    latest,
    next,
    date: new Date(
      Math.max(...dates.map((date) => date.getTime())),
    ).toISOString(),
    msg,
  });
  if (!manifest)
    throw new Error('Generated an invalid Neondeck update manifest.');
  return manifest;
}

export function manifestChannelIncludesRelease(
  manifest: UpdateManifest,
  channel: 'latest' | 'next',
  expectedVersion: string,
) {
  if (!parseVersion(expectedVersion)) {
    throw new Error(`Invalid expected release version ${expectedVersion}.`);
  }
  const publishedVersion = manifest[channel];
  return (
    publishedVersion !== null &&
    compareVersions(publishedVersion, expectedVersion) >= 0
  );
}

function parseChannelVersion(value: unknown) {
  if (value === null) return null;
  return typeof value === 'string' && parseVersion(value) ? value : undefined;
}

function publishedChannelVersion(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !parseVersion(value)) {
    throw new Error('npm returned an invalid Neondeck dist-tag version.');
  }
  return value;
}

function publishedVersionDate(value: unknown, version: string) {
  if (typeof value !== 'string') {
    throw new Error(`npm returned no publication date for ${version}.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`npm returned an invalid publication date for ${version}.`);
  }
  return date;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
