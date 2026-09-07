import type { CodingAdapterId } from '../../shared/coding-adapters';
import {
  adapterFixtures,
  enableAdapterFixtureHost,
  writeAdapterFixture,
  assertAdapterAttempts,
} from './factory-adapters-fixtures.test-helper';
import {
  codingConfig,
  assertReleasedCodingConfig,
} from '../modules/factory/coding-context';
import { deliveryDetailSchema } from '../../shared/factory-delivery-api';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, vi } from 'vitest';
import * as v from 'valibot';
import { emptyFactorySpec } from '../../shared/factory';
import { ensureRuntimeHome, runtimePaths } from '../runtime-home';
import {
  artifactHash,
  cancelLocalAttempt,
  getActiveCodingRun,
  inspectLocalAttempt,
  listCodingRuns,
  type LocalAttemptHandle,
} from '../modules/coding-runs';
import {
  codingDigest,
  codingHandle,
  dispatchCodingWork,
  reconcileCodingRun,
  requireCodingRun,
  releaseFactoryWork,
  saveFactorySpec,
  submitFactoryWork,
} from '../modules/factory';
import {
  authorizeFactoryDelivery,
  factoryDeliveryDetail,
  factoryDeliveryPreview,
  revokeFactoryDelivery,
} from '../modules/factory-delivery/service-operator';
import { advanceFactoryDelivery } from '../modules/factory-delivery/service';
import { deliveryIO } from '../modules/factory-delivery/delivery-io';
import {
  requireDelivery,
  changeDelivery,
  deliveryReceipt,
  deliveryIntentPath,
} from '../modules/factory-delivery/service-records';
import {
  candidateReviewRequestSchema,
  type CandidateReviewRequest,
} from '../modules/factory-delivery/reviewer-contract';
import { reviewerChecksSchema } from '../modules/factory-delivery/reviewer-contract';
import * as publicationGit from '../modules/factory-delivery/publication-git-io';
import type { DeliveryPipeline } from '../../shared/factory-delivery';
import {
  progressReviewRequestSchema,
  type ProgressReviewRequest,
} from '../modules/factory-delivery/progress-reviewer-contract';
import { progressIO } from '../modules/factory-delivery/progress-service';
import { candidateCheckLogSchema } from '../modules/factory-delivery/verification-contract';
import { deliveryBudget } from '../modules/factory-delivery/delivery-aggregate';
import { progressDigest } from '../modules/factory-delivery/progress-evidence-contract';
import { captureCandidateEvidence } from '../modules/factory-delivery/evidence';

// Only external Flue admission/settlement is synthetic. The production reviewer
// still validates the complete request, executed checks, reply and dispatch receipt.
const model = vi.hoisted(() => ({ dispatch: vi.fn(), init: vi.fn() }));
vi.mock('@flue/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@flue/runtime')>()),
  dispatch: model.dispatch,
  init: model.init,
}));
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  model.dispatch.mockReset();
  model.init.mockReset();
});

export const deliveryModes = [
  'complete',
  'repair',
  'uncertain-create',
  'prepublish-repair',
  'reviewer-findings',
  'change-approach',
  'escalate',
  'unknown-progress-admission',
  'two-repairs',
] as const;
export type DeliveryMode = (typeof deliveryModes)[number];

export async function runDeliveryIntegration(
  mode: DeliveryMode,
  provider?: CodingAdapterId,
) {
  const selected = provider ? adapterFixtures[provider] : undefined;
  if (provider) enableAdapterFixtureHost();
  const candidateFile = selected?.file ?? 'mockdex-result.txt';
  const candidateMarker = selected?.marker ?? 'deterministic';
  const expectsRepair =
    mode.includes('repair') ||
    mode === 'reviewer-findings' ||
    mode === 'change-approach';
  const expectedRepairs = mode === 'two-repairs' ? 2 : expectsRepair ? 1 : 0;
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'factory-delivery-e2e-')),
  );
  const paths = runtimePaths(join(root, 'runtime'));
  const repo = join(root, 'repo');
  const bare = join(root, 'remote.git');
  let handle: LocalAttemptHandle | undefined;
  let pipelineId = '';
  let postCount = 0;
  let readsAfterPost = 0;
  const observedPullHeads: string[] = [];
  let pull: Record<string, unknown> | undefined;
  const requests: CandidateReviewRequest[] = [];
  const progressRequests: ProgressReviewRequest[] = [];
  const handles: LocalAttemptHandle[] = [];
  // Fail closed for all HTTP not explicitly modeled below.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/factory-delivery/deliveries/'))
      return json(
        factoryDeliveryDetail(requireDelivery(pipelineId, paths), paths),
      );
    if (!url.startsWith('https://api.github.com/repos/fixture/fixture/pulls'))
      throw new Error(`Unexpected external request: ${url}`);
    if (init?.method === 'POST') {
      postCount++;
      const body = v.parse(
        v.object({
          head: v.string(),
          base: v.string(),
          body: v.string(),
          draft: v.literal(true),
          title: v.string(),
        }),
        JSON.parse(String(init.body)),
      );
      const p = requireDelivery(pipelineId, paths);
      const sha = p.commits.at(-1)!.publishedHeadSha;
      expect(
        git(repo, '--git-dir', bare, 'rev-parse', `refs/heads/${p.branch}`),
      ).toBe(sha);
      const repository = {
        id: 123,
        name: 'fixture',
        owner: { login: 'fixture' },
      };
      pull = {
        id: 70,
        number: 7,
        html_url: 'https://github.com/fixture/fixture/pull/7',
        title: body.title,
        body: body.body,
        state: 'open',
        draft: true,
        head: { ref: body.head, sha, repo: repository },
        base: { ref: body.base, sha: p.revision.baseSha, repo: repository },
        user: { id: 1, login: 'fixture' },
        merged_at: null,
        merge_commit_sha: null,
        updated_at: new Date().toISOString(),
      };
      if (mode === 'uncertain-create')
        throw new Error('Synthetic accepted POST with lost response');
      return json(pull, 201);
    }
    if (url === 'https://api.github.com/repos/fixture/fixture/pulls/7') {
      if (!pull) throw new Error('Cannot observe a PR before its creation.');
      const p = requireDelivery(pipelineId, paths);
      const remoteHead = git(
        repo,
        '--git-dir',
        bare,
        'rev-parse',
        `refs/heads/${p.branch}`,
      );
      observedPullHeads.push(remoteHead);
      const recordedHead = v.parse(
        v.object({ head: v.object({ ref: v.string(), repo: v.unknown() }) }),
        pull,
      ).head;
      return json({
        ...pull,
        head: { ...recordedHead, sha: remoteHead },
        merged: false,
        mergeable: null,
        mergeable_state: 'unknown',
      });
    }
    if (pull) readsAfterPost++;
    // One negative observation after the lost response must never rearm creation.
    return json(
      pull && !(mode === 'uncertain-create' && readsAfterPost === 1)
        ? [pull]
        : [],
    );
  });
  try {
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Synthetic Factory');
    git(repo, 'config', 'user.email', 'factory@example.test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'init', '--bare', bare);
    git(
      repo,
      'remote',
      'add',
      'origin',
      'https://github.com/fixture/fixture.git',
    );
    const checkCommand = `${process.execPath} check.cjs`;
    writeFileSync(join(repo, 'original.txt'), 'unchanged\n');
    writeFileSync(
      join(repo, 'check.cjs'),
      `const fs=require('node:fs'); console.log(JSON.stringify({cwd:process.cwd(),pid:process.pid,hasProviderSecret:'FACTORY_DELIVERY_AUTH' in process.env})); if(!fs.readFileSync(${JSON.stringify(candidateFile)},'utf8').includes(${JSON.stringify(candidateMarker)})) process.exit(2); if(${['prepublish-repair', 'change-approach', 'escalate', 'unknown-progress-admission', 'two-repairs'].includes(mode) ? (mode === 'two-repairs' ? "!fs.readFileSync('state.txt','utf8').startsWith('fixed-v')" : "fs.readFileSync('state.txt','utf8') !== 'fixed-v2'") : "!fs.readFileSync('state.txt','utf8').startsWith('fixed')"}) process.exit(3);`,
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'synthetic base');
    const base = git(repo, 'rev-parse', 'HEAD');
    // A real ordinary pre-commit hook must run in the publication checkout.
    const hookLog = join(root, 'hook-observed');
    writeFileSync(
      join(repo, '.git/hooks/pre-commit'),
      `#!/bin/sh\npwd >> '${hookLog}'\n`,
      { mode: 0o700 },
    );
    await ensureRuntimeHome(paths);
    const executable = provider
      ? writeAdapterFixture(root, provider)
      : join(root, 'codex-fixture.mjs');
    if (!provider)
      writeFileSync(
        executable,
        `#!/usr/bin/env node
import {writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';import {spawn} from 'node:child_process';
if(process.argv[2]==='--version') console.log('codex-cli 0.150.1');
else {let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const repair=prompt.includes('This is a bounded repair');
if(repair&&existsSync('mockdex-result.txt'))unlinkSync('mockdex-result.txt');
writeFileSync('state.txt',repair?(${mode === 'two-repairs'}&&readFileSync('state.txt','utf8')==='fixed-v2'?'fixed-v3':'fixed-v2'):'fixed');
const child=spawn(process.execPath,[${JSON.stringify(resolve('scripts/mockdex.mjs'))},...process.argv.slice(2)],{env:{...process.env,MOCKDEX_SCENARIO:'success'},stdio:['pipe','inherit','inherit']});child.stdin.end(prompt);child.on('exit',code=>process.exitCode=code??1);child.on('error',()=>process.exitCode=1);}
`,
        { mode: 0o700 },
      );
    vi.stubEnv('FACTORY_DELIVERY_AUTH', 'synthetic-only');
    vi.stubEnv('FACTORY_DELIVERY_GITHUB', 'synthetic-github');
    const config = {
      version: 1,
      models: { prReview: 'faux/faux-1' },
      guardrails: { requiredChecks: [checkCommand] },
      execution: {
        enabledBackends: ['local'],
        unattended: 'allow-preapproved',
        preapprovedCommands: [
          { command: checkCommand, match: 'exact', backends: ['local'] },
        ],
      },
      factory: {
        enabled: true,
        github: [
          {
            id: 'fixture',
            enabled: true,
            repoId: 'demo',
            repositoryId: '123',
            owner: 'fixture',
            name: 'fixture',
            webhookSecretEnv: 'FACTORY_DELIVERY_WEBHOOK',
            tokenEnv: 'FACTORY_DELIVERY_GITHUB',
            admission: { mode: 'all' },
          },
        ],
        coding: {
          enabled: true,
          executable,
          model: selected?.model ?? 'test-model',
          ...(provider && selected
            ? {
                adapter: {
                  id: provider,
                  contractVersion: 1 as const,
                  cliVersion: selected.cliVersion,
                },
              }
            : {}),
          auth: { kind: 'api-key', env: 'FACTORY_DELIVERY_AUTH' },
          path: `${dirname(process.execPath)}:/usr/bin:/bin`,
          wallTimeMs: 15000,
        },
      },
    };
    writeFileSync(paths.config, JSON.stringify(config));
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
    let work = submitFactoryWork(
      {
        requestKey: 'delivery-e2e',
        title: 'Synthetic delivery',
        body: 'Create the candidate file and set state to fixed.',
        repoId: 'demo',
      },
      actor,
      paths,
    );
    work = saveFactorySpec(
      work.work.id,
      {
        expectedVersion: work.work.version,
        expectedSpecVersion: work.work.specVersion,
        expectedRepoFingerprint: work.repoFingerprint,
        spec: {
          ...emptyFactorySpec(),
          outcome: 'Create the candidate file and set state to fixed.',
          scope: `${candidateFile} and state.txt`,
          approach: 'Write two files.',
          acceptanceCriteria: [
            {
              id: 'fixed',
              text: 'The deterministic file exists and state is fixed.',
            },
          ],
        },
      },
      actor,
      paths,
    );
    work = releaseFactoryWork(
      work.work.id,
      {
        requestKey: 'release-e2e',
        expectedVersion: work.work.version,
        specVersion: work.work.specVersion,
        specHash: work.revisions.at(-1)!.hash,
        sourceVersion: work.source.version,
        repoFingerprint: work.repoFingerprint,
        policyVersion: 'isolated-local-v1',
        expectedCodingConfigFingerprint: codingDigest(
          codingConfig(paths).coding,
        ),
      },
      actor,
      paths,
    );
    const dispatched = await dispatchCodingWork(work.work.id, paths);
    expect(dispatched).not.toBeNull();
    handle = codingHandle(dispatched!, paths);
    handles.push(handle);
    await until(async () => {
      const run = await reconcileCodingRun(dispatched!.runId, paths);
      return ['candidate', 'failed', 'cancelled'].includes(run.status);
    });
    const run = requireCodingRun(dispatched!.runId, paths);
    expect(run.status).toBe('candidate');
    const retained = (await captureCandidateEvidence(handle)).root;
    const originalIndex = readFileSync(
      git(retained, 'rev-parse', '--git-path', 'index'),
    );
    const originalStatus = git(retained, 'status', '--porcelain');
    const preview = await factoryDeliveryPreview(run.runId, paths);
    expect(preview.checkCommands).toEqual([checkCommand]);
    expect(preview.revision.treeSha).not.toBe(
      git(repo, 'rev-parse', 'HEAD^{tree}'),
    );
    await expect(
      authorizeFactoryDelivery(
        {
          requestId: 'stale-grant',
          confirm: true,
          preview: {
            ...preview,
            revision: { ...preview.revision, treeSha: '0'.repeat(40) },
          },
        },
        paths,
      ),
    ).rejects.toThrow();
    writeFileSync(
      paths.config,
      JSON.stringify({ ...config, guardrails: { requiredChecks: [] } }),
    );
    await expect(factoryDeliveryPreview(run.runId, paths)).rejects.toThrow(
      /check commands/i,
    );
    writeFileSync(paths.config, JSON.stringify(config));
    const granted = await authorizeFactoryDelivery(
      { requestId: 'grant-e2e', confirm: true, preview },
      paths,
    );
    pipelineId = granted.pipeline.pipelineId;
    if (provider) {
      const changed = {
        ...config,
        factory: {
          ...config.factory,
          coding: {
            ...config.factory.coding,
            adapter: {
              id: provider === 'codex' ? 'opencode' : 'codex',
              contractVersion: 1,
              cliVersion: 'changed-version',
            },
            executable: join(root, 'must-never-launch'),
            model: 'changed-model',
          },
        },
      };
      writeFileSync(paths.config, JSON.stringify(changed));
      // This newly granted candidate has no failed evidence or progress admission.
      // Exercise configuration authority directly instead of asking repair admission
      // to bypass those earlier prerequisites merely to reach a particular error.
      expect(() => assertReleasedCodingConfig(work.work.id, paths)).toThrow(
        /Coding configuration changed since human release/,
      );
      expect(listCodingRuns({}, paths)).toHaveLength(1);
      expect(requireDelivery(pipelineId, paths).repairs).toEqual([]);
      expect(requireCodingRun(run.runId, paths).snapshot).toEqual(run.snapshot);
      writeFileSync(paths.config, JSON.stringify(config));
    }
    expect(
      v.parse(
        deliveryDetailSchema,
        factoryDeliveryDetail(requireDelivery(pipelineId, paths), paths),
      ),
    ).toEqual(granted);
    expect(
      (
        await authorizeFactoryDelivery(
          { requestId: 'grant-e2e', confirm: true, preview },
          paths,
        )
      ).pipeline.pipelineId,
    ).toBe(pipelineId);
    // Retain all production Git validation and hook behavior; translate ONLY
    // the explicit GitHub push/ls-remote transport destination to a local bare repo.
    const realGit = publicationGit.git;
    vi.spyOn(publicationGit, 'git').mockImplementation((cwd, args) => {
      if (args.includes('push') || args.includes('ls-remote')) {
        expect(args).toContain('https://github.com/fixture/fixture.git');
        if (args.includes('push') && mode === 'repair' && postCount === 1) {
          const p = requireDelivery(pipelineId, paths);
          const priorHead = git(
            repo,
            '--git-dir',
            bare,
            'rev-parse',
            `refs/heads/${p.branch}`,
          );
          expect(observedPullHeads).toContain(priorHead);
          expect(priorHead).not.toBe(p.commits.at(-1)!.publishedHeadSha);
        }
        return realGit(
          cwd,
          args.map((arg) =>
            arg === 'https://github.com/fixture/fixture.git' ? bare : arg,
          ),
        );
      }
      return realGit(cwd, args);
    });
    model.dispatch.mockImplementation(
      async (_agent: unknown, raw: { initialData: unknown }) => {
        const progress = v.safeParse(
          progressReviewRequestSchema,
          raw.initialData,
        );
        if (progress.success) {
          progressRequests.push(progress.output);
          const packet = progress.output.packet;
          if (packet.repairOrdinal === 1) {
            expect(packet.priorRepairs).toEqual([]);
            expect(packet.candidates).toHaveLength(1);
          } else {
            expect(mode).toBe('two-repairs');
            expect(packet.repairOrdinal).toBe(2);
            const current = requireDelivery(pipelineId, paths);
            expect(packet.priorRepairs).toEqual([
              {
                ordinal: 1,
                revision: current.repairs[0].fromRevision,
                instructions: current.repairs[0].reason,
              },
            ]);
            expect(
              packet.candidates.map((candidate) => candidate.revision),
            ).toEqual([current.initialRevision, current.revision]);
            expect(packet.candidates[0].diff).not.toBe(
              packet.candidates[1].diff,
            );
            expect(packet.candidates[0].revision.candidateDigest).not.toBe(
              packet.candidates[1].revision.candidateDigest,
            );
            expect(
              packet.candidates.every(
                (candidate) => candidate.observations.length > 0,
              ),
            ).toBe(true);
          }
          expect(progress.output.packet.missingEvidence).toEqual([]);
          expect(progress.output.packet.omittedEvidence).toEqual([]);
          if (mode === 'unknown-progress-admission')
            throw new Error(
              'Synthetic accepted progress admission with lost response',
            );
          return {
            submissionId: `progress-${progressRequests.length}`,
            uid: 'synthetic-progress',
            acceptedAt: new Date().toISOString(),
          };
        }
        const request = v.parse(candidateReviewRequestSchema, raw.initialData);
        requests.push(request);
        expect(request.checks.passed).toBe(true);
        expect(request.checks.checks.length).toBeGreaterThan(0);
        return {
          submissionId: `review-${requests.length}`,
          uid: 'synthetic-review',
          acceptedAt: new Date().toISOString(),
        };
      },
    );
    model.init.mockImplementation(
      (_agent: unknown, options: { id: string }) => ({
        abort: async () => {},
        read: async (receipt: { submissionId: string } | string) => {
          const progress = progressRequests.findLast(
            (r) => r.id === options.id,
          );
          if (progress) {
            const submissionId =
              typeof receipt === 'string' ? receipt : receipt.submissionId;
            expect(
              requireDelivery(pipelineId, paths).progress.assessments.find(
                (a) => a.assessmentId === progress.binding.assessmentId,
              )?.submissionId,
            ).toBe(submissionId);
            return {
              submissionId,
              data: {
                factoryProgressReview: [
                  {
                    ...progress.binding,
                    decision:
                      mode === 'change-approach'
                        ? 'change-approach'
                        : mode === 'escalate'
                          ? 'escalate'
                          : 'continue',
                    rationale:
                      'Synthetic assessment of the retained production evidence.',
                    evidenceRefs: [
                      `candidate:${progress.packet.revision.candidateDigest}`,
                    ],
                    nextInstructions:
                      mode === 'change-approach'
                        ? 'Use the alternate scoped approach: write fixed-v2 to state.txt and preserve mockdex-result.txt.'
                        : null,
                  },
                ],
              },
              metadata: {
                startedAt: Date.now(),
                completedAt: Date.now(),
                totalTokens: 20,
                requestDigest: progressDigest(progress),
              },
            };
          }
          const request = requests.findLast((r) => r.id === options.id)!;
          expect(request).toBeDefined();
          const p = requireDelivery(pipelineId, paths);
          const effect = p.effects.findLast((e) => e.kind === 'review')!;
          expect(
            readFileSync(
              deliveryIntentPath(pipelineId, `${effect.id}:submission`, paths),
              'utf8',
            ),
          ).toContain(
            typeof receipt === 'string' ? receipt : receipt.submissionId,
          );
          const hasFindings =
            mode === 'reviewer-findings' && request.id === requests[0]?.id;
          return {
            submissionId:
              typeof receipt === 'string' ? receipt : receipt.submissionId,
            data: {
              factoryReview: [
                {
                  evidenceDigest: request.evidence.evidenceDigest,
                  revision: request.evidence.revision,
                  outcome: hasFindings ? 'findings' : 'pass',
                  summary:
                    'Synthetic independent review of the executed evidence.',
                  findings: hasFindings
                    ? [
                        {
                          severity: 'medium',
                          path: 'state.txt',
                          line: 1,
                          description:
                            'The scoped state value must be fixed-v2. Update it without changing the released file scope.',
                        },
                      ]
                    : [],
                },
              ],
            },
            metadata: {
              startedAt: Date.now(),
              completedAt: Date.now(),
              totalTokens: 20,
              evidenceDigest: request.evidence.evidenceDigest,
              revision: request.evidence.revision,
              requestDigest: artifactHash(JSON.stringify(request)),
            },
          };
        },
      }),
    );
    const progressReview = vi.spyOn(progressIO, 'review');
    const observations = {
      verification: vi.spyOn(deliveryIO, 'verify'),
      review: vi.spyOn(deliveryIO, 'review'),
      commit: vi.spyOn(deliveryIO, 'commit'),
      push: vi.spyOn(deliveryIO, 'push'),
    };
    // Do not tick past PR settlement: watch provider integration has its own tests.
    async function drive(done: (p: DeliveryPipeline) => boolean) {
      let lastVersion = -1;
      let unchanged = 0;
      await until(
        async () => {
          await advanceFactoryDelivery(pipelineId, paths, deliveryIO);
          const p = requireDelivery(pipelineId, paths);
          unchanged = p.version === lastVersion ? unchanged + 1 : 0;
          lastVersion = p.version;
          if (unchanged > 3 && !p.repairs.some((r) => r.status === 'reserved'))
            throw new Error(
              `Stalled production delivery: ${JSON.stringify({ version: p.version, effects: p.effects, evidence: p.evidence, pr: p.pr })}`,
            );
          for (const repair of p.repairs) {
            const child = requireCodingRun(repair.runId, paths);
            if (
              child.host &&
              !handles.some(
                (h) => h.directory === codingHandle(child, paths).directory,
              )
            )
              handles.push(codingHandle(child, paths));
          }
          if (done(p)) return true;
          if (p.interventions.length) {
            const call = progressReview.mock.results.at(-1);
            if (call?.type === 'return') await call.value;
            throw new Error(JSON.stringify(p.interventions));
          }
          if (
            p.effects.some(
              (e) => e.state === 'uncertain' && e.kind !== 'create-pr',
            )
          ) {
            const effect = p.effects.find((e) => e.state === 'uncertain');
            const observation =
              effect && effect.kind in observations
                ? observations[effect.kind as keyof typeof observations]
                : undefined;
            const call = observation?.mock.results.at(-1);
            if (call?.type === 'return') await call.value;
            throw new Error(
              `Unexpected uncertain effect: ${JSON.stringify(p.effects)}`,
            );
          }
          return done(p);
        },
        180000,
        () => JSON.stringify(requireDelivery(pipelineId, paths)),
      );
    }
    if (mode === 'escalate' || mode === 'unknown-progress-admission') {
      await drive((p) => p.interventions.length > 0);
      const stopped = requireDelivery(pipelineId, paths);
      expect(stopped.progress.assessments).toHaveLength(1);
      expect(stopped.progress.assessments[0].result?.decision).toBe(
        mode === 'escalate' ? 'escalate' : undefined,
      );
      if (mode === 'unknown-progress-admission')
        expect(stopped.progress.assessments[0]).toMatchObject({
          state: 'uncertain',
          submissionId: null,
          executionMs: null,
          result: null,
        });
      expect(stopped.repairs).toEqual([]);
      expect(listCodingRuns({}, paths)).toHaveLength(1);
      expect(postCount).toBe(0);
      for (let tick = 0; tick < 3; tick++)
        await advanceFactoryDelivery(pipelineId, paths, deliveryIO);
      expect(progressRequests).toHaveLength(1);
      expect(requireDelivery(pipelineId, paths).progress).toEqual(
        stopped.progress,
      );
      expect(listCodingRuns({}, paths)).toHaveLength(1);
      return;
    }
    await drive((p) => p.pr !== null);
    if (mode === 'repair' || mode === 'two-repairs') {
      const first = requireDelivery(pipelineId, paths);
      // Model the external current-head CI observation, then enter the real
      // durable feedback command and coordinator repair admission.
      const normalized = {
        headSha: first.commits.at(-1)!.publishedHeadSha,
        checks: [
          {
            name: 'synthetic-ci',
            status: 'completed',
            conclusion: 'failure',
          },
        ],
        statuses: [],
        reviews: [],
        inlineComments: [],
        issueComments: [],
      };
      const fingerprint = codingDigest(normalized);
      const feedback = {
        id: 'synthetic-ci',
        fingerprint,
        revision: first.revision,
        publishedHeadSha: normalized.headSha,
        ciFailed: true,
        hasReviewFeedback: false,
        evidenceRef: deliveryReceipt(
          pipelineId,
          {
            ...normalized,
            fingerprint,
            ciFailed: true,
            hasReviewFeedback: false,
            feedbackBody: JSON.stringify({
              reviews: normalized.reviews,
              inlineComments: normalized.inlineComments,
              issueComments: normalized.issueComments,
            }),
          },
          paths,
        ),
      };
      changeDelivery(pipelineId, { type: 'record-feedback', feedback }, paths);
      // Duplicate provider observation must preserve the same prospective repair.
      changeDelivery(pipelineId, { type: 'record-feedback', feedback }, paths);
      await drive(
        (p) =>
          p.revision.runId !== first.revision.runId &&
          p.effects.some(
            (e) =>
              e.kind === 'push' &&
              e.state === 'delivered' &&
              e.revision.runId === p.revision.runId,
          ),
      );
      expect(requireDelivery(pipelineId, paths).pr).toEqual(first.pr);
    }
    const delivered = requireDelivery(pipelineId, paths);
    const exposed = v.parse(
      deliveryDetailSchema,
      factoryDeliveryDetail(requireDelivery(pipelineId, paths), paths),
    ).pipeline;
    // The operator projection redacts local paths in progress instructions.
    // All admission identities and accounting must remain exactly durable.
    expect({ ...exposed, progress: delivered.progress }).toEqual(delivered);
    const identities = (p: DeliveryPipeline) =>
      p.progress.assessments.map(
        ({ instructions: _instructions, ...assessment }) => assessment,
      );
    expect(identities(exposed)).toEqual(identities(delivered));
    for (const assessment of exposed.progress.assessments) {
      expect(assessment.instructions.length).toBeGreaterThan(0);
      expect(assessment.instructions).not.toContain(homedir());
    }

    expect(postCount).toBe(1);
    expect(delivered.pr?.number).toBe(7);
    expect(delivered.effects.every((e) => e.state === 'delivered')).toBe(true);
    const check = delivered.evidence.findLast(
      (e) => e.kind === 'verification',
    )!;
    const review = delivered.evidence.findLast((e) => e.kind === 'review')!;
    expect(review.verificationEvidenceId).toBe(check.id);
    expect(review.verificationBundleDigest).toBe(check.bundleDigest);
    const checks = v.parse(
      v.object({ details: reviewerChecksSchema }),
      JSON.parse(readFileSync(check.evidenceRef, 'utf8')),
    ).details;
    expect(checks.checks[0].exitCode).toBe(0);
    expect(checks.noWriter).toBe(true);
    const checkOutput = readFileSync(checks.checks[0].evidenceRef!, 'utf8');
    expect(checkOutput).toContain('factory-publication-');
    expect(checkOutput).toContain('hasProviderSecret');
    if (provider) {
      const log = v.parse(candidateCheckLogSchema, JSON.parse(checkOutput));
      const checkProcess = v.parse(
        v.strictObject({
          cwd: v.string(),
          pid: v.number(),
          hasProviderSecret: v.boolean(),
        }),
        JSON.parse(log.stdout.trim()),
      );
      expect(checkProcess.hasProviderSecret).toBe(false);
      expect(log.environment?.policy).toBe('private-check-env-v1');
      expect(checkProcess.cwd).not.toBe(retained);
      expect(delivered.authorization.maxRepairAttempts).toBe(2);
      expect(delivered.authorization.totalExecutionMs).toBeLessThanOrEqual(
        10800000,
      );
      const budget = deliveryBudget(delivered);
      expect(budget.repairsUsed).toBe(1);
      expect(budget.repairsRemaining).toBe(1);
      expect(budget.consumedExecutionMs).toBeGreaterThan(
        delivered.authorization.initialExecutionMs,
      );
      expect(budget.remainingExecutionMs).toBeLessThan(
        delivered.authorization.totalExecutionMs,
      );
      expect(
        delivered.progress.assessments[0].reservedExecutionMs,
      ).toBeLessThanOrEqual(180000);
    }
    const publicationRoots = delivered.commits.map(
      (c) =>
        v.parse(
          v.object({ root: v.string() }),
          JSON.parse(readFileSync(c.evidenceRef, 'utf8')),
        ).root,
    );
    const publication = publicationRoots.at(-1)!;
    expect(readFileSync(hookLog, 'utf8').trim().split('\n')).toEqual(
      publicationRoots,
    );
    expect(git(publication, 'rev-parse', 'HEAD^{tree}')).toBe(
      delivered.revision.treeSha,
    );
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(retained, 'status', '--porcelain')).toBe(originalStatus);
    expect(
      readFileSync(git(retained, 'rev-parse', '--git-path', 'index')),
    ).toEqual(originalIndex);
    expect(delivered.repairs).toHaveLength(expectedRepairs);
    expect(listCodingRuns({}, paths)).toHaveLength(expectedRepairs + 1);
    expect(progressRequests).toHaveLength(expectedRepairs);
    expect(delivered.progress.assessments).toHaveLength(expectedRepairs);
    if (expectedRepairs > 0) {
      expect(delivered.progress.assessments[0]).toMatchObject({
        state: 'settled',
        repairOrdinal: 1,
        submissionId: 'progress-1',
        result: {
          decision: mode === 'change-approach' ? 'change-approach' : 'continue',
        },
      });
      if (mode === 'change-approach') {
        expect(delivered.repairs[0].reason).toContain(
          'alternate scoped approach',
        );
        const repairRun = requireCodingRun(delivered.repairs[0].runId, paths);
        expect(repairRun.attemptId).not.toBe(run.attemptId);
        expect(
          readFileSync(
            join(codingHandle(repairRun, paths).directory, 'prompt.txt'),
            'utf8',
          ),
        ).toContain(delivered.repairs[0].reason);
      }
      expect(delivered.revision.runId).not.toBe(run.runId);
      expect(
        delivered.evidence.filter((e) => e.kind === 'verification'),
      ).toHaveLength(expectedRepairs + 1);
      expect(delivered.authorization.id).toBe('grant-e2e');
    }
    if (mode === 'reviewer-findings') {
      const reviews = delivered.evidence.filter((e) => e.kind === 'review');
      expect(reviews.map((e) => e.result)).toEqual(['failed', 'passed']);
      const firstReceipt = v.parse(
        v.object({
          details: v.object({
            submissionId: v.string(),
            totalTokens: v.number(),
            durationMs: v.number(),
            findings: v.array(v.object({ description: v.string() })),
          }),
        }),
        JSON.parse(readFileSync(reviews[0].evidenceRef, 'utf8')),
      );
      expect(firstReceipt.details.totalTokens).toBe(20);
      expect(firstReceipt.details.findings[0].description).toContain(
        'fixed-v2',
      );
      expect(delivered.repairs[0].reason).toContain('fixed-v2');
      expect(delivered.authorization.id).toBe('grant-e2e');
    }
    if (mode === 'uncertain-create')
      expect(readsAfterPost).toBeGreaterThanOrEqual(2);
    if (mode === 'two-repairs') {
      expect(
        delivered.progress.assessments.map((a) => a.repairOrdinal),
      ).toEqual([1, 2]);
      expect(delivered.repairs.map((r) => r.status)).toEqual([
        'candidate',
        'candidate',
      ]);
      await deliveryIO.repair(
        delivered,
        'A third repair must not be admitted.',
        'third-repair',
        paths,
      );
      const exhausted = requireDelivery(pipelineId, paths);
      expect(exhausted.interventions.some((i) => i.kind === 'budget')).toBe(
        true,
      );
      expect(exhausted.progress.assessments).toHaveLength(2);
      expect(progressRequests).toHaveLength(2);
      expect(exhausted.repairs).toHaveLength(2);
      expect(listCodingRuns({}, paths)).toHaveLength(3);
    }
    if (provider) await assertAdapterAttempts(provider, paths, run);
    const revoked = await revokeFactoryDelivery(
      pipelineId,
      {
        expectedVersion: requireDelivery(pipelineId, paths).version,
        reason: 'Synthetic operator stop',
      },
      paths,
    );
    expect(revoked.pipeline.interventions).toContainEqual(
      expect.objectContaining({
        kind: 'authority',
        reason: 'Human revoked delivery: Synthetic operator stop',
        resolution: null,
      }),
    );
    // The first unresolved intervention retains projection priority.
    expect(revoked.nextAction).toBe(
      mode === 'two-repairs' ? 'human-budget' : 'human-authority',
    );
    expect(postCount).toBe(1);
  } finally {
    const active = getActiveCodingRun(paths);
    if (active?.host) handles.push(codingHandle(active, paths));
    for (const item of handles) {
      await cancelLocalAttempt(item);
      await until(async () => {
        const state = await inspectLocalAttempt(item);
        return state.state !== 'needs-reconcile' && state.receipt.noWriter;
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
async function until(
  check: () => Promise<boolean>,
  timeoutMs = 25000,
  describe = () => '',
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error(
        `Production delivery did not settle within fixture deadline: ${describe()}`,
      );
    await delay(100);
  }
}
