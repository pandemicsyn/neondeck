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
};

export type ReviewAssistPromptContext = {
  repoId: string | null;
  learningMemoryContext: AutomationLearningMemoryContext;
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
};

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
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prReviewAssistInputSchema, input);
  if (!parsed.success) {
    return failure('Invalid PR review assist input.', {
      errors: [v.summarize(parsed.issues)],
      requires: ['ref'],
    });
  }

  const factsResult = await readReviewFacts(parsed.output, paths, dependencies);
  if (!factsResult.ok) return factsResult.result;

  const facts = factsResult.facts;
  const repoId = await repoIdForFullName(facts.target.repoFullName, paths);
  const promptContext = {
    repoId,
    learningMemoryContext: await loadAutomationLearningMemoryContext(paths, {
      repoId,
      includeGlobal: true,
    }),
  };
  const rawOutput = await (dependencies.reviewer ?? deterministicReviewPass)(
    facts,
    promptContext,
  );
  const reviewed = v.safeParse(reviewAssistStructuredOutputSchema, rawOutput);
  if (!reviewed.success) {
    return failure('Review output did not match the expected schema.', {
      errors: [v.summarize(reviewed.issues)],
    });
  }

  const seedResult = await seedDraftComments(
    facts,
    reviewed.output,
    paths,
    reviewSeedingBlockedReason(facts),
  );
  const reports = await writeReviewReports({
    facts,
    output: reviewed.output,
    repoId,
    seedResult,
    paths,
  });
  const workflowSummary = await addWorkflowSummary(
    {
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
  );
  await addNotification(
    {
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
  if (!files || !diffSummary) {
    return {
      ok: false,
      result: failure('GitHub PR file response was incomplete.'),
    };
  }

  return { ok: true, facts: { target, state, files, diffSummary } };
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
  return {
    overview: {
      summary: `${facts.state.title} changes ${facts.diffSummary.files} file${facts.diffSummary.files === 1 ? '' : 's'} with ${facts.diffSummary.additions} addition${facts.diffSummary.additions === 1 ? '' : 's'} and ${facts.diffSummary.deletions} deletion${facts.diffSummary.deletions === 1 ? '' : 's'}.`,
      changeMap,
      risks,
      checks:
        failedChecks.length > 0
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
  if (existing?.comments.some((comment) => comment.origin === 'neon')) {
    existing = clearPrReviewNeonDraftComments({
      databasePath: paths.neondeckDatabase,
      draftId: existing.id,
    });
  }
  if (existing && existing.headSha !== facts.state.headSha) {
    existing = upsertPrReviewDraft({
      databasePath: paths.neondeckDatabase,
      repo: facts.target.repoFullName,
      prNumber: facts.target.number,
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

  const anchors = anchorsByPath(facts.files);
  const seeded: SeededFinding[] = [];
  const reportOnly: ReportOnlyFinding[] = [];
  const seedable = [];
  for (const finding of output.findings) {
    if (finding.anchor.kind === 'report-only') {
      reportOnly.push({ finding, reason: finding.anchor.reason });
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

  let draft = upsertPrReviewDraft({
    databasePath: paths.neondeckDatabase,
    repo: facts.target.repoFullName,
    prNumber: facts.target.number,
    headSha: facts.state.headSha,
    reanchorHeadSha: true,
  });
  const addedIds: string[] = [];
  try {
    for (const item of seedable) {
      const beforeIds = new Set(draft.comments.map((comment) => comment.id));
      draft = addPrReviewDraftComment({
        databasePath: paths.neondeckDatabase,
        draftId: draft.id,
        path: item.finding.path,
        side: item.anchor.side,
        line: item.anchor.line,
        startLine: item.anchor.startLine ?? null,
        startSide: item.anchor.startSide ?? null,
        body: seededCommentBody(item.finding),
        origin: 'neon',
        sourceFindingId: prReviewFindingSourceId({
          ...item.finding,
          line: findingLine(item.finding),
        }),
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
        deletePrReviewDraftComment({
          databasePath: paths.neondeckDatabase,
          commentId: id,
        });
      } catch {
        // Preserve the original seeding failure.
      }
    }
    throw error;
  }

  return { draft, seeded, reportOnly, skippedReason: null as string | null };
}

function reviewSeedingBlockedReason(facts: ReviewAssistFacts) {
  const stateTruncation = pullRequestEventStateTruncation(facts.state);
  const filePatchTruncation = facts.files.some((file) => file.truncated);
  const reasons = [
    stateTruncation.any
      ? `truncated-pr-event-facts:${stateTruncation.categories.join(',')}`
      : null,
    filePatchTruncation ? 'truncated-file-patches' : null,
  ].filter((reason): reason is string => Boolean(reason));
  return reasons.length > 0 ? reasons.join(';') : null;
}

async function writeReviewReports(input: {
  facts: ReviewAssistFacts;
  output: ReviewAssistStructuredOutput;
  repoId: string | null;
  seedResult: Awaited<ReturnType<typeof seedDraftComments>>;
  paths: RuntimePaths;
}) {
  const { facts, output, repoId, seedResult, paths } = input;
  const sourceRef = `${facts.target.repoFullName}#${facts.target.number}`;
  const generatedAt = new Date();
  const generatedAtIso = generatedAt.toISOString();
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
  const overview = await writeReport(
    {
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
  const issues = await writeReport(
    {
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
    },
    paths,
  );
  return [overview, issues];
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
  return [
    `Neon review finding (${finding.severity}${finding.confidence ? `, ${finding.confidence} confidence` : ''}): ${finding.summary}`,
    '',
    `Suggested fix: ${finding.suggestedFix}`,
    '',
    'Generated by Neon. Edit or delete before submitting the review.',
  ].join('\n');
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
