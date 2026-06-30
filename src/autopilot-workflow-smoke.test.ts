import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvePreparedDiffPush, listPreparedDiffs } from './prepared-diffs';
import { listNotifications, listWorkflowSummaries } from './app-state';
import { checkAutopilotConcurrency } from './autopilot-policy';
import {
  listPrWatchEventWatermarks,
  refreshPrWatchEventState,
} from './pr-event-state';
import { readWorkflowObservability } from './workflow-observability';
import { recordFlueObservation } from './workflow-observability';
import { runtimePaths } from './runtime-home';
import { addPrWatch } from './watch-actions';
import { createWorktree, lockWorktree } from './worktrees';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const originalEnv = { ...process.env };

vi.setConfig({ testTimeout: 60_000 });
vi.mock('./skills/github-gh/SKILL.md', async () => {
  const { defineSkill } = await import('@flue/runtime');
  return {
    default: defineSkill({
      name: 'github-gh',
      description: 'GitHub fixture skill for workflow smoke tests.',
    }),
  };
});
vi.mock('./skills/neondeck/SKILL.md', async () => {
  const { defineSkill } = await import('@flue/runtime');
  return {
    default: defineSkill({
      name: 'neondeck',
      description: 'Neondeck fixture skill for workflow smoke tests.',
    }),
  };
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('autopilot Flue workflow smoke', () => {
  it('runs PR autopilot workflows with local fixture dependencies', async () => {
    const workflows = await loadWorkflows();
    const { paths, featureSha, remote } = await fixture();
    await writeAutopilotFixture(paths.home, featureSha, remote);

    const triage = await runWorkflow(workflows.triagePrEvent, {
      repoId: 'sample',
      prNumber: 7,
      source: 'fixture',
      autopilotMode: 'auto-fix-push-after-checks',
      current: { state: 'open', headSha: featureSha, baseRef: 'main' },
      deltas: [
        {
          type: 'requested-changes',
          id: 'review-55',
          actionable: true,
          severity: 'high',
        },
      ],
    });
    expect(triage).toMatchObject({
      ok: true,
      action: 'autopilot_triage_pr_event',
      data: { shouldPrepareWorktree: true },
    });

    const preparedWorktree = await runWorkflow(workflows.preparePrWorktree, {
      repoId: 'sample',
      prNumber: 7,
      lock: false,
    });
    expect(preparedWorktree).toMatchObject({
      ok: true,
      action: 'autopilot_prepare_pr_worktree',
      data: {
        pr: { headSha: featureSha },
        worktree: { lifecycleStatus: 'ready' },
      },
    });

    const ciWorktreeId = stringPath(preparedWorktree, [
      'data',
      'worktree',
      'id',
    ]);
    const ciFix = await runWorkflow(workflows.fixPrCiFailure, {
      worktreeId: ciWorktreeId,
      checks: ['npm run check'],
      patch: [
        '*** Begin Patch',
        '*** Update File: src/app.ts',
        '@@',
        '-export const value = 2;',
        '+export const value = 4;',
        '*** End Patch',
      ].join('\n'),
      confidence: 'high',
      risk: 'low',
    });
    expect(ciFix).toMatchObject({
      ok: true,
      action: 'autopilot_fix_pr_ci_failure',
      data: { preparedDiff: { status: 'prepared' } },
    });

    const reviewFix = await runWorkflow(workflows.fixPrReviewFeedback, {
      repoId: 'sample',
      prNumber: 7,
      replacements: [
        {
          path: 'src/app.ts',
          oldString: 'export const value = 2;\n',
          newString: 'export const value = 3;\n',
        },
      ],
      lock: false,
    });
    expect(reviewFix).toMatchObject({
      ok: true,
      action: 'autopilot_fix_pr_review_feedback',
      data: { preparedDiff: { status: 'prepared' } },
    });

    const reviewWorktreeId = stringPath(reviewFix, ['data', 'worktree', 'id']);
    const preparedDiffId = stringPath(reviewFix, [
      'data',
      'preparedDiff',
      'id',
    ]);
    const approval = await approvePreparedDiffPush(
      {
        preparedDiffId,
        confirm: true,
        reason: 'Smoke fixture approval.',
        approverSurface: 'vitest',
      },
      paths,
    );
    expect(approval.ok).toBe(true);

    const verification = await runWorkflow(workflows.verifyPrWorktree, {
      worktreeId: reviewWorktreeId,
      checks: ['npm run check'],
      lock: false,
    });
    expect(verification).toMatchObject({
      ok: true,
      action: 'autopilot_verify_pr_worktree',
      data: { results: [{ command: 'npm run check', ok: true }] },
    });

    const push = await runWorkflow(workflows.pushPrAutofix, { preparedDiffId });
    expect(push).toMatchObject({
      ok: true,
      action: 'autopilot_push_pr_autofix',
      data: {
        preparedDiff: { status: 'pushed' },
        worktree: { lifecycleStatus: 'succeeded' },
        nextWorkflow: 'comment_pr_autofix_result',
      },
    });

    const comment = await runWorkflow(workflows.commentPrAutofixResult, {
      preparedDiffId,
    });
    expect(comment).toMatchObject({
      ok: true,
      action: 'autopilot_comment_pr_autofix_result',
      workflowSummary: {
        workflow: 'comment_pr_autofix_result',
        status: 'completed',
      },
    });

    await recordFlueObservation(
      {
        type: 'run_end',
        runId: 'run_autopilot_smoke',
        workflowName: 'push-pr-autofix',
        resourceKind: 'workflow',
        resourceName: 'push-pr-autofix',
        isError: false,
        durationMs: 12,
      } as never,
      paths,
    );

    await expect(
      listPreparedDiffs({ includeTerminal: true }, paths),
    ).resolves.toMatchObject({
      preparedDiffs: expect.arrayContaining([
        expect.objectContaining({ id: preparedDiffId, status: 'pushed' }),
      ]),
    });
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'autopilot',
          title: 'Autofix pushed',
        }),
      ]),
    );
    await expect(listWorkflowSummaries(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: 'comment_pr_autofix_result',
          status: 'completed',
        }),
      ]),
    );
    await expect(readWorkflowObservability(paths)).resolves.toMatchObject({
      recentEvents: expect.arrayContaining([
        expect.objectContaining({
          runId: 'run_autopilot_smoke',
          workflow: 'push-pr-autofix',
          eventType: 'run_end',
        }),
      ]),
    });
  });

  it('reconciles same-PR events while keeping parallel PR watermarks isolated', async () => {
    const { paths, featureSha } = await fixture();
    process.env.GITHUB_TOKEN = 'fixture-token';
    await addPrWatch({ ref: 'sample#7' }, paths, async () =>
      prFacts(featureSha),
    );
    await addPrWatch({ ref: 'sample#8' }, paths, async () => ({
      ...prFacts('other-head'),
      number: 8,
    }));

    const first = await refreshPrWatchEventState(
      { watchId: 'example/sample#7' },
      paths,
      { fetchPullRequestEventState: async () => reviewEventState(featureSha) },
    );
    const duplicate = await refreshPrWatchEventState(
      { watchId: 'example/sample#7' },
      paths,
      { fetchPullRequestEventState: async () => reviewEventState(featureSha) },
    );
    const parallel = await refreshPrWatchEventState(
      { watchId: 'example/sample#8' },
      paths,
      {
        fetchPullRequestEventState: async () => ({
          ...reviewEventState('other-head'),
          number: 8,
          url: 'https://github.com/example/sample/pull/8',
        }),
      },
    );

    expect(first).toMatchObject({
      ok: true,
      changed: true,
      data: { watchId: 'example/sample#7' },
    });
    expect(duplicate).toMatchObject({
      ok: true,
      changed: false,
      data: { changedCategories: [] },
    });
    expect(parallel).toMatchObject({
      ok: true,
      changed: true,
      data: { watchId: 'example/sample#8' },
    });
    await expect(
      listPrWatchEventWatermarks({ watchId: 'example/sample#7' }, paths),
    ).resolves.toMatchObject({
      data: {
        watermarks: expect.arrayContaining([
          expect.objectContaining({ watchId: 'example/sample#7' }),
        ]),
      },
    });
    await expect(
      listPrWatchEventWatermarks({ watchId: 'example/sample#8' }, paths),
    ).resolves.toMatchObject({
      data: {
        watermarks: expect.arrayContaining([
          expect.objectContaining({ watchId: 'example/sample#8' }),
        ]),
      },
    });
  });

  it('serializes same-PR mutation admission while allowing cross-PR work', async () => {
    const { paths, featureSha } = await fixture();
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          autopilot: {
            concurrency: {
              maxAutonomousJobs: 3,
              maxActiveWorkflowRuns: 3,
              maxPerRepoAutonomousJobs: 2,
              singleMutationPerPr: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const created = await createWorktree(
      {
        repoId: 'sample',
        prNumber: 7,
        baseRef: 'main',
        headRef: 'feature',
        headSha: featureSha,
      },
      paths,
    );
    expect(created.ok).toBe(true);
    const worktreeId = stringPath(created, ['worktree', 'id']);
    await expect(
      lockWorktree(
        {
          worktreeId,
          scope: 'pr',
          owner: 'fixture-active-pr-7',
          ttlSeconds: 3600,
        },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      checkAutopilotConcurrency(
        {
          repoId: 'sample',
          prNumber: 7,
          workflow: 'fix_pr_review_feedback',
          mutation: true,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      allowed: false,
      usage: { samePrMutationWorkflows: 1 },
    });
    await expect(
      checkAutopilotConcurrency(
        {
          repoId: 'sample',
          prNumber: 8,
          workflow: 'fix_pr_review_feedback',
          mutation: true,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      allowed: true,
      usage: { perRepoAutonomousJobs: 1, samePrMutationWorkflows: 0 },
    });
  });

  it('retains blocked push-back worktrees and high-risk prepared diffs', async () => {
    const workflows = await loadWorkflows();
    const { paths, featureSha, remote } = await fixture();
    await writeAutopilotFixture(paths.home, featureSha, remote, {
      canLikelyPush: false,
    });
    const reviewFix = await runWorkflow(workflows.fixPrReviewFeedback, {
      repoId: 'sample',
      prNumber: 7,
      replacements: [
        {
          path: 'src/app.ts',
          oldString: 'export const value = 2;\n',
          newString: 'export const value = 3;\n',
        },
      ],
      lock: false,
    });
    const worktreeId = stringPath(reviewFix, ['data', 'worktree', 'id']);
    const preparedDiffId = stringPath(reviewFix, [
      'data',
      'preparedDiff',
      'id',
    ]);
    await approvePreparedDiffPush({ preparedDiffId, confirm: true }, paths);
    await runWorkflow(workflows.verifyPrWorktree, {
      worktreeId,
      checks: ['npm run check'],
      lock: false,
    });

    const blockedPush = await runWorkflow(workflows.pushPrAutofix, {
      preparedDiffId,
    });
    expect(blockedPush).toMatchObject({
      ok: false,
      changed: true,
      requires: expect.arrayContaining(['github-permissions']),
      data: {
        preparedDiff: { status: 'push-blocked' },
        worktree: { lifecycleStatus: 'prepared-diff' },
      },
    });

    const preparedWorktree = await runWorkflow(workflows.preparePrWorktree, {
      repoId: 'sample',
      prNumber: 7,
      lock: false,
    });
    const highRiskWorktreeId = stringPath(preparedWorktree, [
      'data',
      'worktree',
      'id',
    ]);
    const highRisk = await runWorkflow(workflows.fixPrCiFailure, {
      worktreeId: highRiskWorktreeId,
      patch: [
        '*** Begin Patch',
        '*** Add File: package-lock.json',
        '+{"lockfileVersion":3}',
        '*** End Patch',
      ].join('\n'),
    });
    expect(highRisk).toMatchObject({
      ok: false,
      changed: true,
      requires: expect.arrayContaining(['approval']),
      data: {
        preparedDiff: { status: 'prepared' },
        policy: { approvalRequired: true },
      },
    });
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-smoke-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-smoke-repo-'));
  const remote = await mkdtemp(
    join(tmpdir(), 'neondeck-autopilot-smoke-remote-'),
  );
  tempRoots.push(home, repo, remote);
  const paths = runtimePaths(home);
  process.env.NEONDECK_HOME = home;

  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 1;\n');
  await writeFile(join(repo, 'package.json'), '{"scripts":{"check":"true"}}\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'main']);
  await git(repo, ['checkout', '-b', 'feature']);
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 2;\n');
  await git(repo, ['commit', '-am', 'feature']);
  const featureSha = (await gitOutput(repo, ['rev-parse', 'HEAD'])).trim();
  await git(repo, ['checkout', 'main']);
  await git(remote, ['init', '--bare']);
  await git(repo, ['remote', 'add', 'origin', remote]);
  await git(repo, ['push', 'origin', 'main', 'feature']);

  await mkdir(paths.home, { recursive: true });
  await writeFile(
    paths.config,
    `${JSON.stringify(
      {
        version: 1,
        autopilot: {
          defaultMode: 'autofix-with-approval',
          limits: { requiredChecks: ['npm run check'] },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    paths.repos,
    `${JSON.stringify(
      {
        repos: [
          {
            id: 'sample',
            github: { owner: 'example', name: 'sample' },
            path: repo,
            defaultBranch: 'main',
            packageScripts: { check: 'npm run check' },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  return { paths, featureSha, remote };
}

async function writeAutopilotFixture(
  home: string,
  featureSha: string,
  remote: string,
  options: { canLikelyPush?: boolean } = {},
) {
  const fixturePath = join(home, 'autopilot-fixture.json');
  await writeFile(
    fixturePath,
    `${JSON.stringify(
      {
        token: 'fixture-token',
        pullRequests: [prFacts(featureSha)],
        checkSummaries: [
          {
            repo: 'example/sample',
            ref: featureSha,
            summary: {
              status: 'failure',
              total: 1,
              successful: 0,
              failed: 1,
              pending: 0,
              checkedAt: '2026-06-30T00:00:00.000Z',
            },
          },
        ],
        failingChecks: [
          {
            repo: 'example/sample',
            ref: featureSha,
            checks: [failingCheck(featureSha)],
          },
        ],
        eventStates: [reviewEventState(featureSha)],
        branchPermissions: [
          {
            repo: 'example/sample',
            prNumber: 7,
            branchPermissions: branchPermissions(options.canLikelyPush ?? true),
          },
        ],
        execution: {
          default: {
            ok: true,
            message: 'Fixture execution passed.',
            exitCode: 0,
          },
        },
        pushRemotes: [{ repo: 'example/sample', remote }],
      },
      null,
      2,
    )}\n`,
  );
  process.env.NEONDECK_AUTOPILOT_FIXTURE_PATH = fixturePath;
  process.env.NEONDECK_AUTOPILOT_FIXTURE_ENABLE = '1';
  process.env.GITHUB_TOKEN = 'fixture-token';
}

function prFacts(featureSha: string) {
  return {
    number: 7,
    title: 'Update feature',
    repo: 'example/sample',
    url: 'https://github.com/example/sample/pull/7',
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: featureSha,
    headRef: 'feature',
    headOwner: 'example',
    headName: 'sample',
    baseRef: 'main',
    updatedAt: '2026-06-30T00:00:00.000Z',
    maintainerCanModify: true,
  };
}

function failingCheck(featureSha: string) {
  return {
    id: 903,
    name: 'check',
    headSha: featureSha,
    status: 'completed',
    conclusion: 'failure',
    url: null,
    htmlUrl: null,
    detailsUrl: null,
    startedAt: null,
    completedAt: null,
    outputTitle: null,
    outputSummary: 'npm run check failed.',
    outputText: null,
    annotations: [],
    log: {
      available: false,
      source: null,
      text: null,
      truncated: false,
      unavailableReason: 'Full logs are unavailable in this fixture.',
    },
  };
}

function reviewEventState(featureSha: string) {
  return {
    ...prFacts(featureSha),
    baseSha: null,
    mergeable: true,
    mergeableState: 'clean',
    commits: [
      {
        sha: featureSha,
        url: `https://github.com/example/sample/commit/${featureSha}`,
        authorLogin: 'contributor',
        committedAt: '2026-06-30T00:00:00.000Z',
      },
    ],
    reviewThreads: [
      {
        id: 'PRRT_1',
        isResolved: false,
        isOutdated: false,
        path: 'src/app.ts',
        line: 1,
        comments: [
          {
            id: 'PRRC_1',
            databaseId: 101,
            authorLogin: 'reviewer',
            body: 'Please use the next value here.',
            url: 'https://github.com/example/sample/pull/7#discussion_r101',
            path: 'src/app.ts',
            line: 1,
            originalLine: 1,
            diffHunk: '@@ -1 +1 @@',
            reviewId: 55,
            createdAt: '2026-06-30T00:00:00.000Z',
            updatedAt: '2026-06-30T00:00:00.000Z',
          },
        ],
      },
    ],
    requestedChangesReviews: [review(featureSha)],
    requestedChangesState: {
      active: [review(featureSha)],
      latestByReviewer: [review(featureSha)],
      history: [review(featureSha)],
    },
    checkSuites: [],
    checkRuns: [],
    branchPermissions: branchPermissions(true),
    isOutOfDate: false,
    fetchedAt: '2026-06-30T00:00:00.000Z',
  };
}

function review(featureSha: string) {
  return {
    id: 55,
    nodeId: 'PRR_55',
    state: 'CHANGES_REQUESTED',
    authorLogin: 'reviewer',
    submittedAt: '2026-06-30T00:00:00.000Z',
    commitId: featureSha,
    url: 'https://github.com/example/sample/pull/7#pullrequestreview-55',
  };
}

function branchPermissions(canLikelyPush: boolean) {
  return {
    headRepoFullName: 'example/sample',
    baseRepoFullName: 'example/sample',
    isFork: false,
    maintainerCanModify: true,
    headRepoPush: canLikelyPush,
    baseRepoPush: canLikelyPush,
    canLikelyPush,
    checkedAt: '2026-06-30T00:00:00.000Z',
  };
}

async function runWorkflow(workflow: unknown, input: unknown) {
  const runnable = workflow as {
    action: { run(context: { input: unknown }): unknown };
  };
  return Promise.resolve(runnable.action.run({ input }));
}

async function loadWorkflows() {
  const [
    commentPrAutofixResult,
    fixPrCiFailure,
    fixPrReviewFeedback,
    preparePrWorktree,
    pushPrAutofix,
    triagePrEvent,
    verifyPrWorktree,
  ] = await Promise.all([
    import('./workflows/comment-pr-autofix-result'),
    import('./workflows/fix-pr-ci-failure'),
    import('./workflows/fix-pr-review-feedback'),
    import('./workflows/prepare-pr-worktree'),
    import('./workflows/push-pr-autofix'),
    import('./workflows/triage-pr-event'),
    import('./workflows/verify-pr-worktree'),
  ]);
  return {
    commentPrAutofixResult: commentPrAutofixResult.default,
    fixPrCiFailure: fixPrCiFailure.default,
    fixPrReviewFeedback: fixPrReviewFeedback.default,
    preparePrWorktree: preparePrWorktree.default,
    pushPrAutofix: pushPrAutofix.default,
    triagePrEvent: triagePrEvent.default,
    verifyPrWorktree: verifyPrWorktree.default,
  };
}

function stringPath(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) {
    current =
      current && typeof current === 'object'
        ? (current as Record<string, unknown>)[key]
        : undefined;
  }
  if (typeof current !== 'string') {
    throw new Error(`Expected string at ${path.join('.')}`);
  }
  return current;
}

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}
