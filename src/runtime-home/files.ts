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
import * as v from 'valibot';

import { generateLocalApiToken } from './defaults.ts';
import { runtimePaths } from './paths.ts';
import {
  ConfigValidationError,
  parseAppConfig,
  parseDashboardConfig,
  parseMcpConfig,
  parseRepoRegistry,
  runtimeHomeExternalRecordSchema,
  type RuntimeHomeExternalRecord,
  type RuntimeHomeExternalValue,
} from './schemas.ts';

const alreadyExistsErrorSchema = v.object({ code: v.literal('EEXIST') });
const runtimeHomeErrorSchema = v.instance(Error);

export async function readRuntimeJson<T>(
  path: string,
  parse: (value: RuntimeHomeExternalValue, path: string) => T,
): Promise<T> {
  const source = await readFile(path, 'utf8');
  return parseJson(source, path, parse);
}

export function readRuntimeJsonSync<T>(
  path: string,
  parse: (value: RuntimeHomeExternalValue, path: string) => T,
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

export async function readJsonObjectLenient(path: string) {
  try {
    const value: RuntimeHomeExternalValue = JSON.parse(
      await readFile(path, 'utf8'),
    );
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function readJsonObjectLenientSync(path: string) {
  try {
    const value: RuntimeHomeExternalValue = JSON.parse(
      readFileSync(path, 'utf8'),
    );
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readLocalApiTokenValue(value: RuntimeHomeExternalRecord) {
  const localApi = value.localApi;
  if (!isRecord(localApi)) return undefined;
  return localApi.token;
}

function isValidLocalApiToken(value: RuntimeHomeExternalValue) {
  return v.safeParse(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{32,}$/)), value)
    .success;
}

export function isRecord(
  value: RuntimeHomeExternalValue,
): value is RuntimeHomeExternalRecord {
  if (Array.isArray(value)) return false;
  return v.safeParse(runtimeHomeExternalRecordSchema, value).success;
}

export async function writeJsonAtomic(
  path: string,
  value: RuntimeHomeExternalValue,
) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = temporaryJsonPath(path);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

export function writeJsonAtomicSync(
  path: string,
  value: RuntimeHomeExternalValue,
) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = temporaryJsonPath(path);
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tempPath, path);
}

function temporaryJsonPath(path: string) {
  return `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
}

export async function writeJsonIfMissing(
  path: string,
  value: RuntimeHomeExternalValue,
) {
  await writeFileIfMissing(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonIfMissingSync(
  path: string,
  value: RuntimeHomeExternalValue,
) {
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

function isAlreadyExistsError(error: RuntimeHomeExternalValue) {
  return v.safeParse(alreadyExistsErrorSchema, error).success;
}

function parseJson<T>(
  source: string,
  path: string,
  parse: (value: RuntimeHomeExternalValue, path: string) => T,
) {
  try {
    const value: RuntimeHomeExternalValue = JSON.parse(source);
    return parse(value, path);
  } catch (error) {
    const validationError = v.safeParse(
      v.instance(ConfigValidationError),
      error,
    );
    if (validationError.success) {
      throw validationError.output;
    }

    const parsedError = v.safeParse(runtimeHomeErrorSchema, error);
    const message = parsedError.success
      ? parsedError.output.message
      : String(error);
    throw new ConfigValidationError(path, message);
  }
}
