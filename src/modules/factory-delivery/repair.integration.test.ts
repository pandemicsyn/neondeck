import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { openDb } from '../../lib/sqlite';
import { emptyFactorySpec } from '../../../shared/factory';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import {
  getActiveCodingRun,
  listCodingRuns,
  cancelLocalAttempt,
  inspectLocalAttempt,
  loadLocalManifest,
  type LocalAttemptHandle,
} from '../coding-runs';
import {
  codingConfig,
  codingDigest,
  releaseFactoryWork,
  saveFactorySpec,
  submitFactoryWork,
} from '../factory';
import {
  codingHandle,
  dispatchCodingWork,
  reconcileCodingRun,
  requireCodingRun,
  readCodingExecutionUsage,
} from '../factory';
import { dispatchCodingRepair } from './repair';
import { approveTestProgress } from './progress-test-helpers';
import { captureCandidateEvidence } from './evidence';
import {
  reserveDeliveryPipeline,
  deliveryValidationContractDigest,
  getDeliveryPipeline,
  updateDeliveryPipeline,
} from './store';
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
it.each(['normal', 'remaining', 'replaced-binary', 'legacy-binary'] as const)(
  'repairs a retained mockdex candidate: %s allowance',
  async (allowance) => {
    const mode = 'candidate';
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
      await ensureRuntimeHome(paths);
      const executable = join(root, 'contract-fixture.mjs');
      // TEST ONLY: production configuration has no mock-scenario switch. This explicit
      // adapter advertises the supported contract, then runs the actual mockdex CLI.
      // Neither readiness, dispatch, host supervision nor reconciliation is mocked.
      writeFileSync(
        executable,
        `#!/usr/bin/env node
import {readFileSync,writeFileSync,existsSync,unlinkSync,chmodSync} from 'node:fs';
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
  if (prompt.includes('This is a bounded repair')) {
    if (readFileSync('original.txt','utf8') !== 'dirty candidate\\n' || readFileSync('extra.sh','utf8') !== 'echo candidate\\n' || readFileSync('mockdex-result.txt','utf8') !== 'mockdex deterministic test change\\n') process.exit(42);
    unlinkSync('mockdex-result.txt'); // mockdex's exclusive-create fixture rewrites identical bytes.
  } else {
    writeFileSync('original.txt','dirty candidate\\n');
    writeFileSync('extra.sh','echo candidate\\n'); chmodSync('extra.sh',0o755);
  }
  const child=spawn(process.execPath,[${JSON.stringify(resolve('scripts/mockdex.mjs'))},...process.argv.slice(2)],{
    env:{...process.env,MOCKDEX_SCENARIO:'${'success'}'},stdio:['pipe','inherit','inherit']});
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
          expectedCodingConfigFingerprint: codingDigest(
            codingConfig(paths).coding,
          ),
        },
        actor,
        paths,
      );
      const first = await dispatchCodingWork(detail.work.id, paths);
      expect(first).not.toBeNull();
      handle = codingHandle(first!, paths);
      const parent = await settle(first!.runId);
      expect(parent.status).toBe('candidate');
      const captured = await captureCandidateEvidence(handle);
      const revision = {
        runId: parent.runId,
        attemptId: parent.attemptId,
        releaseId: parent.snapshot.releaseId,
        specVersion: parent.snapshot.specVersion,
        specHash: parent.snapshot.specHash,
        candidateDigest: captured.evidenceDigest,
        baseSha: captured.baseSha,
        headSha: captured.headSha,
        treeSha: captured.treeSha,
      };
      let pipeline = reserveDeliveryPipeline(
        {
          workItemId: parent.snapshot.workItemId,
          repoId: parent.snapshot.repoId,
          initialRevision: revision,
          authorization: {
            id: 'explicit-grant',
            authorizedBy: 'operator',
            authorizedAt: new Date().toISOString(),
            revision,
            repoId: parent.snapshot.repoId,
            target: { owner: 'fixture', name: 'fixture', baseBranch: 'main' },
            configFingerprint: 'a'.repeat(64),
            checkCommands: ['npm test'],
            maxRepairAttempts: 2,
            totalExecutionMs: allowance === 'remaining' ? 6001 : 10800000,
            initialExecutionMs: 1000,
          },
        },
        paths,
      );
      pipeline = updateDeliveryPipeline(
        {
          pipelineId: pipeline.pipelineId,
          expectedVersion: pipeline.version,
          action: {
            type: 'plan-effect',
            id: 'verification-effect',
            kind: 'verification',
            maxExecutionMs: 1000,
          },
        },
        paths,
      );
      pipeline = updateDeliveryPipeline(
        {
          pipelineId: pipeline.pipelineId,
          expectedVersion: pipeline.version,
          action: { type: 'start-effect', id: 'verification-effect' },
        },
        paths,
      );
      pipeline = updateDeliveryPipeline(
        {
          pipelineId: pipeline.pipelineId,
          expectedVersion: pipeline.version,
          action: {
            type: 'record-evidence',
            evidence: {
              id: 'failed-check',
              kind: 'verification',
              revision,
              producerId: 'checker',
              result: 'failed',
              evidenceRef: 'retained-check',
              effectId: 'verification-effect',
              validationContractDigest:
                deliveryValidationContractDigest(pipeline),
              bundleDigest: 'a'.repeat(64),
              verificationEvidenceId: null,
              verificationBundleDigest: null,
            },
          },
        },
        paths,
      );
      pipeline = updateDeliveryPipeline(
        {
          pipelineId: pipeline.pipelineId,
          expectedVersion: pipeline.version,
          action: {
            type: 'settle-effect',
            id: 'verification-effect',
            state: 'delivered',
            receiptRef: 'retained-check',
            executionMs: 1,
          },
        },
        paths,
      );
      pipeline = approveTestProgress(
        pipeline,
        paths,
        'repair-one',
        'Fix within released scope',
      );
      const assessment = pipeline.progress.assessments.at(-1)!;
      expect(assessment.state).toBe('settled');
      expect(assessment.executionMs).toBe(1);
      const command = {
        pipelineId: pipeline.pipelineId,
        expectedVersion: pipeline.version,
        requestId: 'repair-one',
        reason: 'Fix within released scope',
        maxWallTimeMs: 15000,
        progressAssessmentId: assessment.assessmentId,
        progressInputDigest: assessment.inputDigest,
        progressEvidenceDigest: assessment.evidenceDigest,
      };
      const originalEvidence = readFileSync(parent.candidate!.diffRef);
      const authority = vi.fn<() => Promise<void>>(async () => {});
      if (allowance === 'replaced-binary' || allowance === 'legacy-binary') {
        const marker = join(root, 'replacement-was-executed');
        if (allowance === 'legacy-binary') {
          // Explicit old persisted fixture: decoding must not invent identity.
          const { executableIdentity: _identity, ...harness } =
            parent.snapshot.harness;
          const legacy = {
            ...parent,
            snapshot: { ...parent.snapshot, harness },
          };
          const db = openDb(paths.neondeckDatabase);
          try {
            db.prepare(
              'UPDATE coding_runs SET record_json=? WHERE run_id=?',
            ).run(JSON.stringify(legacy), parent.runId);
          } finally {
            db.close();
          }
          expect(await reconcileCodingRun(parent.runId, paths)).toEqual(legacy);
        }
        writeFileSync(
          executable,
          `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\nconsole.log('codex-cli 0.150.1');\n`,
          { mode: 0o700 },
        );
        expect(
          await dispatchCodingRepair(command, paths, authority),
        ).toBeNull();
        expect(existsSync(marker)).toBe(false);
        const retained = getDeliveryPipeline(pipeline.pipelineId, paths)!;
        expect(retained.repairs).toEqual(pipeline.repairs);
        expect(retained.effects).toEqual(pipeline.effects);
        expect(retained.interventions.at(-1)).toMatchObject({
          kind: 'authority',
          resolution: null,
        });
        expect(retained.interventions.at(-1)?.reason).toContain(
          allowance === 'legacy-binary'
            ? 'no original executable identity'
            : 'no longer matches original admission',
        );
        expect(listCodingRuns({}, paths)).toHaveLength(1);
        expect(getActiveCodingRun(paths)).toBeNull();
        expect(readFileSync(parent.candidate!.diffRef)).toEqual(
          originalEvidence,
        );
        return;
      }
      const started = await dispatchCodingRepair(command, paths, authority);
      if (!started) throw new Error('Expected reserved repair');
      handle = codingHandle(started, paths);
      // The accounted judge millisecond shares the original grant ceiling.
      const expectedCap = allowance === 'remaining' ? 4999 : 15000;
      expect((await loadLocalManifest(handle)).manifest.config.wallTimeMs).toBe(
        expectedCap,
      );
      expect(
        getDeliveryPipeline(pipeline.pipelineId, paths)!.repairs[0]
          .reservedExecutionMs,
      ).toBe(expectedCap);
      expect(started.runId).not.toBe(parent.runId);
      expect(started.attemptId).not.toBe(parent.attemptId);
      expect(started.snapshot).toEqual({
        ...parent.snapshot,
        requestId: 'repair-one',
      });
      expect(
        (await dispatchCodingRepair(command, paths, authority))?.runId,
      ).toBe(started.runId);
      const repaired = await settle(started.runId);
      expect(repaired.status).toBe('candidate');
      const usage = await readCodingExecutionUsage(repaired, paths);
      const inspected = await inspectLocalAttempt(handle);
      if (inspected.state !== 'finished')
        throw new Error('Expected signed terminal receipt');
      expect(usage).toBe(
        inspected.receipt.endedAt! - inspected.receipt.startedAt!,
      );
      expect(usage).toBeGreaterThanOrEqual(0);
      expect(usage).toBeLessThan(expectedCap);
      // Controller timestamps can span a day without changing charged host execution.
      expect(
        await readCodingExecutionUsage(
          {
            ...repaired,
            createdAt: new Date(
              Date.parse(repaired.createdAt) - 86400000,
            ).toISOString(),
            completedAt: new Date(
              Date.parse(repaired.completedAt!) + 86400000,
            ).toISOString(),
          },
          paths,
        ),
      ).toBe(usage);

      // mockdex emits a fixed session ID; verify the actual fresh CLI invocation.
      const execution = v.parse(
        v.object({ args: v.array(v.string()), codexHome: v.string() }),
        JSON.parse(
          readFileSync(
            join(handle.directory, 'scratch/execution.json'),
            'utf8',
          ),
        ),
      );
      expect(execution.args[0]).toBe('exec');
      expect(execution.args).not.toContain('resume');
      expect(execution.codexHome).not.toBe(
        join(codingHandle(parent, paths).directory, 'home/.codex'),
      );
      expect(repaired.workspace!.worktreeId).not.toBe(
        parent.workspace!.worktreeId,
      );
      expect(requireCodingRun(parent.runId, paths)).toEqual(parent);
      expect(readFileSync(parent.candidate!.diffRef)).toEqual(originalEvidence);
      expect(
        getDeliveryPipeline(pipeline.pipelineId, paths)!.repairs,
      ).toHaveLength(1);
      expect(listCodingRuns({}, paths)).toHaveLength(2);
      expect(getActiveCodingRun(paths)).toBeNull();
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(authority).toHaveBeenCalledTimes(2);
      await (allowance === 'remaining' ? assertExhaustion() : assertStale());
      async function assertExhaustion() {
        const nextCommand = {
          ...command,
          requestId: 'budget-exhausted',
          expectedVersion: getDeliveryPipeline(pipeline.pipelineId, paths)!
            .version,
        };
        expect(
          await dispatchCodingRepair(nextCommand, paths, authority),
        ).toBeNull();
        const exhausted = getDeliveryPipeline(pipeline.pipelineId, paths)!;
        expect(
          exhausted.interventions.filter(
            (i) => i.kind === 'budget' && i.resolution === null,
          ),
        ).toHaveLength(1);
        expect(
          await dispatchCodingRepair(
            { ...nextCommand, expectedVersion: exhausted.version },
            paths,
            authority,
          ),
        ).toBeNull();
        expect(getDeliveryPipeline(pipeline.pipelineId, paths)!.version).toBe(
          exhausted.version,
        );
        expect(listCodingRuns({}, paths)).toHaveLength(2);
      }
      async function assertStale() {
        // A stale live candidate fails before it can reserve another attempt.
        writeFileSync(
          join(captured.root, 'mockdex-result.txt'),
          'external drift',
        );
        await expect(
          dispatchCodingRepair(
            {
              ...command,
              requestId: 'repair-two',
              expectedVersion: getDeliveryPipeline(pipeline.pipelineId, paths)!
                .version,
            },
            paths,
            authority,
          ),
        ).rejects.toThrow(/Stale/);
        expect(listCodingRuns({}, paths)).toHaveLength(2);
      }
      async function settle(id: string) {
        const deadline = Date.now() + 25000;
        for (;;) {
          const run = await reconcileCodingRun(id, paths);
          if (['candidate', 'failed', 'cancelled'].includes(run.status))
            return run;
          if (Date.now() > deadline) throw new Error('Fixture did not settle');
          await delay(100);
        }
      }
    } finally {
      const active = getActiveCodingRun(paths);
      handle = active?.host ? codingHandle(active, paths) : handle;
      if (handle) await stopFixture(handle);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);

async function stopFixture(handle: LocalAttemptHandle) {
  await cancelLocalAttempt(handle);
  const deadline = Date.now() + 20000;
  for (;;) {
    const state = await inspectLocalAttempt(handle);
    if (state.state !== 'needs-reconcile' && state.receipt.noWriter) return;
    if (Date.now() > deadline) throw new Error('Fixture writer did not stop');
    await delay(100);
  }
}
