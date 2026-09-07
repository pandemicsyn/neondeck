/* eslint-disable no-control-regex -- Reject terminal control characters at input boundaries. */
import { accessSync, constants, statSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';

export type CodingDiscoveryContext = {
  env: NodeJS.ProcessEnv;
  home: string;
  node: string;
};
export function codingDiscoveryContext(): CodingDiscoveryContext {
  return { env: process.env, home: homedir(), node: process.execPath };
}
export function validCodingPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    value
      .split(':')
      .every((part) => isAbsolute(part) && !/[\x00-\x1f\x7f]/u.test(part))
  );
}
export function codingSearchDirectories(context: CodingDiscoveryContext) {
  return [
    ...new Set(
      [
        ...(context.env.PATH ?? '').split(':'),
        join(context.home, '.local/bin'),
        join(context.home, '.npm-global/bin'),
        join(context.home, '.bun/bin'),
        join(context.home, '.opencode/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ]
        .filter((part) => isAbsolute(part) && !/[\x00-\x1f\x7f:]/u.test(part))
        .map(normalize),
    ),
  ];
}
export async function isCodingExecutable(path: string) {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f:]/u.test(path) || path.length > 4096)
    return false;
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export async function discoverCodingExecutable(
  id: string,
  context: CodingDiscoveryContext,
) {
  if (!['codex', 'kilo', 'opencode'].includes(id)) return undefined;
  for (const directory of codingSearchDirectories(context)) {
    const candidate = join(directory, id);
    if (await isCodingExecutable(candidate)) return candidate;
  }
  return undefined;
}
export function codingExecutionPath(
  executable: string,
  context: CodingDiscoveryContext,
) {
  return [
    ...new Set(
      [
        dirname(executable),
        dirname(context.node),
        ...codingSearchDirectories(context),
      ]
        .filter((part) => isAbsolute(part) && !/[\x00-\x1f\x7f:]/u.test(part))
        .map(normalize),
    ),
  ].join(':');
}

export function validateCodingExecutable(path: string) {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f:]/u.test(path) || path.length > 4096)
    return 'Enter an absolute path to an executable regular file.';
  try {
    if (!statSync(path).isFile()) throw new Error();
    accessSync(path, constants.X_OK);
    return undefined;
  } catch {
    return 'Enter an absolute path to an executable regular file.';
  }
}
