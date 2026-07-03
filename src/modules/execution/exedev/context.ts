import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import * as v from 'valibot';
import {
  type ExeDevCheckoutConfig,
  type ExeDevEnvForwardingConfig,
  type RepoConfig,
  type RuntimePaths,
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import { readWorktreeRecord, type WorktreeRecord } from '../../../worktrees';

export type ExeDevTargetInput = {
  repoId?: string;
  worktreeId?: string;
};

export type ExeDevCheckoutTarget = {
  repo: RepoConfig;
  worktree: WorktreeRecord | null;
  repoFullName: string;
  localPath: string;
  remotePath: string;
  remoteRoot: string;
  remoteUrl: string;
  defaultRef: string;
  checkoutConfig: ExeDevCheckoutConfig | undefined;
};

export type ExeDevEnvSourceAudit = {
  kind: 'repo-file' | 'config-vars' | 'host-env';
  scope: 'global' | 'repo' | 'checkout';
  id: string;
  keys: string[];
  missing?: boolean;
};

export type ExeDevForwardedEnv = {
  env: Record<string, string>;
  sources: ExeDevEnvSourceAudit[];
};

const envFileLine = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

export async function resolveExeDevCheckoutTarget(
  input: ExeDevTargetInput,
  paths: RuntimePaths = runtimePaths(),
): Promise<ExeDevCheckoutTarget | null> {
  if (!input.repoId && !input.worktreeId) return null;
  await ensureRuntimeHome(paths);
  const [registry, appConfig] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const worktree = input.worktreeId
    ? readWorktreeRecord(input.worktreeId, paths)
    : null;
  const repoId = worktree?.repoId ?? input.repoId;
  const repo = registry.repos.find((candidate) => candidate.id === repoId);
  if (!repo) {
    throw new Error(`Repository "${repoId ?? 'unknown'}" is not configured.`);
  }
  if (input.repoId && worktree && input.repoId !== worktree.repoId) {
    throw new Error(
      `Worktree "${worktree.id}" belongs to repo "${worktree.repoId}", not "${input.repoId}".`,
    );
  }
  if (worktree?.lifecycleStatus === 'deleted') {
    throw new Error(`Worktree "${worktree.id}" is deleted.`);
  }

  const exeDev = appConfig.execution?.exeDev;
  const repoCheckout = exeDev?.repos?.[repo.id];
  const worktreeCheckout = worktree
    ? exeDev?.checkouts?.[worktree.id]
    : undefined;
  const checkoutConfig = worktreeCheckout ?? repoCheckout;
  const remoteRoot = exeDev?.remoteRoot ?? '/home/user/neondeck/checkouts';
  const repoFullName = `${repo.github.owner}/${repo.github.name}`;
  const remotePath =
    checkoutConfig?.remotePath ??
    `${remoteRoot.replace(/\/+$/, '')}/${defaultRemoteCheckoutName(
      repo,
      worktree,
    )}`;

  return {
    repo,
    worktree,
    repoFullName,
    localPath: worktree?.localPath ?? repo.path,
    remotePath,
    remoteRoot,
    remoteUrl: `https://github.com/${repo.github.owner}/${repo.github.name}.git`,
    defaultRef: worktree?.headSha ?? worktree?.headRef ?? repo.defaultBranch,
    checkoutConfig,
  };
}

export async function resolveExeDevForwardedEnv(
  input: ExeDevTargetInput,
  paths: RuntimePaths = runtimePaths(),
): Promise<ExeDevForwardedEnv> {
  const target = await resolveExeDevCheckoutTarget(input, paths);
  if (!target) return { env: {}, sources: [] };
  const appConfig = await readRuntimeJson(paths.config, parseAppConfig);
  const scopes: Array<{
    scope: ExeDevEnvSourceAudit['scope'];
    config?: ExeDevEnvForwardingConfig;
  }> = [
    { scope: 'global', config: appConfig.execution?.exeDev?.env },
    {
      scope: 'repo',
      config: appConfig.execution?.exeDev?.repos?.[target.repo.id]?.env,
    },
    {
      scope: 'checkout',
      config: target.worktree
        ? appConfig.execution?.exeDev?.checkouts?.[target.worktree.id]?.env
        : undefined,
    },
  ];
  const env: Record<string, string> = {};
  const sources: ExeDevEnvSourceAudit[] = [];

  for (const { scope, config } of scopes) {
    if (!config?.enabled) continue;
    for (const file of config.files ?? []) {
      const resolved = await resolveRepoEnvFile(target.localPath, file);
      if (!resolved) {
        sources.push({
          kind: 'repo-file',
          scope,
          id: file,
          keys: [],
          missing: true,
        });
        continue;
      }
      try {
        const parsed = parseEnvFile(await readFile(resolved, 'utf8'));
        Object.assign(env, parsed);
        sources.push({
          kind: 'repo-file',
          scope,
          id: file,
          keys: Object.keys(parsed).sort(),
        });
      } catch {
        sources.push({
          kind: 'repo-file',
          scope,
          id: file,
          keys: [],
          missing: true,
        });
      }
    }
    const vars = config.vars ?? {};
    if (Object.keys(vars).length > 0) {
      Object.assign(env, vars);
      sources.push({
        kind: 'config-vars',
        scope,
        id: `${scope}:vars`,
        keys: Object.keys(vars).sort(),
      });
    }
    for (const [targetName, hostName] of Object.entries(config.hostEnv ?? {})) {
      const value = process.env[hostName];
      if (value === undefined) {
        sources.push({
          kind: 'host-env',
          scope,
          id: `${targetName}:${hostName}`,
          keys: [targetName],
          missing: true,
        });
        continue;
      }
      env[targetName] = value;
      sources.push({
        kind: 'host-env',
        scope,
        id: `${targetName}:${hostName}`,
        keys: [targetName],
      });
    }
  }

  return { env, sources };
}

export function parseEnvFile(source: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = envFileLine.exec(line);
    if (!match) continue;
    const [, key, rawValue = ''] = match;
    env[key] = unquoteEnvValue(rawValue.trim());
  }
  return env;
}

export function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function remoteParent(remotePath: string) {
  return remotePath.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
}

export function exedevTargetInputSchema() {
  return {
    repoId: v.optional(v.pipe(v.string(), v.minLength(1))),
    worktreeId: v.optional(v.pipe(v.string(), v.minLength(1))),
  };
}

async function resolveRepoEnvFile(repoRoot: string, file: string) {
  if (file.includes('\u0000') || isAbsolute(file)) return undefined;
  const candidate = resolve(repoRoot, file);
  const root = resolve(repoRoot);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    return undefined;
  }
  try {
    const [rootRealPath, fileStats] = await Promise.all([
      realpath(root),
      lstat(candidate),
    ]);
    if (fileStats.isSymbolicLink()) return undefined;
    const candidateRealPath = await realpath(candidate);
    if (!isInsidePath(rootRealPath, candidateRealPath)) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

function isInsidePath(root: string, candidate: string) {
  const segment = relative(root, candidate);
  return segment === '' || (!segment.startsWith('..') && !isAbsolute(segment));
}

function unquoteEnvValue(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  const commentIndex = value.search(/\s#/);
  return commentIndex === -1 ? value : value.slice(0, commentIndex).trimEnd();
}

function defaultRemoteCheckoutName(
  repo: RepoConfig,
  worktree: WorktreeRecord | null,
) {
  return slug(
    [
      repo.github.owner,
      repo.github.name,
      worktree
        ? worktree.prNumber
          ? `pr-${worktree.prNumber}`
          : worktree.id
        : 'repo',
    ].join('-'),
  );
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}
