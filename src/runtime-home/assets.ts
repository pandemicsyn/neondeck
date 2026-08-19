import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveShippedAsset(
  sourceRelativePath: string,
  bundledRelativePath: string,
  moduleUrl = import.meta.url,
) {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(moduleDirectory, '..', '..', sourceRelativePath),
    resolve(moduleDirectory, bundledRelativePath),
    resolve(process.cwd(), sourceRelativePath),
    resolve(process.cwd(), 'dist', bundledRelativePath),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function resolvePackageRoot(moduleUrl = import.meta.url) {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(moduleDirectory, '..'),
    resolve(moduleDirectory, '..', '..'),
    process.cwd(),
  ];

  return (
    candidates.find((candidate) =>
      existsSync(resolve(candidate, 'package.json')),
    ) ?? candidates[0]
  );
}
