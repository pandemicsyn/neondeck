import {
  cancel,
  confirm,
  isCancel,
  multiselect,
  password,
  select,
  text,
} from '@clack/prompts';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { quoteEnvValue } from '../modules/runtime';
import type { EnvMap } from './types';

export async function findGitRepos(parent: string) {
  const root = expandHome(parent);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    if (existsSync(join(candidate, '.git'))) repos.push(candidate);
  }
  return repos;
}

export async function writeDotEnvFile(path: string, env: EnvMap) {
  await mkdir(dirname(path), { recursive: true });
  const orderedKeys = [
    'KILOCODE_API_KEY',
    'KILOCODE_ORGANIZATION_ID',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'FLUE_AGENT_MODEL',
    'GITHUB_TOKEN',
    'GITHUB_LOGIN',
  ];
  const lines: string[] = [];
  for (const key of orderedKeys) {
    const value = env.get(key);
    if (value !== undefined) lines.push(`${key}=${quoteEnvValue(value)}`);
  }
  for (const [key, value] of env) {
    if (!orderedKeys.includes(key))
      lines.push(`${key}=${quoteEnvValue(value)}`);
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

export function expandHome(path: string) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function requiredText(value: string | undefined) {
  return value?.trim().length ? undefined : 'Enter a value.';
}

export async function promptText(options: Parameters<typeof text>[0]) {
  const result = await text(options);
  if (isCancel(result)) abort();
  return String(result);
}

export async function promptPassword(
  options: Parameters<typeof password>[0] & { required?: boolean },
) {
  const { required, ...promptOptions } = options;
  const result = await password({
    ...promptOptions,
    validate(value) {
      if (required && value?.trim().length === 0) return 'Enter a value.';
      return undefined;
    },
  });
  if (isCancel(result)) abort();
  return String(result);
}

export async function promptConfirm(options: Parameters<typeof confirm>[0]) {
  const result = await confirm(options);
  if (isCancel(result)) abort();
  return Boolean(result);
}

export async function promptSelect<T extends string>(
  options: Parameters<typeof select<T>>[0],
) {
  const result = await select<T>(options);
  if (isCancel(result)) abort();
  return result;
}

export async function promptMultiselect<T extends string>(
  options: Parameters<typeof multiselect<T>>[0],
) {
  const result = await multiselect<T>(options);
  if (isCancel(result)) abort();
  return result;
}

export function abort(): never {
  cancel('Setup cancelled.');
  process.exit(0);
}
