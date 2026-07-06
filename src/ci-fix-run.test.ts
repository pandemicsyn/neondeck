import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addWorkflowSummary,
  listNotifications,
  listWorkflowSummaries,
} from './modules/app-state';
import {
  createCiFailureDossierReport,
  type CiFixDossier,
  fixPrCiRun,
} from './modules/autopilot/ci-fix-run';
import { listPreparedDiffs } from './modules/prepared-diffs';
import { readReportHtml } from './modules/reports';
import type {
  GitHubFailingCheckFact,
  GitHubPullRequestEventState,
} from './modules/github';
import { reconcileCiFixRunForKiloTask } from './modules/kilo';
import type { KiloTaskRecord } from './modules/kilo';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('CI fix run', () => {
  it('writes an escaped CI dossier report with failing checks and command hints', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    const result = await createCiFailureDossierReport(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      testDependencies(),
    );

    expect(result).toMatchObject({
      ok: true,
      report: {
        repoId: 'neondeck',
        sourceRef: 'pandemicsyn/neondeck#10',
      },
      data: {
        dossier: {
          likelyCommands: ['npm run test'],
          suspectFiles: ['src/failing.test.ts'],
        },
      },
    });
    if (!result.ok || !('report' in result)) {
      throw new Error(result.message);
    }
    const html = await readReportHtml(result.report.id, paths);
    expect(html?.html).toContain('CI Failure Dossier');
    expect(html?.html).toContain('npm run test');
    expect(html?.html).toContain('src/failing.test.ts');
    expect(html?.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html?.html).not.toContain('<script>alert(1)</script>');
  });

  it('fails deterministically on CI fix lock contention without starting Kilo', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    let startedKilo = false;

    const result = await fixPrCiRun(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        ...testDependencies(),
        preparePrWorktree: async () =>
          ({
            ok: true,
            action: 'autopilot_prepare_pr_worktree',
            changed: true,
            message: 'prepared',
            data: {
              worktree: {
                id: 'worktree-1',
                headSha: 'abc123',
              },
            },
          }) as never,
        lockWorktree: async () =>
          ({
            ok: false,
            action: 'worktree_lock',
            changed: false,
            message: 'Lock is already held by ci-fix-run.',
          }) as never,
        startKiloTask: async () => {
          startedKilo = true;
          throw new Error('should not start Kilo');
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      requires: ['worktreeLock'],
      data: {
        report: { url: expect.stringContaining('/reports/') },
      },
    });
    expect(startedKilo).toBe(false);
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          title: 'CI fix needs attention',
        }),
      ]),
    );
  });

  it('marks a successful no-op Kilo run without creating a prepared diff', async () => {
    const home = await tempDir('neondeck-home-');
    const cwd = await tempDir('ci-fix-worktree-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await addWorkflowSummary(
      {
        workflow: 'ci_fix_run',
        runId: 'kilo-task-1',
        status: 'running',
        summary: {
          outcome: 'kilo-started',
          pr: 'pandemicsyn/neondeck#10',
          kiloTaskId: 'kilo-task-1',
          worktreeId: 'worktree-1',
          reportId: 'report-1',
        },
      },
      paths,
    );

    await reconcileCiFixRunForKiloTask(
      {
        task: kiloTask({ id: 'kilo-task-1', cwd, worktreeId: 'worktree-1' }),
        status: 'succeeded',
        diff: { ok: true, fileCount: 0 },
      },
      paths,
    );

    await expect(listPreparedDiffs({}, paths)).resolves.toMatchObject({
      preparedDiffs: [],
    });
    await expect(listWorkflowSummaries(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: 'ci_fix_run',
          status: 'completed',
          summary: expect.objectContaining({ outcome: 'no-op' }),
        }),
      ]),
    );
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          title: 'CI fix needs attention',
        }),
      ]),
    );
  });
});

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function writeRepoRegistry(path: string) {
  await writeFile(
    path,
    `${JSON.stringify({
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: '/tmp/neondeck',
          defaultBranch: 'main',
          packageScripts: { test: 'vitest' },
        },
      ],
    })}\n`,
  );
}

function testDependencies() {
  return {
    readDossier: async () => ciFixDossier(),
  };
}

function ciFixDossier(): CiFixDossier {
  return {
    target: {
      repoFullName: 'pandemicsyn/neondeck',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 10,
    },
    state: pullRequestEventState(),
    repo: {
      id: 'neondeck',
      github: { owner: 'pandemicsyn', name: 'neondeck' },
      path: '/tmp/neondeck',
      defaultBranch: 'main',
      packageScripts: { test: 'vitest' },
    },
    failingChecks: failingChecks(),
    likelyCommands: ['npm run test'],
    fetchedAt: '2026-07-05T20:02:30.000Z',
  };
}

function pullRequestEventState(): GitHubPullRequestEventState {
  return {
    repo: 'pandemicsyn/neondeck',
    number: 10,
    url: 'https://github.com/pandemicsyn/neondeck/pull/10',
    title: 'Fix CI',
    body: 'This PR changes tests.',
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: 'abc123def456',
    headRef: 'ci-fix',
    baseRef: 'main',
    baseSha: 'base123',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [
      {
        sha: 'abc123def456',
        url: 'https://github.com/pandemicsyn/neondeck/commit/abc123def456',
        authorLogin: 'pandemicsyn',
        committedAt: '2026-07-05T19:59:00.000Z',
      },
    ],
    reviewThreads: [],
    requestedChangesReviews: [],
    requestedChangesState: {
      active: [],
      latestByReviewer: [],
      history: [],
    },
    checkSuites: [],
    checkRuns: [],
    branchPermissions: {
      headRepoFullName: 'pandemicsyn/neondeck',
      baseRepoFullName: 'pandemicsyn/neondeck',
      isFork: false,
      maintainerCanModify: true,
      headRepoPush: true,
      baseRepoPush: true,
      canLikelyPush: true,
      checkedAt: '2026-07-05T20:00:00.000Z',
    },
    isOutOfDate: false,
    fetchedAt: '2026-07-05T20:02:00.000Z',
  };
}

function failingChecks(): GitHubFailingCheckFact[] {
  return [
    {
      id: 42,
      name: 'npm run test',
      headSha: 'abc123def456',
      status: 'completed',
      conclusion: 'failure',
      url: 'https://api.github.com/check-runs/42',
      htmlUrl: 'https://github.com/pandemicsyn/neondeck/actions/runs/42',
      detailsUrl: 'https://github.com/pandemicsyn/neondeck/actions/runs/42/job/1',
      startedAt: '2026-07-05T20:01:00.000Z',
      completedAt: '2026-07-05T20:02:00.000Z',
      outputTitle: 'Tests failed',
      outputSummary: 'One test failed.',
      outputText: null,
      annotations: [
        {
          path: 'src/failing.test.ts',
          startLine: 12,
          endLine: 12,
          annotationLevel: 'failure',
          title: 'Assertion failed',
          message: 'Expected true but got false <b>boom</b>',
          rawDetails: null,
        },
      ],
      log: {
        available: true,
        source: 'github-actions-job',
        text: 'npm run test\nERROR src/failing.test.ts:12 <script>alert(1)</script>',
        truncated: false,
        unavailableReason: null,
      },
    },
  ];
}

function kiloTask(input: {
  id: string;
  cwd: string;
  worktreeId: string | null;
}): KiloTaskRecord {
  return {
    id: input.id,
    title: 'Fix CI',
    prompt: 'prompt',
    repoId: 'neondeck',
    repoFullName: 'pandemicsyn/neondeck',
    worktreeId: input.worktreeId,
    lockId: null,
    cwd: input.cwd,
    mode: 'draft-fix',
    status: 'succeeded',
    explicitUserRequest: true,
    autoEnabled: true,
    cliPath: 'kilo',
    args: [],
    pid: null,
    processStartedAt: null,
    rootSessionId: null,
    childSessionIds: [],
    rawLogPath: null,
    summary: null,
    exitCode: 0,
    error: null,
    createdAt: '2026-07-05T20:00:00.000Z',
    updatedAt: '2026-07-05T20:00:00.000Z',
    completedAt: '2026-07-05T20:01:00.000Z',
  };
}
