import * as v from 'valibot';
import { addNotification, addWorkflowSummary } from '../app-state';
import {
  addPrReviewDraftComment,
  deletePrReviewDraftComment,
  readLivePrReviewDraft,
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
import { renderReportHtml } from '../../lib/report-html';
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
import {
  prReviewAssistInputSchema,
  reviewAssistStructuredOutputSchema,
  type PrReviewAssistInput,
  type ReviewAssistFinding,
  type ReviewAssistStructuredOutput,
} from './schemas';

export type ReviewAssistFacts = {
  target: PullRequestTarget;
  state: GitHubPullRequestEventState;
  files: GitHubPullRequestFile[];
  diffSummary: GitHubDiffSummary;
};

export type ReviewAssistDependencies = {
  fetchFacts?: (
    input: v.InferOutput<typeof prReviewAssistInputSchema>,
    paths: RuntimePaths,
  ) => Promise<ReviewAssistFacts>;
  reviewer?: (facts: ReviewAssistFacts) => Promise<unknown> | unknown;
  prEventDependencies?: PrEventStateDependencies;
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

  const rawOutput = await (dependencies.reviewer ?? deterministicReviewPass)(
    factsResult.facts,
  );
  const reviewed = v.safeParse(reviewAssistStructuredOutputSchema, rawOutput);
  if (!reviewed.success) {
    return failure('Review output did not match the expected schema.', {
      errors: [v.summarize(reviewed.issues)],
    });
  }

  const facts = factsResult.facts;
  const repoId = await repoIdForFullName(facts.target.repoFullName, paths);
  const seedResult = await seedDraftComments(facts, reviewed.output, paths);
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
) {
  const existing = readLivePrReviewDraft({
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
      });
      const added = draft.comments.find(
        (comment) => !beforeIds.has(comment.id),
      );
      if (added) {
        addedIds.push(added.id);
        seeded.push({ ...item, commentId: added.id });
      }
    }
  } catch (error) {
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
      },
      html: renderReportHtml({
        eyebrow: 'PR REVIEW',
        title: `PR Overview: ${sourceRef}`,
        summary: output.overview.summary,
        generatedAt,
        sections: [
          {
            title: 'Pull Request',
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
            items: output.overview.changeMap.map((item) => ({
              label: item.path,
              value: [item.summary, item.risk].filter(Boolean).join('\n'),
            })),
          },
          {
            title: 'Checks And Risks',
            items: [
              ...output.overview.checks.map((check, index) => ({
                label: `check ${index + 1}`,
                value: check,
              })),
              ...output.overview.risks.map((risk, index) => ({
                label: `risk ${index + 1}`,
                value: risk,
              })),
            ],
          },
        ],
      }),
    },
    paths,
  );
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
      },
      html: renderReportHtml({
        eyebrow: 'PR REVIEW',
        title: `Review Issues: ${sourceRef}`,
        summary:
          output.findings.length === 0
            ? 'No structured review findings were produced.'
            : `${output.findings.length} structured finding${output.findings.length === 1 ? '' : 's'}; ${seedResult.seeded.length} seeded as local draft comment${seedResult.seeded.length === 1 ? '' : 's'}.`,
        generatedAt,
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
            items:
              seedResult.reportOnly.length > 0
                ? seedResult.reportOnly.map((item) => ({
                    label: `${item.finding.severity} ${item.finding.path}`,
                    value: `${item.reason}\n${item.finding.summary}\nSuggested fix: ${item.finding.suggestedFix}`,
                  }))
                : [{ label: 'report-only', value: 'No report-only findings.' }],
          },
        ],
      }),
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
  if (!finding.line) return null;
  return {
    side: finding.side ?? 'RIGHT',
    line: finding.line,
    startLine: finding.startLine ?? null,
    startSide: finding.startSide ?? null,
  };
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
    prReviewRepo: target.repoFullName,
    prReviewNumber: String(target.number),
  });
  return `/?${params.toString()}`;
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
