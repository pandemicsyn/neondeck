import {
  readCandidateReviewWithinDeadline,
  ReviewerTerminalError,
} from './modules/factory-delivery/reviewer-deadline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { start, sqlite } from '@flue/runtime/node';
import { dispatch, init } from '@flue/runtime';
import { FactoryReviewer } from './agents/factory-reviewer';
import { validateReviewerReply } from './modules/factory-delivery/reviewer';
import type { CandidateReviewRequest } from './modules/factory-delivery/reviewer-contract';
it.each(['complete', 'missing-diff', 'failed-read'] as const)(
  'settles real bounded Flue reviewer: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'factory-review-flue-'));
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', args, {
        cwd: root,
        encoding: 'utf8',
      }).trim();
    git(['init', '-q']);
    await writeFile(join(root, 'a.txt'), 'base\n');
    git(['add', '.']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'base',
    ]);
    const head = git(['rev-parse', 'HEAD']);
    const tree = git(['rev-parse', 'HEAD^{tree}']);
    const evidence = {
      root,
      attemptId: 'a',
      repoId: 'r',
      worktreeId: 'w',
      baseSha: head,
      headSha: head,
      revision: tree,
      treeSha: tree,
      evidenceDigest: 'a'.repeat(64),
      statusHash: 'b'.repeat(64),
      diffHash: 'c'.repeat(64),
      untrackedHash: 'd'.repeat(64),
    };
    const request: CandidateReviewRequest = {
      id: `review-${mode}`,
      model: 'faux/faux-1',
      brief: 'Verify the base file.',
      evidence,
      maxTokens: 16000,
      maxDurationMs: 10000,
      deadlineAt: Date.now() + 10000,
      thinkingLevel: 'medium',
      checks: {
        evidenceDigest: evidence.evidenceDigest,
        revision: tree,
        passed: true,
        noWriter: true,
        durationMs: 1,
        checks: [
          {
            command: 'npm test',
            passed: true,
            exitCode: 0,
            truncated: false,
            durationMs: 1,
            evidenceRef: '/private-fixture',
            outputHash: 'f'.repeat(64),
          },
        ],
      },
    };
    const review = {
      evidenceDigest: evidence.evidenceDigest,
      revision: tree,
      outcome: 'pass',
      summary: 'The bounded diff meets the brief.',
      findings: [],
    };
    const faux = fauxProvider();
    const contexts: string[] = [];
    const calls =
      mode === 'complete'
        ? [fauxToolCall('readCandidateDiff', {})]
        : [
            fauxToolCall('readCandidateFile', {
              path: mode === 'failed-read' ? '.env' : 'a.txt',
            }),
          ];
    faux.setResponses([
      (context) => {
        contexts.push(JSON.stringify(context));
        return fauxAssistantMessage(calls, { stopReason: 'toolUse' });
      },
      () =>
        fauxAssistantMessage([fauxToolCall('submitCandidateReview', review)], {
          stopReason: 'toolUse',
        }),
    ]);
    let flue = await start({
      agents: [FactoryReviewer],
      providers: [faux.provider],
      db: sqlite(join(root, 'review.db')),
    });
    try {
      const input = {
        id: request.id,
        initialData: request,
        idempotencyKey: `${request.id}:${tree}`,
        message: {
          kind: 'signal' as const,
          type: 'neondeck.factory.review',
          attributes: { evidenceDigest: evidence.evidenceDigest },
          body: 'Review the exact fixture.',
        },
      };
      const receipt = await dispatch(FactoryReviewer, input);
      if (mode === 'complete') {
        const reply = await init(FactoryReviewer, { id: request.id }).read(
          receipt,
        );
        expect(validateReviewerReply(reply, request).outcome).toBe('pass');
        expect(reply.metadata?.totalTokens).toBeGreaterThan(0);
        expect((await dispatch(FactoryReviewer, input)).submissionId).toBe(
          receipt.submissionId,
        );
        expect(faux.state.callCount).toBe(2);
        await flue.stop();
        flue = await start({
          agents: [FactoryReviewer],
          providers: [faux.provider],
          db: sqlite(join(root, 'review.db')),
        });
        expect(
          validateReviewerReply(
            await init(FactoryReviewer, { id: request.id }).read(
              receipt.submissionId,
            ),
            request,
          ).outcome,
        ).toBe('pass');
        expect(faux.state.callCount).toBe(2);
        expect(contexts[0]).toContain('npm test');
        expect(contexts[0]).not.toContain('/private-fixture');
        expect(contexts[0]).not.toContain('executeCode');
      } else {
        await expect(
          readCandidateReviewWithinDeadline(
            init(FactoryReviewer, { id: request.id }),
            receipt.submissionId,
            request,
          ),
        ).rejects.toBeInstanceOf(ReviewerTerminalError);
        await flue.stop();
        flue = await start({
          agents: [FactoryReviewer],
          providers: [faux.provider],
          db: sqlite(join(root, 'review.db')),
        });
        await expect(
          readCandidateReviewWithinDeadline(
            init(FactoryReviewer, { id: request.id }),
            receipt.submissionId,
            request,
          ),
        ).rejects.toMatchObject({
          terminalOutcome: 'failed',
          usageKnown: false,
        });
        expect(faux.state.callCount).toBe(2);
      }
    } finally {
      await flue.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('durably aborts a hung provider at the reserved deadline and reattaches without a new window', async () => {
  const {
    readCandidateReviewWithinDeadline,
    ReviewerTerminalError,
    ReviewerDeadlineError,
  } = await import('./modules/factory-delivery/reviewer-deadline');
  const root = await mkdtemp(join(tmpdir(), 'reviewer-hung-flue-'));
  const evidence = {
    root,
    attemptId: 'a',
    repoId: 'r',
    worktreeId: 'w',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    treeSha: 'c'.repeat(40),
    revision: 'c'.repeat(40),
    evidenceDigest: 'd'.repeat(64),
    statusHash: 'e'.repeat(64),
    diffHash: 'f'.repeat(64),
    untrackedHash: '0'.repeat(64),
  };
  const request: CandidateReviewRequest = {
    id: 'hung-review',
    model: 'faux/faux-1',
    thinkingLevel: 'medium',
    evidence,
    brief: 'Bounded fixture',
    maxTokens: 16000,
    maxDurationMs: 500,
    deadlineAt: Date.now() + 500,
    checks: {
      evidenceDigest: evidence.evidenceDigest,
      revision: evidence.revision,
      passed: true,
      noWriter: true,
      durationMs: 1,
      checks: [
        {
          command: 'npm test',
          passed: true,
          exitCode: 0,
          truncated: false,
          durationMs: 1,
          evidenceRef: '/private-fixture',
          outputHash: '1'.repeat(64),
        },
      ],
    },
  };
  const started = Promise.withResolvers<void>();
  const release =
    Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  const faux = fauxProvider();
  faux.setResponses([
    () => {
      started.resolve();
      return release.promise;
    },
  ]);
  let flue = await start({
    agents: [FactoryReviewer],
    providers: [faux.provider],
    db: sqlite(join(root, 'review.db')),
  });
  try {
    const receipt = await dispatch(FactoryReviewer, {
      id: request.id,
      initialData: request,
      message: {
        kind: 'signal',
        type: 'neondeck.factory.review',
        attributes: { evidenceDigest: evidence.evidenceDigest },
        body: 'Review',
      },
    });
    await started.promise;
    const error = await readCandidateReviewWithinDeadline(
      init(FactoryReviewer, { id: request.id }),
      receipt.submissionId,
      request,
    ).catch((error) => error);
    expect(
      error instanceof ReviewerTerminalError ||
        error instanceof ReviewerDeadlineError,
    ).toBe(true);
    expect(Date.now() - request.deadlineAt).toBeLessThan(1500);
    release.resolve(fauxAssistantMessage('Late output cannot certify.'));
    await flue.stop();
    flue = await start({
      agents: [FactoryReviewer],
      providers: [faux.provider],
      db: sqlite(join(root, 'review.db')),
    });
    const recovered = await readCandidateReviewWithinDeadline(
      init(FactoryReviewer, { id: request.id }),
      receipt.submissionId,
      JSON.parse(JSON.stringify(request)),
    ).catch((error) => error);
    expect(
      recovered instanceof ReviewerTerminalError ||
        recovered instanceof ReviewerDeadlineError,
    ).toBe(true);
    expect(faux.state.callCount).toBe(1);
  } finally {
    release.resolve(fauxAssistantMessage('Stopped'));
    await flue.stop();
    await rm(root, { recursive: true, force: true });
  }
});
