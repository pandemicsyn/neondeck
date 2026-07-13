import {
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { generateLocalApiToken } from './defaults.ts';
import { runtimePaths } from './paths.ts';
import {
  ConfigValidationError,
  parseAppConfig,
  parseDashboardConfig,
  parseMcpConfig,
  parseRepoRegistry,
} from './schemas.ts';

export async function readRuntimeJson<T>(
  path: string,
  parse: (value: unknown, path: string) => T,
): Promise<T> {
  const source = await readFile(path, 'utf8');
  return parseJson(source, path, parse);
}

export function readRuntimeJsonSync<T>(
  path: string,
  parse: (value: unknown, path: string) => T,
): T {
  const source = readFileSync(path, 'utf8');
  return parseJson(source, path, parse);
}

export async function validateRuntimeFiles(paths = runtimePaths()) {
  await readRuntimeJson(paths.config, parseAppConfig);
  await readRuntimeJson(paths.mcp, parseMcpConfig);
  await readRuntimeJson(paths.repos, parseRepoRegistry);
  await readRuntimeJson(paths.dashboard, parseDashboardConfig);
}

export function validateRuntimeFilesSync(paths = runtimePaths()) {
  readRuntimeJsonSync(paths.config, parseAppConfig);
  readRuntimeJsonSync(paths.mcp, parseMcpConfig);
  readRuntimeJsonSync(paths.repos, parseRepoRegistry);
  readRuntimeJsonSync(paths.dashboard, parseDashboardConfig);
}

export async function ensureLocalApiConfig(path: string) {
  const value = await readJsonObjectLenient(path);
  if (!value) return;
  if (isValidLocalApiToken(readLocalApiTokenValue(value))) return;

  await writeJsonAtomic(path, {
    ...value,
    localApi: { token: generateLocalApiToken() },
  });
}

export function ensureLocalApiConfigSync(path: string) {
  const value = readJsonObjectLenientSync(path);
  if (!value) return;
  if (isValidLocalApiToken(readLocalApiTokenValue(value))) return;

  writeJsonAtomicSync(path, {
    ...value,
    localApi: { token: generateLocalApiToken() },
  });
}

async function readJsonObjectLenient(path: string) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readJsonObjectLenientSync(path: string) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readLocalApiTokenValue(value: Record<string, unknown>) {
  const localApi = value.localApi;
  if (!isRecord(localApi)) return undefined;
  return localApi.token;
}

function isValidLocalApiToken(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = temporaryJsonPath(path);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

function writeJsonAtomicSync(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = temporaryJsonPath(path);
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tempPath, path);
}

function temporaryJsonPath(path: string) {
  return `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
}

export async function writeJsonIfMissing(path: string, value: unknown) {
  await writeFileIfMissing(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonIfMissingSync(path: string, value: unknown) {
  writeFileIfMissingSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeFileIfMissing(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, value, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

export function writeFileIfMissingSync(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, value, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

export async function copyIfMissing(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

export function copyIfMissingSync(source: string, target: string) {
  mkdirSync(dirname(target), { recursive: true });
  try {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

function isAlreadyExistsError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}

function parseJson<T>(
  source: string,
  path: string,
  parse: (value: unknown, path: string) => T,
) {
  try {
    return parse(JSON.parse(source) as unknown, path);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(path, message);
  }
}
