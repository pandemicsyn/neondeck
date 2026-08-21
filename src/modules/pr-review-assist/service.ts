import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { addNotification, addWorkflowSummary } from '../app-state';
import {
  addPrReviewDraftComment,
  clearPrReviewNeonDraftComments,
  deletePrReviewNeonSeedsForComments,
  deletePrReviewDraftComment,
  readLivePrReviewDraft,
  recordPrReviewNeonSeed,
  pullRequestEventStateTruncation,
  upsertPrReviewDraft,
  type GitHubDiffSummary,
  type GitHubPrReviewDraft,
  type GitHubPullRequestEventState,
  type GitHubPullRequestFile,
} from '../github';
import { getGitHubPrEventState, getGitHubPrFiles } from '../pr-events';
import type { PrEventStateDependencies, PullRequestTarget } from '../pr-events';
import { readLocalPullRequestFileDiff } from '../pr-local-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import { writeReport } from '../reports';
import {
  loadAutomationLearningMemoryContext,
  type AutomationLearningMemoryContext,
} from '../learning';
import { renderReportDeckHtml } from '../../lib/report-deck-html';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  buildPatchAnchorIndex,
  commentAnchorExists,
  type ReviewCommentAnchor,
} from '../../../shared/patch-anchors';
import type { ReportDocument } from '../../../shared/report-document';
import {
  prReviewAssistInputSchema,
  reviewAssistStructuredOutputSchema,
  type PrReviewAssistInput,
  type ReviewAssistFinding,
  type ReviewAssistStructuredOutput,
} from './schemas';
import { buildReviewReportDecks } from './report-deck';
import { prReviewFindingSourceId } from '../pr-reviews/finding-id';

export type ReviewAssistFacts = {
  target: PullRequestTarget;
  state: GitHubPullRequestEventState;
  files: GitHubPullRequestFile[];
  diffSummary: GitHubDiffSummary;
  source: 'local' | 'github';
};

export type ReviewAssistPromptContext = {
  repoId: string | null;
  learningMemoryContext: AutomationLearningMemoryContext;
};

export type PreparedPrReviewAssist = {
  input: PrReviewAssistInput;
  facts: ReviewAssistFacts;
  promptContext: ReviewAssistPromptContext;
};

export type ReviewAssistDependencies = {
  fetchFacts?: (
    input: v.InferOutput<typeof prReviewAssistInputSchema>,
    paths: RuntimePaths,
  ) => Promise<ReviewAssistFacts>;
  reviewer?: (
    facts: ReviewAssistFacts,
    context: ReviewAssistPromptContext,
  ) => Promise<unknown> | unknown;
  prEventDependencies?: PrEventStateDependencies;
  workflowRunId?: string;
  effectId?: string;
  signal?: AbortSignal;
  runEffect?: ReviewAssistEffectRunner;
  validateReviewFiles?: (
    facts: ReviewAssistFacts,
    output: ReviewAssistStructuredOutput,
    paths: RuntimePaths,
  ) => Promise<GitHubPullRequestFile[]>;
};

export type ReviewAssistEffectRunner = <T>(
  name: string,
  effect: () => T | Promise<T>,
) => Promise<T>;

type SeededFinding = {
  finding: ReviewAssistFinding;
  anchor: ReviewCommentAnchor;
  commentId: string;
};

type ReportOnlyFinding = {
  finding: ReviewAssistFinding;
  reason: string;
};

export async function reviewPrForHuman(
  input: PrReviewAssistInput,
  paths = runtimePaths(),
  dependencies: ReviewAssistDependencies = {},
) {
  const runEffect: ReviewAssistEffectRunner =
    dependencies.runEffect ?? ((_name, effect) => Promise.resolve(effect()));
  const preparation = await preparePrReviewForHuman(input, paths, {
    ...dependencies,
    runEffect,
  });
  if (!preparation.ok) return preparation.result;
  const rawOutput = await runEffect('generate-review-output', () =>
    (dependencies.reviewer ?? deterministicReviewPass)(
      preparation.prepared.facts,
      preparation.prepared.promptContext,
    ),
  );
  return completePreparedPrReviewForHuman(
    preparation.prepared,
    rawOutput,
    paths,
    { ...dependencies, runEffect },
  );
}

export async function preparePrReviewForHuman(
  input: PrReviewAssistInput,
  paths = runtimePaths(),
  dependencies: Pick<
    ReviewAssistDependencies,
    'fetchFacts' | 'prEventDependencies' | 'runEffect' | 'signal'
  > = {},
): Promise<
  | { ok: true; prepared: PreparedPrReviewAssist }
  | { ok: false; result: ReturnType<typeof failure> }
> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prReviewAssistInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      result: failure('Invalid PR review assist input.', {
        errors: [v.summarize(parsed.issues)],
        requires: ['ref'],
      }),
    };
  }
  const runEffect: ReviewAssistEffectRunner =
    dependencies.runEffect ?? ((_name, effect) => Promise.resolve(effect()));
  const factsResult = await runEffect('read-review-facts', () =>
    readReviewFacts(parsed.output, paths, dependencies),
  );
  if (!factsResult.ok) return { ok: false, result: factsResult.result };

  const facts = factsResult.facts;
  const revisionFailure = exactRevisionFailure(parsed.output, facts);
  if (revisionFailure) return { ok: false, result: revisionFailure };
  const promptContext = await runEffect('load-review-context', async () => {
    const repoId = await repoIdForFullName(facts.target.repoFullName, paths);
    return {
      repoId,
      learningMemoryContext: await loadAutomationLearningMemoryContext(paths, {
        repoId,
        includeGlobal: true,
      }),
    };
  });
  return {
    ok: true,
    prepared: { input: parsed.output, facts, promptContext },
  };
}

export async function completePreparedPrReviewForHuman(
  prepared: PreparedPrReviewAssist,
  rawOutput: unknown,
  paths = runtimePaths(),
  dependencies: Pick<
    ReviewAssistDependencies,
    | 'workflowRunId'
    | 'effectId'
    | 'signal'
    | 'runEffect'
    | 'validateReviewFiles'
  > = {},
) {
  await ensureRuntimeHome(paths);
  const runEffect: ReviewAssistEffectRunner =
    dependencies.runEffect ?? ((_name, effect) => Promise.resolve(effect()));
  const { facts, promptContext } = prepared;
  const repoId = promptContext.repoId;
  const reviewed = v.safeParse(reviewAssistStructuredOutputSchema, rawOutput);
  if (!reviewed.success) {
    return failure('Review output did not match the expected schema.', {
      errors: [v.summarize(reviewed.issues)],
    });
  }

  const seedResult = await runEffect('seed-draft-comments', () =>
    seedDraftComments(
      facts,
      reviewed.output,
      paths,
      reviewSeedingBlockedReason(facts),
      dependencies.effectId,
      dependencies.signal,
      dependencies.validateReviewFiles,
    ),
  );
  const generatedAt = await runEffect('review-generated-at', () =>
    Promise.resolve(new Date().toISOString()),
  );
  const reports = await runEffect('write-review-reports', () =>
    writeReviewReports({
      facts,
      output: reviewed.output,
      repoId,
      seedResult,
      paths,
      generatedAt,
      overviewId: stableEffectId(dependencies.effectId, 'overview-report'),
      issuesId: stableEffectId(dependencies.effectId, 'issues-report'),
      signal: dependencies.signal,
    }),
  );
  const workflowSummary = await runEffect('write-workflow-summary', () =>
    addWorkflowSummary(
      {
        id: stableEffectId(dependencies.effectId, 'workflow-summary'),
        signal: dependencies.signal,
        workflow: 'review-pr-for-human',
        ...(dependencies.workflowRunId
          ? { runId: dependencies.workflowRunId }
          : {}),
        status: 'completed',
        summary: {
          message: `Prepared review reports for ${facts.target.repoFullName}#${facts.target.number}.`,
          repoId,
          repoFullName: facts.target.repoFullName,
          prNumber: facts.target.number,
          headSha: facts.state.headSha,
          findingCount: reviewed.output.findings.length,
          seededCount: seedResult.seeded.length,
          reportOnlyCount: seedResult.reportOnly.length,
          skippedSeedingReason: seedResult.skippedReason,
          reportIds: reports.map((report) => report.id),
          memoryIds: promptContext.learningMemoryContext.memoryIds,
        },
      },
      paths,
    ),
  );
  await runEffect('notify-review-ready', () =>
    addNotification(
      {
        id: stableEffectId(dependencies.effectId, 'ready-notification'),
        signal: dependencies.signal,
        level: 'ready',
        title: 'PR review ready',
        message: `Neon prepared ${reports.length} report${reports.length === 1 ? '' : 's'} and ${seedResult.seeded.length} draft comment${seedResult.seeded.length === 1 ? '' : 's'} for ${facts.target.repoFullName}#${facts.target.number}.`,
        source: 'review-pr-for-human',
        sourceId: `${facts.target.repoFullName}#${facts.target.number}:${facts.state.headSha}`,
        data: {
          workflow: 'review-pr-for-human',
          repo: facts.target.repoFullName,
          prNumber: facts.target.number,
          reportIds: reports.map((report) => report.id),
          reportUrls: reports.map((report) => `/reports/${report.id}`),
          reviewUrl: reviewSurfaceUrl(facts.target),
          seededCount: seedResult.seeded.length,
          reportOnlyCount: seedResult.reportOnly.length,
          skippedSeedingReason: seedResult.skippedReason,
        },
      },
      paths,
    ),
  );

  return {
    ok: true,
    action: 'pr_review_assist' as const,
    changed: true,
    message: `Prepared review assist artifacts for ${facts.target.repoFullName}#${facts.target.number}.`,
    data: {
      workflow: 'review-pr-for-human',
      target: {
        repoFullName: facts.target.repoFullName,
        owner: facts.target.owner,
        repo: facts.target.repo,
        number: facts.target.number,
      },
      headSha: facts.state.headSha,
      reports: reports.map((report) => ({
        id: report.id,
        title: report.title,
        url: `/reports/${report.id}`,
      })),
      reviewUrl: reviewSurfaceUrl(facts.target),
      findingCount: reviewed.output.findings.length,
      seededCount: seedResult.seeded.length,
      reportOnlyCount: seedResult.reportOnly.length,
      reportOnlyFindings: seedResult.reportOnly.map((item) => ({
        sourceId: prReviewFindingSourceId({
          ...item.finding,
          line: findingLine(item.finding),
        }),
        severity: item.finding.severity,
        path: item.finding.path,
        line: findingLine(item.finding),
        summary: item.finding.summary,
        suggestedFix: item.finding.suggestedFix,
        reason: item.reason,
      })),
      skippedSeedingReason: seedResult.skippedReason,
      seededCommentIds: seedResult.seeded.map((item) => item.commentId),
      draftId: seedResult.draft?.id ?? null,
    },
    workflowSummary,
  };
}

async function readReviewFacts(
  input: v.InferOutput<typeof prReviewAssistInputSchema>,
  paths: RuntimePaths,
  dependencies: ReviewAssistDependencies,
): Promise<
  | { ok: true; facts: ReviewAssistFacts }
  | { ok: false; result: ReturnType<typeof failure> }
> {
  if (dependencies.fetchFacts) {
    return { ok: true, facts: await dependencies.fetchFacts(input, paths) };
  }

  const stateResult = await getGitHubPrEventState(
    input,
    paths,
    dependencies.prEventDependencies,
  );
  if (!stateResult.ok) {
    return { ok: false, result: fromPrEventFailure(stateResult) };
  }
  const stateData = objectField(stateResult.data);
  const target = targetField(stateData.target);
  const state = stateData.state as GitHubPullRequestEventState | undefined;
  if (!target || !state) {
    return {
      ok: false,
      result: failure('GitHub PR event state response was incomplete.'),
    };
  }

  const filesResult = await getGitHubPrFiles(
    {
      repo: target.repoFullName,
      prNumber: target.number,
      headSha: state.headSha,
      baseSha: state.baseSha,
      baseRef: state.baseRef,
    },
    paths,
    dependencies.prEventDependencies,
  );
  if (!filesResult.ok) {
    return { ok: false, result: fromPrEventFailure(filesResult) };
  }
  const filesData = objectField(filesResult.data);
  const files = Array.isArray(filesData.files)
    ? (filesData.files as GitHubPullRequestFile[])
    : null;
  const diffSummary = filesData.diffSummary as GitHubDiffSummary | undefined;
  const source = filesData.source === 'local' ? 'local' : 'github';
  if (!files || !diffSummary) {
    return {
      ok: false,
      result: failure('GitHub PR file response was incomplete.'),
    };
  }

  return { ok: true, facts: { target, state, files, diffSummary, source } };
}

function deterministicReviewPass(
  facts: ReviewAssistFacts,
  _context?: ReviewAssistPromptContext,
): ReviewAssistStructuredOutput {
  const changeMap = facts.files.map((file) => ({
    path: file.path,
    summary: `${file.status}; +${file.additions}/-${file.deletions}${file.truncated ? '; patch truncated' : ''}${file.binary ? '; binary' : ''}.`,
    risk: file.generatedLike
      ? 'Generated-like file; verify the source change instead of reviewing the output in isolation.'
      : file.binary
        ? 'Binary file; manual inspection required.'
        : file.truncated
          ? 'Patch is truncated; review may be incomplete.'
          : undefined,
  }));
  const risks = changeMap
    .map((item) => item.risk)
    .filter((risk): risk is string => Boolean(risk));
  const checkRuns = facts.state.checkRuns ?? [];
  const failedChecks = checkRuns.filter(
    (check) => check.conclusion && check.conclusion !== 'success',
  );
  const unavailableChecks = [
    facts.state.checkSuitesUnavailableReason,
    facts.state.checkRunsUnavailableReason,
  ].filter((reason): reason is string => Boolean(reason));
  return {
    overview: {
      summary: `${facts.state.title} changes ${facts.diffSummary.files} file${facts.diffSummary.files === 1 ? '' : 's'} with ${facts.diffSummary.additions} addition${facts.diffSummary.additions === 1 ? '' : 's'} and ${facts.diffSummary.deletions} deletion${facts.diffSummary.deletions === 1 ? '' : 's'}.`,
      changeMap,
      risks,
      checks:
        unavailableChecks.length > 0
          ? [
              `GitHub Checks were unavailable: ${[...new Set(unavailableChecks)].join('; ')}`,
            ]
          : failedChecks.length > 0
            ? failedChecks.map(
                (check) =>
                  `${check.name}: ${check.conclusion ?? check.status ?? 'unknown'}`,
              )
            : ['No failing check runs were present in fetched facts.'],
    },
    findings: [],
  };
}

async function seedDraftComments(
  facts: ReviewAssistFacts,
  output: ReviewAssistStructuredOutput,
  paths: RuntimePaths,
  seedingBlockedReason: string | null,
  effectId?: string,
  signal?: AbortSignal,
  validateReviewFiles = reviewValidationFiles,
) {
  let existing = readLivePrReviewDraft({
    databasePath: paths.neondeckDatabase,
    repo: facts.target.repoFullName,
    prNumber: facts.target.number,
  });
  if (seedingBlockedReason) {
    return {
      draft: existing,
      seeded: [] as SeededFinding[],
      reportOnly: output.findings.map((finding) => ({
        finding,
        reason: seedingBlockedReason,
      })),
      skippedReason: seedingBlockedReason,
    };
  }
  if (existing && draftHasHumanWork(existing)) {
    return {
      draft: existing,
      seeded: [] as SeededFinding[],
      reportOnly: output.findings.map((finding) => ({
        finding,
        reason: 'existing-human-draft',
      })),
      skippedReason: 'existing-human-draft',
    };
  }
  const validationFiles = await validateReviewFiles(facts, output, paths);
  signal?.throwIfAborted();
  existing = readLivePrReviewDraft({
    databasePath: paths.neondeckDatabase,
    repo: facts.target.repoFullName,
    prNumber: facts.target.number,
  });
  if (existing && draftHasHumanWork(existing)) {
    return {
      draft: existing,
      seeded: [] as SeededFinding[],
      reportOnly: output.findings.map((finding) => ({
        finding,
        reason: 'existing-human-draft',
      })),
      skippedReason: 'existing-human-draft',
    };
  }
  if (existing?.comments.some((comment) => comment.origin === 'neon')) {
    existing = clearPrReviewNeonDraftComments({
      databasePath: paths.neondeckDatabase,
      draftId: existing.id,
      expectedDraftRevision: existing.revision,
    });
  }
  if (existing && existing.headSha !== facts.state.headSha) {
    existing = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: facts.target.repoFullName,
      prNumber: facts.target.number,
      draftId: existing.id,
      expectedRevision: existing.revision,
      headSha: facts.state.headSha,
      reanchorHeadSha: true,
    });
  }
  if (existing && existing.comments.length > 0) {
    return {
      draft: existing,
      seeded: [] as SeededFinding[],
      reportOnly: output.findings.map((finding) => ({
        finding,
        reason: 'existing-draft-comments',
      })),
      skippedReason: 'existing-draft-comments',
    };
  }
  const anchors = anchorsByPath(validationFiles);
  const filesByPath = new Map(validationFiles.map((file) => [file.path, file]));
  const seeded: SeededFinding[] = [];
  const reportOnly: ReportOnlyFinding[] = [];
  const seedable = [];
  for (const finding of output.findings) {
    if (finding.anchor.kind === 'report-only') {
      reportOnly.push({ finding, reason: finding.anchor.reason });
      continue;
    }
    if (filesByPath.get(finding.path)?.truncated) {
      reportOnly.push({ finding, reason: 'file-diff-truncated' });
      continue;
    }
    const anchor = findingAnchor(finding);
    const index = anchors.get(finding.path);
    if (!anchor || !index || !commentAnchorExists(index, anchor)) {
      reportOnly.push({ finding, reason: 'unanchorable' });
      continue;
    }
    seedable.push({ finding, anchor });
  }

  if (seedable.length === 0) {
    return {
      draft: existing,
      seeded,
      reportOnly,
      skippedReason: null as string | null,
    };
  }

  let draft =
    existing ??
    upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: facts.target.repoFullName,
      prNumber: facts.target.number,
      headSha: facts.state.headSha,
      expectedAbsent: true,
    });
  const addedIds: string[] = [];
  try {
    for (const [index, item] of seedable.entries()) {
      const beforeIds = new Set(draft.comments.map((comment) => comment.id));
      const sourceFindingId = prReviewFindingSourceId({
        ...item.finding,
        line: findingLine(item.finding),
      });
      draft = addPrReviewDraftComment({
        id: stableEffectId(
          effectId,
          `draft-comment:${index}:${sourceFindingId}`,
        ),
        databasePath: paths.neondeckDatabase,
        draftId: draft.id,
        expectedDraftRevision: draft.revision,
        path: item.finding.path,
        side: item.anchor.side,
        line: item.anchor.line,
        startLine: item.anchor.startLine ?? null,
        startSide: item.anchor.startSide ?? null,
        body: seededCommentBody(item.finding),
        origin: 'neon',
        sourceFindingId,
      });
      const added = draft.comments.find(
        (comment) => !beforeIds.has(comment.id),
      );
      if (added) {
        addedIds.push(added.id);
        recordPrReviewNeonSeed({
          databasePath: paths.neondeckDatabase,
          draft,
          comment: added,
          severity: item.finding.severity,
          summary: item.finding.summary,
          source: 'review-pr-for-human',
        });
        seeded.push({ ...item, commentId: added.id });
      }
    }
  } catch (error) {
    try {
      deletePrReviewNeonSeedsForComments({
        databasePath: paths.neondeckDatabase,
        commentIds: addedIds,
      });
    } catch {
      // Preserve the original seeding failure.
    }
    for (const id of addedIds) {
      try {
        draft = deletePrReviewDraftComment({
          databasePath: paths.neondeckDatabase,
          commentId: id,
          expectedDraftId: draft.id,
          expectedDraftRevision: draft.revision,
        });
      } catch {
        // Preserve the original seeding failure.
      }
    }
    throw error;
  }

  return { draft, seeded, reportOnly, skippedReason: null as string | null };
}

async function reviewValidationFiles(
  facts: ReviewAssistFacts,
  output: ReviewAssistStructuredOutput,
  paths: RuntimePaths,
) {
  const findingPaths = new Set(
    output.findings
      .filter((finding) => finding.anchor.kind === 'inline')
      .map((finding) => finding.path),
  );
  const truncatedPaths = [
    ...new Set(
      facts.files
        .filter((file) => file.truncated && findingPaths.has(file.path))
        .map((file) => file.path),
    ),
  ];
  if (truncatedPaths.length === 0) return facts.files;

  const exactFiles = new Map<string, GitHubPullRequestFile>();
  let nextPathIndex = 0;
  const worker = async () => {
    while (nextPathIndex < truncatedPaths.length) {
      const path = truncatedPaths[nextPathIndex];
      nextPathIndex += 1;
      if (!path) continue;
      try {
        const exact = await readLocalPullRequestFileDiff(
          {
            owner: facts.target.owner,
            repo: facts.target.repo,
            number: facts.target.number,
            headSha: facts.state.headSha,
            baseSha: facts.state.baseSha,
            baseRef: facts.state.baseRef,
            path,
            maxPatchBytes: 16 * 1024 * 1024,
          },
          paths,
        );
        if (exact.file) exactFiles.set(path, exact.file);
      } catch {
        // Preserve the bounded source patch and keep the finding report-only.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(3, truncatedPaths.length) }, () => worker()),
  );
  return facts.files.map((file) => exactFiles.get(file.path) ?? file);
}

function reviewSeedingBlockedReason(facts: ReviewAssistFacts) {
  const stateTruncation = pullRequestEventStateTruncation(facts.state);
  const reasons = [
    stateTruncation.any
      ? `truncated-pr-event-facts:${stateTruncation.categories.join(',')}`
      : null,
  ].filter((reason): reason is string => Boolean(reason));
  return reasons.length > 0 ? reasons.join(';') : null;
}

async function writeReviewReports(input: {
  facts: ReviewAssistFacts;
  output: ReviewAssistStructuredOutput;
  repoId: string | null;
  seedResult: Awaited<ReturnType<typeof seedDraftComments>>;
  paths: RuntimePaths;
  generatedAt: string;
  overviewId?: string;
  issuesId?: string;
  signal?: AbortSignal;
}) {
  const { facts, output, repoId, seedResult, paths } = input;
  const sourceRef = `${facts.target.repoFullName}#${facts.target.number}`;
  const generatedAtIso = input.generatedAt;
  const decks = buildReviewReportDecks({
    sourceRef,
    state: facts.state,
    files: facts.files,
    output,
    seededFindings: seedResult.seeded.map((item) => ({
      finding: item.finding,
      line: item.anchor.line,
    })),
    reportOnlyFindings: seedResult.reportOnly,
    generatedAt: generatedAtIso,
  });
  const overviewDocument: ReportDocument = {
    eyebrow: 'PR REVIEW',
    title: `PR Overview: ${sourceRef}`,
    summary: output.overview.summary,
    generatedAt: generatedAtIso,
    sections: [
      {
        title: 'Pull Request',
        body: null,
        items: [
          { label: 'title', value: facts.state.title },
          { label: 'state', value: facts.state.state },
          { label: 'base', value: facts.state.baseRef },
          { label: 'head', value: facts.state.headSha },
          { label: 'url', value: facts.state.url },
        ],
      },
      {
        title: 'Change Map',
        body: null,
        items: output.overview.changeMap.map((item) => ({
          label: item.path,
          value: [item.summary, item.risk].filter(Boolean).join('\n'),
        })),
      },
      {
        title: 'Checks, Risks, And Next Actions',
        body: null,
        items: [
          ...output.overview.checks.map((check, index) => ({
            label: `check ${index + 1}`,
            value: check,
          })),
          ...output.overview.risks.map((risk, index) => ({
            label: `risk ${index + 1}`,
            value: risk,
          })),
          ...(output.overview.nextActions ?? []).map((action, index) => ({
            label: `next action ${index + 1}`,
            value: action,
          })),
        ],
      },
    ],
  };
  input.signal?.throwIfAborted();
  const overview = await writeReport(
    {
      id: input.overviewId,
      signal: input.signal,
      kind: 'pr-review',
      title: `PR Overview: ${sourceRef}`,
      repoId,
      sourceRef,
      createdBy: 'review-pr-for-human',
      summary: {
        report: 'overview',
        workflow: 'review-pr-for-human',
        repo: facts.target.repoFullName,
        prNumber: facts.target.number,
        headSha: facts.state.headSha,
        findingCount: output.findings.length,
        deck: decks.overview.document,
        deckOverflow: decks.overview.overflowUsed,
        presentationWarnings: decks.presentationWarnings,
        document: overviewDocument,
      },
      html: renderReportDeckHtml(decks.overview.document),
      createdAt: generatedAtIso,
    },
    paths,
  );
  const issuesDocument: ReportDocument = {
    eyebrow: 'PR REVIEW',
    title: `Review Issues: ${sourceRef}`,
    summary:
      output.findings.length === 0
        ? 'No structured review findings were produced.'
        : `${output.findings.length} structured finding${output.findings.length === 1 ? '' : 's'}; ${seedResult.seeded.length} seeded as local draft comment${seedResult.seeded.length === 1 ? '' : 's'}.`,
    generatedAt: generatedAtIso,
    sections: [
      {
        title: 'Seeded Draft Comments',
        body: seedResult.skippedReason
          ? `Draft seeding skipped: ${seedResult.skippedReason}.`
          : null,
        items:
          seedResult.seeded.length > 0
            ? seedResult.seeded.map((item) => ({
                label: `${item.finding.severity} ${item.finding.path}:${item.anchor.line}`,
                value: item.finding.summary,
              }))
            : [{ label: 'seeded', value: 'No findings were seeded.' }],
      },
      {
        title: 'Report-Only Findings',
        body: null,
        items:
          seedResult.reportOnly.length > 0
            ? seedResult.reportOnly.map((item) => ({
                label: `${item.finding.severity} ${item.finding.path}`,
                value: `${item.reason}\n${item.finding.summary}\nSuggested fix: ${item.finding.suggestedFix}`,
              }))
            : [
                {
                  label: 'report-only',
                  value: 'No report-only findings.',
                },
              ],
      },
    ],
  };
  input.signal?.throwIfAborted();
  const issues = await writeReport(
    {
      id: input.issuesId,
      signal: input.signal,
      kind: 'pr-review',
      title: `Review Issues: ${sourceRef}`,
      repoId,
      sourceRef,
      createdBy: 'review-pr-for-human',
      summary: {
        report: 'issues',
        workflow: 'review-pr-for-human',
        repo: facts.target.repoFullName,
        prNumber: facts.target.number,
        headSha: facts.state.headSha,
        findingCount: output.findings.length,
        seededCount: seedResult.seeded.length,
        reportOnlyCount: seedResult.reportOnly.length,
        deck: decks.issues.document,
        deckOverflow: decks.issues.overflowUsed,
        presentationWarnings: decks.presentationWarnings,
        document: issuesDocument,
      },
      html: renderReportDeckHtml(decks.issues.document),
      createdAt: generatedAtIso,
    },
    paths,
  );
  return [overview, issues];
}

function exactRevisionFailure(
  input: v.InferOutput<typeof prReviewAssistInputSchema>,
  facts: ReviewAssistFacts,
) {
  if (!input.reviewId) return null;
  const matches =
    input.repoFullName?.toLowerCase() ===
      facts.target.repoFullName.toLowerCase() &&
    input.prNumber === facts.target.number &&
    input.headSha === facts.state.headSha &&
    input.baseSha === facts.state.baseSha &&
    input.baseRef === facts.state.baseRef;
  return matches
    ? null
    : failure(
        `Pull request ${input.repoFullName}#${input.prNumber} moved from the exact revision admitted for this review attempt. Start a new review.`,
      );
}

function stableEffectId(effectId: string | undefined, purpose: string) {
  if (!effectId) return undefined;
  return createHash('sha256')
    .update(`pr-review-assist:${effectId}:${purpose}`)
    .digest('hex');
}

function anchorsByPath(files: GitHubPullRequestFile[]) {
  return new Map(
    files.map((file) => [file.path, buildPatchAnchorIndex(file.patch)]),
  );
}

function findingAnchor(
  finding: ReviewAssistFinding,
): ReviewCommentAnchor | null {
  if (finding.anchor.kind !== 'inline') return null;
  return {
    side: finding.anchor.side,
    line: finding.anchor.line,
    startLine: finding.anchor.startLine ?? null,
    startSide: finding.anchor.startSide ?? null,
  };
}

function findingLine(finding: ReviewAssistFinding) {
  return finding.anchor.kind === 'inline' ? finding.anchor.line : null;
}

function seededCommentBody(finding: ReviewAssistFinding) {
  return [finding.summary, '', `Suggested fix: ${finding.suggestedFix}`].join(
    '\n',
  );
}

function draftHasHumanWork(draft: GitHubPrReviewDraft) {
  return Boolean(
    draft.body?.trim() ||
    draft.verdict ||
    draft.comments.some((comment) => comment.origin === 'human'),
  );
}

async function repoIdForFullName(fullName: string, paths: RuntimePaths) {
  const registry = await readRepoRegistrySnapshot(paths);
  return (
    registry.repos.find(
      (repo) => repoFullName(repo).toLowerCase() === fullName.toLowerCase(),
    )?.id ?? null
  );
}

function reviewSurfaceUrl(target: PullRequestTarget) {
  const params = new URLSearchParams({
    repo: target.repoFullName,
    number: String(target.number),
  });
  return `/review?${params.toString()}`;
}

function fromPrEventFailure(result: {
  message: string;
  errors?: string[];
  requires?: string[];
}) {
  return failure(result.message, {
    errors: result.errors,
    requires: result.requires,
  });
}

function failure(
  message: string,
  options: { errors?: string[]; requires?: string[] } = {},
) {
  return {
    ok: false,
    action: 'pr_review_assist' as const,
    changed: false,
    message,
    errors: options.errors,
    requires: options.requires,
  };
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function targetField(value: unknown): PullRequestTarget | null {
  const target = objectField(value);
  const repoFullName =
    typeof target.repoFullName === 'string' ? target.repoFullName : null;
  const owner = typeof target.owner === 'string' ? target.owner : null;
  const repo = typeof target.repo === 'string' ? target.repo : null;
  const number = typeof target.number === 'number' ? target.number : null;
  if (!repoFullName || !owner || !repo || !number) return null;
  return { repoFullName, owner, repo, number };
}
