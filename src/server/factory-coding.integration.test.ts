import { factoryValidationPolicy } from '../modules/factory/validation-policy';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { emptyFactorySpec } from '../../shared/factory';
import {
  factoryCodingRunSchema,
  factoryCodingStateSchema,
} from '../../shared/factory-coding';
import { reviewRevisionKey } from '../../shared/review-source';
import { ensureRuntimeHome, runtimePaths } from '../runtime-home';
import {
  cancelLocalAttempt,
  prepareSchema,
  inspectCodexReadiness,
  getActiveCodingRun,
  getCodingRun,
  inspectLocalAttempt,
  listCodingRuns,
  type LocalAttemptHandle,
} from '../modules/coding-runs';
import * as localHost from '../modules/coding-runs';
import { codingConfig, codingDigest } from '../modules/factory/coding-context';
import { localCodingConfig } from '../modules/factory/coding-readiness';
import {
  transitionFactoryWork,
  getFactoryWork,
  releaseFactoryWork,
  saveFactorySpec,
  submitFactoryWork,
} from '../modules/factory/service';
import {
  codingHandle,
  dispatchCodingWork,
  reconcileCodingRun,
  type CodingHost,
} from '../modules/factory/coding-service';
import {
  cleanupWorktrees,
  listActiveRepoWorktrees,
} from '../modules/worktrees';
import { createFactoryCodingRoutes } from './routes/factory-coding';
import { createPreparedDiffRoutes } from './routes/prepared-diffs';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();

it.each([
  'candidate',
  'revoke-before-authorization',
  'revoke-after-authorization',
] as const)(
  'real local host factory flow: %s',
  async (mode) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'factory-real-host-')),
    );
    const paths = runtimePaths(join(root, 'runtime'));
    const repo = join(root, 'repo');
    let handle: LocalAttemptHandle | undefined;
    try {
      mkdirSync(repo);
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.name', 'Factory integration');
      git(repo, 'config', 'user.email', 'factory@example.test');
      const instructions =
        'Keep the original file unchanged; present the new file for human review.';
      writeFileSync(join(repo, 'AGENTS.md'), instructions);
      writeFileSync(join(repo, 'original.txt'), 'original\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'fixture base');
      const baseSha = git(repo, 'rev-parse', 'HEAD');
      await ensureRuntimeHome(paths);
      const executable = join(root, 'contract-fixture.mjs');
      // TEST ONLY: production configuration has no mock-scenario switch. This explicit
      // adapter advertises the supported contract, then runs the actual mockdex CLI.
      // Neither readiness, dispatch, host supervision nor reconciliation is mocked.
      writeFileSync(
        executable,
        `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
if(process.argv[2]==='--version') { console.log('${mode === 'candidate' ? 'codex-cli 0.150.1' : 'mockdex codex-contract 0.150.1'}'); }
else {
  let prompt=''; for await(const chunk of process.stdin) prompt+=chunk;
  writeFileSync(join(process.env.TMPDIR,'execution.json'),JSON.stringify({
    prompt,args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,
    codexHome:process.env.CODEX_HOME,scratch:process.env.TMPDIR,
    controllerEnvAbsent:!('NEONDECK_CONTROL_SENTINEL' in process.env),
    selectedEnvAbsent:!('FACTORY_E2E_AUTH' in process.env),
    selectedAuthPresent:readFileSync(join(process.env.CODEX_HOME,'auth.json'),'utf8').includes('synthetic-e2e-auth')
  }));
  const child=spawn(process.execPath,[${JSON.stringify(resolve('scripts/mockdex.mjs'))},...process.argv.slice(2)],{
    env:{...process.env,MOCKDEX_SCENARIO:'${mode === 'revoke-after-authorization' ? 'stall' : 'success'}'},stdio:['pipe','inherit','inherit']});
  child.stdin.end(prompt);
  child.on('error',()=>{process.exitCode=1;});
  child.on('exit',(code)=>{process.exitCode=code??1;});
}
`,
        { mode: 0o700 },
      );
      vi.stubEnv('FACTORY_E2E_AUTH', 'synthetic-e2e-auth');
      vi.stubEnv('NEONDECK_CONTROL_SENTINEL', 'controller-only');
      writeFileSync(
        paths.config,
        JSON.stringify({
          version: 1,
          models: { prReview: 'faux/faux-1' },
          guardrails: { requiredChecks: ['npm test'] },
          factory: {
            enabled: true,
            coding: {
              enabled: true,
              executable,
              model: 'test-model',
              auth: { kind: 'api-key', env: 'FACTORY_E2E_AUTH' },
              path: `${dirname(process.execPath)}:/usr/bin:/bin`,
              wallTimeMs: 15000,
            },
          },
        }),
      );
      writeFileSync(
        paths.repos,
        JSON.stringify({
          version: 1,
          repos: [
            {
              id: 'demo',
              path: repo,
              defaultBranch: 'main',
              github: { owner: 'fixture', name: 'fixture' },
            },
          ],
        }),
      );
      const actor = { kind: 'human' as const, id: 'operator' };
      const outcome =
        'Create mockdex-result.txt containing the deterministic test change.';
      let detail = submitFactoryWork(
        {
          requestKey: 'real-host',
          title: 'Reviewable local candidate',
          body: outcome,
          repoId: 'demo',
        },
        actor,
        paths,
      );
      detail = saveFactorySpec(
        detail.work.id,
        {
          expectedVersion: detail.work.version,
          expectedSpecVersion: detail.work.specVersion,
          expectedRepoFingerprint: detail.repoFingerprint,
          spec: {
            ...emptyFactorySpec(),
            outcome,
            scope: 'mockdex-result.txt only',
            approach: 'Create one new file',
            acceptanceCriteria: [
              {
                id: 'content',
                text: 'The new file contains the deterministic test change.',
              },
            ],
          },
        },
        actor,
        paths,
      );
      const specHash = detail.revisions.at(-1)!.hash;
      detail = releaseFactoryWork(
        detail.work.id,
        {
          requestKey: 'release-real-host',
          expectedVersion: detail.work.version,
          specVersion: detail.work.specVersion,
          specHash,
          sourceVersion: detail.source.version,
          repoFingerprint: detail.repoFingerprint,
          policyVersion: 'isolated-local-v1',
          validationPolicy: factoryValidationPolicy('demo', paths),
          expectedCodingConfigFingerprint: codingDigest(
            codingConfig(paths).coding,
          ),
        },
        actor,
        paths,
      );
      const app = new Hono();
      app.route('/api/factory/coding', createFactoryCodingRoutes(paths));
      app.route('/api', createPreparedDiffRoutes(paths));
      // Production success uses defaults. Revocation cases opt into the host's
      // typed mockdex-only pause/scenario seam, retaining every real host method.
      const host: CodingHost =
        mode === 'candidate'
          ? localHost
          : {
              ...localHost,
              prepareLocalAttempt(input) {
                const parsed = v.parse(prepareSchema, input);
                return localHost.prepareLocalAttempt({
                  ...parsed,
                  config: {
                    ...parsed.config,
                    mockScenario:
                      mode === 'revoke-after-authorization'
                        ? 'stall'
                        : 'success',
                  },
                  testPauseBeforeSpawn: mode === 'revoke-before-authorization',
                });
              },
            };
      const fixtureReadiness = async () => {
        const result = await inspectCodexReadiness(
          {
            ...localCodingConfig(codingConfig(paths).coding),
            mockScenario: 'success',
          },
          root,
        );
        return {
          ready: result.ready,
          enabled: true,
          supportedVersion: 'mockdex codex-contract 0.150.1',
          installedVersion: result.version,
          blockers: result.reason ? [result.reason] : [],
        };
      };
      if (mode === 'candidate') {
        const readiness = v.parse(
          factoryCodingStateSchema,
          await (await app.request('/api/factory/coding/state')).json(),
        );
        expect(readiness.readiness.ready).toBe(true);
        expect(readiness.readiness.installedVersion).toBe('codex-cli 0.150.1');
      }
      const dispatch =
        mode === 'candidate'
          ? dispatchCodingWork(detail.work.id, paths)
          : dispatchCodingWork(detail.work.id, paths, host, fixtureReadiness);
      if (mode !== 'candidate') {
        await waitFor(() => {
          const active = getActiveCodingRun(paths);
          if (active?.host) handle = codingHandle(active, paths);
          return Boolean(
            handle &&
            existsSync(
              join(
                handle.directory,
                mode === 'revoke-before-authorization'
                  ? 'test-spawn.ready'
                  : 'scratch/execution.json',
              ),
            ),
          );
        }, 'Actual anchor/CLI did not reach the intended authorization boundary');
        const current = getFactoryWork(detail.work.id, paths);
        transitionFactoryWork(
          detail.work.id,
          { expectedVersion: current.work.version, action: 'pause' },
          actor,
          paths,
        );
        expect(getActiveCodingRun(paths)?.cancelRequestedAt).toBeTruthy();
        // The real synchronous factory mutation must deliver intent before returning.
        expect(existsSync(`${handle!.directory}.cancel.json`)).toBe(true);
        if (mode === 'revoke-before-authorization')
          rmSync(join(handle!.directory, 'test-spawn.pause'), { force: true });
      }
      const dispatched = await dispatch;
      expect(dispatched).not.toBeNull();
      const id = dispatched!.runId;
      handle = codingHandle(dispatched!, paths);
      let run = getCodingRun(id, paths)!;
      const deadline = Date.now() + 25000;
      while (
        !['candidate', 'failed', 'cancelled'].includes(run.status) &&
        Date.now() < deadline
      ) {
        await delay(100);
        run = await reconcileCodingRun(id, paths, host);
      }
      if (mode !== 'candidate') {
        expect(run.status, run.reason ?? 'Cancellation did not settle').toBe(
          'cancelled',
        );
        const state = await inspectLocalAttempt(handle);
        expect(state.state).toBe('finished');
        if (state.state === 'needs-reconcile') throw new Error(state.reason);
        expect(state.receipt).toMatchObject({
          noWriter: true,
          authCleanup: 'removed',
        });
        expect(
          existsSync(join(handle.directory, 'scratch/execution.json')),
        ).toBe(mode === 'revoke-after-authorization');
        expect(getFactoryWork(detail.work.id, paths).work.lifecycle).toBe(
          'paused',
        );
        expect(git(repo, 'status', '--porcelain')).toBe('');
        expect(listCodingRuns({}, paths)).toHaveLength(1);
        expect(listActiveRepoWorktrees('demo', paths)).toHaveLength(1);
        expect(getActiveCodingRun(paths)).toBeNull();
        return;
      }
      expect(run.status, run.reason ?? 'No terminal result').toBe('candidate');
      expect(run.snapshot.specHash).toBe(specHash);
      expect(run.candidate?.baseSha).toBe(baseSha);
      const inspection = await inspectLocalAttempt(handle);
      expect(inspection.state).toBe('finished');
      if (inspection.state === 'needs-reconcile')
        throw new Error(inspection.reason);
      expect(inspection.receipt).toMatchObject({
        noWriter: true,
        terminal: 'completed',
        exitCode: 0,
        reason: null,
        authCleanup: 'removed',
      });
      expect(inspection.receipt.group?.pid).toBeGreaterThan(0);
      expect(run.providerSessionId).toBeTruthy();
      const execution = v.parse(
        v.object({
          prompt: v.string(),
          args: v.array(v.string()),
          cwd: v.string(),
          home: v.string(),
          codexHome: v.string(),
          scratch: v.string(),
          controllerEnvAbsent: v.boolean(),
          selectedEnvAbsent: v.boolean(),
          selectedAuthPresent: v.boolean(),
        }),
        JSON.parse(
          readFileSync(
            join(handle.directory, 'scratch/execution.json'),
            'utf8',
          ),
        ),
      );
      expect(execution.prompt).toContain(outcome);
      expect(execution.prompt).toContain(instructions);
      expect(execution.prompt).not.toContain('synthetic-e2e-auth');
      expect(execution.args[0]).toBe('exec');
      expect(execution.args).not.toContain('resume');
      expect(execution.args).toEqual(
        expect.arrayContaining(['test-model', 'workspace-write']),
      );
      expect(execution).toMatchObject({
        home: join(handle.directory, 'home'),
        codexHome: join(handle.directory, 'home/.codex'),
        scratch: join(handle.directory, 'scratch'),
        controllerEnvAbsent: true,
        selectedEnvAbsent: true,
        selectedAuthPresent: true,
      });
      expect(existsSync(join(execution.codexHome, 'auth.json'))).toBe(false);
      expect(execution.cwd).not.toBe(repo);
      expect(git(execution.cwd, 'rev-parse', 'HEAD')).toBe(baseSha);
      expect(git(execution.cwd, 'branch', '--show-current')).not.toBe('main');
      expect(
        readFileSync(join(execution.cwd, 'mockdex-result.txt'), 'utf8'),
      ).toBe('mockdex deterministic test change\n');
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(baseSha);
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(existsSync(join(repo, 'mockdex-result.txt'))).toBe(false);

      const response = await app.request(`/api/factory/coding/runs/${id}`);
      expect(response.status).toBe(200);
      const publicJson: unknown = await response.json();
      const publicRun = v.parse(factoryCodingRunSchema, publicJson);
      expect(publicRun.displayStatus).toBe('candidate-awaiting-review');
      expect(publicRun.diff?.worktreeId).toBe(run.workspace?.worktreeId);
      for (const privateValue of [
        run.ownershipToken,
        handle.attemptToken,
        'synthetic-e2e-auth',
      ])
        expect(JSON.stringify(publicJson)).not.toContain(privateValue);
      expect(publicRun.diff).not.toBeNull();
      const diffUrl = `/api/prepared-diffs/${publicRun.diff!.preparedDiffId}`;
      expect((await app.request(`${diffUrl}/summary`)).status).toBe(200);
      const filesResponse = await app.request(`${diffUrl}/files`);
      expect(filesResponse.status).toBe(200);
      const files = v.parse(
        v.object({
          ok: v.literal(true),
          files: v.array(v.object({ path: v.string() })),
          revision: v.object({
            state: v.literal('resolved'),
            kind: v.picklist(['git-commit', 'worktree-diff', 'retained-patch']),
            id: v.string(),
            baseId: v.nullable(v.string()),
          }),
        }),
        await filesResponse.json(),
      );
      expect(files.files.map((file) => file.path)).toContain(
        'mockdex-result.txt',
      );
      const query = new URLSearchParams({
        path: 'mockdex-result.txt',
        expectedRevisionKey: reviewRevisionKey(files.revision)!,
      });
      const patchResponse = await app.request(`${diffUrl}/files/diff?${query}`);
      expect(patchResponse.status).toBe(200);
      const patch = v.parse(
        v.object({ ok: v.literal(true), diff: v.string() }),
        await patchResponse.json(),
      );
      expect(patch.diff).toContain('+mockdex deterministic test change');
      expect(getFactoryWork(detail.work.id, paths).work.lifecycle).toBe(
        'queued',
      );
      expect(getActiveCodingRun(paths)).toBeNull();
      await cleanupWorktrees(
        {
          worktreeId: run.workspace!.worktreeId,
          force: true,
          confirmPreparedDiff: true,
        },
        paths,
      );
      expect(existsSync(join(execution.cwd, 'mockdex-result.txt'))).toBe(true);
      await dispatchCodingWork(detail.work.id, paths);
      expect(listCodingRuns({}, paths)).toHaveLength(1);
      expect(listActiveRepoWorktrees('demo', paths)).toHaveLength(1);
    } finally {
      // Never remove a workspace while a real child could still own it, even on failure.
      const active = getActiveCodingRun(paths);
      handle ??= active?.host ? codingHandle(active, paths) : undefined;
      try {
        if (handle) await confirmStopped(handle, root);
      } finally {
        vi.unstubAllEnvs();
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);

async function confirmStopped(handle: LocalAttemptHandle, root: string) {
  await cancelLocalAttempt(handle);
  const deadline = Date.now() + 20000;
  for (;;) {
    const state = await inspectLocalAttempt(handle);
    if (state.state !== 'needs-reconcile' && state.receipt.noWriter) return;
    if (Date.now() > deadline)
      throw new Error(`Unconfirmed child exit; retained fixture at ${root}`);
    await delay(100);
  }
}

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 12000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(25);
  }
}
