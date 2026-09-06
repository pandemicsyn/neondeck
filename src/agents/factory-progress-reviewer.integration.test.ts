import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { start, sqlite } from '@flue/runtime/node';
import { FactoryProgressReviewer } from './factory-progress-reviewer';
import {
  reviewFactoryProgress,
  recoverExistingFactoryProgress,
} from '../modules/factory-delivery/progress-reviewer';
import { snapshotProgressEvidence } from '../modules/factory-delivery/progress-evidence-contract';
import {
  progressReviewInputDigest,
  validateProgressRequest,
} from '../modules/factory-delivery/progress-reviewer-contract';

// Real Flue persistence, tools and production adapter; only the model is fake.
// These cases establish bounded wiring, not the quality of model judgment.
it.each([
  'continue',
  'change-approach',
  'escalate',
  'malformed',
  'missing-evidence',
  'text-only',
  'multiple-tools',
  'unknown-tool',
  'provider-error',
] as const)(
  'real progress runtime settles or fails closed and reattaches: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'factory-progress-flue-'));
    vi.stubEnv('NEONDECK_HOME', root);
    const revision = {
      runId: 'run',
      attemptId: 'attempt',
      releaseId: 'release',
      specVersion: 1,
      specHash: 'a'.repeat(64),
      candidateDigest: 'b'.repeat(64),
      baseSha: 'c'.repeat(40),
      headSha: 'd'.repeat(40),
      treeSha: 'e'.repeat(40),
    };
    const packet = snapshotProgressEvidence({
      version: 1,
      grantId: 'grant',
      requestId: 'repair-one',
      revision,
      repairOrdinal: 1,
      releasedBrief: 'Fix the state value; preserve the check assertions.',
      proposedInstructions: 'Change state.txt to fixed-v2.',
      candidates: [
        {
          revision,
          diff:
            mode === 'missing-evidence'
              ? null
              : 'diff --git a/state.txt b/state.txt\n-old\n+fixed\n',
          observations: [
            {
              ref: 'check-one',
              kind: 'verification',
              body: 'state should equal fixed-v2; observed fixed',
              fingerprint: 'f'.repeat(64),
            },
          ],
        },
      ],
      priorRepairs: [],
      remainingBudget: { durationMs: 180000, repairs: 2 },
      missingEvidence:
        mode === 'missing-evidence' ? ['Current diff unavailable'] : [],
      omittedEvidence: [],
    });
    const request = validateProgressRequest({
      id: `progress-${mode}`,
      binding: {
        assessmentId: 'assessment',
        grantId: packet.grantId,
        revision,
        repairOrdinal: 1,
        requestId: packet.requestId,
        inputDigest: progressReviewInputDigest(packet, 'faux/faux-1', 'medium'),
        evidenceDigest: '0'.repeat(64),
      },
      model: 'faux/faux-1',
      thinkingLevel: 'medium',
      packet,
      maxDurationMs: 10000,
      deadlineAt: Date.now() + 10000,
      maxTokens: 16000,
    });
    const verdict = {
      ...request.binding,
      decision:
        mode === 'change-approach'
          ? 'change-approach'
          : mode === 'escalate'
            ? 'escalate'
            : 'continue',
      rationale:
        mode === 'malformed'
          ? 'x'.repeat(4001)
          : 'The current check identifies a scoped next step.',
      evidenceRefs: [`candidate:${revision.candidateDigest}`, 'check-one'],
      nextInstructions:
        mode === 'change-approach'
          ? 'Update state.txt directly while retaining assertions.'
          : null,
    };
    const faux = fauxProvider();
    const contexts: string[] = [];
    faux.setResponses([
      (context) => {
        contexts.push(JSON.stringify(context));
        if (mode === 'provider-error')
          return fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: '429 rate limit: synthetic transient provider error',
          });
        if (mode === 'text-only')
          return fauxAssistantMessage(
            'A freeform answer is not a bound verdict.',
          );
        return fauxAssistantMessage(
          mode === 'multiple-tools'
            ? [
                fauxToolCall('submitProgressReview', verdict),
                fauxToolCall('submitProgressReview', verdict),
              ]
            : [
                fauxToolCall(
                  mode === 'unknown-tool'
                    ? 'executeCode'
                    : 'submitProgressReview',
                  verdict,
                ),
              ],
          { stopReason: 'toolUse' },
        );
      },
    ]);
    let flue = await start({
      agents: [FactoryProgressReviewer],
      providers: [faux.provider],
      db: sqlite(join(root, 'progress.db')),
    });
    let submissionId = '';
    let authorityChecks = 0;
    const valid = ['continue', 'change-approach', 'escalate'].includes(mode);
    try {
      const result = reviewFactoryProgress(request, {
        onDispatched: async (id) => {
          submissionId = id;
        },
        assertAuthority: () => {
          authorityChecks++;
        },
      });
      if (valid) {
        await expect(result).resolves.toMatchObject({
          decision: mode,
          submissionId: expect.any(String),
          totalTokens: expect.any(Number),
        });
      } else await expect(result).rejects.toThrow();
      expect(submissionId).not.toBe('');
      expect(faux.state.callCount).toBe(1);
      expect(authorityChecks).toBeGreaterThanOrEqual(2);
      expect(contexts[0]).toContain('submitProgressReview');
      expect(contexts[0]).toContain('check-one');
      expect(contexts[0]).not.toContain('executeCode');
      await flue.stop();
      flue = await start({
        agents: [FactoryProgressReviewer],
        providers: [faux.provider],
        db: sqlite(join(root, 'progress.db')),
      });
      const recovered = recoverExistingFactoryProgress(
        JSON.parse(JSON.stringify(request)),
        submissionId,
      );
      if (valid)
        await expect(recovered).resolves.toMatchObject({
          decision: mode,
          submissionId,
        });
      else await expect(recovered).rejects.toThrow();
      expect(faux.state.callCount).toBe(1);
      await expect(
        reviewFactoryProgress(request, {
          onDispatched: async () => {
            throw new Error('Duplicate must not mint a receipt');
          },
          assertAuthority: () => {},
        }),
      ).rejects.toThrow();
      expect(faux.state.callCount).toBe(1);
      await expect(recoverExistingFactoryProgress(request, '')).rejects.toThrow(
        /Unknown progress admission/,
      );
      expect(faux.state.callCount).toBe(1);
    } finally {
      await flue.stop();
      await rm(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  20000,
);
