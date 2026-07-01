import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RuntimePaths, runtimePaths } from './runtime-home';

export type EnvFile = {
  id: 'runtime' | 'dev';
  path: string;
  loaded: boolean;
  keys: string[];
};

export type EnvLoadResult = {
  files: EnvFile[];
};

const rootDir = dirname(
  fileURLToPath(new URL('../package.json', import.meta.url)),
);
export const devEnvPath = join(rootDir, '.env');

export function loadNeondeckEnv(
  paths: RuntimePaths = runtimePaths(),
  options: { includeDevFallback?: boolean; overwrite?: boolean } = {},
): EnvLoadResult {
  const includeDevFallback = options.includeDevFallback ?? true;
  const overwrite = options.overwrite ?? false;
  const files: EnvFile[] = [];

  files.push(loadEnvFileSync('runtime', paths.env, overwrite));
  if (includeDevFallback && devEnvPath !== paths.env) {
    files.push(loadEnvFileSync('dev', devEnvPath, overwrite));
  }

  return { files };
}

export async function readEnvFiles(
  paths: RuntimePaths = runtimePaths(),
  options: { includeDevFallback?: boolean } = {},
) {
  const includeDevFallback = options.includeDevFallback ?? true;
  const env = new Map<string, string>();

  await mergeEnvFile(env, paths.env);
  if (includeDevFallback && devEnvPath !== paths.env) {
    await mergeEnvFile(env, devEnvPath);
  }

  return env;
}

export async function readDotEnvFile(path: string) {
  const env = new Map<string, string>();
  await mergeEnvFile(env, path, true);
  return env;
}

export function parseDotEnv(source: string) {
  const env = new Map<string, string>();
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env.set(match[1], unquoteEnvValue(match[2]));
  }
  return env;
}

export function unquoteEnvValue(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'string') return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function quoteEnvValue(value: string) {
  return JSON.stringify(value);
}

function loadEnvFileSync(id: EnvFile['id'], path: string, overwrite: boolean) {
  if (!existsSync(path)) {
    return { id, path, loaded: false, keys: [] };
  }

  const env = parseDotEnv(readFileSync(path, 'utf8'));
  const keys: string[] = [];
  for (const [key, value] of env) {
    if (overwrite || !process.env[key]) {
      process.env[key] = value;
      keys.push(key);
    }
  }

  return { id, path, loaded: true, keys };
}

async function mergeEnvFile(
  env: Map<string, string>,
  path: string,
  overwrite = false,
) {
  if (!existsSync(path)) return;
  const parsed = parseDotEnv(await readFile(path, 'utf8'));
  for (const [key, value] of parsed) {
    if (overwrite || !env.has(key)) {
      env.set(key, value);
    }
  }
}
