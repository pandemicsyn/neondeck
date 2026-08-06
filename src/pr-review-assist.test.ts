import { rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolStep } from '@flue/runtime';
import {
  addPrReviewDraftComment,
  readLivePrReviewDraft,
  updatePrReviewDraftComment,
  upsertPrReviewDraft,
  type GitHubDiffSummary,
  type GitHubPullRequestEventState,
  type GitHubPullRequestFile,
} from './modules/github';
import {
  createSubmitPrReviewTool,
  createReviewDurableEffectRunner,
  reviewFactsForPrompt,
  reviewPrForHuman,
  type ReviewAssistFacts,
} from './modules/pr-review-assist';
import { upsertMemory } from './modules/memory';
import { listReports, readReportHtml } from './modules/reports';
import { listNotifications, listWorkflowSummaries } from './modules/app-state';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { reportDocumentFromSummary } from '../shared/report-document';
import { reportDeckFromSummary } from '../shared/report-deck';
import { openDb } from './lib/sqlite';
import * as v from 'valibot';
import { prReviewAgentInitialDataSchema } from './modules/pr-review-assist/schemas';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PR review assist', () => {
  it('accepts persisted initial-review data created before Explore was captured', () => {
    const legacyInitialData = {
      model: 'faux/faux-1',
      thinkingLevel: 'low',
      instructions: 'Review the bounded change.',
      prepared: {
        input: { ref: 'pandemicsyn/neondeck#10' },
        facts: {},
        promptContext: {},
      },
      workspace: { available: false, reason: 'fixture has no workspace' },
      prompt: '{"task":"Review this pull request."}',
    };

    expect(
      v.safeParse(prReviewAgentInitialDataSchema, legacyInitialData).success,
    ).toBe(true);
    expect(
      v.safeParse(prReviewAgentInitialDataSchema, {
        ...legacyInitialData,
        exploreModel: 'faux/faux-1',
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(prReviewAgentInitialDataSchema, {
        ...legacyInitialData,
        schema: 'neondeck.pr-review-agent-context.v2',
        exploreModel: 'faux/faux-1',
        exploreThinkingLevel: 'minimal',
      }).success,
    ).toBe(true);
  });

  it('declares typed review submission as a durable non-harness Flue tool', () => {
    const tool = createSubmitPrReviewTool(
      { ref: 'pandemicsyn/neondeck#10' },
      async () => {
        throw new Error('The declaration test must not load review context.');
      },
    );
    expect(tool).toMatchObject({ durable: true });
    expect(tool).not.toHaveProperty('harness', true);
  });

  it('checkpoints durable effect failures and propagates outer aborts', async () => {
    const recorded = new Map<string, unknown>();
    const step: ToolStep = {
      async do<T>(name: string, effect: () => T | Promise<T>) {
        if (recorded.has(name)) return recorded.get(name) as T;
        const value = await effect();
        recorded.set(name, value);
        return value;
      },
    };
    const runEffect = createReviewDurableEffectRunner(step);
    let attempts = 0;
    await expect(
      runEffect('transient-operation', async () => {
        attempts += 1;
        throw new Error('record this failure');
      }),
    ).rejects.toThrow('record this failure');
    await expect(
      runEffect('transient-operation', async () => {
        attempts += 1;
        return 'unexpected recovery success';
      }),
    ).rejects.toThrow('record this failure');
    expect(attempts).toBe(1);

    const controller = new AbortController();
    controller.abort(new DOMException('operator cancelled', 'AbortError'));
    let abortedStepCalls = 0;
    const abortedStep: ToolStep = {
      async do<T>(_name: string, _effect: () => T | Promise<T>): Promise<T> {
        abortedStepCalls += 1;
        throw new Error('The aborted step must not execute.');
      },
    };
    const abortedEffect = vi.fn<() => Promise<string>>();
    await expect(
      createReviewDurableEffectRunner(abortedStep, controller.signal)(
        'must-not-run',
        abortedEffect,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortedStepCalls).toBe(0);
    expect(abortedEffect).not.toHaveBeenCalled();

    const inFlightController = new AbortController();
    let releaseEffect!: () => void;
    const effectGate = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const inFlightEffect = vi.fn(async () => {
      await effectGate;
      return 'finished after cancellation';
    });
    const inFlightStep: ToolStep = {
      async do<T>(_name: string, effect: () => T | Promise<T>): Promise<T> {
        return effect();
      },
    };
    const inFlightResult = createReviewDurableEffectRunner(
      inFlightStep,
      inFlightController.signal,
    )('in-flight-operation', inFlightEffect);
    await vi.waitFor(() => expect(inFlightEffect).toHaveBeenCalledOnce());
    inFlightController.abort(
      new DOMException('operator cancelled in flight', 'AbortError'),
    );
    releaseEffect();
    await expect(inFlightResult).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops the review before application effects when cancellation arrives in flight', async () => {
    const paths = await tempPaths();
    const controller = new AbortController();
    let releaseFacts!: () => void;
    const factsGate = new Promise<void>((resolve) => {
      releaseFacts = resolve;
    });
    const fetchFacts = vi.fn(async () => {
      await factsGate;
      return reviewFacts();
    });
    const reviewer = vi.fn(() => reviewOutputWithOneFinding());
    const step: ToolStep = {
      async do<T>(_name: string, effect: () => T | Promise<T>): Promise<T> {
        return effect();
      },
    };
    const result = reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, {
      signal: controller.signal,
      runEffect: createReviewDurableEffectRunner(step, controller.signal),
      fetchFacts,
      reviewer,
    });
    await vi.waitFor(() => expect(fetchFacts).toHaveBeenCalledOnce());
    controller.abort(new DOMException('operator cancelled', 'AbortError'));
    releaseFacts();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(reviewer).not.toHaveBeenCalled();
    await expect(listReports(paths, { kind: 'pr-review' })).resolves.toEqual(
      [],
    );
    await expect(
      listNotifications(paths, { includeResolved: true }),
    ).resolves.toEqual([]);
    await expect(listWorkflowSummaries(paths)).resolves.toEqual([]);
    expect(
      readLivePrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: 'pandemicsyn/neondeck',
        prNumber: 10,
      }),
    ).toBeNull();
  });

  it('preserves an existing Neon draft when cancellation arrives during validation', async () => {
    const paths = await tempPaths();
    const original = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 10,
      headSha: 'previous-head',
    });
    addPrReviewDraftComment({
      id: 'existing-neon-comment',
      databasePath: paths.neondeckDatabase,
      draftId: original.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 2,
      body: 'Existing Neon draft comment',
      origin: 'neon',
      sourceFindingId: 'existing-finding',
    });
    const before = readLivePrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 10,
    });
    const controller = new AbortController();
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const validateReviewFiles = vi.fn(async (facts: ReviewAssistFacts) => {
      await validationGate;
      return facts.files;
    });
    const step: ToolStep = {
      async do<T>(_name: string, effect: () => T | Promise<T>): Promise<T> {
        return effect();
      },
    };
    const result = reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, {
      signal: controller.signal,
      runEffect: createReviewDurableEffectRunner(step, controller.signal),
      fetchFacts: async () => reviewFacts(),
      reviewer: async () => reviewOutputWithOneFinding(),
      validateReviewFiles,
    });
    await vi.waitFor(() => expect(validateReviewFiles).toHaveBeenCalledOnce());
    controller.abort(new DOMException('operator cancelled', 'AbortError'));
    releaseValidation();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      readLivePrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: 'pandemicsyn/neondeck',
        prNumber: 10,
      }),
    ).toEqual(before);
    await expect(listReports(paths, { kind: 'pr-review' })).resolves.toEqual(
      [],
    );
  });

  it('defaults human draft comment origin and preserves explicit Neon origin', async () => {
    const paths = await tempPaths();
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 10,
      headSha: 'head123',
    });

    const withHuman = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 2,
      body: 'Human draft',
    });
    const withNeon = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 3,
      body: 'Neon draft',
      origin: 'neon',
      sourceFindingId: 'prf_seeded_finding',
    });
    const alreadyPrefixed = addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 4,
      body: 'bot: Existing attribution',
      origin: 'neon',
    });

    expect(withHuman.comments.at(-1)).toMatchObject({
      origin: 'human',
      body: 'Human draft',
    });
    expect(withNeon.comments.at(-1)).toMatchObject({
      origin: 'neon',
      body: 'bot: Neon draft',
      sourceFindingId: 'prf_seeded_finding',
    });
    expect(alreadyPrefixed.comments.at(-1)).toMatchObject({
      origin: 'neon',
      body: 'bot: Existing attribution',
    });
  });

  it('seeds only anchor-valid Neon draft comments and writes escaped reports', async () => {
    const paths = await tempPaths();
    const facts = reviewFacts();
    const result = await reviewPrForHuman(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        fetchFacts: async () => facts,
        reviewer: async () => ({
          overview: {
            summary: 'Review <script>alert(1)</script>',
            changeMap: [
              {
                path: 'src/app.ts',
                summary: 'Adds guarded branch with <unsafe> text.',
              },
            ],
            risks: ['Risk contains <b>markup</b>'],
            checks: ['unit tests pending'],
          },
          findings: [
            {
              severity: 'major',
              path: 'src/app.ts',
              anchor: { kind: 'inline', side: 'RIGHT', line: 2 },
              summary: 'Validate the new branch.',
              suggestedFix: 'Add an explicit guard.',
              confidence: 'high',
            },
            {
              severity: 'minor',
              path: 'src/app.ts',
              anchor: {
                kind: 'report-only',
                reason: 'The supplied patch does not prove a changed line.',
              },
              summary: 'This cannot be anchored.',
              suggestedFix: 'Keep it report-only.',
            },
          ],
          presentation: {
            overview: [
              {
                kind: 'source',
                source: 'change-map',
                layout: 'facts',
              },
            ],
            issues: [],
          },
        }),
      },
    );

    const okResult = requireReviewAssistOk(result);
    expect(okResult.data).toMatchObject({
      findingCount: 2,
      seededCount: 1,
      reportOnlyCount: 1,
      skippedSeedingReason: null,
      reportOnlyFindings: [
        expect.objectContaining({
          sourceId: expect.stringMatching(/^prf_[a-f0-9]{24}$/),
          summary: 'This cannot be anchored.',
        }),
      ],
    });

    const draft = readLivePrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 10,
    });
    expect(draft?.comments).toMatchObject([
      {
        path: 'src/app.ts',
        line: 2,
        origin: 'neon',
        sourceFindingId: expect.stringMatching(/^prf_[a-f0-9]{24}$/),
        body: [
          'bot: Validate the new branch.',
          '',
          'Suggested fix: Add an explicit guard.',
        ].join('\n'),
      },
    ]);

    const reports = await listReports(paths, { kind: 'pr-review' });
    expect(reports).toHaveLength(2);
    const overview = reports.find((report) =>
      report.title.startsWith('PR Overview:'),
    );
    expect(overview).toBeTruthy();
    expect(reportDocumentFromSummary(overview?.summary)).toMatchObject({
      title: 'PR Overview: pandemicsyn/neondeck#10',
      summary: 'Review <script>alert(1)</script>',
      sections: expect.arrayContaining([
        expect.objectContaining({ title: 'Change Map' }),
      ]),
    });
    const overviewDeck = reportDeckFromSummary(overview?.summary);
    expect(overviewDeck).toMatchObject({
      version: 2,
      summaryMarkdown: 'Review <script>alert(1)</script>',
    });
    expect(overviewDeck?.slides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'summary', title: 'Review brief' }),
        expect.objectContaining({ kind: 'facts', title: 'PR facts' }),
        expect.objectContaining({
          kind: 'change-map',
          items: expect.any(Array),
        }),
      ]),
    );
    expect(overview?.summary).toMatchObject({
      presentationWarnings: [
        expect.stringContaining('deterministic overview layout was used'),
      ],
    });
    const issues = reports.find((report) =>
      report.title.startsWith('Review Issues:'),
    );
    const issuesDeck = reportDeckFromSummary(issues?.summary);
    expect(issuesDeck).toMatchObject({ version: 2 });
    expect(issuesDeck?.slides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'summary', title: 'Review brief' }),
        expect.objectContaining({
          kind: 'findings',
          disposition: 'seeded',
        }),
        expect.objectContaining({
          kind: 'findings',
          disposition: 'report-only',
        }),
      ]),
    );
    const html = await readReportHtml(overview!.id, paths);
    expect(html?.html).toContain('data-report-deck=""');
    expect(html?.html).toContain('Review alert(1)');
    expect(html?.html).toContain('Risk contains markup');
    expect(html?.html).not.toContain('<script>alert(1)</script>');
    expect(html?.html).not.toContain('<b>markup</b>');
  });

  it('replaces prior Neon findings on re-review', async () => {
    const paths = await tempPaths();
    const facts = reviewFacts();
    await reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, {
      fetchFacts: async () => facts,
      reviewer: async () => reviewOutputWithOneFinding(),
    });

    const firstDraft = readLivePrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 10,
    });
    expect(firstDraft?.comments).toHaveLength(1);

    const refreshed = await reviewPrForHuman(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        fetchFacts: async () => facts,
        reviewer: async () => ({
          overview: reviewOutputWithOneFinding().overview,
          findings: [],
        }),
      },
    );

    expect(requireReviewAssistOk(refreshed).data).toMatchObject({
      findingCount: 0,
      seededCount: 0,
      reportOnlyCount: 0,
    });
    expect(
      readLivePrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: 'pandemicsyn/neondeck',
        prNumber: 10,
      })?.comments,
    ).toEqual([]);
  });

  it('reanchors an emptied Neon draft when the reviewed head advances', async () => {
    const paths = await tempPaths();
    const firstFacts = reviewFacts();
    await reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, {
      fetchFacts: async () => firstFacts,
      reviewer: async () => reviewOutputWithOneFinding(),
    });

    const nextFacts = {
      ...firstFacts,
      state: { ...firstFacts.state, headSha: 'head456' },
    };
    await reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, {
      fetchFacts: async () => nextFacts,
      reviewer: async () => ({
        overview: reviewOutputWithOneFinding().overview,
        findings: [],
      }),
    });

    expect(
      readLivePrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: 'pandemicsyn/neondeck',
        prNumber: 10,
      }),
    ).toMatchObject({ headSha: 'head456', comments: [] });
  });

  it('preserves a Neon finding after a human edits it', async () => {
    const paths = await tempPaths();
    await reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, {
      fetchFacts: async () => reviewFacts(),
      reviewer: async () => reviewOutputWithOneFinding(),
    });
    const firstDraft = readLivePrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 10,
    });
    const comment = firstDraft?.comments[0];
    if (!comment) throw new Error('Expected a Neon draft comment.');
    const edited = updatePrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      commentId: comment.id,
      body: 'Human-edited finding',
    });
    expect(edited.comments[0]).toMatchObject({
      body: 'Human-edited finding',
      origin: 'human',
    });

    const refreshed = await reviewPrForHuman(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        fetchFacts: async () => reviewFacts(),
        reviewer: async () => reviewOutputWithOneFinding(),
      },
    );

    expect(requireReviewAssistOk(refreshed).data).toMatchObject({
      seededCount: 0,
      reportOnlyCount: 1,
      skippedSeedingReason: 'existing-human-draft',
    });
    expect(
      readLivePrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: 'pandemicsyn/neondeck',
        prNumber: 10,
      })?.comments,
    ).toEqual([expect.objectContaining({ body: 'Human-edited finding' })]);
  });

  it('does not overwrite or append to an existing human draft', async () => {
    const paths = await tempPaths();
    const draft = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 10,
      headSha: 'head123',
      body: 'Human body',
    });
    addPrReviewDraftComment({
      databasePath: paths.neondeckDatabase,
      draftId: draft.id,
      path: 'src/app.ts',
      side: 'RIGHT',
      line: 2,
      body: 'Human inline comment',
    });

    const result = await reviewPrForHuman(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        fetchFacts: async () => reviewFacts(),
        reviewer: async () => reviewOutputWithOneFinding(),
      },
    );

    const okResult = requireReviewAssistOk(result);
    expect(okResult.data).toMatchObject({
      seededCount: 0,
      reportOnlyCount: 1,
      skippedSeedingReason: 'existing-human-draft',
    });
    const live = readLivePrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: 'pandemicsyn/neondeck',
      prNumber: 10,
    });
    expect(live?.body).toBe('Human body');
    expect(live?.comments).toHaveLength(1);
    expect(live?.comments[0]).toMatchObject({
      body: 'Human inline comment',
      origin: 'human',
    });
  });

  it('keeps findings report-only when PR file facts are truncated', async () => {
    const paths = await tempPaths();
    const facts = reviewFacts();
    facts.files[0] = {
      ...facts.files[0]!,
      patch: null,
      truncated: true,
      message: 'GitHub omitted the text patch for this file.',
    };

    const result = await reviewPrForHuman(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        fetchFacts: async () => facts,
        reviewer: async () => reviewOutputWithOneFinding(),
      },
    );

    const okResult = requireReviewAssistOk(result);
    expect(okResult.data).toMatchObject({
      seededCount: 0,
      reportOnlyCount: 1,
      skippedSeedingReason: null,
      reportOnlyFindings: [
        expect.objectContaining({ reason: 'file-diff-truncated' }),
      ],
    });
    expect(
      readLivePrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: 'pandemicsyn/neondeck',
        prNumber: 10,
      }),
    ).toBeNull();
  });

  it('still anchors findings in complete files when another file is truncated', async () => {
    const paths = await tempPaths();
    const facts = reviewFacts();
    facts.files.push({
      ...facts.files[0]!,
      path: 'generated/snapshot.json',
      patch: '{"large":true}',
      truncated: true,
      generatedLike: true,
      message: 'Local git patch exceeded the configured size limit.',
    });

    const result = await reviewPrForHuman(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        fetchFacts: async () => facts,
        reviewer: async () => reviewOutputWithOneFinding(),
      },
    );

    expect(requireReviewAssistOk(result).data).toMatchObject({
      seededCount: 1,
      reportOnlyCount: 0,
      skippedSeedingReason: null,
    });
  });

  it('includes typed PR context and explicit limitations in review prompt facts', () => {
    const facts = reviewFacts();
    facts.state.commits = [
      {
        sha: 'head123',
        url: 'https://github.com/pandemicsyn/neondeck/commit/head123',
        authorLogin: 'pandemicsyn',
        committedAt: '2026-07-05T11:00:00.000Z',
      },
    ];
    facts.state.reviewThreads = [
      {
        id: 'thread-1',
        isResolved: false,
        isOutdated: false,
        path: 'src/app.ts',
        line: 2,
        originalLine: 2,
        diffSide: 'RIGHT',
        comments: [
          {
            id: 'comment-1',
            databaseId: 1001,
            authorLogin: 'reviewer',
            body: 'Please handle this review case.',
            url: 'https://github.com/pandemicsyn/neondeck/pull/10#discussion_r1001',
            path: 'src/app.ts',
            line: 2,
            originalLine: 2,
            diffHunk: '@@ -1,2 +1,3 @@',
            reviewId: 9001,
            createdAt: '2026-07-05T11:05:00.000Z',
            updatedAt: '2026-07-05T11:05:00.000Z',
          },
        ],
      },
    ];
    const requestedChange = {
      id: 9001,
      nodeId: 'PRR_9001',
      state: 'CHANGES_REQUESTED',
      authorLogin: 'reviewer',
      submittedAt: '2026-07-05T11:06:00.000Z',
      commitId: 'head123',
      url: 'https://github.com/pandemicsyn/neondeck/pull/10#pullrequestreview-9001',
    };
    facts.state.requestedChangesState = {
      active: [requestedChange],
      latestByReviewer: [requestedChange],
      history: [requestedChange],
    };
    facts.state.requestedChangesReviews = [requestedChange];

    const promptFacts = reviewFactsForPrompt(facts, {
      learningMemoryContext: {
        memoryIds: ['memory-1', 'memory-2'],
        memories: [
          {
            id: 'memory-1',
            scope: 'project',
            key: 'review-style',
            repoId: 'neondeck',
            value: 'Focus on error handling.',
          },
          {
            id: 'memory-2',
            scope: 'user',
            key: 'duplicate-review-style',
            repoId: null,
            value: 'Focus on error handling.',
          },
        ],
        text: 'Learning memories background context:\n- memory-1 [project:review-style repo=neondeck] Focus on error handling.',
        available: true,
        truncated: false,
      },
    });

    expect(promptFacts.pullRequest).toMatchObject({
      body: 'Fixes #123 by adding review assistance facts.',
      baseSha: 'base123',
      draft: false,
      merged: false,
      mergeable: true,
      mergeableState: 'clean',
      maintainerCanModify: true,
      isOutOfDate: false,
    });
    expect(promptFacts.linkedIssueReferenceHints).toEqual(['#123']);
    expect(promptFacts.backgroundContext).toBe(
      'Focus on error handling.\n\nTreat this learned memory as durable background guidance, not current PR evidence. Fetched PR facts and bounded review rules win on conflict.',
    );
    expect(JSON.stringify(promptFacts)).not.toContain('memory-1');
    expect(JSON.stringify(promptFacts)).not.toContain('memory-2');
    expect(JSON.stringify(promptFacts)).not.toContain('review-style');
    expect(promptFacts.commits).toMatchObject([{ sha: 'head123' }]);
    expect(promptFacts.reviewThreads).toMatchObject([
      {
        id: 'thread-1',
        isResolved: false,
        comments: [
          {
            id: 'comment-1',
            body: 'Please handle this review case.',
            diffHunk: '@@ -1,2 +1,3 @@',
          },
        ],
      },
    ]);
    expect(promptFacts.requestedChangesState.active).toEqual([requestedChange]);
    expect(promptFacts.requestedChangesReviews).toEqual([requestedChange]);
    expect(promptFacts.branchPermissions).toMatchObject({
      canLikelyPush: true,
      maintainerCanModify: true,
    });
    expect(promptFacts.limitations).toEqual([
      expect.stringContaining(
        'Linked issue relationships are not currently typed separately',
      ),
    ]);
  });

  it('injects bounded repo learning memories into review facts and summary', async () => {
    const paths = await tempPaths();
    await writeRepoRegistry(paths.repos);
    const memory = await upsertMemory(
      {
        scope: 'project',
        repoId: 'neondeck',
        key: 'e2e-shard',
        value: 'This repo has a flaky e2e shard; do not over-trust it.',
      },
      paths,
    );
    await upsertMemory(
      {
        scope: 'project',
        repoId: 'other-repo',
        key: 'ignore-me',
        value: 'This belongs to another repo.',
      },
      paths,
    );
    let promptFacts: ReturnType<typeof reviewFactsForPrompt> | null = null;

    const result = await reviewPrForHuman(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        fetchFacts: async () => reviewFacts(),
        reviewer: async (facts, context) => {
          promptFacts = reviewFactsForPrompt(facts, context);
          return reviewOutputWithOneFinding();
        },
      },
    );
    const okResult = requireReviewAssistOk(result);
    const memoryId = (memory as { memory: { id: string } }).memory.id;
    const capturedFacts = promptFacts as unknown as {
      backgroundContext: string;
      memories?: unknown;
    };

    expect(capturedFacts.backgroundContext).toContain('flaky e2e shard');
    expect(capturedFacts).not.toHaveProperty('memories');
    expect(JSON.stringify(promptFacts)).not.toContain(memoryId);
    expect(JSON.stringify(promptFacts)).not.toContain('e2e-shard');
    expect(JSON.stringify(promptFacts)).not.toContain('other-repo');
    expect(okResult.workflowSummary.summary).toMatchObject({
      memoryIds: [memoryId],
    });
  });

  it('lets exact-revision tools own changed-file discovery in the model seed', () => {
    const facts = reviewFacts();
    const promptFacts = reviewFactsForPrompt(facts, {
      workspace: {
        available: true,
        repoId: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        repoPath: '/tmp/neondeck',
        headSha: 'head123',
        baseSha: 'base123',
        mergeBase: 'base123',
        tools: [],
      },
    });

    expect(promptFacts.workspace).toMatchObject({
      available: true,
      access: 'exact-revision-read-only-tools',
    });
    expect(promptFacts).not.toHaveProperty('files');
    expect(JSON.stringify(promptFacts)).not.toContain('+const added = true;');
  });

  it('keeps actionable CI details while compacting successful checks', () => {
    const facts = reviewFacts();
    facts.state.checkSuites = [
      {
        id: 5001,
        headSha: 'head123',
        status: 'completed',
        conclusion: 'success',
        appSlug: 'github-actions',
        url: null,
        htmlUrl: null,
        createdAt: '2026-07-05T11:00:00.000Z',
        updatedAt: '2026-07-05T11:01:00.000Z',
      },
    ];
    facts.state.checkRuns = [
      checkRun(6001, 'unit', 'completed', 'success'),
      checkRun(6002, 'docs', 'completed', 'skipped'),
      checkRun(6003, 'integration', 'in_progress', null),
      checkRun(6004, 'lint', 'completed', 'failure'),
    ];
    facts.state.checkSuitesTruncated = true;
    facts.state.checkRunsTruncated = false;

    const promptFacts = reviewFactsForPrompt(facts);
    expect(promptFacts.checks).toEqual({
      summary: {
        suites: 1,
        runs: 4,
        suitesTruncated: true,
        runsTruncated: false,
        successful: 2,
        skipped: 1,
        neutral: 0,
        pending: 1,
        failed: 1,
      },
      successfulRuns: {
        count: 1,
        names: ['unit'],
        truncated: false,
      },
      pending: [
        expect.objectContaining({ name: 'integration', status: 'in_progress' }),
      ],
      failed: [
        expect.objectContaining({ name: 'lint', conclusion: 'failure' }),
      ],
    });
    expect(JSON.stringify(promptFacts.checks)).not.toContain('docs');
  });

  it('rejects malformed structured output before writing reports or drafts', async () => {
    const paths = await tempPaths();
    const result = await reviewPrForHuman(
      { ref: 'pandemicsyn/neondeck#10' },
      paths,
      {
        fetchFacts: async () => reviewFacts(),
        reviewer: async () => ({ findings: [] }),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      message: 'Review output did not match the expected schema.',
    });
    await expect(listReports(paths)).resolves.toEqual([]);
    expect(
      readLivePrReviewDraft({
        databasePath: paths.neondeckDatabase,
        repo: 'pandemicsyn/neondeck',
        prNumber: 10,
      }),
    ).toBeNull();
  });

  it('rejects facts that drift from the immutable admitted revision', async () => {
    const paths = await tempPaths();
    let reviewed = false;
    const result = await reviewPrForHuman(
      {
        reviewId: 'review-1',
        attemptId: 'attempt-1',
        ref: 'pandemicsyn/neondeck#10',
        repoFullName: 'pandemicsyn/neondeck',
        repo: 'pandemicsyn/neondeck',
        prNumber: 10,
        headSha: 'admitted-head',
        baseSha: 'base123',
        baseRef: 'main',
      },
      paths,
      {
        fetchFacts: async () => reviewFacts(),
        reviewer: async () => {
          reviewed = true;
          return reviewOutputWithOneFinding();
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('moved from the exact revision'),
    });
    expect(reviewed).toBe(false);
    await expect(listReports(paths)).resolves.toEqual([]);
  });

  it('replays a crashed report step without duplicating artifacts', async () => {
    const paths = await tempPaths();
    const steps = new Map<string, unknown>();
    let interruptReportRecording = true;
    const runEffect = async <T>(
      name: string,
      effect: () => T | Promise<T>,
    ): Promise<T> => {
      if (steps.has(name)) return steps.get(name) as T;
      const value = await effect();
      if (name === 'write-review-reports' && interruptReportRecording) {
        interruptReportRecording = false;
        throw new Error('simulated crash after report writes');
      }
      steps.set(name, value);
      return value;
    };
    const options = {
      effectId: 'review-1:attempt-1',
      runEffect,
      fetchFacts: async () => reviewFacts(),
      reviewer: async () => reviewOutputWithOneFinding(),
    };

    await expect(
      reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, options),
    ).rejects.toThrow('simulated crash');
    const firstReports = await listReports(paths, { kind: 'pr-review' });
    expect(firstReports).toHaveLength(2);

    const replayed = requireReviewAssistOk(
      await reviewPrForHuman(
        { ref: 'pandemicsyn/neondeck#10' },
        paths,
        options,
      ),
    );
    const replayedReports = await listReports(paths, { kind: 'pr-review' });
    expect(replayedReports).toHaveLength(2);
    expect(replayed.data.reports.map((report) => report.id).sort()).toEqual(
      firstReports.map((report) => report.id).sort(),
    );
  });

  it('replays crashed draft seeding without orphaning its seed ledger', async () => {
    const paths = await tempPaths();
    const steps = new Map<string, unknown>();
    let interruptSeedRecording = true;
    const runEffect = async <T>(
      name: string,
      effect: () => T | Promise<T>,
    ): Promise<T> => {
      if (steps.has(name)) return steps.get(name) as T;
      const value = await effect();
      if (name === 'seed-draft-comments' && interruptSeedRecording) {
        interruptSeedRecording = false;
        throw new Error('simulated crash after draft seeding');
      }
      steps.set(name, value);
      return value;
    };
    const options = {
      effectId: 'review-seed:attempt-1',
      runEffect,
      fetchFacts: async () => reviewFacts(),
      reviewer: async () => reviewOutputWithOneFinding(),
    };

    await expect(
      reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, options),
    ).rejects.toThrow('simulated crash');
    expect(reviewSeedCounts(paths.neondeckDatabase)).toEqual({
      comments: 1,
      seeds: 1,
    });

    await expect(
      reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, options),
    ).resolves.toMatchObject({ ok: true });
    expect(reviewSeedCounts(paths.neondeckDatabase)).toEqual({
      comments: 1,
      seeds: 1,
    });
  });

  it('replays a crashed notification step without duplicate user effects', async () => {
    const paths = await tempPaths();
    const steps = new Map<string, unknown>();
    let interruptNotificationRecording = true;
    const runEffect = async <T>(
      name: string,
      effect: () => T | Promise<T>,
    ): Promise<T> => {
      if (steps.has(name)) return steps.get(name) as T;
      const value = await effect();
      if (name === 'notify-review-ready' && interruptNotificationRecording) {
        interruptNotificationRecording = false;
        throw new Error('simulated crash after notification write');
      }
      steps.set(name, value);
      return value;
    };
    const options = {
      effectId: 'review-2:attempt-1',
      runEffect,
      fetchFacts: async () => reviewFacts(),
      reviewer: async () => reviewOutputWithOneFinding(),
    };

    await expect(
      reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, options),
    ).rejects.toThrow('simulated crash');
    await expect(
      reviewPrForHuman({ ref: 'pandemicsyn/neondeck#10' }, paths, options),
    ).resolves.toMatchObject({ ok: true });

    const notifications = await listNotifications(paths, {
      includeResolved: true,
    });
    expect(notifications).toMatchObject([
      { source: 'review-pr-for-human', occurrenceCount: 1 },
    ]);
    await expect(listWorkflowSummaries(paths)).resolves.toHaveLength(1);
  });
});

async function tempPaths() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-pr-review-assist-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  return paths;
}

async function writeRepoRegistry(path: string) {
  await writeFile(
    path,
    JSON.stringify(
      {
        repos: [
          {
            id: 'neondeck',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: '/tmp/neondeck',
            defaultBranch: 'main',
          },
        ],
      },
      null,
      2,
    ),
  );
}

function reviewFacts(): ReviewAssistFacts {
  const state: GitHubPullRequestEventState = {
    repo: 'pandemicsyn/neondeck',
    number: 10,
    url: 'https://github.com/pandemicsyn/neondeck/pull/10',
    title: 'Add review assist',
    body: 'Fixes #123 by adding review assistance facts.',
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: 'head123',
    headRef: 'feature/review',
    baseRef: 'main',
    baseSha: 'base123',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [],
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
      baseRepoPush: false,
      canLikelyPush: true,
      checkedAt: '2026-07-05T12:00:00.000Z',
    },
    isOutOfDate: false,
    fetchedAt: '2026-07-05T12:00:00.000Z',
  };
  const files: GitHubPullRequestFile[] = [
    {
      path: 'src/app.ts',
      previousPath: null,
      status: 'modified',
      additions: 2,
      deletions: 0,
      changes: 2,
      binary: false,
      generatedLike: false,
      patch: [
        '@@ -1,2 +1,3 @@',
        ' const keep = true;',
        '+const added = true;',
        ' export { keep };',
      ].join('\n'),
      truncated: false,
      sha: 'file123',
      htmlUrl: null,
      rawUrl: null,
      contentsUrl: null,
      message: null,
    },
  ];
  const diffSummary: GitHubDiffSummary = {
    files: 1,
    additions: 2,
    deletions: 0,
    binaryFiles: 0,
  };
  return {
    target: {
      repoFullName: 'pandemicsyn/neondeck',
      owner: 'pandemicsyn',
      repo: 'neondeck',
      number: 10,
    },
    state,
    files,
    diffSummary,
    source: 'local',
  };
}

function checkRun(
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
): GitHubPullRequestEventState['checkRuns'][number] {
  return {
    id,
    name,
    headSha: 'head123',
    status,
    conclusion,
    url: null,
    htmlUrl: null,
    detailsUrl: null,
    startedAt: '2026-07-05T11:00:00.000Z',
    completedAt: status === 'completed' ? '2026-07-05T11:01:00.000Z' : null,
  };
}

function requireReviewAssistOk(
  result: Awaited<ReturnType<typeof reviewPrForHuman>>,
) {
  if (!result.ok || !('data' in result)) throw new Error(result.message);
  return result;
}

function reviewOutputWithOneFinding() {
  return {
    overview: {
      summary: 'Review summary',
      changeMap: [{ path: 'src/app.ts', summary: 'Modified source file.' }],
      risks: [],
      checks: ['No failing check runs were present in fetched facts.'],
    },
    findings: [
      {
        severity: 'major',
        path: 'src/app.ts',
        anchor: { kind: 'inline', side: 'RIGHT', line: 2 },
        summary: 'Validate the new branch.',
        suggestedFix: 'Add an explicit guard.',
      },
    ],
  };
}

function reviewSeedCounts(databasePath: string) {
  const database = openDb(databasePath, { readOnly: true });
  try {
    const comments = database
      .prepare(
        "SELECT count(*) AS count FROM pr_review_draft_comments WHERE origin = 'neon';",
      )
      .get() as { count: number };
    const seeds = database
      .prepare('SELECT count(*) AS count FROM pr_review_neon_seeded_comments;')
      .get() as { count: number };
    return { comments: comments.count, seeds: seeds.count };
  } finally {
    database.close();
  }
}
