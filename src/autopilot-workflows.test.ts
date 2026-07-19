import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { listWorkflowSummaries } from './modules/app-state';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import {
  checkAutopilotConcurrency,
  checkAutopilotPolicy,
  approvePreparedDiffPushWithPolicy,
} from './modules/autopilot';
import {
  fixPrCiFailure,
  fixPrReviewFeedback,
  commentPrAutofixResult,
  preparePrWorktree,
  pushPrAutofix,
  triagePrEvent,
  verifyPrWorktree,
} from './modules/autopilot';
import {
  abandonPreparedDiff,
  ensurePreparedDiffForWorktree,
  readPreparedDiff,
} from './modules/prepared-diffs';
import { lockWorktree, releaseWorktreeLock } from './modules/worktrees';
import { approvePreparedDiffPushWithDispatch } from './server/autopilot-push-dispatch';
import { runWithFlueExecutionContextForTests } from './modules/flue/execution-context';
import {
  createSeededGitRepository,
  type SeededGitRepository,
} from './testing/git-repository-fixture';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
let repositorySeed: SeededGitRepository | undefined;

vi.setConfig({ testTimeout: 60_000 });

beforeAll(async () => {
  repositorySeed = await createSeededGitRepository({
    initialCommitMessage: 'main',
    initialFiles: { 'src/app.ts': 'export const value = 1;\n' },
    feature: {
      files: { 'src/app.ts': 'export const value = 2;\n' },
    },
  });
});

afterAll(async () => {
  await repositorySeed?.dispose();
});

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PR event autopilot', () => {
  it('classifies actionable review feedback according to autopilot mode', async () => {
    const result = await triagePrEvent({
      repoId: 'sample',
      prNumber: 7,
      source: 'fixture',
      autopilotMode: 'autofix-with-approval',
      current: {
        state: 'open',
        draft: false,
        headSha: 'abc123',
        baseRef: 'main',
      },
      deltas: [
        {
          type: 'requested-changes',
          id: 'review-1',
          actionable: true,
          severity: 'high',
          summary: 'Reviewer requested a small code change.',
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      action: 'autopilot_triage_pr_event',
      data: {
        classification: 'autofix-with-approval',
        shouldPrepareWorktree: true,
        nextWorkflow: 'prepare_pr_worktree',
      },
    });
  });

  it('keeps merge conflicts in explain-only triage', async () => {
    const result = await triagePrEvent({
      repoId: 'sample',
      prNumber: 8,
      source: 'fixture',
      autopilotMode: 'prepare-only',
      current: { state: 'open', mergeable: false },
      deltas: [{ type: 'merge-conflict', actionable: true }],
    });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      data: {
        classification: 'explain-only',
        shouldPrepareWorktree: false,
      },
    });
  });

  it('prepares a managed PR worktree from deterministic PR facts', async () => {
    const { paths, featureSha } = await fixture();
    const result = await preparePrWorktree(
      {
        repoId: 'sample',
        prNumber: 7,
        eventId: 'watch-event-1',
        lockOwner: 'test-prepare',
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestDetail() {
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
        },
        async fetchCheckSummary() {
          return {
            status: 'success',
            total: 1,
            successful: 1,
            failed: 0,
            pending: 0,
            checkedAt: '2026-06-30T00:00:00.000Z',
          };
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      action: 'autopilot_prepare_pr_worktree',
      data: {
        repo: { id: 'sample', fullName: 'example/sample' },
        pr: { number: 7, headSha: featureSha },
        checks: { status: 'success' },
        worktree: {
          repoId: 'sample',
          prNumber: 7,
          lifecycleStatus: 'ready',
          directPushAllowed: true,
        },
        lock: null,
        status: {
          ok: true,
          git: { dirty: false },
        },
        eventId: 'watch-event-1',
        runLinkage: { owningWorkflowRunIdAttached: false },
      },
    });
  });

  it('prepares a managed PR worktree under an existing caller lock', async () => {
    const { paths, featureSha } = await fixture();
    const locked = await lockWorktree(
      {
        repoId: 'sample',
        prNumber: 7,
        scope: 'pr',
        owner: 'ci-fix-run',
        ttlSeconds: 300,
      },
      paths,
    );
    if (!locked.ok || !('lock' in locked)) {
      throw new Error(locked.message);
    }

    try {
      const result = await preparePrWorktree(
        {
          repoId: 'sample',
          prNumber: 7,
          lock: false,
          lockId: locked.lock.id,
        },
        paths,
        {
          token: 'test-token',
          async fetchPullRequestDetail() {
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
          },
          async fetchCheckSummary() {
            return {
              status: 'success',
              total: 1,
              successful: 1,
              failed: 0,
              pending: 0,
              checkedAt: '2026-06-30T00:00:00.000Z',
            };
          },
        },
      );

      expect(result).toMatchObject({
        ok: true,
        action: 'autopilot_prepare_pr_worktree',
        data: {
          worktree: {
            repoId: 'sample',
            prNumber: 7,
            lifecycleStatus: 'ready',
          },
          lock: null,
        },
      });
    } finally {
      await releaseWorktreeLock(
        { lockId: locked.lock.id, owner: 'ci-fix-run' },
        paths,
      );
    }
  });

  it('does not accept caller-supplied PR facts as authoritative input', async () => {
    const { paths, featureSha } = await fixture();
    const previousToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const result = await preparePrWorktree(
        {
          repoId: 'sample',
          prNumber: 7,
          pr: {
            number: 7,
            title: 'Fabricated',
            repo: 'example/sample',
            url: 'https://github.com/example/sample/pull/7',
            state: 'open',
            headSha: featureSha,
            headRef: 'feature',
            baseRef: 'main',
            updatedAt: '2026-06-30T00:00:00.000Z',
            maintainerCanModify: true,
          },
          checks: {
            status: 'success',
            total: 1,
            successful: 1,
            failed: 0,
            pending: 0,
            checkedAt: '2026-06-30T00:00:00.000Z',
          },
        },
        paths,
      );

      expect(result).toMatchObject({
        ok: false,
        action: 'autopilot_prepare_pr_worktree',
        message: 'Invalid autopilot input.',
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousToken;
      }
    }
  });

  it('classifies default high-risk worktree changes before verification or push', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const localPath = stringPath(prepared, ['data', 'worktree', 'localPath']);
    await writeFile(
      join(localPath, 'package-lock.json'),
      '{"lockfileVersion":3}\n',
    );

    const policy = await checkAutopilotPolicy({ worktreeId }, paths);

    expect(policy).toMatchObject({
      ok: true,
      approvalRequired: true,
      blocked: false,
      diff: { filesChanged: 1 },
    });
    expect(policy.files[0]).toMatchObject({
      path: 'package-lock.json',
      approvalRequired: true,
      classes: expect.arrayContaining(['lockfile']),
    });
  });

  it('applies PR watch overrides during downstream autopilot policy checks', async () => {
    const { paths, featureSha, repo } = await fixture();
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          autopilot: {
            defaultMode: 'notify-only',
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
              metadata: {
                autopilot: {
                  watchOverrides: [
                    {
                      prNumber: 7,
                      mode: 'autofix-with-approval',
                    },
                  ],
                },
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const policy = await checkAutopilotPolicy({ worktreeId }, paths);

    expect(policy).toMatchObject({
      ok: true,
      mode: 'autofix-with-approval',
    });
  });

  it('applies watch-id overrides during downstream autopilot policy checks', async () => {
    const { paths, featureSha, repo } = await fixture();
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          autopilot: {
            defaultMode: 'notify-only',
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
              metadata: {
                autopilot: {
                  watchOverrides: [
                    {
                      watchId: 'example/sample#7',
                      mode: 'autofix-with-approval',
                    },
                  ],
                },
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const policy = await checkAutopilotPolicy({ worktreeId }, paths);

    expect(policy).toMatchObject({
      ok: true,
      mode: 'autofix-with-approval',
    });
  });

  it('classifies root package dependency changes even without approval globs', async () => {
    const { paths, featureSha } = await fixture();
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          guardrails: {
            approvalRequiredFileGlobs: [],
            highRiskClasses: ['dependency-manifest'],
          },
        },
        null,
        2,
      )}\n`,
    );
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const localPath = stringPath(prepared, ['data', 'worktree', 'localPath']);
    await writeFile(
      join(localPath, 'package.json'),
      `${JSON.stringify({ dependencies: { react: '^19.0.0' } }, null, 2)}\n`,
    );

    const policy = await checkAutopilotPolicy({ worktreeId }, paths);

    expect(policy.files[0]).toMatchObject({
      path: 'package.json',
      approvalRequired: true,
      classes: expect.arrayContaining(['dependency-manifest']),
    });
  });

  it('blocks push destinations outside autopilot policy', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);

    const policy = await checkAutopilotPolicy(
      { worktreeId, pushDestination: 'base-branch' },
      paths,
    );

    expect(policy).toMatchObject({
      blocked: true,
      canPush: false,
      requires: expect.arrayContaining(['allowedPushDestinations']),
    });
  });

  it('counts hyphenated active Flue workflow names for concurrency limits', async () => {
    const { paths } = await fixture();
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          autopilot: {
            concurrency: { maxActiveWorkflowRuns: 1 },
          },
        },
        null,
        2,
      )}\n`,
    );
    insertActiveWorkflowRun(paths, 'run-verify', 'verify-pr-worktree');

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: 'sample',
        prNumber: 7,
        workflow: 'prepare_pr_worktree',
        mutation: true,
      },
      paths,
    );

    expect(concurrency).toMatchObject({
      allowed: false,
      usage: { activeWorkflowRuns: 1 },
    });
  });

  it('verifies a PR worktree by running configured checks through execution policy', async () => {
    const { paths, featureSha } = await fixture();
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          guardrails: { requiredChecks: ["node -e 'process.exit(0)'"] },
          execution: {
            preapprovedCommands: [
              {
                id: 'node-ok',
                command: "node -e 'process.exit(0)'",
                match: 'exact',
                backends: ['local'],
                description: 'Fixture check.',
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);

    const result = await verifyPrWorktree({ worktreeId, lock: false }, paths);

    expect(result).toMatchObject({
      ok: true,
      action: 'autopilot_verify_pr_worktree',
      data: {
        checks: ["node -e 'process.exit(0)'"],
        results: [
          {
            command: "node -e 'process.exit(0)'",
            ok: true,
            exitCode: 0,
          },
        ],
      },
    });
  });

  it('runs policy-required checks even when caller supplies additional checks', async () => {
    const { paths, featureSha } = await fixture();
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          guardrails: {
            requiredChecks: ['node -e \'process.stdout.write("required")\''],
          },
          execution: {
            preapprovedCommands: [
              {
                id: 'required',
                command: 'node -e \'process.stdout.write("required")\'',
                match: 'exact',
                backends: ['local'],
                description: 'Required fixture check.',
              },
              {
                id: 'caller',
                command: 'node -e \'process.stdout.write("caller")\'',
                match: 'exact',
                backends: ['local'],
                description: 'Caller fixture check.',
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);

    const result = await verifyPrWorktree(
      {
        worktreeId,
        checks: ['node -e \'process.stdout.write("caller")\''],
        lock: false,
      },
      paths,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        checks: [
          'node -e \'process.stdout.write("required")\'',
          'node -e \'process.stdout.write("caller")\'',
        ],
      },
    });
  });

  it('applies concurrency limits before preparing a PR worktree', async () => {
    const { paths, featureSha } = await fixture();
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          autopilot: {
            concurrency: { maxActiveWorkflowRuns: 1 },
          },
        },
        null,
        2,
      )}\n`,
    );
    insertActiveWorkflowRun(paths, 'run-prepare', 'prepare-pr-worktree');

    const result = await preparePrWorktree(
      {
        repoId: 'sample',
        prNumber: 7,
        lock: false,
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestDetail() {
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
        },
        async fetchCheckSummary() {
          return {
            status: 'success',
            total: 1,
            successful: 1,
            failed: 0,
            pending: 0,
            checkedAt: '2026-06-30T00:00:00.000Z',
          };
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_prepare_pr_worktree',
      requires: ['concurrency'],
    });
  });

  it('blocks unattended verification checks that are not preapproved', async () => {
    const { paths, featureSha } = await fixture();
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          guardrails: { requiredChecks: ["node -e 'process.exit(0)'"] },
        },
        null,
        2,
      )}\n`,
    );
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);

    const result = await verifyPrWorktree({ worktreeId, lock: false }, paths);

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_verify_pr_worktree',
      message:
        'Verification is blocked by execution approval or concurrency policy.',
      data: {
        results: [
          {
            command: "node -e 'process.exit(0)'",
            ok: false,
            requires: ['preapprovedCommands'],
          },
        ],
      },
    });
  });
  it('fixes a PR CI failure in a managed worktree and creates a prepared diff', async () => {
    const { paths, featureSha } = await fixture();
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          execution: {
            preapprovedCommands: [
              {
                id: 'ci-diagnostic',
                command: 'node -e \'process.stdout.write("diagnostic ok")\'',
                match: 'exact',
                backends: ['local'],
                description: 'Fixture diagnostic.',
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);

    const result = await fixPrCiFailure(
      {
        worktreeId,
        diagnostics: ['node -e \'process.stdout.write("diagnostic ok")\''],
        patch: [
          '*** Begin Patch',
          '*** Update File: src/app.ts',
          '@@',
          '-export const value = 2;',
          '+export const value = 3;',
          '*** End Patch',
        ].join('\n'),
        confidence: 'high',
        risk: 'low',
        manualAsks: ['Confirm CI logs in GitHub after push.'],
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestDetail() {
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
        },
        async fetchFailingCheckFacts() {
          return [
            {
              id: 901,
              name: 'check',
              headSha: featureSha,
              status: 'completed',
              conclusion: 'failure',
              url: 'https://api.github.com/check-runs/901',
              htmlUrl: 'https://github.com/example/sample/runs/901',
              detailsUrl: null,
              startedAt: '2026-06-30T00:00:00.000Z',
              completedAt: '2026-06-30T00:01:00.000Z',
              outputTitle: 'Tests failed',
              outputSummary: 'Expected value 3.',
              outputText: null,
              annotations: [
                {
                  path: 'src/app.ts',
                  startLine: 1,
                  endLine: 1,
                  annotationLevel: 'failure',
                  message: 'Expected value 3.',
                  title: 'Assertion failed',
                  rawDetails: null,
                },
              ],
              log: {
                available: false,
                source: null,
                text: null,
                truncated: false,
                unavailableReason: 'Full logs are unavailable in this fixture.',
              },
            },
          ];
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      action: 'autopilot_fix_pr_ci_failure',
      data: {
        failingChecks: [
          {
            id: 901,
            name: 'check',
            log: {
              available: false,
              unavailableReason: 'Full logs are unavailable in this fixture.',
            },
          },
        ],
        diagnostics: [
          {
            command: 'node -e \'process.stdout.write("diagnostic ok")\'',
            ok: true,
            exitCode: 0,
          },
        ],
        commit: { committed: true },
        preparedDiff: {
          worktreeId,
          status: 'prepared',
          pushApprovalStatus: 'pending',
          summary: {
            confidence: 'high',
            risk: 'low',
            remainingManualAsks: ['Confirm CI logs in GitHub after push.'],
          },
        },
      },
    });
  });

  it('does not apply a CI fix patch when diagnostics need approval', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const localPath = stringPath(prepared, ['data', 'worktree', 'localPath']);

    const result = await fixPrCiFailure(
      {
        worktreeId,
        diagnostics: ['node -e \'process.stdout.write("needs approval")\''],
        patch: [
          '*** Begin Patch',
          '*** Update File: src/app.ts',
          '@@',
          '-export const value = 2;',
          '+export const value = 4;',
          '*** End Patch',
        ].join('\n'),
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestDetail() {
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
        },
        async fetchFailingCheckFacts() {
          return [
            {
              id: 902,
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
              outputSummary: null,
              outputText: null,
              annotations: [],
              log: {
                available: false,
                source: null,
                text: null,
                truncated: false,
                unavailableReason: 'No log.',
              },
            },
          ];
        },
      },
    );

    await expect(readFile(join(localPath, 'src/app.ts'), 'utf8')).resolves.toBe(
      'export const value = 2;\n',
    );
    expect(result).toMatchObject({
      ok: false,
      changed: false,
      requires: ['approval'],
      data: {
        patchSkipped: true,
        diagnostics: [
          {
            command: 'node -e \'process.stdout.write("needs approval")\'',
            ok: false,
            requires: ['preapprovedCommands'],
          },
        ],
      },
    });
  });

  it('refuses to fix CI when the managed worktree is already dirty', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const localPath = stringPath(prepared, ['data', 'worktree', 'localPath']);
    await writeFile(join(localPath, 'scratch.txt'), 'manual dirt\n');

    const result = await fixPrCiFailure({ worktreeId }, paths);

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      requires: ['cleanWorktree'],
      message:
        'Worktree has existing uncommitted changes; refusing to mix them into an autonomous CI fix.',
    });
  });

  it('prepares but does not commit high-risk CI fix patches', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await preparePreparedWorktree(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);

    const result = await fixPrCiFailure(
      {
        worktreeId,
        patch: [
          '*** Begin Patch',
          '*** Add File: package-lock.json',
          '+{"lockfileVersion":3}',
          '*** End Patch',
        ].join('\n'),
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestDetail() {
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
        },
        async fetchFailingCheckFacts() {
          return [
            {
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
              outputSummary: 'Lockfile changed.',
              outputText: null,
              annotations: [],
              log: {
                available: false,
                source: null,
                text: null,
                truncated: false,
                unavailableReason: 'No log.',
              },
            },
          ];
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      changed: true,
      action: 'autopilot_fix_pr_ci_failure',
      data: {
        policy: {
          approvalRequired: true,
          files: [
            expect.objectContaining({
              path: 'package-lock.json',
              approvalRequired: true,
            }),
          ],
        },
        preparedDiff: {
          worktreeId,
          status: 'prepared',
          summary: {
            committed: false,
            policy: { approvalRequired: true },
          },
        },
      },
    });
    expect((result.data as Record<string, unknown>).commit).toBeUndefined();
  });

  it('does not expose lock bypass on the CI fixer input', async () => {
    const result = await fixPrCiFailure({
      worktreeId: 'wt_123',
      lock: false,
    });

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_fix_pr_ci_failure',
      message: 'Invalid autopilot input.',
    });
  });

  it('fixes review feedback in an isolated worktree and prepares a local committed diff', async () => {
    const { paths, featureSha } = await fixture();
    const result = await fixPrReviewFeedback(
      {
        repoId: 'sample',
        prNumber: 7,
        addressedReviewCommentIds: ['PRRC_1'],
        addressedReviewThreadIds: ['PRRT_1'],
        replacements: [
          {
            path: 'src/app.ts',
            oldString: 'export const value = 2;\n',
            newString: 'export const value = 3;\n',
          },
        ],
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestEventState() {
          return reviewEventState(featureSha);
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      action: 'autopilot_fix_pr_review_feedback',
      data: {
        plan: {
          groupCount: 1,
          groups: [
            {
              path: 'src/app.ts',
              commentIds: ['PRRC_1'],
              threadIds: ['PRRT_1'],
            },
          ],
        },
        commit: {
          committed: true,
        },
        preparedDiff: {
          repoId: 'sample',
          prNumber: 7,
          baseRef: featureSha,
          status: 'prepared',
          pushApprovalStatus: 'pending',
        },
      },
    });
    const worktreePath = stringPath(result, ['data', 'worktree', 'localPath']);
    const file = await gitOutput(worktreePath, ['show', 'HEAD:src/app.ts']);
    expect(file).toBe('export const value = 3;\n');
    const commitMessage = await gitOutput(worktreePath, [
      'log',
      '-1',
      '--pretty=%B',
    ]);
    expect(commitMessage).toContain('Review comments: PRRC_1');
    expect(commitMessage).toContain('Review threads: PRRT_1');
  });

  it('refuses review feedback fixes when there are no unresolved comments', async () => {
    const { paths, featureSha } = await fixture();
    const result = await fixPrReviewFeedback(
      {
        repoId: 'sample',
        prNumber: 7,
        replacements: [
          {
            path: 'src/app.ts',
            oldString: 'export const value = 2;\n',
            newString: 'export const value = 3;\n',
          },
        ],
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestEventState() {
          return { ...reviewEventState(featureSha), reviewThreads: [] };
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_fix_pr_review_feedback',
      requires: ['unresolvedReviewComments'],
    });
  });

  it('refuses review feedback edits outside unresolved review paths', async () => {
    const { paths, featureSha } = await fixture();
    const result = await fixPrReviewFeedback(
      {
        repoId: 'sample',
        prNumber: 7,
        replacements: [
          {
            path: 'README.md',
            oldString: 'missing',
            newString: 'changed',
          },
        ],
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestEventState() {
          return reviewEventState(featureSha);
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_fix_pr_review_feedback',
      message:
        'Review feedback fixes may only edit files that have unresolved review comments.',
    });
  });

  it('refuses a supplied worktree for a different PR', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await preparePrWorktree(
      {
        repoId: 'sample',
        prNumber: 8,
        lock: false,
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestDetail() {
          return {
            number: 8,
            title: 'Different PR',
            repo: 'example/sample',
            url: 'https://github.com/example/sample/pull/8',
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
        },
        async fetchCheckSummary() {
          return {
            status: 'success',
            total: 1,
            successful: 1,
            failed: 0,
            pending: 0,
            checkedAt: '2026-06-30T00:00:00.000Z',
          };
        },
      },
    );
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);

    const result = await fixPrReviewFeedback(
      {
        repoId: 'sample',
        prNumber: 7,
        worktreeId,
        replacements: [
          {
            path: 'src/app.ts',
            oldString: 'export const value = 2;\n',
            newString: 'export const value = 3;\n',
          },
        ],
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestEventState() {
          return reviewEventState(featureSha);
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_fix_pr_review_feedback',
      requires: ['worktreeId'],
    });
  });

  it('validates fixture GitHub review event state at the action boundary', async () => {
    const { paths } = await fixture();
    const result = await fixPrReviewFeedback(
      {
        repoId: 'sample',
        prNumber: 7,
        replacements: [
          {
            path: 'src/app.ts',
            oldString: 'export const value = 2;\n',
            newString: 'export const value = 3;\n',
          },
        ],
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestEventState() {
          return { repo: 'example/sample' } as never;
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_fix_pr_review_feedback',
      message: 'Invalid GitHub PR review event state.',
    });
  });

  it('posts and audits concise PR autofix result comments from prepared-diff facts', async () => {
    delete process.env.GITHUB_TOKEN;
    const { paths, featureSha, repo } = await fixture();
    const preparedDiff = await ensurePreparedDiffForWorktree(
      {
        id: 'wt-comment-1',
        repoId: 'sample',
        repoFullName: 'example/sample',
        prNumber: 7,
        localPath: repo,
        baseRef: 'main',
        headRef: 'feature',
        headSha: featureSha,
        lifecycleStatus: 'prepared-diff',
      },
      paths,
      {
        createdBy: 'fix_pr_review_feedback',
        title: 'Review feedback fix for example/sample#7',
        summary: {
          workflow: 'fix_pr_review_feedback',
          addressed: {
            reviewCommentIds: ['PRRC_1'],
            reviewThreadIds: ['PRRT_1'],
          },
          commit: {
            committed: true,
            sha: featureSha,
          },
          diffSummary: {
            files: 1,
            additions: 2,
            deletions: 1,
            binaryFiles: 0,
          },
          checksRun: [
            {
              name: 'npm run check',
              status: 'passed',
              checkRunId: 6001,
            },
          ],
          remainingManualAsks: ['Reviewer re-review is still needed.'],
        },
      },
    );
    const calls: Array<{
      owner: string;
      repo: string;
      number: number;
      body: string;
    }> = [];

    const result = await commentPrAutofixResult(
      {
        preparedDiffId: preparedDiff.id,
      },
      paths,
      {
        token: 'fixture-token',
        async fetchPullRequestEventState() {
          return reviewEventState(featureSha);
        },
        listPullRequestComments: async () => [],
        postPullRequestComment: async (input) => {
          calls.push(input);
          return {
            id: 99,
            nodeId: 'comment-node-99',
            url: 'https://github.com/example/sample/pull/7#issuecomment-99',
            authorLogin: 'neon',
            body: input.body,
            createdAt: '2026-06-30T21:00:00Z',
            updatedAt: '2026-06-30T21:00:00Z',
          };
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      action: 'autopilot_comment_pr_autofix_result',
      data: {
        comment: {
          data: {
            metadata: {
              addressedReviewThreadIds: ['PRRT_1'],
              addressedReviewCommentIds: ['PRRC_1'],
              checkRunIds: [6001],
              commitSha: featureSha,
            },
          },
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      owner: 'example',
      repo: 'sample',
      number: 7,
    });
    expect(calls[0]?.body).toContain(
      'Neon autopilot result for example/sample#7: prepared.',
    );
    expect(calls[0]?.body).toContain('Addressed review comments: PRRC_1.');
    expect(calls[0]?.body).toContain('Checks run: npm run check passed.');
    expect(calls[0]?.body).toContain(
      'Remaining manual asks: Reviewer re-review is still needed.',
    );

    const summaries = await listWorkflowSummaries(paths);
    expect(summaries[0]).toMatchObject({
      workflow: 'comment_pr_autofix_result',
      status: 'completed',
      summary: {
        humanSummary: expect.stringContaining('prepared diff'),
        audit: {
          preparedDiffId: preparedDiff.id,
          worktreeId: 'wt-comment-1',
          addressedReviewCommentIds: ['PRRC_1'],
        },
      },
    });
  });

  it('refuses to comment on prepared diffs that are not result states', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const { paths, featureSha, repo } = await fixture();
    const preparedDiff = await ensurePreparedDiffForWorktree(
      {
        id: 'wt-comment-pending',
        repoId: 'sample',
        repoFullName: 'example/sample',
        prNumber: 7,
        localPath: repo,
        baseRef: 'main',
        headRef: 'feature',
        headSha: featureSha,
        lifecycleStatus: 'prepared-diff',
      },
      paths,
    );
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database
        .prepare(
          "UPDATE prepared_diffs SET status = 'push-approved' WHERE id = ?;",
        )
        .run(preparedDiff.id);
    } finally {
      database.close();
    }
    const calls: unknown[] = [];

    const result = await commentPrAutofixResult(
      { preparedDiffId: preparedDiff.id },
      paths,
      {
        async fetchPullRequestEventState() {
          return reviewEventState(featureSha);
        },
        listPullRequestComments: async () => [],
        postPullRequestComment: async (input) => {
          calls.push(input);
          throw new Error('should not post');
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_comment_pr_autofix_result',
      requires: ['preparedResult'],
    });
    expect(calls).toEqual([]);
  });

  it('comments on verification-requested prepared diffs after matching the PR head', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const { paths, featureSha, repo } = await fixture();
    const preparedDiff = await ensurePreparedDiffForWorktree(
      {
        id: 'wt-comment-verified',
        repoId: 'sample',
        repoFullName: 'example/sample',
        prNumber: 7,
        localPath: repo,
        baseRef: 'main',
        headRef: 'feature',
        headSha: featureSha,
        lifecycleStatus: 'prepared-diff',
      },
      paths,
      {
        summary: {
          checksRun: [{ name: 'npm run check', status: 'passed' }],
        },
      },
    );
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database
        .prepare(
          "UPDATE prepared_diffs SET status = 'verification-requested' WHERE id = ?;",
        )
        .run(preparedDiff.id);
    } finally {
      database.close();
    }
    const calls: unknown[] = [];

    const result = await commentPrAutofixResult(
      { preparedDiffId: preparedDiff.id },
      paths,
      {
        async fetchPullRequestEventState() {
          return reviewEventState(featureSha);
        },
        listPullRequestComments: async () => [],
        postPullRequestComment: async (input) => {
          calls.push(input);
          return {
            id: 100,
            nodeId: 'comment-node-100',
            url: 'https://github.com/example/sample/pull/7#issuecomment-100',
            authorLogin: 'neon',
            body: input.body,
            createdAt: '2026-06-30T21:00:00Z',
            updatedAt: '2026-06-30T21:00:00Z',
          };
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      action: 'autopilot_comment_pr_autofix_result',
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses stale prepared diffs when the PR head changed', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const { paths, featureSha, repo } = await fixture();
    const preparedDiff = await ensurePreparedDiffForWorktree(
      {
        id: 'wt-comment-stale',
        repoId: 'sample',
        repoFullName: 'example/sample',
        prNumber: 7,
        localPath: repo,
        baseRef: 'main',
        headRef: 'feature',
        headSha: featureSha,
        lifecycleStatus: 'prepared-diff',
      },
      paths,
    );
    const calls: unknown[] = [];

    const result = await commentPrAutofixResult(
      { preparedDiffId: preparedDiff.id },
      paths,
      {
        async fetchPullRequestEventState() {
          return { ...reviewEventState(featureSha), headSha: 'new-head-sha' };
        },
        listPullRequestComments: async () => [],
        postPullRequestComment: async (input) => {
          calls.push(input);
          throw new Error('should not post');
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_comment_pr_autofix_result',
      requires: ['currentPrHead'],
    });
    expect(calls).toEqual([]);
  });

  it('pushes an approved and verified prepared diff to the PR head branch', async () => {
    const { paths, featureSha, remote } = await fixture({ remote: true });
    const remotePath = requireRemote(remote);
    const prepared = await prepareReviewPreparedDiff(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const preparedDiffId = stringPath(prepared, ['data', 'preparedDiff', 'id']);

    const approval = await approvePreparedDiffPushWithPolicy(
      {
        preparedDiffId,
        reason: 'Fixture approval.',
        confirm: true,
      },
      paths,
    );
    expect(approval.ok).toBe(true);

    const verification = await verifyPrWorktree(
      { worktreeId, checks: ['npm run check'], lock: false },
      paths,
      { runExecution: successfulExecution },
    );
    expect(verification.ok).toBe(true);

    const result = await pushPrAutofix({ preparedDiffId }, paths, {
      getBranchPermissions: pushAllowedPermissions,
      pushGit: pushToFixtureOrigin(remotePath),
    });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      action: 'autopilot_push_pr_autofix',
      data: {
        preparedDiff: { status: 'pushed' },
        worktree: { lifecycleStatus: 'succeeded' },
        push: { branch: 'feature', force: false },
        commentsDeferred: true,
      },
    });
    const pushedSha = await gitOutput(remotePath, [
      'rev-parse',
      'refs/heads/feature',
    ]);
    expect(pushedSha.trim()).toBe(stringPath(result, ['data', 'currentSha']));
    expect(readPreparedDiff(preparedDiffId, paths)).toMatchObject({
      status: 'pushed',
      verificationStatus: 'passed',
    });

    const duplicate = await pushPrAutofix({ preparedDiffId }, paths, {
      getBranchPermissions: failUnexpectedBranchPermissions,
      pushGit: failUnexpectedPush,
    });
    expect(duplicate).toMatchObject({
      ok: false,
      changed: false,
      action: 'autopilot_push_pr_autofix',
      requires: ['prepared-diff-status'],
      data: {
        preparedDiff: { status: 'pushed' },
      },
    });
    expect(readPreparedDiff(preparedDiffId, paths)).toMatchObject({
      status: 'pushed',
      verificationStatus: 'passed',
    });
  });

  it('invalidates a SHA-matching approval after the effective policy changes', async () => {
    const { paths, featureSha, remote } = await fixture({ remote: true });
    const prepared = await prepareReviewPreparedDiff(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const preparedDiffId = stringPath(prepared, ['data', 'preparedDiff', 'id']);
    await approvePreparedDiffPushWithPolicy(
      { preparedDiffId, confirm: true },
      paths,
    );
    await verifyPrWorktree(
      { worktreeId, checks: ['npm run check'], lock: false },
      paths,
      { runExecution: successfulExecution },
    );
    await writeAutopilotConfig(paths, {}, { maxFilesChanged: 13 });

    const result = await pushPrAutofix({ preparedDiffId }, paths, {
      getBranchPermissions: pushAllowedPermissions,
      pushGit: pushToFixtureOrigin(requireRemote(remote)),
    });

    expect(result).toMatchObject({
      ok: false,
      requires: ['autopilot-policy', 'sha-bound-policy-approval'],
    });

    await expect(
      approvePreparedDiffPushWithPolicy(
        { preparedDiffId, confirm: true },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      preparedDiff: { status: 'push-approved' },
    });
  });

  it('does not mark a prepared diff push-blocked before push approval', async () => {
    const { paths, featureSha, remote } = await fixture({ remote: true });
    const remotePath = requireRemote(remote);
    const prepared = await prepareReviewPreparedDiff(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const preparedDiffId = stringPath(prepared, ['data', 'preparedDiff', 'id']);

    const premature = await pushPrAutofix({ preparedDiffId }, paths, {
      getBranchPermissions: failUnexpectedBranchPermissions,
      pushGit: failUnexpectedPush,
    });

    expect(premature).toMatchObject({
      ok: false,
      changed: false,
      action: 'autopilot_push_pr_autofix',
      requires: ['verification'],
      data: {
        preparedDiff: {
          status: 'prepared',
          pushApprovalStatus: 'pending',
        },
      },
    });
    expect(readPreparedDiff(preparedDiffId, paths)).toMatchObject({
      status: 'prepared',
      pushApprovalStatus: 'pending',
    });

    const approval = await approvePreparedDiffPushWithPolicy(
      { preparedDiffId, confirm: true },
      paths,
    );
    expect(approval).toMatchObject({
      ok: true,
      preparedDiff: { status: 'push-approved' },
    });
    const verification = await verifyPrWorktree(
      { worktreeId, checks: ['npm run check'], lock: false },
      paths,
      { runExecution: successfulExecution },
    );
    expect(verification.ok).toBe(true);

    const pushed = await pushPrAutofix({ preparedDiffId }, paths, {
      getBranchPermissions: pushAllowedPermissions,
      pushGit: pushToFixtureOrigin(remotePath),
    });
    expect(pushed).toMatchObject({
      ok: true,
      changed: true,
      data: {
        preparedDiff: { status: 'pushed' },
      },
    });
  });

  it('dispatches verify-then-push after push approval by default and records the linkage', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await prepareReviewPreparedDiff(paths, featureSha);
    const preparedDiffId = stringPath(prepared, ['data', 'preparedDiff', 'id']);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const calls: Array<{ workflow: string; input: Record<string, unknown> }> =
      [];

    const result = await approvePreparedDiffPushWithDispatch(
      {
        preparedDiffId,
        reason: 'Ship it.',
        confirm: true,
        approverSurface: 'test',
      },
      paths,
      {
        async invokeWorkflow(workflow, input) {
          calls.push({ workflow, input });
          return { runId: 'run-verify-then-push-after-approval' };
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      preparedDiff: { status: 'push-approved' },
      data: {
        dispatchedPushRunId: 'run-verify-then-push-after-approval',
        pushApprovalDispatch: {
          mode: 'verify-then-push',
          status: 'dispatched',
          workflow: 'verify-then-push-pr-autofix',
          runId: 'run-verify-then-push-after-approval',
        },
      },
    });
    expect(calls).toEqual([
      {
        workflow: 'verify-then-push-pr-autofix',
        input: {
          preparedDiffId,
          worktreeId,
        },
      },
    ]);
    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        workflow: 'verify_then_push_pr_autofix',
        runId: 'run-verify-then-push-after-approval',
        status: 'pending',
        summary: expect.objectContaining({
          event: 'prepared_diff_push_approval_dispatch',
          approvalId: result.approvals?.[0]?.id,
          preparedDiffId,
          worktreeId,
        }),
      }),
    ]);
  });

  it('admits only one push workflow when prepared-diff approvals race', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await prepareReviewPreparedDiff(paths, featureSha);
    const preparedDiffId = stringPath(prepared, ['data', 'preparedDiff', 'id']);
    const calls: string[] = [];
    const invokeWorkflow = async () => {
      calls.push('invoked');
      return { runId: `run-concurrent-approval-${calls.length}` };
    };

    const results = await Promise.all([
      approvePreparedDiffPushWithDispatch(
        { preparedDiffId, confirm: true },
        paths,
        { invokeWorkflow },
      ),
      approvePreparedDiffPushWithDispatch(
        { preparedDiffId, confirm: true },
        paths,
        { invokeWorkflow },
      ),
    ]);

    expect(
      results.filter((result) => result.ok && result.changed),
    ).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && !result.changed),
    ).toHaveLength(1);
    expect(calls).toEqual(['invoked']);
    await expect(listWorkflowSummaries(paths)).resolves.toHaveLength(1);
  });

  it('returns an explicit dispatch failure after recording push approval', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await prepareReviewPreparedDiff(paths, featureSha);
    const preparedDiffId = stringPath(prepared, ['data', 'preparedDiff', 'id']);

    const result = await approvePreparedDiffPushWithDispatch(
      { preparedDiffId, confirm: true },
      paths,
      {
        async invokeWorkflow() {
          throw new Error('Flue admission unavailable.');
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      preparedDiff: { status: 'push-approved' },
      requires: ['workflowDispatch'],
      errors: ['Flue admission unavailable.'],
      data: {
        dispatchedPushRunId: null,
        pushApprovalDispatch: {
          mode: 'verify-then-push',
          status: 'dispatch-failed',
          workflow: 'verify-then-push-pr-autofix',
        },
      },
    });
    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        workflow: 'verify_then_push_pr_autofix',
        runId: null,
        status: 'failed',
        summary: expect.objectContaining({
          approvalId: result.approvals?.[0]?.id,
          preparedDiffId,
          error: 'Flue admission unavailable.',
        }),
      }),
    ]);
  });

  it('rejects verify-then-push workflow worktree mismatches', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await prepareReviewPreparedDiff(paths, featureSha);
    const preparedDiffId = stringPath(prepared, ['data', 'preparedDiff', 'id']);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const previousHome = process.env.NEONDECK_HOME;
    process.env.NEONDECK_HOME = paths.home;
    vi.doMock('./agents/display-assistant', async () => {
      const { defineAgent } = await import('@flue/runtime');
      return {
        default: defineAgent(() => ({
          instructions: 'test display assistant',
        })),
      };
    });

    try {
      const { default: verifyThenPushPrAutofixWorkflow } =
        await import('./workflows/verify-then-push-pr-autofix');
      await expect(
        runWorkflowAction(verifyThenPushPrAutofixWorkflow, {
          preparedDiffId,
          worktreeId: `${worktreeId}-other`,
        }),
      ).resolves.toMatchObject({
        ok: false,
        action: 'autopilot_verify_then_push_pr_autofix',
        changed: false,
        requires: ['worktreeId'],
        message: expect.stringContaining('is linked to worktree'),
      });
    } finally {
      vi.doUnmock('./agents/display-assistant');
      vi.resetModules();
      if (previousHome === undefined) delete process.env.NEONDECK_HOME;
      else process.env.NEONDECK_HOME = previousHome;
    }
  });

  it('can dispatch push immediately or leave approval record-only from config', async () => {
    const pushFixture = await fixture();
    await writeAutopilotConfig(pushFixture.paths, { pushOnApproval: 'push' });
    const pushPrepared = await prepareReviewPreparedDiff(
      pushFixture.paths,
      pushFixture.featureSha,
    );
    const pushPreparedDiffId = stringPath(pushPrepared, [
      'data',
      'preparedDiff',
      'id',
    ]);
    const pushCalls: Array<{
      workflow: string;
      input: Record<string, unknown>;
    }> = [];

    const pushed = await approvePreparedDiffPushWithDispatch(
      { preparedDiffId: pushPreparedDiffId, confirm: true },
      pushFixture.paths,
      {
        async invokeWorkflow(workflow, input) {
          pushCalls.push({ workflow, input });
          return { runId: 'run-push-after-approval' };
        },
      },
    );

    expect(pushed).toMatchObject({
      ok: true,
      data: {
        dispatchedPushRunId: 'run-push-after-approval',
        pushApprovalDispatch: {
          mode: 'push',
          status: 'dispatched',
          workflow: 'push-pr-autofix',
        },
      },
    });
    expect(pushCalls).toEqual([
      {
        workflow: 'push-pr-autofix',
        input: {
          preparedDiffId: pushPreparedDiffId,
          lockOwner: 'approval_push_pr_autofix',
        },
      },
    ]);

    const offFixture = await fixture();
    await writeAutopilotConfig(offFixture.paths, { pushOnApproval: 'off' });
    const offPrepared = await prepareReviewPreparedDiff(
      offFixture.paths,
      offFixture.featureSha,
    );
    const offPreparedDiffId = stringPath(offPrepared, [
      'data',
      'preparedDiff',
      'id',
    ]);

    const off = await approvePreparedDiffPushWithDispatch(
      { preparedDiffId: offPreparedDiffId, confirm: true },
      offFixture.paths,
      {
        async invokeWorkflow() {
          throw new Error('push dispatch should be disabled');
        },
      },
    );

    expect(off).toMatchObject({
      ok: true,
      preparedDiff: { status: 'push-approved' },
      data: {
        dispatchedPushRunId: null,
        pushApprovalDispatch: {
          mode: 'off',
          status: 'off',
        },
      },
    });
    await expect(listWorkflowSummaries(offFixture.paths)).resolves.toEqual([]);
  });

  it('does not rewrite abandoned prepared diffs on duplicate push calls', async () => {
    const { paths, featureSha } = await fixture();
    const prepared = await prepareReviewPreparedDiff(paths, featureSha);
    const preparedDiffId = stringPath(prepared, ['data', 'preparedDiff', 'id']);
    const abandoned = await abandonPreparedDiff(
      { preparedDiffId, confirm: true, reason: 'No longer needed.' },
      paths,
    );
    expect(abandoned).toMatchObject({
      ok: true,
      preparedDiff: { status: 'abandoned' },
    });

    const result = await pushPrAutofix({ preparedDiffId }, paths, {
      getBranchPermissions: failUnexpectedBranchPermissions,
      pushGit: failUnexpectedPush,
    });

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      action: 'autopilot_push_pr_autofix',
      data: {
        preparedDiff: { status: 'abandoned' },
      },
    });
    expect(readPreparedDiff(preparedDiffId, paths)).toMatchObject({
      status: 'abandoned',
      pushApprovalStatus: 'rejected',
    });
  });

  it('blocks push-back when GitHub branch permissions do not allow direct push', async () => {
    const { paths, featureSha, remote } = await fixture({ remote: true });
    const remotePath = requireRemote(remote);
    const prepared = await prepareReviewPreparedDiff(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const preparedDiffId = stringPath(prepared, ['data', 'preparedDiff', 'id']);
    await approvePreparedDiffPushWithPolicy(
      { preparedDiffId, confirm: true },
      paths,
    );
    const verification = await verifyPrWorktree(
      { worktreeId, checks: ['npm run check'], lock: false },
      paths,
      { runExecution: successfulExecution },
    );
    expect(verification.ok).toBe(true);

    const result = await pushPrAutofix({ preparedDiffId }, paths, {
      getBranchPermissions: pushDeniedPermissions,
    });

    expect(result).toMatchObject({
      ok: false,
      changed: true,
      action: 'autopilot_push_pr_autofix',
      requires: ['github-permissions'],
      data: {
        preparedDiff: { status: 'push-blocked' },
        worktree: { lifecycleStatus: 'prepared-diff' },
      },
    });
    const remoteFeatureSha = await gitOutput(remotePath, [
      'rev-parse',
      'refs/heads/feature',
    ]);
    expect(remoteFeatureSha.trim()).toBe(featureSha);
  });

  it('blocks push-back when the approved and verified commit is no longer HEAD', async () => {
    const { paths, featureSha, remote } = await fixture({ remote: true });
    const remotePath = requireRemote(remote);
    const prepared = await prepareReviewPreparedDiff(paths, featureSha);
    const worktreeId = stringPath(prepared, ['data', 'worktree', 'id']);
    const worktreePath = stringPath(prepared, [
      'data',
      'worktree',
      'localPath',
    ]);
    const preparedDiffId = stringPath(prepared, ['data', 'preparedDiff', 'id']);
    await approvePreparedDiffPushWithPolicy(
      { preparedDiffId, confirm: true },
      paths,
    );
    const verification = await verifyPrWorktree(
      { worktreeId, checks: ['npm run check'], lock: false },
      paths,
      { runExecution: successfulExecution },
    );
    expect(verification.ok).toBe(true);

    await writeFile(
      join(worktreePath, 'src/extra.ts'),
      'export const x = 1;\n',
    );
    await git(worktreePath, ['add', 'src/extra.ts']);
    await git(worktreePath, ['commit', '-m', 'extra clean commit']);

    const result = await pushPrAutofix({ preparedDiffId }, paths, {
      getBranchPermissions: pushAllowedPermissions,
    });

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_push_pr_autofix',
      requires: [
        'autopilot-policy',
        'sha-bound-policy-approval',
        'approved-commit',
        'verified-commit',
      ],
      data: {
        preparedDiff: { status: 'push-blocked' },
        worktree: { lifecycleStatus: 'prepared-diff' },
      },
    });
    const remoteFeatureSha = await gitOutput(remotePath, [
      'rev-parse',
      'refs/heads/feature',
    ]);
    expect(remoteFeatureSha.trim()).toBe(featureSha);
  });

  it('rejects caller-supplied push remotes at the action boundary', async () => {
    const result = await pushPrAutofix({
      preparedDiffId: 'prepared-1',
      remote: 'https://github.com/example/other.git',
    });

    expect(result).toMatchObject({
      ok: false,
      action: 'autopilot_push_pr_autofix',
      message: 'Invalid autopilot input.',
    });
  });
});

async function fixture(options: { remote?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-home-'));
  const repoRoot = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-repo-'));
  const repo = join(repoRoot, 'repository');
  const remote = options.remote
    ? await mkdtemp(join(tmpdir(), 'neondeck-autopilot-remote-'))
    : null;
  tempRoots.push(...[home, repoRoot, remote].filter((path) => path !== null));
  const paths = runtimePaths(home);

  if (!repositorySeed?.featureSha) {
    throw new Error('Autopilot Git repository seed is unavailable.');
  }
  await repositorySeed.copyTo(repo);
  const featureSha = repositorySeed.featureSha;
  if (remote) {
    await git(remote, ['init', '--bare']);
    await git(repo, ['remote', 'add', 'origin', remote]);
    await git(repo, ['push', 'origin', 'main', 'feature']);
  }

  await mkdir(paths.home, { recursive: true });
  await writeFile(
    paths.config,
    `${JSON.stringify(
      {
        version: 1,
        autopilot: {
          defaultMode: 'autofix-with-approval',
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
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  return { paths, repo, featureSha, remote };
}

async function preparePreparedWorktree(
  paths: ReturnType<typeof runtimePaths>,
  featureSha: string,
) {
  const result = await preparePrWorktree(
    {
      repoId: 'sample',
      prNumber: 7,
      lock: false,
    },
    paths,
    {
      token: 'test-token',
      async fetchPullRequestDetail() {
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
      },
      async fetchCheckSummary() {
        return {
          status: 'success',
          total: 1,
          successful: 1,
          failed: 0,
          pending: 0,
          checkedAt: '2026-06-30T00:00:00.000Z',
        };
      },
    },
  );
  expect(result.ok).toBe(true);
  return result;
}

async function prepareReviewPreparedDiff(
  paths: ReturnType<typeof runtimePaths>,
  featureSha: string,
) {
  const result = await fixPrReviewFeedback(
    {
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
    },
    paths,
    {
      token: 'test-token',
      async fetchPullRequestEventState() {
        return reviewEventState(featureSha);
      },
    },
  );
  expect(result.ok).toBe(true);
  return result;
}

async function successfulExecution() {
  return {
    ok: true,
    action: 'execution_run',
    changed: true,
    message: 'Fixture execution passed.',
    result: { exitCode: 0 },
    requires: [],
  } as never;
}

async function pushAllowedPermissions() {
  return branchPermissionResult(true);
}

async function pushDeniedPermissions() {
  return branchPermissionResult(false);
}

async function writeAutopilotConfig(
  paths: ReturnType<typeof runtimePaths>,
  autopilot: Record<string, unknown>,
  guardrails?: Record<string, unknown>,
) {
  await writeFile(
    paths.config,
    `${JSON.stringify(
      {
        version: 1,
        ...(guardrails ? { guardrails } : {}),
        autopilot: {
          defaultMode: 'autofix-with-approval',
          ...autopilot,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function pushToFixtureOrigin(remote: string) {
  return async (
    cwd: string,
    input: { remote: string; branch: string; sha: string; force?: boolean },
  ) => {
    expect(input).toMatchObject({
      remote: 'https://github.com/example/sample.git',
      branch: 'feature',
      force: false,
      sha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    await git(cwd, ['push', remote, `${input.sha}:refs/heads/feature`]);
    return {
      remote: input.remote,
      branch: input.branch,
      force: Boolean(input.force),
      stdout: '',
    } as never;
  };
}

function requireRemote(remote: string | null) {
  if (!remote) throw new Error('Expected fixture remote.');
  return remote;
}

async function failUnexpectedBranchPermissions(): Promise<never> {
  throw new Error('Branch permissions should not be fetched.');
}

async function failUnexpectedPush(): Promise<never> {
  throw new Error('Git push should not be attempted.');
}

function branchPermissionResult(canLikelyPush: boolean) {
  return {
    ok: true,
    action: 'github_pr_branch_permissions_get',
    changed: false,
    message: 'Fetched branch permission facts for example/sample#7.',
    data: {
      target: {
        repoFullName: 'example/sample',
        owner: 'example',
        repo: 'sample',
        number: 7,
      },
      branchPermissions: {
        headRepoFullName: 'example/sample',
        baseRepoFullName: 'example/sample',
        isFork: false,
        maintainerCanModify: true,
        headRepoPush: canLikelyPush,
        baseRepoPush: canLikelyPush,
        canLikelyPush,
        checkedAt: '2026-06-30T00:00:00.000Z',
      },
    },
  } as never;
}

function reviewEventState(featureSha: string) {
  return {
    repo: 'example/sample',
    number: 7,
    url: 'https://github.com/example/sample/pull/7',
    title: 'Update feature',
    body: 'Fixes #7 by updating the feature.',
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: featureSha,
    headRef: 'feature',
    baseRef: 'main',
    baseSha: null,
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
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
    requestedChangesReviews: [
      {
        id: 55,
        nodeId: 'PRR_55',
        state: 'CHANGES_REQUESTED',
        authorLogin: 'reviewer',
        submittedAt: '2026-06-30T00:00:00.000Z',
        commitId: featureSha,
        url: 'https://github.com/example/sample/pull/7#pullrequestreview-55',
      },
    ],
    requestedChangesState: {
      active: [
        {
          id: 55,
          nodeId: 'PRR_55',
          state: 'CHANGES_REQUESTED',
          authorLogin: 'reviewer',
          submittedAt: '2026-06-30T00:00:00.000Z',
          commitId: featureSha,
          url: 'https://github.com/example/sample/pull/7#pullrequestreview-55',
        },
      ],
      latestByReviewer: [
        {
          id: 55,
          nodeId: 'PRR_55',
          state: 'CHANGES_REQUESTED',
          authorLogin: 'reviewer',
          submittedAt: '2026-06-30T00:00:00.000Z',
          commitId: featureSha,
          url: 'https://github.com/example/sample/pull/7#pullrequestreview-55',
        },
      ],
      history: [
        {
          id: 55,
          nodeId: 'PRR_55',
          state: 'CHANGES_REQUESTED',
          authorLogin: 'reviewer',
          submittedAt: '2026-06-30T00:00:00.000Z',
          commitId: featureSha,
          url: 'https://github.com/example/sample/pull/7#pullrequestreview-55',
        },
      ],
    },
    checkSuites: [],
    checkRuns: [],
    branchPermissions: {
      headRepoFullName: 'example/sample',
      baseRepoFullName: 'example/sample',
      isFork: false,
      maintainerCanModify: true,
      headRepoPush: true,
      baseRepoPush: true,
      canLikelyPush: true,
      checkedAt: '2026-06-30T00:00:00.000Z',
    },
    isOutOfDate: false,
    fetchedAt: '2026-06-30T00:00:00.000Z',
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

async function runWorkflowAction(workflow: unknown, input: unknown) {
  const runnable = workflow as {
    action: {
      run(context: { input: unknown }): unknown;
    };
  };
  return runWithFlueExecutionContextForTests(
    { runId: `test-run-${Date.now()}` },
    () => Promise.resolve(runnable.action.run({ input })),
  );
}

function insertActiveWorkflowRun(
  paths: ReturnType<typeof runtimePaths>,
  runId: string,
  workflow: string,
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO workflow_run_observations (
          run_id,
          workflow,
          status,
          started_at,
          last_event_at,
          last_message,
          event_count,
          is_error,
          updated_at
        )
        VALUES (?, ?, 'active', ?, ?, ?, 1, 0, ?);
      `,
      )
      .run(runId, workflow, now, now, `Running ${workflow}.`, now);
  } finally {
    database.close();
  }
}

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd, env: unsignedGitEnv() });
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: unsignedGitEnv(),
  });
  return stdout;
}

function unsignedGitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
  };
}
