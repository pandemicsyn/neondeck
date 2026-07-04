import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { type RepoDiffFile } from '../../repo-edit/git';
import { type RuntimePaths } from '../../runtime-home';
import {
  autopilotWorkflowNames,
  defaultAutopilotConcurrency,
  defaultAutopilotPolicyLimits,
  type ActiveRunRow,
  type AutopilotFileRisk,
  type AutopilotPolicyDecision,
  type AutopilotPolicyLimits,
} from './schemas';

export async function classifyFileRisk(
  root: string,
  file: RepoDiffFile,
  limits: AutopilotPolicyLimits,
): Promise<AutopilotFileRisk> {
  const path = normalizePath(file.path);
  const sizeBytes = await stat(join(root, path))
    .then((item) => item.size)
    .catch(() => null);
  const classes = new Set<string>();
  const reasons: string[] = [];
  const denied = matchesAny(path, limits.deniedFileGlobs);
  const approvalByGlob = matchesAny(path, limits.approvalRequiredFileGlobs);

  addClass(classes, reasons, isLockfile(path), 'lockfile', 'lockfile');
  addClass(
    classes,
    reasons,
    isDependencyManifestChange(path, file.patch),
    'dependency-manifest',
    'dependency manifest dependency change',
  );
  addClass(classes, reasons, isCiConfig(path), 'ci-config', 'CI/CD config');
  addClass(
    classes,
    reasons,
    isDeploymentConfig(path),
    'deployment-config',
    'deployment or infrastructure config',
  );
  addClass(
    classes,
    reasons,
    isSecuritySensitive(path),
    'security-sensitive-code',
    'auth/security-sensitive path',
  );
  addClass(
    classes,
    reasons,
    isSecretEnv(path),
    'secrets-env',
    'secret/env path',
  );
  addClass(
    classes,
    reasons,
    isMigration(path),
    'database-migration',
    'database migration',
  );
  addClass(classes, reasons, file.binary, 'binary-file', 'binary file');
  addClass(
    classes,
    reasons,
    isVendored(path),
    'vendored-code',
    'vendored code',
  );
  addClass(
    classes,
    reasons,
    Boolean(
      file.generatedLike &&
      sizeBytes !== null &&
      sizeBytes >= limits.generatedFileSizeThresholdBytes,
    ),
    'large-generated-file',
    'large generated-like file',
  );
  addClass(
    classes,
    reasons,
    approvalByGlob,
    'repo-glob',
    'approval-required glob',
  );

  const configuredHighRisk = [...classes].some((item) =>
    limits.highRiskClasses.includes(item),
  );

  return {
    path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    generatedLike: file.generatedLike,
    sizeBytes,
    denied,
    approvalRequired: approvalByGlob || configuredHighRisk,
    classes: [...classes],
    reasons,
  };
}

export function emptyPolicyFailure(
  repoId: string,
  message: string,
): AutopilotPolicyDecision {
  return {
    ok: false,
    action: 'autopilot_policy_check',
    changed: false,
    message,
    repoId,
    repoFullName: 'unknown',
    prNumber: null,
    mode: 'notify-only',
    limits: defaultAutopilotPolicyLimits,
    concurrency: defaultAutopilotConcurrency,
    diff: {
      base: 'HEAD',
      filesChanged: 0,
      linesChanged: 0,
      additions: 0,
      deletions: 0,
      binaryFiles: 0,
    },
    files: [],
    blocked: true,
    approvalRequired: false,
    canPush: false,
    reasons: [message],
    requires: ['repo'],
    fetchedAt: new Date().toISOString(),
  };
}

export function readActiveAutopilotRuns(paths: RuntimePaths): ActiveRunRow[] {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT run_id, workflow, status
        FROM workflow_run_observations
        WHERE status = 'active'
        ORDER BY last_event_at DESC
        LIMIT 100;
      `,
      )
      .all()
      .map((row) =>
        v.parse(
          v.object({
            run_id: v.string(),
            workflow: v.string(),
            status: v.string(),
          }),
          row,
        ),
      )
      .filter((row) =>
        autopilotWorkflowNames.has(normalizeWorkflowName(row.workflow)),
      );
  } finally {
    database.close();
  }
}

function addClass(
  classes: Set<string>,
  reasons: string[],
  condition: boolean,
  className: string,
  reason: string,
) {
  if (!condition) return;
  classes.add(className);
  reasons.push(reason);
}

function normalizePath(path: string) {
  return path.replaceAll('\\', '/');
}

function isLockfile(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return (
    name.endsWith('.lock') ||
    [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'Cargo.lock',
      'Gemfile.lock',
      'composer.lock',
    ].includes(name)
  );
}

function isDependencyManifestChange(path: string, patch: string | undefined) {
  const name = path.split('/').at(-1) ?? path;
  if (!isDependencyManifest(path)) return false;
  if (!patch) return true;
  if (
    ['requirements.txt', 'requirements-dev.txt', 'go.mod', 'Cargo.toml'].some(
      (item) => name === item,
    )
  ) {
    return changedContentLines(patch).length > 0;
  }
  return changedContentLines(patch).some((line) =>
    /"(dependencies|devDependencies|peerDependencies|optionalDependencies|resolutions|overrides)"|version\s*=|^[+-]\s*"?[\w@./-]+"?\s*[:=]\s*"?[~^<>=\d*]/.test(
      line,
    ),
  );
}

function isDependencyManifest(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return [
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'requirements-dev.txt',
    'Cargo.toml',
    'go.mod',
    'composer.json',
    'Gemfile',
  ].includes(name);
}

function changedContentLines(patch: string) {
  return patch
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---'),
    );
}

function isCiConfig(path: string) {
  return (
    path.startsWith('.github/') ||
    path.startsWith('.circleci/') ||
    path === '.gitlab-ci.yml' ||
    path === 'azure-pipelines.yml' ||
    path.startsWith('.buildkite/')
  );
}

function isDeploymentConfig(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return (
    name === 'Dockerfile' ||
    name.startsWith('Dockerfile.') ||
    name.startsWith('docker-compose') ||
    name === 'wrangler.jsonc' ||
    name === 'wrangler.toml' ||
    name === 'fly.toml' ||
    name === 'netlify.toml' ||
    name === 'vercel.json' ||
    path.startsWith('terraform/') ||
    path.endsWith('.tf') ||
    path.startsWith('infra/') ||
    path.startsWith('k8s/') ||
    path.startsWith('helm/')
  );
}

function isSecuritySensitive(path: string) {
  return /(^|\/)(auth|security|crypto|oauth|session|sessions|permissions?|rbac|jwt)(\/|\.|-|_)/i.test(
    path,
  );
}

function isSecretEnv(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return (
    name.startsWith('.env') ||
    /secret|credential|private[-_]?key/i.test(path) ||
    /\.(pem|key|p12|pfx)$/i.test(path)
  );
}

function isMigration(path: string) {
  return /(^|\/)(migrations?|db\/migrate|schema\/migrations)(\/|$)/i.test(path);
}

function isVendored(path: string) {
  return /(^|\/)(vendor|third_party|node_modules)(\/|$)/i.test(path);
}

export function matchesAny(path: string, patterns: string[]) {
  const normalized = normalizePath(path);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

function globToRegExp(pattern: string) {
  const expanded = pattern.replace(/\{([^}]+)\}/g, (_, body: string) => {
    return `(${body
      .split(',')
      .map((part) => escapeRegExp(part.trim()))
      .join('|')})`;
  });
  let source = '';
  for (let index = 0; index < expanded.length; index += 1) {
    const char = expanded[index];
    const next = expanded[index + 1];
    const afterNext = expanded[index + 2];
    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      index += 2;
      continue;
    }
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '(' || char === ')' || char === '|') {
      source += char;
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}

export function normalizeWorkflowName(name: string) {
  return name.replaceAll('_', '-');
}
