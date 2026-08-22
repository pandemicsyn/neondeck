import * as v from 'valibot';
import { asJsonValue } from '../../lib/action-result';
import { renderReportHtml } from '../../lib/report-html';
import {
  runtimePaths,
  type RepoConfig,
  type RuntimePaths,
} from '../../runtime-home';
import {
  fetchFailingCheckFacts,
  pullRequestEventStateIncompleteness,
  type GitHubFailingCheckFact,
  type GitHubPullRequestEventState,
} from '../github';
import { getGitHubPrEventState, type PullRequestTarget } from '../pr-events';
import type { PrEventStateDependencies } from '../pr-events';
import { writeReport } from '../reports';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import { identifyLikelyCommands } from './github-facts';
import { errorMessage } from './utils';

const nonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

export const ciFixReportInputSchema = v.object({
  ref: v.optional(nonEmptyStringSchema),
  repo: v.optional(nonEmptyStringSchema),
  prNumber: v.optional(positiveIntegerSchema),
  maxLogBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * 1024)),
  ),
});

export type CiFixReportInput = v.InferInput<typeof ciFixReportInputSchema>;

type CiFixDossier = {
  target: PullRequestTarget;
  state: GitHubPullRequestEventState;
  repo: RepoConfig | null;
  failingChecks: GitHubFailingCheckFact[];
  failingCheckFactsError: string | null;
  likelyCommands: string[];
};

export type CiFixReportDependencies = {
  fetchFailingCheckFacts?: typeof fetchFailingCheckFacts;
  prEventDependencies?: PrEventStateDependencies;
};

export async function createCiFailureDossierReport(
  rawInput: CiFixReportInput,
  paths = runtimePaths(),
  dependencies: CiFixReportDependencies = {},
) {
  const parsed = v.safeParse(ciFixReportInputSchema, rawInput);
  if (!parsed.success) return invalidInput(v.summarize(parsed.issues));
  if (!parsed.output.ref && (!parsed.output.repo || !parsed.output.prNumber)) {
    return invalidInput('A PR reference or repo/prNumber is required.');
  }

  const result = await readDossier(parsed.output, paths, dependencies);
  if (!result.ok) return result.result;
  const report = await writeCiFixDossierReport(result.dossier, paths);
  return {
    ok: true,
    action: 'ci_fix_report' as const,
    changed: true,
    message: `Wrote CI failure dossier report for ${sourceRef(result.dossier)}.`,
    report,
    data: asJsonValue({
      report: {
        id: report.id,
        title: report.title,
        url: `/reports/${report.id}`,
      },
      dossier: dossierSummary(result.dossier),
      workflow: 'explain-ci',
      mode: 'report-only',
    }),
  };
}

async function readDossier(
  input: v.InferOutput<typeof ciFixReportInputSchema>,
  paths: RuntimePaths,
  dependencies: CiFixReportDependencies,
): Promise<
  | { ok: true; dossier: CiFixDossier }
  | { ok: false; result: ReturnType<typeof failure> }
> {
  const stateResult = await getGitHubPrEventState(
    { ref: input.ref, repo: input.repo, prNumber: input.prNumber },
    paths,
    dependencies.prEventDependencies,
  );
  if (!stateResult.ok) {
    return { ok: false, result: failure(stateResult.message, stateResult) };
  }
  const data = objectField(stateResult.data);
  const target = targetField(data.target);
  const state = data.state as GitHubPullRequestEventState | undefined;
  if (!target || !state) {
    return {
      ok: false,
      result: failure('GitHub PR event state response was incomplete.'),
    };
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false,
      result: failure('GITHUB_TOKEN is not configured.', {
        requires: ['GITHUB_TOKEN'],
      }),
    };
  }

  let failingChecks: GitHubFailingCheckFact[] = [];
  let failingCheckFactsError: string | null = null;
  try {
    failingChecks = await (
      dependencies.fetchFailingCheckFacts ?? fetchFailingCheckFacts
    )({
      token,
      owner: target.owner,
      repo: target.repo,
      ref: state.headSha,
      maxLogBytes: input.maxLogBytes ?? 64 * 1024,
    });
  } catch (error) {
    failingCheckFactsError = errorMessage(error);
  }
  const registry = await readRepoRegistrySnapshot(paths);
  const repo =
    registry.repos.find(
      (candidate) =>
        repoFullName(candidate).toLowerCase() ===
        target.repoFullName.toLowerCase(),
    ) ?? null;
  return {
    ok: true,
    dossier: {
      target,
      state,
      repo,
      failingChecks,
      failingCheckFactsError,
      likelyCommands: repo
        ? identifyLikelyCommands(failingChecks, repo, [], undefined, undefined)
        : [],
    },
  };
}

async function writeCiFixDossierReport(
  dossier: CiFixDossier,
  paths: RuntimePaths,
) {
  const incompleteness = pullRequestEventStateIncompleteness(dossier.state);
  const logError = incompleteLogFactsError(dossier);
  return writeReport(
    {
      kind: 'ci-fix',
      title: `CI Failure Dossier: ${sourceRef(dossier)}`,
      repoId: dossier.repo?.id ?? null,
      sourceRef: sourceRef(dossier),
      createdBy: 'explain-ci',
      summary: {
        workflow: 'explain-ci',
        repo: dossier.target.repoFullName,
        prNumber: dossier.target.number,
        headSha: dossier.state.headSha,
        failedCheckCount: dossier.failingChecks.length,
        failingCheckFactsError: dossier.failingCheckFactsError,
        failingCheckLogFactsError: logError,
        likelyCommands: dossier.likelyCommands.slice(0, 5),
        truncation: incompleteness,
      },
      html: renderReportHtml({
        eyebrow: 'CI',
        title: `CI Failure Dossier: ${sourceRef(dossier)}`,
        summary:
          dossier.failingCheckFactsError || logError
            ? 'Failing GitHub check facts could not be completely collected; this CI dossier is partial.'
            : `${dossier.failingChecks.length} failing check run${dossier.failingChecks.length === 1 ? '' : 's'} found for ${dossier.state.headSha.slice(0, 12)}.`,
        generatedAt: new Date(),
        sections: [
          {
            title: 'Pull Request',
            items: [
              { label: 'title', value: dossier.state.title },
              { label: 'state', value: dossier.state.state },
              { label: 'base', value: dossier.state.baseRef },
              { label: 'head', value: dossier.state.headSha },
              { label: 'url', value: dossier.state.url },
              {
                label: 'incomplete facts',
                value: incompleteness.any
                  ? incompleteness.categories.join(', ')
                  : 'none',
              },
            ],
          },
          {
            title: 'Failing Checks',
            items: dossier.failingChecks.length
              ? dossier.failingChecks.map((check) => ({
                  label: check.name,
                  value: checkReportValue(check),
                }))
              : [
                  {
                    label: 'checks',
                    value:
                      dossier.failingCheckFactsError ??
                      'No failing checks found.',
                  },
                ],
          },
          {
            title: 'Likely Local Commands',
            items: dossier.likelyCommands.length
              ? dossier.likelyCommands.map((command, index) => ({
                  label: `command ${index + 1}`,
                  value: command,
                }))
              : [
                  {
                    label: 'commands',
                    value:
                      'No likely local validation command was inferred from configured scripts and failing checks.',
                  },
                ],
          },
        ],
      }),
    },
    paths,
  );
}

function checkReportValue(check: GitHubFailingCheckFact) {
  return [
    `status: ${check.status}`,
    `conclusion: ${check.conclusion ?? 'unknown'}`,
    check.outputTitle ? `title: ${check.outputTitle}` : null,
    check.outputSummary
      ? `summary: ${truncate(check.outputSummary, 2_000)}`
      : null,
    check.outputText ? `output: ${truncate(check.outputText, 4_000)}` : null,
    check.log.available && check.log.text
      ? `log excerpt${check.log.truncated ? ' (truncated)' : ''}:\n${truncate(check.log.text, 6_000)}`
      : `log unavailable: ${check.log.unavailableReason ?? 'not available'}`,
    check.htmlUrl ? `url: ${check.htmlUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function sourceRef(dossier: CiFixDossier) {
  return `${dossier.target.repoFullName}#${dossier.target.number}`;
}

function dossierSummary(dossier: CiFixDossier) {
  return {
    repo: dossier.target.repoFullName,
    prNumber: dossier.target.number,
    headSha: dossier.state.headSha,
    failedCheckCount: dossier.failingChecks.length,
    failingCheckFactsError: dossier.failingCheckFactsError,
    failingCheckLogFactsError: incompleteLogFactsError(dossier),
    likelyCommands: dossier.likelyCommands.slice(0, 5),
    truncation: pullRequestEventStateIncompleteness(dossier.state),
  };
}

function incompleteLogFactsError(dossier: CiFixDossier) {
  const incomplete = dossier.failingChecks.filter(
    (check) => !check.log.available || check.log.truncated,
  );
  if (!incomplete.length) return null;
  return `Incomplete failing check logs: ${incomplete.map((check) => `${check.name} (${check.log.truncated ? 'truncated' : (check.log.unavailableReason ?? 'unavailable')})`).join(', ')}.`;
}

function invalidInput(message: string) {
  return failure('Invalid CI dossier input.', {
    errors: [message],
    requires: ['pr'],
  });
}

function failure(
  message: string,
  options: { errors?: string[]; requires?: string[] } = {},
) {
  return {
    ok: false,
    action: 'ci_fix_report' as const,
    changed: false,
    message,
    ...options,
  };
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function targetField(value: unknown): PullRequestTarget | null {
  const target = objectField(value);
  const repoFullName = stringField(target.repoFullName);
  const owner = stringField(target.owner);
  const repo = stringField(target.repo);
  const number = typeof target.number === 'number' ? target.number : null;
  return repoFullName && owner && repo && number
    ? { repoFullName, owner, repo, number }
    : null;
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n[truncated]`;
}
