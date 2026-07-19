/* eslint-disable no-unused-vars */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  type GitHubCheckSummary,
  type GitHubFailingCheckFact,
  type GitHubPullRequestDetail,
  type GitHubPullRequestEventState,
  fetchPullRequestEventState,
  fetchCheckSummary,
  fetchFailingCheckFacts,
  fetchPullRequestDetail,
} from '../github';
import {
  checkAutopilotConcurrency,
  checkAutopilotPolicy,
  pathDeniedByAutopilotPolicy,
  repoAutopilotPolicy,
  withAutopilotLocalExecutionSlot,
} from '../autopilot-policy';
import { addWorkflowSummary, updateWorkflowSummary } from '../app-state';
import {
  notifyAutopilotState,
  recoveryActionsForPreparedDiff,
} from './notifications';
import { buildPreparedDiffAuditSummary } from '../autonomous-audit';
import { runApprovedExecution } from '../execution';
import {
  getGitHubPrBranchPermissions,
  postGitHubPrComment,
} from '../pr-events';
import {
  ensurePreparedDiffForWorktree,
  markPreparedDiffPushBlocked,
  markPreparedDiffPushed,
  readPreparedDiff,
  readPreparedDiffByWorktree,
  readPreparedDiffRecord,
  recordPreparedDiffVerification,
  type PreparedDiffRecord,
} from '../prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  gitCurrentSha,
  gitCommitAll,
  gitCommitPaths,
  gitPushHead,
  gitStatus,
  type GitCommitResult,
} from '../../repo-edit/git';
import {
  patchRepoFiles,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
} from '../../repo-edit';
import { parseV4APatch } from '../../repo-edit/patch-parser';
import { repoRelativePathSchema } from '../../repo-edit/schemas';
import {
  type RuntimePaths,
  parseAppConfig,
  ensureRuntimeHome,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import {
  createWorktree,
  listWorktrees,
  lockWorktree,
  recordWorktreePushBlocked,
  recordWorktreePushSucceeded,
  readManagedWorktree,
  readWorktreeStatus,
  releaseWorktreeLock,
  syncWorktree,
  type WorktreeRecord,
} from '../worktrees';
const execFileAsync = promisify(execFile);
import { AutopilotDependencies, autopilotFixtureSchema } from './schemas';
import { stringField } from './utils';

type AutopilotFixture = v.InferOutput<typeof autopilotFixtureSchema>;

let cachedAutopilotFixture:
  { path: string; fixture: AutopilotFixture } | undefined;

export async function dependenciesWithAutopilotFixture(
  dependencies: AutopilotDependencies,
): Promise<AutopilotDependencies> {
  const fixturePath = process.env.NEONDECK_AUTOPILOT_FIXTURE_PATH;
  if (!fixturePath) return dependencies;
  if (!autopilotFixtureEnabled()) {
    throw new Error(
      'NEONDECK_AUTOPILOT_FIXTURE_PATH requires NEONDECK_AUTOPILOT_FIXTURE_ENABLE=1 outside test runs.',
    );
  }
  const fixture = await readAutopilotFixture(fixturePath);
  const token = dependencies.token ?? fixture.token ?? 'fixture-token';

  return {
    token,
    fetchPullRequestDetail:
      dependencies.fetchPullRequestDetail ??
      (async ({ owner, repo, number }) =>
        findFixturePullRequest(fixture, owner, repo, number)),
    fetchCheckSummary:
      dependencies.fetchCheckSummary ??
      (async ({ owner, repo, ref }) =>
        findFixtureCheckSummary(fixture, owner, repo, ref)),
    fetchFailingCheckFacts:
      dependencies.fetchFailingCheckFacts ??
      (async ({ owner, repo, ref }) =>
        findFixtureFailingChecks(fixture, owner, repo, ref)),
    fetchPullRequestEventState:
      dependencies.fetchPullRequestEventState ??
      (async ({ owner, repo, number }) =>
        findFixtureEventState(fixture, owner, repo, number)),
    getBranchPermissions:
      dependencies.getBranchPermissions ??
      (async ({ repo, prNumber }) => {
        if (!repo) {
          throw new Error(
            'Autopilot fixture branch permissions require a repo.',
          );
        }
        if (typeof prNumber !== 'number') {
          throw new Error(
            'Autopilot fixture branch permissions require a PR number.',
          );
        }
        return fixtureBranchPermissionResult(fixture, repo, prNumber);
      }),
    runExecution:
      dependencies.runExecution ??
      (async (input) => fixtureExecutionResult(fixture, input)),
    postPullRequestComment:
      dependencies.postPullRequestComment ??
      (async (input) => fixturePrCommentResult(fixture, input)),
    listPullRequestComments:
      dependencies.listPullRequestComments ?? (async () => []),
    pushGit:
      dependencies.pushGit ??
      (async (cwd, input) => fixturePushGit(fixture, cwd, input)),
  };
}

function autopilotFixtureEnabled() {
  return (
    process.env.NEONDECK_AUTOPILOT_FIXTURE_ENABLE === '1' ||
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true'
  );
}

async function readAutopilotFixture(path: string): Promise<AutopilotFixture> {
  if (cachedAutopilotFixture?.path === path) {
    return cachedAutopilotFixture.fixture;
  }

  const parsedJson = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const parsed = v.safeParse(autopilotFixtureSchema, parsedJson);
  if (!parsed.success) {
    throw new Error(
      `Invalid autopilot fixture ${path}: ${v.summarize(parsed.issues)}`,
    );
  }
  cachedAutopilotFixture = { path, fixture: parsed.output };
  return parsed.output;
}

function findFixturePullRequest(
  fixture: AutopilotFixture,
  owner: string,
  repo: string,
  number: number,
): GitHubPullRequestDetail {
  const fullName = `${owner}/${repo}`;
  const pr = fixture.pullRequests?.find(
    (candidate) => candidate.repo === fullName && candidate.number === number,
  );
  if (!pr) {
    throw new Error(
      `Autopilot fixture is missing PR facts for ${fullName}#${number}.`,
    );
  }
  return {
    ...pr,
    merged: pr.merged ?? false,
    mergeCommitSha: pr.mergeCommitSha ?? null,
  };
}

function findFixtureCheckSummary(
  fixture: AutopilotFixture,
  owner: string,
  repo: string,
  ref: string,
): GitHubCheckSummary {
  const fullName = `${owner}/${repo}`;
  const checks = fixture.checkSummaries?.find(
    (candidate) => candidate.repo === fullName && candidate.ref === ref,
  );
  if (!checks) {
    throw new Error(
      `Autopilot fixture is missing check summary for ${fullName}@${ref}.`,
    );
  }
  return checks.summary;
}

function findFixtureFailingChecks(
  fixture: AutopilotFixture,
  owner: string,
  repo: string,
  ref: string,
): GitHubFailingCheckFact[] {
  const fullName = `${owner}/${repo}`;
  const checks = fixture.failingChecks?.find(
    (candidate) => candidate.repo === fullName && candidate.ref === ref,
  );
  if (!checks) {
    throw new Error(
      `Autopilot fixture is missing failing check facts for ${fullName}@${ref}.`,
    );
  }
  return checks.checks as GitHubFailingCheckFact[];
}

function findFixtureEventState(
  fixture: AutopilotFixture,
  owner: string,
  repo: string,
  number: number,
): GitHubPullRequestEventState {
  const fullName = `${owner}/${repo}`;
  const state = fixture.eventStates?.find(
    (candidate) => candidate.repo === fullName && candidate.number === number,
  );
  if (!state) {
    throw new Error(
      `Autopilot fixture is missing event state for ${fullName}#${number}.`,
    );
  }
  return state as GitHubPullRequestEventState;
}

function fixtureBranchPermissionResult(
  fixture: AutopilotFixture,
  repo: string,
  prNumber: number,
) {
  const permissions = fixture.branchPermissions?.find(
    (candidate) => candidate.repo === repo && candidate.prNumber === prNumber,
  );
  if (!permissions) {
    throw new Error(
      `Autopilot fixture is missing branch permissions for ${repo}#${prNumber}.`,
    );
  }
  const [owner, name] = repo.split('/');
  return {
    ok: true,
    action: 'github_pr_branch_permissions_get',
    changed: false,
    message: `Fetched fixture branch permission facts for ${repo}#${prNumber}.`,
    data: {
      target: { repoFullName: repo, owner, repo: name, number: prNumber },
      branchPermissions: permissions.branchPermissions,
    },
  } as never;
}

function fixtureExecutionResult(fixture: AutopilotFixture, input: unknown) {
  const command = stringField(input, 'command') ?? '';
  const configured =
    fixture.execution?.commands?.[command] ?? fixture.execution?.default ?? {};
  const ok = configured.ok ?? true;
  const requires = configured.requires ?? [];
  return {
    ok,
    action: 'execution_run',
    changed: true,
    message:
      configured.message ??
      (ok ? 'Fixture execution passed.' : 'Fixture execution failed.'),
    result: { exitCode: configured.exitCode ?? (ok ? 0 : 1) },
    requires,
  } as never;
}

function fixturePrCommentResult(fixture: AutopilotFixture, input: unknown) {
  const body = stringField(input, 'body') ?? '';
  return (
    fixture.comments?.[0] ?? {
      id: 1,
      nodeId: 'fixture-comment',
      url: 'https://github.com/example/sample/pull/7#issuecomment-1',
      authorLogin: 'neondeck-fixture',
      body,
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
    }
  );
}

async function fixturePushGit(
  fixture: AutopilotFixture,
  cwd: string,
  input: { remote: string; branch: string; force?: boolean },
) {
  const fullName = fullNameFromGitHubRemote(input.remote);
  const remote = fixture.pushRemotes?.find(
    (candidate) => candidate.repo === fullName,
  );
  if (!remote) {
    throw new Error(
      `Autopilot fixture is missing push remote for ${fullName}.`,
    );
  }
  await execFileAsync(
    'git',
    ['push', remote.remote, `HEAD:refs/heads/${input.branch}`],
    {
      cwd,
    },
  );
  return {
    remote: input.remote,
    branch: input.branch,
    force: Boolean(input.force),
    stdout: '',
  } as never;
}

function fullNameFromGitHubRemote(remote: string) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(
    remote,
  );
  if (!match) {
    throw new Error(`Unsupported fixture push remote ${remote}.`);
  }
  return match[1];
}
