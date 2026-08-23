import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import {
  assertPrReviewEvalContracts,
  loadPrReviewEvalFixture,
  runPrReviewEval,
  writePrReviewEvalReport,
} from './harness';
import { prReviewEvalScenarios } from './scenarios';

const execFileAsync = promisify(execFile);

it('defines the complete immutable PR-review scenario catalog', () => {
  expect(prReviewEvalScenarios.map((scenario) => scenario.id)).toEqual([
    'trivial-single-file',
    'small-coupled-change',
    'independent-domains',
    'named-path-or-symbol',
    'explorer-finds-issue',
    'explorer-no-issue',
    'insufficient-evidence',
    'second-wave-threshold',
    'clean-multi-domain',
    'inline-anchor-discipline',
    'security-conclusion',
    'follow-up-reviewer',
  ]);
  expect(Object.isFrozen(prReviewEvalScenarios)).toBe(true);
});

it('derives parallel task batches and validates the submitted review contract', () => {
  const contracts = assertPrReviewEvalContracts({
    fixture: {
      schema: 'neondeck.pr-review-eval-fixture.v1',
      scenario: 'independent-domains',
      immutableRevision: {
        repoPath: '/fixtures/independent-domains',
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        mergeBase: 'b'.repeat(40),
      },
      initialData: {},
    },
    provider: 'example',
    startedAt: '2026-08-20T00:00:00.000Z',
    finishedAt: '2026-08-20T00:00:01.000Z',
    outcome: 'completed',
    error: null,
    replyText: '',
    finalReview: {
      overview: {
        recommendation: 'needs-human',
        recommendationReason:
          'Two independent domains require a human to confirm their interaction.',
        summary: 'Reviewed two independent domains.',
        changeMap: [],
        risks: [],
      },
      findings: [],
    },
    toolCalls: [
      { name: 'task', input: { prompt: 'Question: inspect domain A' } },
      { name: 'task', input: { prompt: 'Question: inspect domain B' } },
    ],
    observations: [
      { type: 'task_start', taskId: 'a', prompt: 'A', turnId: 'wave-1' },
      { type: 'task_start', taskId: 'b', prompt: 'B', turnId: 'wave-1' },
    ] as never,
    promptHashes: [],
    models: [],
  });

  expect(contracts).toMatchObject({
    finalReviewValid: true,
    taskCount: 2,
    taskWaveCount: 1,
    hasParallelTaskWave: true,
  });
});

it('proves fixture commits and their declared merge base with Git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neondeck-pr-review-eval-git-'));
  try {
    const repoPath = join(root, 'repo');
    await execFileAsync('git', ['init', repoPath]);
    const sourcePath = join(repoPath, 'source.ts');
    await writeFile(sourcePath, 'export const value = 1;\n');
    await execFileAsync('git', ['-C', repoPath, 'add', 'source.ts']);
    await execFileAsync('git', [
      '-C',
      repoPath,
      '-c',
      'user.name=Neondeck Eval',
      '-c',
      'user.email=eval@neondeck.test',
      'commit',
      '-m',
      'base',
    ]);
    const baseSha = await gitSha(repoPath, 'HEAD');
    await writeFile(sourcePath, 'export const value = 2;\n');
    await execFileAsync('git', ['-C', repoPath, 'add', 'source.ts']);
    await execFileAsync('git', [
      '-C',
      repoPath,
      '-c',
      'user.name=Neondeck Eval',
      '-c',
      'user.email=eval@neondeck.test',
      'commit',
      '-m',
      'head',
    ]);
    const headSha = await gitSha(repoPath, 'HEAD');
    const fixturePath = join(root, 'fixture.json');
    const fixture = evalFixture({ repoPath, headSha, baseSha });
    await writeFile(fixturePath, JSON.stringify(fixture));

    await expect(loadPrReviewEvalFixture(fixturePath)).resolves.toMatchObject({
      immutableRevision: { headSha, baseSha, mergeBase: baseSha },
    });

    const invalid = evalFixture({
      repoPath,
      headSha,
      baseSha,
      mergeBase: headSha,
    });
    await writeFile(fixturePath, JSON.stringify(invalid));
    await expect(loadPrReviewEvalFixture(fixturePath)).rejects.toThrow(
      'Git repository does not prove its declared immutable revision: mergeBase',
    );

    const mismatchedPreparedBase = evalFixture({
      repoPath,
      headSha,
      baseSha,
    });
    mismatchedPreparedBase.initialData.prepared.input.baseSha = headSha;
    await writeFile(fixturePath, JSON.stringify(mismatchedPreparedBase));
    await expect(loadPrReviewEvalFixture(fixturePath)).rejects.toThrow(
      'immutable revision does not match initial data: prepared.input.baseSha',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function evalFixture(input: {
  repoPath: string;
  headSha: string;
  baseSha: string;
  mergeBase?: string;
}) {
  const mergeBase = input.mergeBase ?? input.baseSha;
  return {
    schema: 'neondeck.pr-review-eval-fixture.v1',
    scenario: 'trivial-single-file',
    immutableRevision: { ...input, mergeBase },
    initialData: {
      schema: 'neondeck.pr-review-agent-context.v2',
      model: 'example/reviewer',
      thinkingLevel: 'medium',
      exploreModel: 'example/explore',
      exploreThinkingLevel: 'medium',
      instructions: 'Review this immutable fixture.',
      prepared: {
        input: { headSha: input.headSha, baseSha: input.baseSha },
        facts: {},
        promptContext: {},
      },
      workspace: {
        available: true,
        repoId: 'eval-repo',
        repoFullName: 'eval/repo',
        repoPath: input.repoPath,
        headSha: input.headSha,
        baseSha: input.baseSha,
        mergeBase,
      },
      prompt: '{"task":"Review the immutable fixture."}',
    },
  };
}

async function gitSha(repoPath: string, revision: string) {
  const { stdout } = await execFileAsync('git', [
    '-C',
    repoPath,
    'rev-parse',
    revision,
  ]);
  return stdout.trim();
}

const fixturePath = process.env.NEONDECK_PR_REVIEW_EVAL_FIXTURE;
const provider = process.env.NEONDECK_PR_REVIEW_EVAL_PROVIDER;

it.runIf(Boolean(fixturePath && provider))(
  'runs a live immutable PR-review fixture',
  async () => {
    if (!fixturePath || !provider) {
      throw new Error(
        'Set NEONDECK_PR_REVIEW_EVAL_FIXTURE and NEONDECK_PR_REVIEW_EVAL_PROVIDER.',
      );
    }
    const fixture = await loadPrReviewEvalFixture(fixturePath);
    const run = await runPrReviewEval({ fixture, provider });
    const reportPath = await writePrReviewEvalReport(
      run,
      process.env.NEONDECK_PR_REVIEW_EVAL_REPORT,
    );
    const contracts = assertPrReviewEvalContracts(run);

    expect(reportPath).toMatch(/\.json$/);
    expect(run.outcome).toBe('completed');
    expect(run.error).toBeNull();
    expect(contracts.finalReviewValid).toBe(true);
    expect(contracts.providerMatchesExpected).toBe(true);
    expect(
      contracts.scenario.delegation !== 'none' || contracts.taskCount === 0,
    ).toBe(true);
    expect(
      contracts.scenario.delegation !== 'zero-or-one' ||
        contracts.taskCount <= 1,
    ).toBe(true);
    expect(
      contracts.scenario.delegation !== 'parallel' ||
        contracts.hasParallelTaskWave,
    ).toBe(true);
  },
);
