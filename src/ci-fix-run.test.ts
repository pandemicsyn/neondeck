import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addWorkflowSummary,
  listNotifications,
  listWorkflowSummaries,
  updateWorkflowSummary,
} from './modules/app-state';
import {
  createCiFailureDossierReport,
  type CiFixDossier,
  fixPrCiRun,
} from './modules/autopilot/ci-fix-run';
import {
  ciFixRunAction,
  neondeckAutopilotActions,
} from './modules/autopilot/actions';
import {
  autopilotWorkflowNames as policyAutopilotWorkflowNames,
  mutationWorkflowNames,
} from './modules/autopilot-policy/schemas';
import { isAutopilotWorkflow } from './modules/autopilot/state-schemas';
import { listPreparedDiffs } from './modules/prepared-diffs';
import { readReportHtml } from './modules/reports';
import type {
  GitHubFailingCheckFact,
  GitHubPullRequestEventState,
} from './modules/github';
import { reconcileCiFixRunForKiloTask } from './modules/kilo';
import { taskDiffSummary } from './modules/kilo/runtime-facts';
import { releaseTaskLock } from './modules/kilo/process';
import type { KiloTaskRecord } from './modules/kilo';
import {
  createWorktree,
  lockWorktree,
  releaseWorktreeLock,
} from './modules/worktrees';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('CI fix run', () => {
  it('registers fix-ci as a mutation workflow without exposing a model-callable action', () => {
    expect(neondeckAutopilotActions).not.toContain(ciFixRunAction);
    expect(policyAutopilotWorkflowNames.has('fix-pr-ci')).toBe(true);
    expect(policyAutopilotWorkflowNames.has('ci-fix-run')).toBe(true);
    expect(mutationWorkflowNames.has('fix-pr-ci')).toBe(true);
    expect(mutationWorkflowNames.has('ci-fix-run')).toBe(true);
    expect(isAutopilotWorkflow('fix-pr-ci')).toBe(true);
    expect(isAutopilotWorkflow('ci_fix_run')).toBe(true);
  });

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
    expect(html?.html).toContain('npm run test #42');
    expect(html?.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html?.html).not.toContain('<script>alert(1)</script>');
  });

  it('records a typed failure when CI dossier preparation throws', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    const result = await fixPrCiRun({ ref: 'pandemicsyn/neondeck#10' }, paths, {
      readDossier: async () => {
        throw new Error('GitHub checks unavailable');
      },
    });

    expect(result).toMatchObject({
      ok: false,
      action: 'ci_fix_run',
      message: expect.stringContaining('GitHub checks unavailable'),
      requires: ['ciFixDossier'],
      data: {
        workflow: 'fix-pr-ci',
        outcome: 'dossier-failed',
      },
      workflowSummary: {
        workflow: 'ci_fix_run',
        status: 'failed',
        summary: expect.objectContaining({
          outcome: 'dossier-failed',
        }),
      },
    });
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          title: 'CI fix failed',
        }),
      ]),
    );
  });

  it('fails deterministically on CI fix lock contention without starting Kilo', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    let startedKilo = false;
    let prepared = false;

    const result = await fixPrCiRun({ ref: 'pandemicsyn/neondeck#10' }, paths, {
      ...testDependencies(),
      preparePrWorktree: async () => {
        prepared = true;
        return {
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
        } as never;
      },
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
    });

    expect(result).toMatchObject({
      ok: false,
      requires: ['worktreeLock'],
      data: {
        report: { url: expect.stringContaining('/reports/') },
      },
      workflowSummary: {
        workflow: 'ci_fix_run',
        status: 'failed',
        summary: expect.objectContaining({
          outcome: 'lock-failed',
          reportId: expect.any(String),
          worktreeId: null,
        }),
      },
    });
    expect(startedKilo).toBe(false);
    expect(prepared).toBe(false);
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          title: 'CI fix needs attention',
        }),
      ]),
    );
    await expect(listWorkflowSummaries(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: 'ci_fix_run',
          status: 'failed',
          summary: expect.objectContaining({
            outcome: 'lock-failed',
            requires: ['worktreeLock'],
          }),
        }),
      ]),
    );
  });

  it('creates the CI fix workflow summary before Kilo can finish', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    let observedTaskId: string | null = null;
    let observedPrepareLockId: string | null = null;
    let prepareSawNoCiLock = false;

    const result = await fixPrCiRun({ ref: 'pandemicsyn/neondeck#10' }, paths, {
      ...testDependencies(),
      preparePrWorktree: async (input) => {
        observedPrepareLockId = stringField(
          (input as { lockId?: unknown }).lockId,
        );
        const probeLock = await lockWorktree(
          {
            repoId: 'neondeck',
            prNumber: 10,
            scope: 'pr',
            owner: 'prepare-probe',
            ttlSeconds: 30,
          },
          paths,
        );
        if (!probeLock.ok || !('lock' in probeLock)) {
          throw new Error('prepare saw pre-existing CI PR lock');
        }
        prepareSawNoCiLock = true;
        await releaseWorktreeLock(
          { lockId: probeLock.lock.id, owner: 'prepare-probe' },
          paths,
        );
        return {
          ok: true,
          action: 'autopilot_prepare_pr_worktree',
          changed: true,
          message: 'prepared',
          data: {
            worktree: {
              id: 'worktree-1',
              headSha: 'prepared-head-sha',
            },
          },
        } as never;
      },
      lockWorktree: async () =>
        ({
          ok: true,
          action: 'worktree_lock',
          changed: true,
          message: 'locked',
          lock: { id: 'ci-fix-lock-1' },
        }) as never,
      startKiloTask: async (input) => {
        observedTaskId = stringField((input as { taskId?: unknown }).taskId);
        expect(observedTaskId).toMatch(/^ci-fix-/);
        await expect(listWorkflowSummaries(paths)).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              workflow: 'ci_fix_run',
              runId: null,
              status: 'running',
              summary: expect.objectContaining({
                outcome: 'kilo-starting',
                headSha: 'prepared-head-sha',
                dossierHeadSha: 'abc123def456',
                kiloTaskId: observedTaskId,
              }),
            }),
          ]),
        );
        return {
          ok: true,
          action: 'kilo_task_start',
          changed: true,
          message: 'started',
          taskId: observedTaskId ?? 'missing-task-id',
          pid: null,
          rawLogPath: null,
          command: [],
          task: kiloTask({
            id: observedTaskId ?? 'missing-task-id',
            cwd: '/tmp/neondeck',
            worktreeId: 'worktree-1',
          }),
        };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        kiloTaskId: observedTaskId,
      },
      workflowSummary: {
        runId: null,
        status: 'running',
        summary: expect.objectContaining({ outcome: 'kilo-started' }),
      },
    });
    expect(prepareSawNoCiLock).toBe(true);
    expect(observedPrepareLockId).toBe('ci-fix-lock-1');
  });

  it('preserves a terminal CI fix workflow summary when Kilo finishes during start', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    let observedTaskId: string | null = null;

    const result = await fixPrCiRun({ ref: 'pandemicsyn/neondeck#10' }, paths, {
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
              headSha: 'prepared-head-sha',
            },
          },
        }) as never,
      lockWorktree: async () =>
        ({
          ok: true,
          action: 'worktree_lock',
          changed: true,
          message: 'locked',
          lock: { id: 'ci-fix-lock-1' },
        }) as never,
      startKiloTask: async (input) => {
        observedTaskId = stringField((input as { taskId?: unknown }).taskId);
        if (!observedTaskId) throw new Error('missing Kilo task id');

        const summaries = await listWorkflowSummaries(paths);
        const summary = summaries.find(
          (row) =>
            row.workflow === 'ci_fix_run' &&
            objectField(row.summary).kiloTaskId === observedTaskId,
        );
        if (!summary) throw new Error('missing pre-created workflow summary');

        await updateWorkflowSummary(
          summary.id,
          {
            status: 'completed',
            summary: {
              ...objectField(summary.summary),
              outcome: 'no-op',
            },
          },
          paths,
        );

        return {
          ok: true,
          action: 'kilo_task_start',
          changed: true,
          message: 'started',
          taskId: observedTaskId,
          pid: null,
          rawLogPath: null,
          command: [],
          task: kiloTask({
            id: observedTaskId,
            cwd: '/tmp/neondeck',
            worktreeId: 'worktree-1',
          }),
        };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      workflowSummary: {
        runId: null,
        status: 'completed',
        summary: expect.objectContaining({
          outcome: 'no-op',
          kiloTaskId: observedTaskId,
        }),
      },
    });
    const summaries = await listWorkflowSummaries(paths);
    const ciFixSummary = summaries.find(
      (row) =>
        row.workflow === 'ci_fix_run' &&
        objectField(row.summary).kiloTaskId === observedTaskId,
    );
    expect(ciFixSummary).toMatchObject({
      status: 'completed',
      summary: expect.objectContaining({
        outcome: 'no-op',
        kiloTaskId: observedTaskId,
      }),
    });
  });

  it('stops after the dossier when current failing check facts are empty', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    let startedKilo = false;

    const result = await fixPrCiRun({ ref: 'pandemicsyn/neondeck#10' }, paths, {
      readDossier: async () => ({
        ...ciFixDossier(),
        failingChecks: [],
        likelyCommands: [],
      }),
      startKiloTask: async () => {
        startedKilo = true;
        throw new Error('should not start Kilo');
      },
    });

    expect(result).toMatchObject({
      ok: false,
      requires: ['failingChecks'],
      data: {
        report: { url: expect.stringContaining('/reports/') },
      },
      workflowSummary: {
        workflow: 'ci_fix_run',
        status: 'failed',
        summary: expect.objectContaining({
          outcome: 'no-failing-checks',
          reportId: expect.any(String),
        }),
      },
    });
    expect(startedKilo).toBe(false);
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          title: 'CI fix needs attention',
          message:
            'No failing GitHub check runs were present in the current CI dossier.',
        }),
      ]),
    );
    await expect(listWorkflowSummaries(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: 'ci_fix_run',
          status: 'failed',
          summary: expect.objectContaining({
            outcome: 'no-failing-checks',
            requires: ['failingChecks'],
          }),
        }),
      ]),
    );
  });

  it('records terminal CI fix summaries when repo setup fails before Kilo starts', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    let startedKilo = false;

    const missingRepo = await fixPrCiRun(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        readDossier: async () => ({
          ...ciFixDossier(),
          repo: null,
        }),
        startKiloTask: async () => {
          startedKilo = true;
          throw new Error('should not start Kilo');
        },
      },
    );

    expect(missingRepo).toMatchObject({
      ok: false,
      requires: ['repo'],
      workflowSummary: {
        workflow: 'ci_fix_run',
        status: 'failed',
        summary: expect.objectContaining({
          outcome: 'repo-missing',
          repoId: null,
        }),
      },
    });
    expect(startedKilo).toBe(false);

    const prepareFailed = await fixPrCiRun(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        ...testDependencies(),
        preparePrWorktree: async () =>
          ({
            ok: false,
            action: 'autopilot_prepare_pr_worktree',
            changed: false,
            message: 'prepare failed',
            requires: ['worktree'],
          }) as never,
        startKiloTask: async () => {
          startedKilo = true;
          throw new Error('should not start Kilo');
        },
      },
    );

    expect(prepareFailed).toMatchObject({
      ok: false,
      requires: ['worktree'],
      workflowSummary: {
        workflow: 'ci_fix_run',
        status: 'failed',
        summary: expect.objectContaining({
          outcome: 'prepare-failed',
          requires: ['worktree'],
        }),
      },
    });
    expect(startedKilo).toBe(false);
    await expect(listWorkflowSummaries(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: 'ci_fix_run',
          status: 'failed',
          summary: expect.objectContaining({ outcome: 'repo-missing' }),
        }),
        expect.objectContaining({
          workflow: 'ci_fix_run',
          status: 'failed',
          summary: expect.objectContaining({ outcome: 'prepare-failed' }),
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

  it('does not treat an unchanged PR branch diff as a CI fix', async () => {
    const home = await tempDir('neondeck-home-');
    const repo = await tempGitRepo();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeRepoRegistry(paths.repos, repo);
    await writeFile(
      join(repo, 'src/failing.test.ts'),
      'export const fixed = false;\nexport const prChange = true;\n',
    );
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'feature change']);
    const created = await createWorktree(
      {
        repoId: 'neondeck',
        prNumber: 10,
        baseRef: 'main',
        headRef: 'feature',
      },
      paths,
    );
    if (!created.ok || !('worktree' in created)) {
      throw new Error(created.message);
    }
    const worktree = created.worktree;
    const startedHeadSha = await git(worktree.localPath, ['rev-parse', 'HEAD']);
    await addWorkflowSummary(
      {
        workflow: 'ci_fix_run',
        status: 'running',
        summary: {
          outcome: 'kilo-started',
          pr: 'pandemicsyn/neondeck#10',
          headSha: startedHeadSha.trim(),
          kiloTaskId: 'kilo-task-unchanged-pr',
          worktreeId: worktree.id,
          reportId: 'report-1',
        },
      },
      paths,
    );
    const lock = await lockKiloWorktree(
      worktree.id,
      'kilo-task-unchanged-pr',
      paths,
    );
    const task = kiloTask({
      id: 'kilo-task-unchanged-pr',
      cwd: worktree.localPath,
      worktreeId: worktree.id,
      lockId: lock.lock.id,
    });
    const diff = await taskDiffSummary(task, paths);
    expect(diff).toMatchObject({
      ok: true,
      fileCount: 1,
    });
    await releaseTaskLock(task, 'succeeded', paths, diff);
    await expect(listPreparedDiffs({}, paths)).resolves.toMatchObject({
      preparedDiffs: [],
    });

    await reconcileCiFixRunForKiloTask(
      {
        task,
        status: 'succeeded',
        diff,
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
  });

  it('creates a prepared diff when Kilo leaves an untracked CI fix file', async () => {
    const home = await tempDir('neondeck-home-');
    const repo = await tempGitRepo();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeRepoRegistry(paths.repos, repo);
    const created = await createWorktree(
      {
        repoId: 'neondeck',
        prNumber: 10,
        baseRef: 'main',
        headRef: 'feature',
      },
      paths,
    );
    if (!created.ok || !('worktree' in created)) {
      throw new Error(created.message);
    }
    const worktree = created.worktree;
    const startedHeadSha = await git(worktree.localPath, ['rev-parse', 'HEAD']);
    await writeFile(
      join(worktree.localPath, 'src/new-fix.ts'),
      'export const fixed = true;\n',
    );
    await addWorkflowSummary(
      {
        workflow: 'ci_fix_run',
        status: 'running',
        summary: {
          outcome: 'kilo-started',
          pr: 'pandemicsyn/neondeck#10',
          headSha: startedHeadSha.trim(),
          kiloTaskId: 'kilo-task-untracked',
          worktreeId: worktree.id,
          reportId: 'report-1',
        },
      },
      paths,
    );
    const lock = await lockKiloWorktree(
      worktree.id,
      'kilo-task-untracked',
      paths,
    );
    const task = kiloTask({
      id: 'kilo-task-untracked',
      cwd: worktree.localPath,
      worktreeId: worktree.id,
      lockId: lock.lock.id,
    });
    const diff = await taskDiffSummary(task, paths);
    expect(diff).toMatchObject({
      ok: true,
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'src/new-fix.ts' }),
      ]),
    });

    await releaseTaskLock(task, 'succeeded', paths, diff);
    await reconcileCiFixRunForKiloTask(
      {
        task,
        status: 'succeeded',
        diff,
      },
      paths,
    );

    await expect(listPreparedDiffs({}, paths)).resolves.toMatchObject({
      preparedDiffs: [
        expect.objectContaining({
          worktreeId: worktree.id,
          status: 'prepared',
        }),
      ],
    });
  });

  it('creates a prepared diff when Kilo commits a CI fix on a PR worktree', async () => {
    const home = await tempDir('neondeck-home-');
    const repo = await tempGitRepo();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeRepoRegistry(paths.repos, repo);
    const created = await createWorktree(
      {
        repoId: 'neondeck',
        prNumber: 10,
        baseRef: 'main',
        headRef: 'feature',
      },
      paths,
    );
    if (!created.ok || !('worktree' in created)) {
      throw new Error(created.message);
    }
    const worktree = created.worktree;
    const startedHeadSha = await git(worktree.localPath, ['rev-parse', 'HEAD']);
    await writeFile(
      join(worktree.localPath, 'src/failing.test.ts'),
      'export const fixed = true;\n',
    );
    await git(worktree.localPath, ['add', '-A']);
    await git(worktree.localPath, ['commit', '-m', 'fix ci']);
    await addWorkflowSummary(
      {
        workflow: 'ci_fix_run',
        status: 'running',
        summary: {
          outcome: 'kilo-started',
          pr: 'pandemicsyn/neondeck#10',
          headSha: startedHeadSha.trim(),
          kiloTaskId: 'kilo-task-commit',
          worktreeId: worktree.id,
          reportId: 'report-1',
        },
      },
      paths,
    );
    const lock = await lockKiloWorktree(worktree.id, 'kilo-task-commit', paths);
    const task = kiloTask({
      id: 'kilo-task-commit',
      cwd: worktree.localPath,
      worktreeId: worktree.id,
      lockId: lock.lock.id,
    });

    const diff = await taskDiffSummary(task, paths);
    expect(diff).toMatchObject({
      ok: true,
      fileCount: expect.any(Number),
    });
    await releaseTaskLock(task, 'succeeded', paths, diff);
    await reconcileCiFixRunForKiloTask(
      {
        task,
        status: 'succeeded',
        diff,
      },
      paths,
    );

    await expect(listPreparedDiffs({}, paths)).resolves.toMatchObject({
      preparedDiffs: [
        expect.objectContaining({
          worktreeId: worktree.id,
          status: 'prepared',
        }),
      ],
    });
    await expect(listWorkflowSummaries(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: 'ci_fix_run',
          status: 'completed',
          summary: expect.objectContaining({ outcome: 'prepared-diff' }),
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

async function writeRepoRegistry(path: string, repoPath = '/tmp/neondeck') {
  await writeFile(
    path,
    `${JSON.stringify({
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: repoPath,
          defaultBranch: 'main',
          packageScripts: { test: 'vitest' },
        },
      ],
    })}\n`,
  );
}

async function tempGitRepo() {
  const repo = await tempDir('ci-fix-repo-');
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'neondeck@example.test']);
  await git(repo, ['config', 'user.name', 'Neondeck Test']);
  await git(repo, ['branch', '-M', 'main']);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(
    join(repo, 'src/failing.test.ts'),
    'export const fixed = false;\n',
  );
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'initial']);
  await git(repo, ['checkout', '-b', 'feature']);
  return repo;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function lockKiloWorktree(
  worktreeId: string,
  taskId: string,
  paths: ReturnType<typeof runtimePaths>,
) {
  const lock = await lockWorktree(
    { worktreeId, owner: `kilo:${taskId}`, ttlSeconds: 300 },
    paths,
  );
  if (!lock.ok || !('lock' in lock)) throw new Error(lock.message);
  return lock;
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
      detailsUrl:
        'https://github.com/pandemicsyn/neondeck/actions/runs/42/job/1',
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
  lockId?: string | null;
}): KiloTaskRecord {
  return {
    id: input.id,
    title: 'Fix CI',
    prompt: 'prompt',
    repoId: 'neondeck',
    repoFullName: 'pandemicsyn/neondeck',
    worktreeId: input.worktreeId,
    lockId: input.lockId ?? null,
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
