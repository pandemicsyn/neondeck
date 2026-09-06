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
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
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

it.each([
  'complete',
  'repair',
  'uncertain-create',
  'prepublish-repair',
  'reviewer-findings',
] as const)(
  'production candidate-to-draft integration: %s',
  async (mode) => {
    const expectsRepair =
      mode.includes('repair') || mode === 'reviewer-findings';
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
        `const fs=require('node:fs'); console.log(JSON.stringify({cwd:process.cwd(),pid:process.pid,hasProviderSecret:'FACTORY_DELIVERY_AUTH' in process.env})); if(!fs.readFileSync('mockdex-result.txt','utf8').includes('deterministic')) process.exit(2); if(${mode === 'prepublish-repair' ? "fs.readFileSync('state.txt','utf8') !== 'fixed-v2'" : "!fs.readFileSync('state.txt','utf8').startsWith('fixed')"}) process.exit(3);`,
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
      const executable = join(root, 'codex-fixture.mjs');
      writeFileSync(
        executable,
        `#!/usr/bin/env node
import {writeFileSync,existsSync,unlinkSync} from 'node:fs';import {spawn} from 'node:child_process';
if(process.argv[2]==='--version') console.log('codex-cli 0.150.1');
else {let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const repair=prompt.includes('This is a bounded repair');
if(repair&&existsSync('mockdex-result.txt'))unlinkSync('mockdex-result.txt');
writeFileSync('state.txt',repair?'fixed-v2':'fixed');
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
            model: 'test-model',
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
            scope: 'mockdex-result.txt and state.txt',
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
          const request = v.parse(
            candidateReviewRequestSchema,
            raw.initialData,
          );
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
            const request = requests.findLast((r) => r.id === options.id)!;
            expect(request).toBeDefined();
            const p = requireDelivery(pipelineId, paths);
            const effect = p.effects.findLast((e) => e.kind === 'review')!;
            expect(
              readFileSync(
                deliveryIntentPath(
                  pipelineId,
                  `${effect.id}:submission`,
                  paths,
                ),
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
            if (
              unchanged > 3 &&
              !p.repairs.some((r) => r.status === 'reserved')
            )
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
            if (p.interventions.length)
              throw new Error(JSON.stringify(p.interventions));
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
          90000,
          () => JSON.stringify(requireDelivery(pipelineId, paths)),
        );
      }
      await drive((p) => p.pr !== null);
      if (mode === 'repair') {
        const first = requireDelivery(pipelineId, paths);
        // Model the external current-head CI observation, then enter the real
        // durable feedback command and coordinator repair admission.
        const feedback = {
          id: 'synthetic-ci',
          fingerprint: '8'.repeat(64),
          revision: first.revision,
          publishedHeadSha: first.commits.at(-1)!.publishedHeadSha,
          ciFailed: true,
          hasReviewFeedback: false,
          evidenceRef: deliveryReceipt(
            pipelineId,
            {
              feedbackBody: 'Scoped state file must use fixed-v2.',
              checks: [
                {
                  name: 'synthetic-ci',
                  status: 'completed',
                  conclusion: 'failure',
                },
              ],
              statuses: [],
            },
            paths,
          ),
        };
        changeDelivery(
          pipelineId,
          { type: 'record-feedback', feedback },
          paths,
        );
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
      expect(
        v.parse(
          deliveryDetailSchema,
          factoryDeliveryDetail(requireDelivery(pipelineId, paths), paths),
        ).pipeline,
      ).toEqual(delivered);
      expect(postCount).toBe(1);
      expect(delivered.pr?.number).toBe(7);
      expect(delivered.effects.every((e) => e.state === 'delivered')).toBe(
        true,
      );
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
      expect(delivered.repairs).toHaveLength(expectsRepair ? 1 : 0);
      expect(listCodingRuns({}, paths)).toHaveLength(expectsRepair ? 2 : 1);
      if (expectsRepair) {
        expect(delivered.revision.runId).not.toBe(run.runId);
        expect(
          delivered.evidence.filter((e) => e.kind === 'verification'),
        ).toHaveLength(2);
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
      const revoked = await revokeFactoryDelivery(
        pipelineId,
        {
          expectedVersion: delivered.version,
          reason: 'Synthetic operator stop',
        },
        paths,
      );
      expect(revoked.nextAction).toBe('human-authority');
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
  },
  180000,
);
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
