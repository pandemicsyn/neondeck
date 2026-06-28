import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { RepoConfig, RuntimePaths } from '../runtime-home';
import {
  ensureRuntimeHome,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from '../runtime-home';
import type { RepoEditError } from './schemas';

export type RepoPathIntent = 'read' | 'write' | 'delete' | 'move';

export type ResolvedRepoPath = {
  repo: RepoConfig;
  repoRoot: string;
  relativePath: string;
  fullPath: string;
  exists: boolean;
  sensitive: boolean;
  generatedLike: boolean;
};

const deniedExactNames = new Set([
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
]);
const deniedExtensions = new Set(['.pem', '.key', '.p12']);
const sensitiveExactNames = new Set(['.env']);
const sensitiveFragments = ['secret', 'secrets', 'token', 'tokens'];
const generatedExtensions = new Set(['.lock']);
const generatedNames = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
]);

export class RepoPathPolicyError extends Error {
  readonly code: RepoEditError['code'];
  readonly path?: string;
  readonly details?: unknown;

  constructor(code: RepoEditError['code'], message: string, path?: string) {
    super(message);
    this.name = 'RepoPathPolicyError';
    this.code = code;
    this.path = path;
  }
}

export async function resolveRepoPath(
  input: {
    repoId: string;
    path: string;
    intent?: RepoPathIntent;
    createParentDirectories?: boolean;
  },
  paths: RuntimePaths = runtimePaths(),
): Promise<ResolvedRepoPath> {
  await ensureRuntimeHome(paths);
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  const repo = registry.repos.find((item) => item.id === input.repoId);
  if (!repo) {
    throw new RepoPathPolicyError(
      'REPO_NOT_FOUND',
      `Repository "${input.repoId}" is not configured.`,
    );
  }

  const relativePath = normalizeRepoRelativePath(input.path);
  assertAllowedSegments(relativePath);

  const repoRoot = await realpath(repo.path);
  const fullPath = resolve(repoRoot, relativePath);
  if (!isInside(repoRoot, fullPath)) {
    throw new RepoPathPolicyError(
      'PATH_OUTSIDE_WORKSPACE',
      `Path "${input.path}" resolves outside configured repo "${repo.id}".`,
      input.path,
    );
  }

  const existing = await lstat(fullPath).catch(() => undefined);
  if (existing?.isSymbolicLink() && input.intent !== 'read') {
    throw new RepoPathPolicyError(
      'PATH_DENIED',
      `Refusing to mutate symlink "${relativePath}".`,
      relativePath,
    );
  }

  if (existing) {
    const target = await realpath(fullPath);
    if (!isInside(repoRoot, target)) {
      throw new RepoPathPolicyError(
        'PATH_OUTSIDE_WORKSPACE',
        `Path "${relativePath}" resolves outside configured repo "${repo.id}".`,
        relativePath,
      );
    }
  } else {
    const parent = input.createParentDirectories
      ? await nearestExistingAncestor(dirname(fullPath), repoRoot)
      : await realpath(dirname(fullPath)).catch(() => undefined);
    if (!parent || !isInside(repoRoot, parent)) {
      throw new RepoPathPolicyError(
        'PATH_OUTSIDE_WORKSPACE',
        `Parent directory for "${relativePath}" is outside configured repo "${repo.id}" or does not exist.`,
        relativePath,
      );
    }
  }

  return {
    repo,
    repoRoot,
    relativePath,
    fullPath,
    exists: Boolean(existing),
    sensitive: isSensitivePath(relativePath),
    generatedLike: isGeneratedLike(relativePath),
  };
}

async function nearestExistingAncestor(path: string, repoRoot: string) {
  let current = path;
  while (isInside(repoRoot, current)) {
    const resolved = await realpath(current).catch(() => undefined);
    if (resolved) return resolved;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function normalizeRepoRelativePath(path: string) {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new RepoPathPolicyError('PATH_DENIED', 'Path must not be empty.');
  }
  if (trimmed === '.') {
    return '.';
  }
  if (isAbsolute(trimmed)) {
    throw new RepoPathPolicyError(
      'PATH_OUTSIDE_WORKSPACE',
      `Absolute paths are not allowed: ${path}`,
      path,
    );
  }

  const normalized = trimmed.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) {
    throw new RepoPathPolicyError('PATH_DENIED', 'Path must not be empty.');
  }
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new RepoPathPolicyError(
      'PATH_OUTSIDE_WORKSPACE',
      `Path traversal is not allowed: ${path}`,
      path,
    );
  }
  return parts.join('/');
}

export function isInside(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isSensitivePath(path: string) {
  const parts = path.split('/');
  const name = parts.at(-1) ?? path;
  const lower = name.toLowerCase();
  return (
    sensitiveExactNames.has(name) ||
    name.startsWith('.env.') ||
    sensitiveFragments.some((fragment) => lower.includes(fragment))
  );
}

export function isGeneratedLike(path: string) {
  const name = path.split('/').at(-1) ?? path;
  if (generatedNames.has(name)) return true;
  return [...generatedExtensions].some((extension) => name.endsWith(extension));
}

function assertAllowedSegments(path: string) {
  if (path === '.') return;
  const parts = path.split('/');
  if (parts.includes('.git') || parts.includes('.ssh')) {
    throw new RepoPathPolicyError(
      'PATH_DENIED',
      `Path "${path}" is denied by workspace policy.`,
      path,
    );
  }

  const name = parts.at(-1) ?? '';
  const lowerName = name.toLowerCase();
  if (
    deniedExactNames.has(name) ||
    [...deniedExtensions].some((extension) => lowerName.endsWith(extension))
  ) {
    throw new RepoPathPolicyError(
      'PATH_DENIED',
      `Path "${path}" is denied by workspace policy.`,
      path,
    );
  }
}

export function toRepoEditError(error: unknown): RepoEditError {
  if (error instanceof RepoPathPolicyError) {
    return {
      code: error.code,
      message: error.message,
      path: error.path,
      details: error.details,
    };
  }

  return {
    code: 'IO_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
