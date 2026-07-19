import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  prAutopilotOwnerCompaction,
  prAutopilotOwnerDurability,
} from './modules/autopilot/owner/config';
import {
  admitAutopilotEvent,
  coordinateAutopilotAdmission,
  reconcileAutopilotStageAttempts,
  recordAutopilotOwnerTerminalObservation,
  submitAutopilotFix,
  stopAutopilotAdmission,
} from './modules/autopilot';
import { readAutopilotPrOwnerByWatch } from './modules/autopilot/owners';
import { classifyAutopilotOwnerConfigChange } from './modules/autopilot/owner/grounding';
import { runScopedOwnerRead } from './modules/autopilot/owner/actions';
import { fixPrReviewFeedback } from './modules/autopilot/review-feedback';
import { runAutopilotDiagnostics } from './modules/autopilot/github-facts';
import { updateLearningConfig } from './modules/config';
import { readStaleReasonChanges } from './modules/sessions/stale-reasons';
import { readAutopilotOwnerCapabilitySnapshot } from './modules/autopilot/owner/capabilities';
import { ensureAutopilotOwnerInstanceInDatabase } from './modules/autopilot/owner/instance';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';

const limits = {
  maxAutonomousJobs: 4,
  maxActiveWorkflowRuns: 4,
  maxPerRepoAutonomousJobs: 4,
  singleMutationPerPr: true,
  localExecutionLimit: 1,
};
const execFileAsync = promisify(execFile);

const facts = {
  pullRequest: { headSha: 'abc123', title: 'Fixture PR', state: 'OPEN' },
  review: {
    comments: [
      { id: 'comment:1', path: 'src/fix.ts', body: 'Handle the edge.' },
    ],
    reviewsTruncated: false,
    reviewThreadsTruncated: false,
    reviewCommentsTruncated: false,
  },
  checks: { failed: 1, pending: 0, truncated: false },
  failingChecks: [
    { id: 7, name: 'unit', log: { available: true, text: 'fixture failure' } },
  ],
};

describe('Package 4 continuing PR owner', () => {
  it.each([
    ['config_update_agent_models', 'models', 'rotate'],
    ['config_update_provider', 'providers.openai', 'rotate'],
    ['config_update_skill_roots', 'skillRoots', 'rotate'],
    ['config_update_soul', 'soul', 'rotate'],
    ['config_update_repo_autopilot_policy', 'repo', 'reground'],
    ['config_update_execution_policy', 'execution', 'reground'],
    ['config_update_repo_autopilot_policy', 'other-repo', 'none'],
    ['config_update_dashboard_layout', 'layout', 'none'],
    ['config_update_handoff', 'handoff', 'none'],
    ['config_add_repo', 'repo', 'block'],
    ['config_update_repo', 'repo', 'block'],
    ['config_remove_repo', 'repo', 'block'],
    ['config_future_unknown', 'mystery', 'block'],
  ] as const)('classifies %s/%s drift as %s', (action, target, expected) => {
    expect(classifyAutopilotOwnerConfigChange({ action, target }, 'repo')).toBe(
      expected,
    );
  });

  it('uses one durable instance/worktree across restart and re-grounds repo policy plus selected memory in place', async () => {
    await withFixture(
      async (paths) => {
        seedPreparedTurn(
          paths,
          'admission:one',
          'event:one',
          1,
          'autofix-with-approval',
        );
        const first = await dispatchTurn(
          paths,
          'admission:one',
          'dispatch:one',
        );
        const firstEnvelope = first.envelope;
        expect(firstEnvelope.workspace.worktreeId).toBe('worktree:one');
        expect(firstEnvelope.request.current).not.toHaveProperty('patch');
        const firstInstance = firstEnvelope.identity.instanceId;

        const fixed = await submitAutopilotFix(
          submissionFromEnvelope(firstEnvelope, {
            disposition: 'fix',
            fixerKind: 'review',
            replacements: [
              {
                path: 'src/fix.ts',
                oldString: 'old',
                newString: 'new',
              },
            ],
            summary: 'Address the review edge.',
          }),
          paths,
          {
            currentSha: async () => 'abc123',
            readLiveHead: async () => 'abc123',
            runReviewFix: async () =>
              ({
                ok: true,
                action: 'autopilot_fix_pr_review_feedback',
                changed: true,
                message: 'Prepared fixture diff.',
                data: { preparedDiff: { id: 'prepared:one' } },
              }) as never,
          },
        );
        expect(fixed).toMatchObject({ ok: true, changed: true });
        const duplicate = await submitAutopilotFix(
          submissionFromEnvelope(firstEnvelope, {
            disposition: 'no-op',
            summary: 'A second submission must be rejected.',
          }),
          paths,
          { currentSha: async () => 'abc123', readLiveHead: liveFixtureHead },
        );
        expect(duplicate).toMatchObject({ ok: false });
        await recordAutopilotOwnerTerminalObservation(
          terminal(firstEnvelope, 'dispatch:one'),
          paths,
        );

        const changedAt = '2026-07-19T18:00:00.000Z';
        const database = new DatabaseSync(paths.neondeckDatabase);
        try {
          database
            .prepare(
              `INSERT INTO config_history (action, file, target, before_json, after_json, changed_at)
             VALUES ('config_update_repo_autopilot_policy', 'repos.json', 'repo', '{}', ?, ?);`,
            )
            .run(
              JSON.stringify({
                repos: [
                  {
                    id: 'repo',
                    github: { owner: 'example', name: 'repo' },
                    path: '/fixture/primary',
                    defaultBranch: 'main',
                    metadata: { autopilot: { mode: 'prepare-only' } },
                  },
                ],
              }),
              changedAt,
            );
          database
            .prepare(
              `INSERT INTO memories (
               id, scope, key, value_json, repo_id, status, use_count, created_at, updated_at
             ) VALUES ('memory:selected', 'project', 'review-style', '"minimal"', 'repo', 'active', 0, ?, ?);`,
            )
            .run(changedAt, changedAt);
          database
            .prepare(
              `INSERT INTO memory_events (
               id, memory_id, action, actor, after_json, created_at
             ) VALUES ('memory-event:selected', 'memory:selected', 'learned', 'user', ?, ?);`,
            )
            .run(
              JSON.stringify({ scope: 'project', key: 'review-style' }),
              changedAt,
            );
        } finally {
          database.close();
        }
        await writeRepoMode(paths, 'prepare-only');

        // A fresh dependency closure simulates restart while the app DB remains.
        seedPreparedTurn(
          paths,
          'admission:two',
          'event:two',
          2,
          'autofix-with-approval',
        );
        const second = await dispatchTurn(
          paths,
          'admission:two',
          'dispatch:two',
        );
        expect(second.envelope.identity.instanceId).toBe(firstInstance);
        expect(second.envelope.workspace.worktreeId).toBe('worktree:one');
        expect(second.envelope.grounding.kind).toBe('reground');
        expect(second.envelope.grounding.reasons).toEqual(
          expect.arrayContaining([
            'config_update_repo_autopilot_policy:repo',
            'memory:memory:selected',
            'selected-memory:memory:selected',
          ]),
        );
        expect(second.envelope.grounding.selectedMemoryIds).toContain(
          'memory:selected',
        );
        const secondSubmit = await submitAutopilotFix(
          submissionFromEnvelope(second.envelope, {
            disposition: 'fix',
            fixerKind: 'review',
            replacements: [
              {
                path: 'src/fix.ts',
                oldString: 'new',
                newString: 'newer',
              },
            ],
            summary: 'Address the second feedback event.',
          }),
          paths,
          {
            currentSha: async () => 'abc123',
            readLiveHead: async () => 'abc123',
            runReviewFix: async () =>
              ({
                ok: true,
                action: 'autopilot_fix_pr_review_feedback',
                changed: true,
                message: 'Updated fixture diff.',
                data: { preparedDiff: { id: 'prepared:two' } },
              }) as never,
          },
        );
        expect(secondSubmit).toMatchObject({ ok: true, changed: true });
        await recordAutopilotOwnerTerminalObservation(
          terminal(second.envelope, 'dispatch:two'),
          paths,
        );
        expect(readAdmission(paths, 'admission:one').prepared_diff_id).toBe(
          'prepared:one',
        );
        expect(readAdmission(paths, 'admission:two').prepared_diff_id).toBe(
          'prepared:two',
        );

        const owner = await readAutopilotPrOwnerByWatch('watch:one', paths);
        expect(owner).toMatchObject({
          flueInstanceId: firstInstance,
          generation: 1,
          worktreeId: 'worktree:one',
          groundingMemoryIds: ['memory:selected'],
          lastDispatchedSequence: 2,
          lastSettledSequence: 2,
        });
        const audit = readRows(paths, 'autopilot_owner_grounding_snapshots');
        expect(audit).toHaveLength(2);
        expect(audit.every((row) => row.status === 'accepted')).toBe(true);
      },
      { mode: 'autofix-with-approval' },
    );
  });

  it('creates then updates a real prepared diff across two continuing feedback turns', async () => {
    await withGitFixture(async ({ paths, headSha, worktreePath }) => {
      seedPreparedTurn(
        paths,
        'admission:real-one',
        'event:real-one',
        1,
        'autofix-with-approval',
      );
      const first = await dispatchGitTurn(
        paths,
        'admission:real-one',
        'dispatch:real-one',
        headSha,
      );
      const scopedRead = await runScopedOwnerRead(
        {
          attemptId: first.envelope.identity.attemptId,
          token: first.envelope.capabilities.reads.token,
          path: 'src/fix.ts',
        },
        'file',
        paths,
      );
      expect(scopedRead).toMatchObject({ ok: true, content: 'old\n' });
      const attemptedScopeOverride = await runScopedOwnerRead(
        {
          attemptId: first.envelope.identity.attemptId,
          token: first.envelope.capabilities.reads.token,
          repoId: 'other-repo',
          path: 'src/fix.ts',
        },
        'file',
        paths,
      );
      expect(attemptedScopeOverride).toMatchObject({ ok: false });
      const firstResult = await submitAutopilotFix(
        submissionFromEnvelope(first.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          addressedReviewCommentIds: ['comment:1'],
          addressedReviewThreadIds: ['thread:1'],
          replacements: [
            { path: 'src/fix.ts', oldString: 'old\n', newString: 'middle\n' },
            { path: 'src/fix.ts', oldString: 'middle\n', newString: 'new\n' },
          ],
          summary: 'Apply first deterministic review fix.',
        }),
        paths,
        realReviewDependencies(headSha, 'comment:1'),
      );
      expect(firstResult).toMatchObject({
        ok: true,
        changed: true,
      });
      const persistedSubmission = String(
        readRows(paths, 'autopilot_owner_fix_submissions')[0]?.result_json,
      );
      expect(persistedSubmission).not.toContain('oldString');
      expect(persistedSubmission).not.toContain('middle');
      expect(persistedSubmission).not.toContain('diffSummary');
      await recordAutopilotOwnerTerminalObservation(
        terminal(first.envelope, 'dispatch:real-one'),
        paths,
      );
      const firstPreparedId = String(
        readAdmission(paths, 'admission:real-one').prepared_diff_id,
      );
      expect(firstPreparedId).not.toBe('null');

      await writeRepoModeAtPath(
        paths,
        'prepare-only',
        join(paths.home, 'primary'),
      );
      insertConfig(paths, 'config_update_repo_autopilot_policy', 'repo');
      seedPreparedTurn(
        paths,
        'admission:real-two',
        'event:real-two',
        2,
        'autofix-with-approval',
      );
      const second = await dispatchGitTurn(
        paths,
        'admission:real-two',
        'dispatch:real-two',
        headSha,
      );
      expect(second.envelope.identity.instanceId).toBe(
        first.envelope.identity.instanceId,
      );
      expect(second.envelope.workspace.localPath).toBe(worktreePath);
      expect(second.envelope.policy).toMatchObject({
        effectiveMode: 'prepare-only',
        localCommit: false,
      });
      const secondResult = await submitAutopilotFix(
        submissionFromEnvelope(second.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          addressedReviewCommentIds: ['comment:2'],
          addressedReviewThreadIds: ['thread:2'],
          replacements: [
            { path: 'src/fix.ts', oldString: 'new\n', newString: 'newer\n' },
          ],
          summary: 'Apply second deterministic review fix.',
        }),
        paths,
        realReviewDependencies(headSha, 'comment:2'),
      );
      expect(secondResult).toMatchObject({ ok: true, changed: true });
      await recordAutopilotOwnerTerminalObservation(
        terminal(second.envelope, 'dispatch:real-two'),
        paths,
      );
      expect(String(await readFile(join(worktreePath, 'src/fix.ts')))).toBe(
        'newer\n',
      );
      expect(readRows(paths, 'prepared_diffs').length).toBeGreaterThan(0);
      expect(
        readAdmission(paths, 'admission:real-two').prepared_diff_id,
      ).toBeTruthy();
    });
  }, 30_000);

  it('blocks unknown config without advancing baseline and rotates on fundamental capability drift with audited handoff', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:one', 'event:one', 1);
      const first = await dispatchTurn(paths, 'admission:one', 'dispatch:one');
      await submitAutopilotFix(
        submissionFromEnvelope(first.envelope, {
          disposition: 'no-op',
          summary: 'Baseline established.',
        }),
        paths,
        syntheticNoOpDependencies(first.envelope),
      );
      await recordAutopilotOwnerTerminalObservation(
        terminal(first.envelope, 'dispatch:one'),
        paths,
      );
      const baseline = (await readAutopilotPrOwnerByWatch('watch:one', paths))!
        .groundingConfigHistoryId;
      insertConfig(paths, 'config_future_unknown', 'mystery');
      seedPreparedTurn(paths, 'admission:unknown', 'event:unknown', 2);
      const unknownDispatch = vi.fn<() => Promise<never>>();
      const unknown = await coordinateAutopilotAdmission(
        coordinationInput('admission:unknown', unknownDispatch),
        paths,
      );
      expect(unknown.dispatched?.status).toBe('blocked');
      expect(unknownDispatch).not.toHaveBeenCalled();
      expect(
        (await readAutopilotPrOwnerByWatch('watch:one', paths))!
          .groundingConfigHistoryId,
      ).toBe(baseline);
    });

    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:one', 'event:one', 1);
      const first = await dispatchTurn(paths, 'admission:one', 'dispatch:one');
      await submitAutopilotFix(
        submissionFromEnvelope(first.envelope, {
          disposition: 'no-op',
          summary: 'Baseline established.',
        }),
        paths,
        syntheticNoOpDependencies(first.envelope),
      );
      await recordAutopilotOwnerTerminalObservation(
        terminal(first.envelope, 'dispatch:one'),
        paths,
      );
      insertConfig(paths, 'config_update_agent_models', 'models');
      seedPreparedTurn(paths, 'admission:rotated', 'event:rotated', 2);
      const rotated = await dispatchTurn(
        paths,
        'admission:rotated',
        'dispatch:rotated',
      );
      expect(rotated.envelope.identity.instanceId).not.toBe(
        first.envelope.identity.instanceId,
      );
      expect(rotated.envelope.identity.generation).toBe(2);
      const generations = readRows(paths, 'autopilot_owner_generations');
      expect(generations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'archived',
            rotation_reason: expect.stringContaining(
              'config_update_agent_models',
            ),
          }),
          expect.objectContaining({ status: 'active', generation: 2 }),
        ]),
      );
    });
  });

  it('detects a later memory event with the same timestamp and lexically smaller id', async () => {
    await withFixture(async (paths) => {
      const timestamp = '2026-07-19T17:00:00.000Z';
      const database = new DatabaseSync(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `INSERT INTO memories (
               id, scope, key, value_json, repo_id, status, use_count, created_at, updated_at
             ) VALUES ('memory:cursor', 'project', 'cursor', '"one"', 'repo', 'active', 0, ?, ?);`,
          )
          .run(timestamp, timestamp);
        database
          .prepare(
            `INSERT INTO memory_events (id, memory_id, action, actor, after_json, created_at)
             VALUES ('z-event', 'memory:cursor', 'learned', 'user', '{}', ?);`,
          )
          .run(timestamp);
      } finally {
        database.close();
      }
      seedPreparedTurn(paths, 'admission:cursor-one', 'event:cursor-one', 1);
      const first = await dispatchTurn(
        paths,
        'admission:cursor-one',
        'dispatch:cursor-one',
      );
      await submitAutopilotFix(
        submissionFromEnvelope(first.envelope, {
          disposition: 'no-op',
          summary: 'Establish memory cursor.',
        }),
        paths,
        syntheticNoOpDependencies(first.envelope),
      );
      await recordAutopilotOwnerTerminalObservation(
        terminal(first.envelope, 'dispatch:cursor-one'),
        paths,
      );
      const next = new DatabaseSync(paths.neondeckDatabase);
      try {
        next
          .prepare(
            `INSERT INTO memory_events (id, memory_id, action, actor, after_json, created_at)
             VALUES ('a-event', 'memory:cursor', 'updated', 'user', '{}', ?);`,
          )
          .run(timestamp);
      } finally {
        next.close();
      }
      seedPreparedTurn(paths, 'admission:cursor-two', 'event:cursor-two', 2);
      const second = await dispatchTurn(
        paths,
        'admission:cursor-two',
        'dispatch:cursor-two',
      );
      expect(second.envelope.grounding.kind).toBe('reground');
      expect(second.envelope.grounding.reasons).toContain(
        'memory:memory:cursor',
      );
    });
  });

  it('does not repeat an audited rotation after later benign config history', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(
        paths,
        'admission:rotation-base',
        'event:rotation-base',
        1,
      );
      const first = await dispatchTurn(
        paths,
        'admission:rotation-base',
        'dispatch:rotation-base',
      );
      await submitAutopilotFix(
        submissionFromEnvelope(first.envelope, {
          disposition: 'no-op',
          summary: 'Establish the pre-rotation baseline.',
        }),
        paths,
        syntheticNoOpDependencies(first.envelope),
      );
      await recordAutopilotOwnerTerminalObservation(
        terminal(first.envelope, 'dispatch:rotation-base'),
        paths,
      );

      insertConfig(paths, 'config_update_agent_models', 'models');
      seedPreparedTurn(
        paths,
        'admission:rotation-failed',
        'event:rotation-failed',
        2,
      );
      const failed = await coordinateAutopilotAdmission(
        {
          ...coordinationInput('admission:rotation-failed', async () => {
            throw new Error('fixture dispatch failure after rotation');
          }),
        },
        paths,
      );
      expect(failed.dispatched?.status).toBe('dispatch-failed');
      expect(
        (await readAutopilotPrOwnerByWatch('watch:one', paths))?.generation,
      ).toBe(2);

      insertConfig(paths, 'config_update_execution_policy', 'execution');
      seedPreparedTurn(
        paths,
        'admission:rotation-retry',
        'event:rotation-retry',
        3,
      );
      const retry = await dispatchTurn(
        paths,
        'admission:rotation-retry',
        'dispatch:rotation-retry',
      );
      expect(retry.envelope.identity.generation).toBe(2);
      expect(retry.envelope.grounding.reasons).toContain(
        'pending-rotation-retry',
      );
      expect(readRows(paths, 'autopilot_owner_generations')).toHaveLength(2);
    });
  });

  it('rejects truncation, stale SHA, missing submission, model failure, and late results deterministically', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:truncated', 'event:truncated', 1);
      const result = await coordinateAutopilotAdmission(
        {
          ...coordinationInput('admission:truncated', vi.fn()),
          ownerFactsLoader: async () => ({
            ...facts,
            review: { ...facts.review, reviewsTruncated: true },
          }),
        },
        paths,
      );
      expect(result.dispatched?.status).toBe('dispatch-failed');
      expect(readAdmission(paths, 'admission:truncated').state).toBe('blocked');
    });

    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:stale', 'event:stale', 1);
      const turn = await dispatchTurn(
        paths,
        'admission:stale',
        'dispatch:stale',
      );
      const rejected = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          patch:
            '*** Begin Patch\n*** Add File: src/fix.ts\n+fixed\n*** End Patch',
          summary: 'Stale proposal.',
        }),
        paths,
        { currentSha: async () => 'new-head', readLiveHead: liveFixtureHead },
      );
      expect(rejected).toMatchObject({ ok: false });
      const missing = await recordAutopilotOwnerTerminalObservation(
        terminal(turn.envelope, 'dispatch:stale'),
        paths,
      );
      expect(missing.status).toBe('settled');
      expect(readAdmission(paths, 'admission:stale').state).toBe('blocked');
      const late = await recordAutopilotOwnerTerminalObservation(
        terminal(turn.envelope, 'dispatch:stale'),
        paths,
      );
      expect(late.status).toBe('stale-or-duplicate');
    });

    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:forged', 'event:forged', 1);
      const turn = await dispatchTurn(
        paths,
        'admission:forged',
        'dispatch:forged',
      );
      const forged = await submitAutopilotFix(
        {
          ...submissionFromEnvelope(turn.envelope, {
            disposition: 'fix',
            fixerKind: 'review',
            replacements: [
              { path: 'src/fix.ts', oldString: 'old', newString: 'new' },
            ],
            summary: 'Attempt to forge the local head binding.',
          }),
          expectedWorktreeHeadSha: 'forged-current-head',
        },
        paths,
        {
          currentSha: async () => 'forged-current-head',
          readLiveHead: liveFixtureHead,
        },
      );
      expect(forged).toMatchObject({
        ok: false,
        message: expect.stringContaining('invalid or already consumed'),
      });
      expect(readRows(paths, 'autopilot_owner_fix_submissions')).toHaveLength(
        0,
      );
    });

    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:missing', 'event:missing', 1);
      const turn = await dispatchTurn(
        paths,
        'admission:missing',
        'dispatch:missing',
      );
      const missing = await recordAutopilotOwnerTerminalObservation(
        terminal(turn.envelope, 'dispatch:missing'),
        paths,
      );
      expect(missing.status).toBe('settled');
      expect(readAdmission(paths, 'admission:missing')).toMatchObject({
        state: 'blocked',
        last_error: expect.stringContaining(
          'without a valid one-time fix submission',
        ),
      });
    });

    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:policy', 'event:policy', 1);
      const turn = await dispatchTurn(
        paths,
        'admission:policy',
        'dispatch:policy',
      );
      const rejected = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          patch:
            '*** Begin Patch\n*** Add File: secrets/blocked.ts\n+blocked\n*** End Patch',
          summary: 'Out-of-policy proposal.',
        }),
        paths,
        { currentSha: async () => 'abc123', readLiveHead: liveFixtureHead },
      );
      expect(rejected).toMatchObject({
        ok: false,
        message: expect.stringContaining('denied by repository policy'),
      });
    });

    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:size', 'event:size', 1);
      const turn = await dispatchTurn(paths, 'admission:size', 'dispatch:size');
      const rejected = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          patch: 'x'.repeat(256 * 1024 + 1),
          summary: 'Oversized proposal.',
        }),
        paths,
        { currentSha: async () => 'abc123', readLiveHead: liveFixtureHead },
      );
      expect(rejected).toMatchObject({
        ok: false,
        message: 'Invalid scoped fix submission.',
      });
    });

    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:lines', 'event:lines', 1);
      const turn = await dispatchTurn(
        paths,
        'admission:lines',
        'dispatch:lines',
      );
      const runReviewFix = vi.fn<() => Promise<never>>();
      const rejected = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          replacements: [
            {
              path: 'src/fix.ts',
              oldString: `${'old\n'.repeat(160)}`,
              newString: `${'new\n'.repeat(160)}`,
            },
          ],
          summary: 'Oversized multiline replacement.',
        }),
        paths,
        {
          currentSha: async () => 'abc123',
          readLiveHead: liveFixtureHead,
          runReviewFix,
        },
      );
      expect(rejected).toMatchObject({
        ok: false,
        message: expect.stringContaining('maximum line count'),
      });
      expect(runReviewFix).not.toHaveBeenCalled();
    });

    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:count', 'event:count', 1);
      const turn = await dispatchTurn(
        paths,
        'admission:count',
        'dispatch:count',
      );
      const rejected = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          replacements: Array.from({ length: 101 }, (_, index) => ({
            path: `src/fix-${index}.ts`,
            oldString: 'old',
            newString: 'new',
          })),
          summary: 'Too many replacement operations.',
        }),
        paths,
      );
      expect(rejected).toMatchObject({
        ok: false,
        message: 'Invalid scoped fix submission.',
      });
      expect(readRows(paths, 'autopilot_owner_fix_submissions')).toHaveLength(
        0,
      );
    });

    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:model', 'event:model', 1);
      const turn = await dispatchTurn(
        paths,
        'admission:model',
        'dispatch:model',
      );
      const failed = await recordAutopilotOwnerTerminalObservation(
        {
          ...terminal(turn.envelope, 'dispatch:model'),
          failed: true,
          error: 'model unavailable',
          source: 'operation',
        },
        paths,
      );
      expect(failed.status).toBe('settled');
      expect(readAdmission(paths, 'admission:model').state).toBe('failed');
      const late = await recordAutopilotOwnerTerminalObservation(
        terminal(turn.envelope, 'dispatch:model'),
        paths,
      );
      expect(late.status).toBe('stale-or-duplicate');
    });
  });

  it('documents model-visible compaction without claiming canonical stream compaction', () => {
    expect(prAutopilotOwnerCompaction).toEqual({
      reserveTokens: 16_000,
      keepRecentTokens: 8_000,
    });
    expect(prAutopilotOwnerCompaction.reserveTokens).toBeGreaterThan(
      prAutopilotOwnerCompaction.keepRecentTokens,
    );
    expect(prAutopilotOwnerDurability).toEqual({
      maxAttempts: 10,
      timeoutMs: 60 * 60 * 1_000,
    });
  });

  it('treats an explicit empty selected-memory set as no memory drift', async () => {
    await withFixture(async (paths) => {
      const database = new DatabaseSync(paths.neondeckDatabase);
      try {
        database
          .prepare(
            `INSERT INTO memory_events (id, memory_id, action, actor, created_at)
             VALUES ('memory:event:ignored', 'memory:ignored', 'updated', 'user', ?);`,
          )
          .run('2026-07-19T18:00:00.000Z');
        const changes = readStaleReasonChanges(database, {
          configHistoryId: 0,
          memoryEventSequence: 0,
          contextMemoryIds: [],
        });
        expect(changes.memoryChanges).toEqual([]);
        expect(changes.memoryHighWaterSequence).toBe(0);
      } finally {
        database.close();
      }
    });
  });

  it('preserves the lowest policy authority across notify-only then safe transitions', async () => {
    await withFixture(
      async (paths) => {
        seedPreparedTurn(
          paths,
          'admission:monotonic-policy',
          'event:monotonic-policy',
          1,
          'autofix-with-approval',
        );
        const database = new DatabaseSync(paths.neondeckDatabase);
        try {
          for (const [id, mode] of [
            [1, 'notify-only'],
            [2, 'autofix-with-approval'],
          ] as const) {
            database
              .prepare(
                `INSERT INTO config_history
                   (id, action, file, target, after_json, changed_at)
                 VALUES (?, 'config_update_repo_autopilot_policy', 'repos.json', 'repo', ?, ?);`,
              )
              .run(
                id,
                JSON.stringify({
                  repos: [
                    {
                      id: 'repo',
                      github: { owner: 'example', name: 'repo' },
                      path: '/fixture/primary',
                      defaultBranch: 'main',
                      metadata: { autopilot: { mode } },
                    },
                  ],
                }),
                `2026-07-19T18:00:0${id}.000Z`,
              );
          }
        } finally {
          database.close();
        }
        const turn = await dispatchTurn(
          paths,
          'admission:monotonic-policy',
          'dispatch:monotonic-policy',
        );
        expect(turn.envelope.policy).toMatchObject({
          authorityMode: 'notify-only',
          effectiveMode: 'notify-only',
          fixAllowed: false,
        });
      },
      { mode: 'autofix-with-approval' },
    );
  });

  it('preserves tightened guardrails after a later relaxation', async () => {
    await withFixture(
      async (paths) => {
        seedPreparedTurn(
          paths,
          'admission:monotonic-guardrails',
          'event:monotonic-guardrails',
          1,
          'autofix-with-approval',
        );
        const database = new DatabaseSync(paths.neondeckDatabase);
        try {
          for (const [id, maxLinesChanged] of [
            [1, 10],
            [2, 300],
          ] as const) {
            database
              .prepare(
                `INSERT INTO config_history
                   (id, action, file, target, after_json, changed_at)
                 VALUES (?, 'config_update_repo_autopilot_policy', 'repos.json', 'repo', ?, ?);`,
              )
              .run(
                id,
                JSON.stringify({
                  repos: [
                    {
                      id: 'repo',
                      github: { owner: 'example', name: 'repo' },
                      path: '/fixture/primary',
                      defaultBranch: 'main',
                      metadata: {
                        autopilot: { mode: 'autofix-with-approval' },
                        guardrails: { maxLinesChanged },
                      },
                    },
                  ],
                }),
                `2026-07-19T18:01:0${id}.000Z`,
              );
          }
        } finally {
          database.close();
        }

        const turn = await dispatchTurn(
          paths,
          'admission:monotonic-guardrails',
          'dispatch:monotonic-guardrails',
        );
        expect(turn.envelope.policy.guardrails.maxLinesChanged).toBe(10);
        expect(
          JSON.parse(
            String(
              readAdmission(paths, 'admission:monotonic-guardrails')
                .authority_policy_json,
            ),
          ),
        ).toMatchObject({ guardrails: { maxLinesChanged: 10 } });
      },
      { mode: 'autofix-with-approval' },
    );
  });

  it('snapshots admission-time guardrails before later policy processing', async () => {
    await withFixture(async (paths) => {
      const config = JSON.parse(String(await readFile(paths.config)));
      config.guardrails.maxLinesChanged = 17;
      await writeFile(paths.config, JSON.stringify(config));

      const admitted = await admitAutopilotEvent(
        {
          watchId: 'watch:one',
          eventFingerprint: 'event:admission-authority',
          repoId: 'repo',
          prNumber: 42,
          mode: 'autofix-with-approval',
          input: { eventId: 'event:admission-authority' },
          limits,
        },
        paths,
      );

      const row = readAdmission(paths, admitted.admission.id);
      expect(JSON.parse(String(row.authority_policy_json))).toMatchObject({
        guardrails: { maxLinesChanged: 17 },
        transitionHash: expect.any(String),
      });
    });
  });

  it('revokes an in-flight owner mutation and waits for its process lease before stopping', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:stop-fence', 'event:stop-fence', 1);
      const turn = await dispatchTurn(
        paths,
        'admission:stop-fence',
        'dispatch:stop-fence',
      );
      let releaseMutation!: () => void;
      let enteredMutation!: () => void;
      const entered = new Promise<void>(
        (resolve) => (enteredMutation = resolve),
      );
      const release = new Promise<void>(
        (resolve) => (releaseMutation = resolve),
      );
      const submission = submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          replacements: [
            { path: 'src/fix.ts', oldString: 'old', newString: 'new' },
          ],
          summary: 'Exercise durable stop fencing.',
        }),
        paths,
        {
          currentSha: async () => 'abc123',
          readLiveHead: liveFixtureHead,
          runReviewFix: async (_input, _paths, dependencies) => {
            await dependencies?.ownerMutationFence?.('before-write', {
              paths: ['src/fix.ts'],
              bytes: 6,
              lines: 2,
            });
            enteredMutation();
            await release;
            await dependencies?.ownerMutationFence?.('before-write', {
              paths: ['src/fix.ts'],
              bytes: 6,
              lines: 2,
            });
            throw new Error('revoked mutation unexpectedly continued');
          },
        },
      );
      await entered;
      let stopFinished = false;
      const stop = stopAutopilotAdmission(
        { admissionId: 'admission:stop-fence' },
        paths,
      ).then((result) => {
        stopFinished = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stopFinished).toBe(false);
      releaseMutation();
      expect(await submission).toMatchObject({ ok: false });
      expect(await stop).toMatchObject({ status: 'stopped' });
      expect(readAdmission(paths, 'admission:stop-fence')).toMatchObject({
        state: 'stopped',
        prepared_diff_id: null,
      });
      expect(
        readRows(paths, 'autopilot_owner_fix_submissions')[0],
      ).toMatchObject({
        status: 'cancelled',
        prepared_diff_id: null,
      });
    });
  });

  it('does not revoke an active mutation when stop loses its version CAS', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:stale-stop', 'event:stale-stop', 1);
      const turn = await dispatchTurn(
        paths,
        'admission:stale-stop',
        'dispatch:stale-stop',
      );
      let enteredMutation!: () => void;
      let releaseMutation!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredMutation = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      const submission = submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          replacements: [
            { path: 'src/fix.ts', oldString: 'old', newString: 'new' },
          ],
          summary: 'Keep the active mutation after a stale stop request.',
        }),
        paths,
        {
          currentSha: async () => 'abc123',
          readLiveHead: liveFixtureHead,
          runReviewFix: async (_input, _paths, dependencies) => {
            await dependencies?.ownerMutationFence?.('before-write', {
              paths: ['src/fix.ts'],
              bytes: 6,
              lines: 2,
            });
            enteredMutation();
            await release;
            await dependencies?.ownerMutationFence?.('before-write', {
              paths: ['src/fix.ts'],
              bytes: 6,
              lines: 2,
            });
            return {
              ok: true,
              action: 'autopilot_fix_pr_review_feedback',
              changed: true,
              message: 'Prepared after stale stop.',
              data: { preparedDiff: { id: 'prepared:stale-stop' } },
            } as never;
          },
        },
      );
      await entered;
      const current = readAdmission(paths, 'admission:stale-stop');
      const stopped = await stopAutopilotAdmission(
        {
          admissionId: 'admission:stale-stop',
          expectedVersion: Number(current.version) - 1,
        },
        paths,
      );
      expect(stopped.status).toBe('cas-lost');
      expect(readAdmission(paths, 'admission:stale-stop')).toMatchObject({
        state: 'owner-turn-running',
        stop_requested_at: null,
      });

      releaseMutation();
      expect(await submission).toMatchObject({ ok: true });
      expect(
        readRows(paths, 'autopilot_owner_fix_submissions')[0],
      ).toMatchObject({ status: 'prepared' });
    });
  });

  it('records owner-handled learning evidence once without retaining proposal source', async () => {
    await withFixture(async (paths) => {
      await updateLearningConfig({ prRetrospectiveThreshold: 100 }, paths);
      seedPreparedTurn(paths, 'admission:learning', 'event:learning', 1);
      const turn = await dispatchTurn(
        paths,
        'admission:learning',
        'dispatch:learning',
      );
      await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'no-op',
          summary: 'No safe change is required.',
          remainingBlockers: ['none'],
        }),
        paths,
        syntheticNoOpDependencies(turn.envelope),
      );
      await recordAutopilotOwnerTerminalObservation(
        terminal(turn.envelope, 'dispatch:learning'),
        paths,
      );
      await recordAutopilotOwnerTerminalObservation(
        terminal(turn.envelope, 'dispatch:learning'),
        paths,
      );
      const handled = readRows(paths, 'learning_events').filter(
        (row) => row.type === 'pr_handled' && row.source === 'autopilot-owner',
      );
      expect(handled).toHaveLength(1);
      expect(String(handled[0]?.source_id).length).toBeLessThanOrEqual(200);
      const stored = String(
        readRows(paths, 'autopilot_owner_fix_submissions')[0]?.result_json,
      );
      expect(stored).not.toContain('remainingBlockers');
      expect(
        String(
          readRows(paths, 'autopilot_owner_fix_submissions')[0]?.result_hash,
        ),
      ).toHaveLength(64);
    });
  });

  it('recovers durable owner learning evidence after settlement interruption', async () => {
    await withFixture(async (paths) => {
      await updateLearningConfig({ enabled: false }, paths);
      seedPreparedTurn(
        paths,
        'admission:learning-recovery',
        'event:learning-recovery',
        1,
      );
      const turn = await dispatchTurn(
        paths,
        'admission:learning-recovery',
        'dispatch:learning-recovery',
      );
      await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'no-op',
          summary: 'Persist learning evidence for restart recovery.',
        }),
        paths,
        syntheticNoOpDependencies(turn.envelope),
      );
      await recordAutopilotOwnerTerminalObservation(
        terminal(turn.envelope, 'dispatch:learning-recovery'),
        paths,
      );

      expect(
        readRows(paths, 'app_metadata').filter((row) =>
          String(row.key).startsWith('autopilot.owner.learning:'),
        ),
      ).toHaveLength(1);
      expect(readRows(paths, 'learning_events')).toHaveLength(0);

      await updateLearningConfig(
        { enabled: true, prRetrospectiveThreshold: 100 },
        paths,
      );
      await reconcileAutopilotStageAttempts(paths);
      await reconcileAutopilotStageAttempts(paths);

      expect(
        readRows(paths, 'learning_events').filter(
          (row) => row.type === 'pr_handled',
        ),
      ).toHaveLength(1);
      expect(
        readRows(paths, 'app_metadata').filter((row) =>
          String(row.key).startsWith('autopilot.owner.learning:'),
        ),
      ).toHaveLength(0);
    });
  });

  it('freezes the durable owner capability generation across recovery', async () => {
    await withFixture(async (paths) => {
      const first = readAutopilotOwnerCapabilitySnapshot(paths);
      const database = new DatabaseSync(paths.neondeckDatabase);
      try {
        ensureAutopilotOwnerInstanceInDatabase(
          database,
          'owner:one',
          new Date().toISOString(),
          first,
        );
        await writeFile(paths.soul, '# Changed soul generation\n');
        const changed = readAutopilotOwnerCapabilitySnapshot(paths);
        expect(() =>
          ensureAutopilotOwnerInstanceInDatabase(
            database,
            'owner:one',
            new Date().toISOString(),
            changed,
          ),
        ).toThrow(/audited generation rotation/);
      } finally {
        database.close();
      }
    });
  });

  it('freezes selected provider configuration across durable recovery', async () => {
    await withFixture(async (paths) => {
      const previous = process.env.NEONDECK_OWNER_PROVIDER_KEY;
      try {
        process.env.NEONDECK_OWNER_PROVIDER_KEY = 'first-credential';
        const initial = readAutopilotOwnerCapabilitySnapshot(paths);
        const config = JSON.parse(String(await readFile(paths.config)));
        config.providers = {
          ...(config.providers ?? {}),
          [initial.provider]: {
            enabled: true,
            apiKeyEnv: 'NEONDECK_OWNER_PROVIDER_KEY',
          },
        };
        await writeFile(paths.config, JSON.stringify(config));
        const first = readAutopilotOwnerCapabilitySnapshot(paths);
        const database = new DatabaseSync(paths.neondeckDatabase);
        try {
          ensureAutopilotOwnerInstanceInDatabase(
            database,
            'owner:one',
            new Date().toISOString(),
            first,
          );
          process.env.NEONDECK_OWNER_PROVIDER_KEY = 'second-credential';
          const changed = readAutopilotOwnerCapabilitySnapshot(paths);
          expect(changed.providerConfigHash).not.toBe(first.providerConfigHash);
          expect(() =>
            ensureAutopilotOwnerInstanceInDatabase(
              database,
              'owner:one',
              new Date().toISOString(),
              changed,
            ),
          ).toThrow(/audited generation rotation/);
        } finally {
          database.close();
        }
      } finally {
        if (previous === undefined) {
          delete process.env.NEONDECK_OWNER_PROVIDER_KEY;
        } else {
          process.env.NEONDECK_OWNER_PROVIDER_KEY = previous;
        }
      }
    });
  });

  it('orphans an accepted dispatch when persisted grounding JSON is malformed', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(
        paths,
        'admission:malformed-grounding',
        'event:malformed-grounding',
        1,
      );
      const dispatchOwner = vi.fn(async () => {
        const database = new DatabaseSync(paths.neondeckDatabase);
        try {
          database
            .prepare(
              `UPDATE autopilot_owner_grounding_snapshots
               SET memory_ids_json = '{invalid'
               WHERE admission_id = ? AND status = 'reserved';`,
            )
            .run('admission:malformed-grounding');
        } finally {
          database.close();
        }
        return {
          dispatchId: 'dispatch:malformed-grounding',
          acceptedAt: Date.now(),
        };
      });

      const result = await coordinateAutopilotAdmission(
        coordinationInput('admission:malformed-grounding', dispatchOwner),
        paths,
      );

      expect(result.dispatched?.status).toBe('orphaned-receipt');
      expect(
        readAdmission(paths, 'admission:malformed-grounding'),
      ).toMatchObject({ state: 'manual-review' });
    });
  });

  it('fails closed when same-SHA repository identity or branch attachment changes', async () => {
    await withGitFixture(async ({ paths, headSha }) => {
      seedPreparedTurn(paths, 'admission:repo-drift', 'event:repo-drift', 1);
      const turn = await dispatchGitTurn(
        paths,
        'admission:repo-drift',
        'dispatch:repo-drift',
        headSha,
      );
      const registry = JSON.parse(String(await readFile(paths.repos)));
      registry.repos[0].defaultBranch = 'develop';
      await writeFile(paths.repos, JSON.stringify(registry));
      const result = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'no-op',
          summary: 'Do not accept changed repository identity.',
        }),
        paths,
        { readLiveHead: async () => headSha },
      );
      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining('identity changed'),
      });
    });

    await withGitFixture(async ({ paths, headSha, worktreePath }) => {
      seedPreparedTurn(
        paths,
        'admission:branch-drift',
        'event:branch-drift',
        1,
      );
      const turn = await dispatchGitTurn(
        paths,
        'admission:branch-drift',
        'dispatch:branch-drift',
        headSha,
      );
      await git(worktreePath, ['checkout', '--detach']);
      const result = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'no-op',
          summary: 'Do not accept changed branch attachment.',
        }),
        paths,
        { readLiveHead: async () => headSha },
      );
      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining('branch attachment changed'),
      });
    });
  });

  it('rejects model-selected CI commands outside grounded required checks', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(
        paths,
        'admission:diagnostic-authority',
        'event:diagnostic-authority',
        1,
      );
      const turn = await dispatchTurn(
        paths,
        'admission:diagnostic-authority',
        'dispatch:diagnostic-authority',
      );
      const runCiFix = vi.fn();
      const result = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'ci',
          diagnostics: ['git push origin HEAD'],
          patch: [
            '*** Begin Patch',
            '*** Update File: src/fix.ts',
            '@@',
            '-old',
            '+new',
            '*** End Patch',
          ].join('\n'),
          summary: 'Reject an ungrounded diagnostic command.',
        }),
        paths,
        {
          currentSha: async () => 'abc123',
          readLiveHead: liveFixtureHead,
          runCiFix,
        },
      );

      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining('outside the grounded'),
      });
      expect(runCiFix).not.toHaveBeenCalled();
    });
  });

  it('revalidates the owner fence inside the diagnostic execution slot', async () => {
    await withFixture(async (paths) => {
      const runExecution = vi.fn();
      let fenceCalls = 0;
      await expect(
        runAutopilotDiagnostics(
          ['npm run check'],
          limits,
          {
            repoId: 'repo',
            repoFullName: 'example/repo',
            prNumber: 42,
            worktreeId: 'worktree:one',
            workflow: 'fix_pr_ci_failure',
          },
          '/fixture/worktree',
          paths,
          {} as never,
          { runExecution: runExecution as never },
          async () => {
            fenceCalls += 1;
            if (fenceCalls === 2) {
              throw new Error('Owner mutation lease was revoked.');
            }
          },
        ),
      ).rejects.toThrow('Owner mutation lease was revoked.');
      expect(runExecution).not.toHaveBeenCalled();
      expect(fenceCalls).toBe(2);
    });
  });

  it('prepares but never locally commits when monotonic admission authority requires approval', async () => {
    await withGitFixture(async ({ paths, headSha, worktreePath }) => {
      seedPreparedTurn(
        paths,
        'admission:approval-required',
        'event:approval-required',
        1,
        'autofix-with-approval',
      );
      const database = new DatabaseSync(paths.neondeckDatabase);
      try {
        for (const [id, approvalRequiredFileGlobs] of [
          [1, ['src/**']],
          [2, []],
        ] as const) {
          database
            .prepare(
              `INSERT INTO config_history
                 (id, action, file, target, after_json, changed_at)
               VALUES (?, 'config_update_repo_autopilot_policy', 'repos.json', 'repo', ?, ?);`,
            )
            .run(
              id,
              JSON.stringify({
                repos: [
                  {
                    id: 'repo',
                    github: { owner: 'example', name: 'repo' },
                    path: join(paths.home, 'primary'),
                    defaultBranch: 'main',
                    metadata: {
                      autopilot: { mode: 'autofix-with-approval' },
                      guardrails: { approvalRequiredFileGlobs },
                    },
                  },
                ],
              }),
              `2026-07-19T18:02:0${id}.000Z`,
            );
        }
      } finally {
        database.close();
      }
      const turn = await dispatchGitTurn(
        paths,
        'admission:approval-required',
        'dispatch:approval-required',
        headSha,
      );
      const result = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          addressedReviewCommentIds: ['comment:3'],
          addressedReviewThreadIds: ['thread:3'],
          replacements: [
            { path: 'src/fix.ts', oldString: 'old\n', newString: 'review\n' },
          ],
          summary: 'Prepare an approval-gated review fix.',
        }),
        paths,
        realReviewDependencies(headSha, 'comment:3'),
      );
      expect(result).toMatchObject({ ok: true, changed: true });
      expect(await gitOutput(worktreePath, ['rev-parse', 'HEAD'])).toBe(
        headSha,
      );
      expect(String(await readFile(join(worktreePath, 'src/fix.ts')))).toBe(
        'review\n',
      );
    });
  });

  it('rejects same-SHA worktree content drift before mutation', async () => {
    await withGitFixture(async ({ paths, headSha, worktreePath }) => {
      seedPreparedTurn(
        paths,
        'admission:revision-drift',
        'event:revision-drift',
        1,
        'autofix-with-approval',
      );
      const turn = await dispatchGitTurn(
        paths,
        'admission:revision-drift',
        'dispatch:revision-drift',
        headSha,
      );
      await writeFile(join(worktreePath, 'src/fix.ts'), 'drifted\n');

      const result = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          replacements: [
            { path: 'src/fix.ts', oldString: 'old\n', newString: 'fixed\n' },
          ],
          summary: 'Reject a stale same-SHA proposal.',
        }),
        paths,
        {
          currentSha: async () => headSha,
          readLiveHead: async () => headSha,
          runReviewFix: async (_input, _paths, dependencies) => {
            await dependencies?.ownerMutationFence?.('before-mutation');
            throw new Error('mutation unexpectedly passed its revision fence');
          },
        },
      );

      expect(result).toMatchObject({ ok: false });
      expect(result.message).toContain('grounded revision');
      expect(String(await readFile(join(worktreePath, 'src/fix.ts')))).toBe(
        'drifted\n',
      );
    });
  });

  it('rejects same-SHA worktree content drift before a durable no-op', async () => {
    await withGitFixture(async ({ paths, headSha, worktreePath }) => {
      seedPreparedTurn(
        paths,
        'admission:no-op-revision-drift',
        'event:no-op-revision-drift',
        1,
        'autofix-with-approval',
      );
      const turn = await dispatchGitTurn(
        paths,
        'admission:no-op-revision-drift',
        'dispatch:no-op-revision-drift',
        headSha,
      );
      await writeFile(join(worktreePath, 'src/fix.ts'), 'drifted\n');

      const result = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'no-op',
          summary: 'Reject a stale no-op.',
        }),
        paths,
        {
          currentSha: async () => headSha,
          readLiveHead: async () => headSha,
        },
      );

      expect(result).toMatchObject({ ok: false });
      expect(result.message).toContain('grounded revision');
      expect(
        readRows(paths, 'autopilot_owner_fix_submissions')[0],
      ).toMatchObject({ status: 'rejected' });
    });
  });

  it('lets finalized prepared and no-op artifacts outrank a later failed terminal event', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(
        paths,
        'admission:prepared-terminal',
        'event:prepared-terminal',
        1,
      );
      const preparedTurn = await dispatchTurn(
        paths,
        'admission:prepared-terminal',
        'dispatch:prepared-terminal',
      );
      const preparedResult = await submitAutopilotFix(
        submissionFromEnvelope(preparedTurn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          replacements: [
            { path: 'src/fix.ts', oldString: 'old', newString: 'new' },
          ],
          summary: 'Persist the prepared artifact before the loop fails.',
        }),
        paths,
        {
          currentSha: async () => 'abc123',
          readLiveHead: liveFixtureHead,
          runReviewFix: async () =>
            ({
              ok: false,
              action: 'autopilot_fix_pr_review_feedback',
              changed: true,
              message: 'Prepared fixture diff.',
              data: { preparedDiff: { id: 'prepared:terminal-wins' } },
            }) as never,
        },
      );
      expect(preparedResult).toMatchObject({
        ok: true,
        changed: true,
        action: 'autopilot_submit_fix',
      });
      const preparedSettlement = await recordAutopilotOwnerTerminalObservation(
        {
          ...terminal(preparedTurn.envelope, 'dispatch:prepared-terminal'),
          failed: true,
          error: 'model loop failed after action completion',
          source: 'operation',
        },
        paths,
      );
      expect(preparedSettlement.status).toBe('settled');
      const preparedAdmission = readAdmission(
        paths,
        'admission:prepared-terminal',
      );
      expect(preparedAdmission).toMatchObject({
        state: 'fix-prepared',
        prepared_diff_id: 'prepared:terminal-wins',
        next_attempt_at: null,
        last_error: null,
      });
      expect(
        JSON.parse(String(preparedAdmission.last_outcome_json)),
      ).toMatchObject({
        stage: 'owner-turn',
        result: 'completed',
        preparedDiffId: 'prepared:terminal-wins',
      });

      seedPreparedTurn(
        paths,
        'admission:no-op-terminal',
        'event:no-op-terminal',
        2,
      );
      const noOpTurn = await dispatchTurn(
        paths,
        'admission:no-op-terminal',
        'dispatch:no-op-terminal',
      );
      await submitAutopilotFix(
        submissionFromEnvelope(noOpTurn.envelope, {
          disposition: 'no-op',
          summary: 'Persist an explicit no-op before the loop fails.',
        }),
        paths,
        syntheticNoOpDependencies(noOpTurn.envelope),
      );
      const noOpSettlement = await recordAutopilotOwnerTerminalObservation(
        {
          ...terminal(noOpTurn.envelope, 'dispatch:no-op-terminal'),
          failed: true,
          error: 'model loop failed after no-op completion',
          source: 'operation',
        },
        paths,
      );
      expect(noOpSettlement.status).toBe('settled');
      const noOpAdmission = readAdmission(paths, 'admission:no-op-terminal');
      expect(noOpAdmission).toMatchObject({
        state: 'completed',
        prepared_diff_id: null,
        next_attempt_at: null,
        last_error: null,
      });
      expect(JSON.parse(String(noOpAdmission.last_outcome_json))).toMatchObject(
        {
          stage: 'owner-turn',
          result: 'completed',
        },
      );
    });
  });

  it('holds terminal settlement while a reserved fix is applying, then reconciles it', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:race', 'event:race', 1);
      const turn = await dispatchTurn(paths, 'admission:race', 'dispatch:race');
      let terminalStatus = '';
      const result = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'review',
          replacements: [
            { path: 'src/fix.ts', oldString: 'old', newString: 'new' },
          ],
          summary: 'Exercise settlement lease.',
        }),
        paths,
        {
          currentSha: async () => 'abc123',
          readLiveHead: liveFixtureHead,
          runReviewFix: async () => {
            const terminalResult =
              await recordAutopilotOwnerTerminalObservation(
                terminal(turn.envelope, 'dispatch:race'),
                paths,
              );
            terminalStatus = terminalResult.status;
            await reconcileAutopilotStageAttempts(paths, {
              now: new Date('2026-07-20T00:00:00.000Z'),
              ownerApplyingTimeoutMs: 0,
              stageTimeoutMs: 0,
            });
            expect(readAdmission(paths, 'admission:race').state).toBe(
              'owner-turn-running',
            );
            return {
              ok: true,
              action: 'autopilot_fix_pr_review_feedback',
              changed: true,
              message: 'Prepared after terminal observation.',
              data: { preparedDiff: { id: 'prepared:race' } },
            } as never;
          },
        },
      );
      expect(terminalStatus).toBe('submission-applying');
      expect(result).toMatchObject({ ok: true });
      expect(readAdmission(paths, 'admission:race')).toMatchObject({
        state: 'fix-prepared',
        prepared_diff_id: 'prepared:race',
      });
    });
  });

  it('returns the durable early-terminal settlement instead of stale running evidence', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:early', 'event:early', 1);
      let envelope: any;
      const result = await coordinateAutopilotAdmission(
        coordinationInput(
          'admission:early',
          async (request: { input: string }) => {
            envelope = JSON.parse(request.input);
            await recordAutopilotOwnerTerminalObservation(
              terminal(envelope, 'dispatch:early'),
              paths,
            );
            return { dispatchId: 'dispatch:early', acceptedAt: Date.now() };
          },
        ),
        paths,
      );
      expect(result.dispatched?.status).toBe('settled');
      expect(readAdmission(paths, 'admission:early').state).toBe('blocked');
    });
  });

  it('reconciles owner dispatches by dispatch id and expires only restart-orphaned applying leases', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:long', 'event:long', 1);
      await dispatchTurn(paths, 'admission:long', 'dispatch:long');
      const longAttempt = readRows(paths, 'autopilot_stage_attempts').find(
        (row) => row.admission_id === 'admission:long',
      )!;
      await reconcileAutopilotStageAttempts(paths, {
        now: new Date(Date.parse(String(longAttempt.started_at)) + 6 * 60_000),
      });
      expect(readAdmission(paths, 'admission:long').state).toBe(
        'owner-turn-running',
      );

      const database = new DatabaseSync(paths.neondeckDatabase);
      try {
        const attempt = database
          .prepare(
            `SELECT id FROM autopilot_stage_attempts
             WHERE admission_id = 'admission:long';`,
          )
          .get() as { id: string };
        database
          .prepare(
            `INSERT INTO autopilot_owner_fix_submissions (
               id, owner_id, admission_id, attempt_id, dispatch_id, token_hash,
               disposition, status, request_hash, result_json, created_at
             ) VALUES ('submission:orphan', 'owner:one', 'admission:long', ?,
                       'dispatch:long', 'orphan-token', 'fix', 'applying',
                       'request', '{}', '2026-07-19T15:00:00.000Z');`,
          )
          .run(attempt.id);
        database
          .prepare(
            `INSERT INTO app_metadata (key, value, updated_at)
             VALUES ('autopilot.owner.terminal:orphan', '{}',
                     '2026-07-19T15:00:00.000Z');`,
          )
          .run();
      } finally {
        database.close();
      }
      const reconciled = await reconcileAutopilotStageAttempts(paths, {
        now: new Date('2026-07-20T00:00:00.000Z'),
        ownerApplyingTimeoutMs: 0,
      });
      expect(readAdmission(paths, 'admission:long').state).toBe(
        'manual-review',
      );
      expect(reconciled.removedTerminalFacts).toBeGreaterThan(0);
    });
  });

  it('suppresses local commits in prepare-only mode while retaining deterministic CI prepared-diff integration', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:ci', 'event:ci', 1);
      const turn = await dispatchTurn(paths, 'admission:ci', 'dispatch:ci');
      const runCiFix = vi.fn<(input: unknown) => Promise<never>>(
        async (input) => {
          expect(input).toMatchObject({
            worktreeId: 'worktree:one',
            commit: false,
          });
          return {
            ok: true,
            action: 'autopilot_fix_pr_ci_failure',
            changed: true,
            message: 'Prepared CI fixture diff.',
            data: { preparedDiff: { id: 'prepared:ci' } },
          } as never;
        },
      );
      const result = await submitAutopilotFix(
        submissionFromEnvelope(turn.envelope, {
          disposition: 'fix',
          fixerKind: 'ci',
          patch:
            '*** Begin Patch\n*** Add File: src/ci-fix.ts\n+fixed\n*** End Patch',
          summary: 'Fix the failing unit check.',
          testsAttempted: ['npm test -- fixture'],
        }),
        paths,
        {
          currentSha: async () => 'abc123',
          readLiveHead: liveFixtureHead,
          runCiFix,
        },
      );
      expect(result).toMatchObject({ ok: true, changed: true });
      expect(runCiFix).toHaveBeenCalledTimes(1);
    });
  });

  it('serializes and durably coalesces feedback that arrives during an owner turn', async () => {
    await withFixture(async (paths) => {
      seedPreparedTurn(paths, 'admission:active', 'event:active', 1);
      const active = await dispatchTurn(
        paths,
        'admission:active',
        'dispatch:active',
      );
      seedPreparedTurn(paths, 'admission:queued-one', 'event:queued-one', 2);
      seedPreparedTurn(paths, 'admission:queued-two', 'event:queued-two', 3);
      await coordinateAutopilotAdmission(
        coordinationInput('admission:queued-one', vi.fn()),
        paths,
      );
      await coordinateAutopilotAdmission(
        coordinationInput('admission:queued-two', vi.fn()),
        paths,
      );
      expect(readAdmission(paths, 'admission:queued-one').state).toBe(
        'blocked',
      );
      expect(readAdmission(paths, 'admission:queued-two').state).toBe(
        'blocked',
      );
      const queuedDatabase = new DatabaseSync(paths.neondeckDatabase);
      try {
        const queued = readAdmission(paths, 'admission:queued-two');
        const queuedInput = JSON.parse(String(queued.input_json));
        queuedDatabase
          .prepare(
            'UPDATE autopilot_admissions SET input_json = ? WHERE id = ?;',
          )
          .run(
            JSON.stringify({
              ...queuedInput,
              coalescedEvents: [
                {
                  admissionId: 'admission:older',
                  eventFingerprint: 'event:older',
                  eventSequence: 0,
                  input: { eventId: 'event:older' },
                },
              ],
            }),
            'admission:queued-two',
          );
      } finally {
        queuedDatabase.close();
      }
      await submitAutopilotFix(
        submissionFromEnvelope(active.envelope, {
          disposition: 'no-op',
          summary: 'Release the serialized owner turn.',
        }),
        paths,
        syntheticNoOpDependencies(active.envelope),
      );
      const settled = await recordAutopilotOwnerTerminalObservation(
        terminal(active.envelope, 'dispatch:active'),
        paths,
      );
      expect(
        'queuedAdmissionId' in settled ? settled.queuedAdmissionId : null,
      ).toBe('admission:queued-two');
      expect(readAdmission(paths, 'admission:queued-one').state).toBe(
        'superseded',
      );
      const survivor = readAdmission(paths, 'admission:queued-two');
      expect(
        JSON.parse(String(survivor.input_json)).coalescedEvents,
      ).toHaveLength(3);
    });
  });
});

async function withFixture(
  run: (paths: RuntimePaths) => Promise<void>,
  options: { mode?: 'prepare-only' | 'autofix-with-approval' } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-owner-'));
  const paths = runtimePaths(home);
  try {
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      JSON.stringify({
        version: 1,
        localApi: { token: 'fixture-token-fixture-token-fixture-token' },
        guardrails: {
          deniedFileGlobs: ['secrets/**'],
          approvalRequiredFileGlobs: [],
          highRiskClasses: [],
          maxFilesChanged: 10,
          maxLinesChanged: 300,
          allowForcePush: false,
          allowedPushDestinations: ['pull-request-head'],
          requiredChecks: [],
        },
        autopilot: {
          mode: options.mode ?? 'prepare-only',
          concurrency: limits,
        },
      }),
    );
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'repo',
            github: { owner: 'example', name: 'repo' },
            path: '/fixture/primary',
            defaultBranch: 'main',
            metadata: { autopilot: { mode: options.mode ?? 'prepare-only' } },
          },
        ],
      }),
    );
    seedOwnerAndWorktree(paths);
    await run(paths);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function withGitFixture(
  run: (fixture: {
    paths: RuntimePaths;
    headSha: string;
    worktreePath: string;
  }) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-owner-git-'));
  const paths = runtimePaths(home);
  const primary = join(home, 'primary');
  const worktreePath = join(paths.worktrees, 'owner-worktree');
  try {
    await ensureRuntimeHome(paths);
    await mkdir(join(primary, 'src'), { recursive: true });
    await git(primary, ['init', '-b', 'main']);
    await git(primary, ['config', 'user.email', 'fixture@example.com']);
    await git(primary, ['config', 'user.name', 'Fixture']);
    await writeFile(join(primary, 'src/fix.ts'), 'old\n');
    await git(primary, ['add', 'src/fix.ts']);
    await git(primary, ['commit', '-m', 'seed']);
    await git(primary, ['worktree', 'add', '-b', 'feature', worktreePath]);
    const headSha = await gitOutput(worktreePath, ['rev-parse', 'HEAD']);
    await writeFile(
      paths.config,
      JSON.stringify({
        version: 1,
        localApi: { token: 'fixture-token-fixture-token-fixture-token' },
        guardrails: {
          deniedFileGlobs: ['secrets/**'],
          approvalRequiredFileGlobs: [],
          highRiskClasses: [],
          maxFilesChanged: 10,
          maxLinesChanged: 300,
          allowForcePush: false,
          allowedPushDestinations: ['pull-request-head'],
          requiredChecks: [],
        },
        autopilot: { mode: 'autofix-with-approval', concurrency: limits },
      }),
    );
    await writeRepoModeAtPath(paths, 'autofix-with-approval', primary);
    seedOwnerAndWorktree(paths, { headSha, primary, worktreePath });
    await run({ paths, headSha, worktreePath });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function seedOwnerAndWorktree(
  paths: RuntimePaths,
  fixture: {
    headSha?: string;
    primary?: string;
    worktreePath?: string;
  } = {},
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = '2026-07-19T17:00:00.000Z';
  const headSha = fixture.headSha ?? 'abc123';
  const worktreePath = fixture.worktreePath ?? '/fixture/worktree';
  try {
    database
      .prepare(
        `INSERT INTO autopilot_pr_owners (
           id, watch_id, repo_id, pr_number, flue_agent, worktree_id,
           generation, grounding_config_history_id, grounding_memory_ids_json,
           status, current_head_sha, last_dispatched_sequence,
           last_settled_sequence, created_at, updated_at
         ) VALUES ('owner:one', 'watch:one', 'repo', 42, 'pr-autopilot-owner',
           'worktree:one', 1, 0, '[]', 'active', ?, 0, 0, ?, ?);`,
      )
      .run(headSha, now, now);
    database
      .prepare(
        `INSERT INTO worktrees (
           id, repo_id, repo_full_name, github_owner, github_name, pr_number,
           base_ref, head_owner, head_name, head_ref, head_sha, local_path,
           storage_kind, lifecycle_status, last_synced_sha, cleanup_policy_json,
           direct_push_allowed, adopted, created_by, created_at, updated_at
         ) VALUES ('worktree:one', 'repo', 'example/repo', 'example', 'repo', 42,
           'main', 'example', 'repo', 'feature', ?, ?,
           'home', 'ready', ?, ?, 1, 0, 'fixture', ?, ?);`,
      )
      .run(
        headSha,
        worktreePath,
        headSha,
        JSON.stringify({
          retainFailed: true,
          retainPreparedDiff: true,
          successfulGraceHours: 24,
          staleAgeHours: 168,
        }),
        now,
        now,
      );
  } finally {
    database.close();
  }
}

function seedPreparedTurn(
  paths: RuntimePaths,
  admissionId: string,
  fingerprint: string,
  sequence: number,
  mode: 'prepare-only' | 'autofix-with-approval' = 'prepare-only',
) {
  const now = new Date(
    Date.parse('2026-07-19T17:00:00.000Z') + sequence * 1_000,
  ).toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `INSERT INTO autopilot_admissions (
           id, owner_id, watch_id, event_fingerprint, event_sequence, repo_id,
           pr_number, mode, input_json, state, priority, worktree_id, version,
           attempt_count, created_at, updated_at
         ) VALUES (?, 'owner:one', 'watch:one', ?, ?, 'repo', 42, ?,
           ?, 'prepared', 0, 'worktree:one', 1, 0, ?, ?);`,
      )
      .run(
        admissionId,
        fingerprint,
        sequence,
        mode,
        JSON.stringify({
          eventId: fingerprint,
          deltas: {
            review: [
              { id: `comment:${sequence}`, body: 'Complete fixture feedback.' },
            ],
            checks: [{ id: sequence, name: 'unit', conclusion: 'failure' }],
          },
        }),
        now,
        now,
      );
  } finally {
    database.close();
  }
}

async function writeRepoMode(
  paths: RuntimePaths,
  mode: 'prepare-only' | 'autofix-with-approval',
) {
  await writeFile(
    paths.repos,
    JSON.stringify({
      repos: [
        {
          id: 'repo',
          github: { owner: 'example', name: 'repo' },
          path: '/fixture/primary',
          defaultBranch: 'main',
          metadata: { autopilot: { mode } },
        },
      ],
    }),
  );
}

async function writeRepoModeAtPath(
  paths: RuntimePaths,
  mode: 'prepare-only' | 'autofix-with-approval',
  primary: string,
) {
  await writeFile(
    paths.repos,
    JSON.stringify({
      repos: [
        {
          id: 'repo',
          github: { owner: 'example', name: 'repo' },
          path: primary,
          defaultBranch: 'main',
          metadata: { autopilot: { mode } },
        },
      ],
    }),
  );
}

async function dispatchTurn(
  paths: RuntimePaths,
  admissionId: string,
  dispatchId: string,
) {
  let envelope: any;
  const dispatchOwner = vi.fn<
    (request: {
      input: string;
    }) => Promise<{ dispatchId: string; acceptedAt: number }>
  >(async (request) => {
    envelope = JSON.parse(request.input);
    return { dispatchId, acceptedAt: Date.now() };
  });
  const result = await coordinateAutopilotAdmission(
    coordinationInput(admissionId, dispatchOwner),
    paths,
  );
  expect(result.dispatched?.status).toBe('running');
  expect(dispatchOwner).toHaveBeenCalledTimes(1);
  return { result, envelope };
}

async function dispatchGitTurn(
  paths: RuntimePaths,
  admissionId: string,
  dispatchId: string,
  headSha: string,
) {
  let envelope: any;
  const dispatchOwner = vi.fn<
    (request: { input: string }) => Promise<{
      dispatchId: string;
      acceptedAt: number;
    }>
  >(async (request) => {
    envelope = JSON.parse(request.input);
    return { dispatchId, acceptedAt: Date.now() };
  });
  const result = await coordinateAutopilotAdmission(
    {
      ...coordinationInput(admissionId, dispatchOwner),
      ownerFactsLoader: async () => ({
        ...facts,
        pullRequest: { ...facts.pullRequest, headSha },
      }),
      ownerLocalShaLoader: undefined,
    },
    paths,
  );
  expect(result.dispatched?.status).toBe('running');
  return { result, envelope };
}

function realReviewDependencies(headSha: string, commentId: string) {
  return {
    readLiveHead: async () => headSha,
    runReviewFix: async (
      input: unknown,
      paths?: RuntimePaths,
      ownerDependencies: Record<string, any> = {},
    ) =>
      fixPrReviewFeedback(input, paths, {
        ...ownerDependencies,
        token: 'fixture-token',
        fetchPullRequestEventState: async () =>
          reviewEventState(headSha, commentId) as never,
      }),
  };
}

function reviewEventState(headSha: string, commentId: string) {
  const suffix = commentId.split(':').at(-1) ?? '1';
  const comment = {
    id: commentId,
    databaseId: Number(suffix),
    authorLogin: 'reviewer',
    authorType: 'User',
    authorIsBot: false,
    body: 'Please update this value.',
    url: `https://github.com/example/repo/pull/42#discussion_${suffix}`,
    path: 'src/fix.ts',
    line: 1,
    originalLine: 1,
    diffHunk: '@@ -1 +1 @@',
    reviewId: Number(suffix),
    createdAt: '2026-07-19T17:00:00.000Z',
    updatedAt: '2026-07-19T17:00:00.000Z',
  };
  return {
    repo: 'example/repo',
    number: 42,
    url: 'https://github.com/example/repo/pull/42',
    title: 'Fixture PR',
    body: 'Fixture body',
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha,
    headRef: 'feature',
    baseRef: 'main',
    baseSha: headSha,
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [],
    reviewThreads: [
      {
        id: `thread:${suffix}`,
        isResolved: false,
        isOutdated: false,
        path: 'src/fix.ts',
        line: 1,
        commentsTruncated: false,
        comments: [comment],
      },
    ],
    requestedChangesReviews: [],
    requestedChangesState: {
      active: [],
      latestByReviewer: [],
      history: [],
    },
    checkSuites: [],
    checkRuns: [],
    branchPermissions: {
      headRepoFullName: 'example/repo',
      baseRepoFullName: 'example/repo',
      isFork: false,
      maintainerCanModify: true,
      headRepoPush: true,
      baseRepoPush: true,
      canLikelyPush: true,
      checkedAt: '2026-07-19T17:00:00.000Z',
    },
    reviewsTruncated: false,
    reviewThreadsTruncated: false,
    reviewCommentsTruncated: false,
    isOutOfDate: false,
    fetchedAt: '2026-07-19T17:00:00.000Z',
  };
}

function coordinationInput(admissionId: string, dispatchOwner: any) {
  return {
    admissionId,
    limits,
    invokeWorkflow: async () => ({ runId: 'unused' }),
    enableOwnerDispatch: true,
    dispatchOwner,
    ownerFactsLoader: async () => facts,
    ownerLocalShaLoader: async () => 'abc123',
    ownerReadinessLoader: async () =>
      ({
        ready: true,
        status: 'ready',
        facts: {},
        blocking: [],
        warnings: [],
        pushTarget: {
          repoFullName: 'example/repo',
          remote: 'https://github.com/example/repo.git',
          branch: 'feature',
          fork: false,
          maintainerCanModify: true,
          canLikelyPush: true,
        },
      }) as never,
  };
}

function submissionFromEnvelope(
  envelope: any,
  values: Record<string, unknown>,
) {
  const scope = envelope.capabilities.submitFix;
  return {
    admissionId: scope.expectedAdmissionId,
    attemptId: scope.expectedAttemptId,
    token: scope.token,
    sourceEventFingerprint: envelope.identity.eventFingerprint,
    worktreeId: scope.expectedWorktreeId,
    expectedPrHeadSha: scope.expectedPrHeadSha,
    expectedWorktreeHeadSha: scope.expectedWorktreeHeadSha,
    policyHash: scope.policyHash,
    ...values,
  };
}

function terminal(envelope: any, dispatchId: string) {
  return {
    agent: 'pr-autopilot-owner' as const,
    instanceId: envelope.identity.instanceId as string,
    dispatchId,
    failed: false,
    error: null,
    source: 'agent_end' as const,
  };
}

async function liveFixtureHead() {
  return 'abc123';
}

function syntheticNoOpDependencies(envelope: any) {
  const baseId = String(envelope.workspace.baseSha);
  const revisionKey = String(envelope.workspace.groundedDiffRevisionKey);
  const prefix = `worktree-diff:${baseId}:`;
  if (!revisionKey.startsWith(prefix)) {
    throw new Error('Synthetic owner fixture has an invalid revision key.');
  }
  return {
    currentSha: async () => 'abc123',
    readLiveHead: liveFixtureHead,
    readDiff: async () =>
      ({
        ok: true,
        action: 'repo_diff',
        revision: {
          state: 'resolved',
          kind: 'worktree-diff',
          id: revisionKey.slice(prefix.length),
          baseId,
        },
      }) as never,
  };
}

function insertConfig(paths: RuntimePaths, action: string, target: string) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `INSERT INTO config_history (action, file, target, changed_at)
         VALUES (?, 'config.json', ?, ?);`,
      )
      .run(action, target, new Date().toISOString());
  } finally {
    database.close();
  }
}

function readAdmission(paths: RuntimePaths, id: string) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    return database
      .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
      .get(id) as Record<string, unknown>;
  } finally {
    database.close();
  }
}

function readRows(paths: RuntimePaths, table: string) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    return database.prepare(`SELECT * FROM ${table};`).all() as Record<
      string,
      unknown
    >[];
  } finally {
    database.close();
  }
}

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd: string, args: string[]) {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout.trim();
}
