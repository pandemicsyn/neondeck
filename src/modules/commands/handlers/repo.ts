import { readGitDiffSummary, readGitRepoStatus, readRepoRegistrySnapshot, repoFullName } from '../../../repos';
import type { RuntimePaths } from '../../../runtime-home';
import type { NeonCommandResult, ParsedNeonCommand } from '../schemas';
import { completedCommand, failedCommand } from '../summaries';

export async function repoStatusCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const registry = await readRepoRegistrySnapshot(paths);
  const target = command.args[0];
  const repos = target
    ? registry.repos.filter(
        (repo) =>
          repo.id === target ||
          repoFullName(repo).toLowerCase() === target.toLowerCase(),
      )
    : registry.repos;

  if (target && repos.length === 0) {
    return failedCommand(
      command.name,
      command.raw,
      `Repository "${target}" is not configured.`,
      { requires: ['repo'] },
    );
  }

  const statuses = await Promise.all(repos.map(readGitRepoStatus));
  return completedCommand(
    command.name,
    command.raw,
    repos.length === 0
      ? 'No repositories are configured.'
      : `Checked ${statuses.length} configured repositor${
          statuses.length === 1 ? 'y' : 'ies'
        }.`,
    {
      home: registry.home,
      repos: statuses,
      attention: statuses.filter((repo) => repo.dirty || repo.error),
    },
  );
}

export async function draftPrDescriptionCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const resolved = await resolveCommandRepo(command, paths);
  if (!resolved.ok) {
    return failedCommand(command.name, command.raw, resolved.message, {
      requires: resolved.requires,
      data: resolved.data,
    });
  }

  const health = await readGitRepoStatus(resolved.repo);
  const draft = {
    title: `${resolved.repo.id}: <short change summary>`,
    body: [
      '## Summary',
      '- <what changed>',
      '',
      '## Validation',
      ...validationChecklist(resolved.repo).map((item) => `- [ ] ${item}`),
      '',
      '## Risk',
      `- Working tree: ${health.dirty ? `${health.changeCount} uncommitted change${health.changeCount === 1 ? '' : 's'}` : 'clean'}`,
      `- Branch: ${health.branch ?? 'unknown'} -> ${resolved.repo.defaultBranch}`,
    ].join('\n'),
  };

  return completedCommand(
    command.name,
    command.raw,
    `Prepared a PR description scaffold for ${resolved.repo.id}.`,
    {
      repo: resolved.repo,
      health,
      draft,
      assistantBrief:
        'Use this scaffold as a draft only. Ask for diff details or run local review before making specific claims about changed behavior.',
    },
  );
}

export async function preparePrCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const resolved = await resolveCommandRepo(command, paths);
  if (!resolved.ok) {
    return failedCommand(command.name, command.raw, resolved.message, {
      requires: resolved.requires,
      data: resolved.data,
    });
  }

  const health = await readGitRepoStatus(resolved.repo);
  const checks = preparePrChecks(resolved.repo, health);

  return completedCommand(
    command.name,
    command.raw,
    `Prepared PR readiness checklist for ${resolved.repo.id}.`,
    {
      repo: resolved.repo,
      health,
      checks,
      ready: checks.every((item) => item.status === 'ok'),
      assistantBrief:
        'Use these deterministic readiness checks before recommending PR creation. Do not run host commands unless a future approved action exists.',
    },
  );
}

export async function reviewLocalCommand(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<NeonCommandResult> {
  const resolved = await resolveCommandRepo(command, paths);
  if (!resolved.ok) {
    return failedCommand(command.name, command.raw, resolved.message, {
      requires: resolved.requires,
      data: resolved.data,
    });
  }

  const health = await readGitRepoStatus(resolved.repo);
  const diff = await readGitDiffSummary(resolved.repo);
  const findings = localReviewFindings(resolved.repo, health, diff);

  return completedCommand(
    command.name,
    command.raw,
    findings.length > 0
      ? `Found ${findings.length} local review finding${findings.length === 1 ? '' : 's'} for ${resolved.repo.id}.`
      : `No deterministic local review findings for ${resolved.repo.id}.`,
    {
      repo: resolved.repo,
      health,
      diff,
      findings,
      assistantBrief:
        'Lead with these deterministic local findings and diff metadata. This is still not a semantic code review because file contents were not read by this command.',
    },
  );
}

export async function resolveCommandRepo(
  command: ParsedNeonCommand,
  paths: RuntimePaths,
): Promise<
  | {
      ok: true;
      repo: Awaited<
        ReturnType<typeof readRepoRegistrySnapshot>
      >['repos'][number];
    }
  | {
      ok: false;
      message: string;
      requires?: string[];
      data?: unknown;
    }
> {
  const registry = await readRepoRegistrySnapshot(paths);
  const target = command.args.join(' ').trim();
  if (registry.repos.length === 0) {
    return {
      ok: false,
      message: 'No repositories are configured.',
      requires: ['repo'],
    };
  }

  if (!target) {
    if (registry.repos.length === 1) {
      return { ok: true, repo: registry.repos[0] };
    }

    return {
      ok: false,
      message: 'A repository id or owner/repo is required.',
      requires: ['repo'],
      data: { repos: registry.repos.map((repo) => repo.id) },
    };
  }

  const repo = registry.repos.find(
    (item) =>
      item.id === target ||
      item.github.name === target ||
      repoFullName(item).toLowerCase() === target.toLowerCase(),
  );
  if (!repo) {
    return {
      ok: false,
      message: `Repository "${target}" is not configured.`,
      requires: ['repo'],
      data: { repos: registry.repos.map((item) => item.id) },
    };
  }

  return { ok: true, repo };
}

export function validationChecklist(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
) {
  const scripts = repo.packageScripts ?? {};
  const preferred = ['format:check', 'lint', 'typecheck', 'test', 'check'];
  const available = preferred.filter((script) => scripts[script]);
  if (available.length > 0) {
    return available.map((script) => `npm run ${script}`);
  }

  return ['Run the project validation command for this repo.'];
}

export function preparePrChecks(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  health: Awaited<ReturnType<typeof readGitRepoStatus>>,
) {
  return [
    {
      id: 'working-tree',
      status: health.error || health.dirty ? 'attention' : 'ok',
      message: health.error
        ? `Git status failed: ${health.error}`
        : health.dirty
          ? `${health.changeCount} local change${health.changeCount === 1 ? '' : 's'} need review before PR creation.`
          : 'Working tree is clean.',
    },
    {
      id: 'branch',
      status:
        health.branch && health.branch !== repo.defaultBranch
          ? 'ok'
          : 'attention',
      message: health.branch
        ? health.branch === repo.defaultBranch
          ? `Current branch is the default branch (${repo.defaultBranch}).`
          : `Current branch is ${health.branch}.`
        : 'Current branch is unknown.',
    },
    {
      id: 'upstream',
      status:
        health.ahead === null && health.behind === null ? 'attention' : 'ok',
      message:
        health.ahead === null && health.behind === null
          ? 'No upstream tracking branch was detected.'
          : `Ahead ${health.ahead ?? 0}, behind ${health.behind ?? 0}.`,
    },
    {
      id: 'validation',
      status: 'attention',
      message: `Run validation before opening PR: ${validationChecklist(repo).join(', ')}.`,
    },
  ];
}

export function localReviewFindings(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  health: Awaited<ReturnType<typeof readGitRepoStatus>>,
  diff: Awaited<ReturnType<typeof readGitDiffSummary>>,
) {
  const findings: Array<{
    severity: 'high' | 'medium' | 'low';
    title: string;
    message: string;
  }> = [];

  if (health.error) {
    findings.push({
      severity: 'high',
      title: 'Git status unavailable',
      message: health.error,
    });
    return findings;
  }

  if (health.branch === repo.defaultBranch) {
    findings.push({
      severity: 'medium',
      title: 'Working on default branch',
      message: `Current branch is ${repo.defaultBranch}; create a topic branch before PR prep.`,
    });
  }

  if (health.behind && health.behind > 0) {
    findings.push({
      severity: 'medium',
      title: 'Branch is behind upstream',
      message: `Branch is ${health.behind} commit${health.behind === 1 ? '' : 's'} behind upstream.`,
    });
  }

  if (health.dirty) {
    findings.push({
      severity: 'low',
      title: 'Uncommitted changes present',
      message: `${health.changeCount} local change${health.changeCount === 1 ? '' : 's'} detected: ${health.changes.slice(0, 5).join(', ')}`,
    });
  }

  if (!diff.ok) {
    findings.push({
      severity: 'medium',
      title: 'Diff summary unavailable',
      message: diff.error ?? 'Could not read git diff metadata.',
    });
  }

  if (diff.fileCount > 15) {
    findings.push({
      severity: 'medium',
      title: 'Large local diff',
      message: `${diff.fileCount} files changed with ${diff.additions} additions and ${diff.deletions} deletions.`,
    });
  }

  if (diff.binaryFiles > 0) {
    findings.push({
      severity: 'low',
      title: 'Binary files changed',
      message: `${diff.binaryFiles} changed file${diff.binaryFiles === 1 ? ' is' : 's are'} binary or uncounted by git numstat.`,
    });
  }

  return findings;
}
