import { readFileSync } from 'node:fs';

declare const __NEONDECK_VERSION__: string | undefined;

export const neondeckVersion =
  typeof __NEONDECK_VERSION__ === 'string'
    ? __NEONDECK_VERSION__
    : readPackageVersion();

function readPackageVersion() {
  const source = readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8',
  );
  const parsed = JSON.parse(source) as { version?: unknown };
  if (typeof parsed.version !== 'string' || !parsed.version.trim()) {
    throw new Error('package.json does not contain a valid Neondeck version.');
  }
  return parsed.version.trim();
}
