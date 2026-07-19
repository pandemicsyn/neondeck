import * as v from 'valibot';
import { encodePathSegment, githubFetch, nextLink } from './client';
import { errorMessage } from './errors';
import {
  githubCheckRunAnnotationsApiResponseSchema,
  githubCheckRunsApiResponseSchema,
  githubCheckSuitesApiResponseSchema,
  githubCommitStatusApiResponseSchema,
} from './schemas';
import type {
  GitHubCheckAnnotation,
  GitHubCheckRun,
  GitHubCheckRunDetail,
  GitHubCheckSuiteApiResponse,
  GitHubCheckSuiteDetail,
  GitHubCheckSummary,
  GitHubFailingCheckFact,
} from './schemas';
import type { PullRequestEventFetchBudget } from './event-budget';

export async function fetchCheckSummary(options: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  maxCheckRunPages?: number;
}): Promise<GitHubCheckSummary> {
  const owner = encodePathSegment(options.owner);
  const repo = encodePathSegment(options.repo);
  const ref = encodePathSegment(options.ref);
  const [runs, statusResponse] = await Promise.all([
    fetchCheckRuns(
      options.token,
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`,
      options.maxCheckRunPages,
    ),
    githubFetch(
      options.token,
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/status`,
    ),
  ]);
  const statusData = v.parse(
    githubCommitStatusApiResponseSchema,
    await statusResponse.json(),
  );
  const failed = runs.items.filter((run) =>
    [
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'startup_failure',
    ].includes(run.conclusion ?? ''),
  ).length;
  const pending = runs.items.filter((run) => run.status !== 'completed').length;
  const successful = runs.items.filter(
    (run) => run.conclusion === 'success',
  ).length;
  const statusContexts = statusData.statuses ?? [];
  const failedStatuses = statusContexts.filter(
    (status) => status.state === 'failure' || status.state === 'error',
  ).length;
  const pendingStatuses = statusContexts.filter(
    (status) => status.state === 'pending',
  ).length;
  const successfulStatuses = statusContexts.filter(
    (status) => status.state === 'success',
  ).length;
  const totalFailed = failed + failedStatuses;
  const truncatedUnknown = runs.truncated && totalFailed === 0 ? 1 : 0;
  const total = runs.items.length + statusContexts.length + truncatedUnknown;
  const totalPending = pending + pendingStatuses + truncatedUnknown;
  const totalSuccessful = successful + successfulStatuses;
  const status =
    total === 0
      ? 'none'
      : totalFailed > 0
        ? 'failure'
        : totalPending > 0
          ? 'pending'
          : 'success';

  return {
    status,
    total,
    successful: totalSuccessful,
    failed: totalFailed,
    pending: totalPending,
    statusContexts: statusContexts.length,
    truncated: runs.truncated,
    checkedAt: new Date().toISOString(),
  };
}

async function fetchCheckRuns(
  token: string,
  initialUrl: string,
  maxPages = 3,
  eventBudget?: PullRequestEventFetchBudget,
) {
  const runs: GitHubCheckRun[] = [];
  let nextUrl: string | undefined = initialUrl;
  let pageCount = 0;

  let budgetExhausted = false;
  while (
    nextUrl &&
    pageCount < maxPages &&
    (eventBudget?.canFetch('check_runs') ?? true)
  ) {
    pageCount += 1;
    const response = await githubFetch(token, nextUrl);
    const data = v.parse(
      githubCheckRunsApiResponseSchema,
      await response.json(),
    );
    for (const run of data.check_runs ?? []) {
      if (eventBudget?.admit('check_runs', run) === false) {
        budgetExhausted = true;
        break;
      }
      runs.push(run);
    }
    nextUrl = nextLink(response.headers.get('link'));
    if (budgetExhausted) break;
  }

  return {
    items: runs,
    truncated:
      Boolean(nextUrl) ||
      budgetExhausted ||
      Boolean(eventBudget?.exhausted('check_runs')),
  };
}

function isFailingCheckRun(run: GitHubCheckRun) {
  return [
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'startup_failure',
  ].includes(run.conclusion ?? '');
}

async function fetchCheckRunAnnotationsWithMetadata(
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
) {
  const annotations: GitHubCheckAnnotation[] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations?per_page=100`;
  let pageCount = 0;

  while (nextUrl && pageCount < 3) {
    pageCount += 1;
    const response = await githubFetch(token, nextUrl);
    const data = v.parse(
      githubCheckRunAnnotationsApiResponseSchema,
      await response.json(),
    );
    annotations.push(
      ...data.map((annotation) => ({
        path: annotation.path,
        startLine: annotation.start_line ?? null,
        endLine: annotation.end_line ?? null,
        annotationLevel: annotation.annotation_level,
        message: annotation.message,
        title: annotation.title ?? null,
        rawDetails: annotation.raw_details ?? null,
      })),
    );
    nextUrl = nextLink(response.headers.get('link'));
  }

  return {
    annotations,
    truncated: Boolean(nextUrl),
  };
}

async function fetchCheckRunLog(options: {
  token: string;
  owner: string;
  repo: string;
  checkRunId?: number | null;
  detailsUrl: string | null;
  maxLogBytes?: number;
}): Promise<GitHubFailingCheckFact['log']> {
  const jobId =
    githubActionsJobId(options.detailsUrl) ??
    (options.checkRunId
      ? await githubActionsJobIdForCheckRun(options).catch(() => null)
      : null);
  if (!jobId) {
    return {
      available: false,
      source: null,
      text: null,
      truncated: false,
      unavailableReason:
        'Full logs are unavailable because the check details URL does not expose a GitHub Actions job id.',
    };
  }

  try {
    const response = await githubFetch(
      options.token,
      `https://api.github.com/repos/${options.owner}/${options.repo}/actions/jobs/${jobId}/logs`,
    );
    const contentType = response.headers.get('content-type') ?? '';
    const { buffer, truncated } = await readBoundedResponseBytes(
      response,
      options.maxLogBytes ?? 64 * 1024,
    );
    if (
      buffer.includes(0) ||
      /zip|octet-stream|gzip/i.test(contentType) ||
      !isLikelyUtf8(buffer)
    ) {
      return {
        available: false,
        source: null,
        text: null,
        truncated: false,
        unavailableReason: `Full logs were returned as non-text content (${contentType || 'unknown content type'}).`,
      };
    }
    const maxBytes = options.maxLogBytes ?? 64 * 1024;
    const text = buffer.toString('utf8');
    return {
      available: true,
      source: 'github-actions-job',
      text:
        Buffer.byteLength(text, 'utf8') > maxBytes
          ? text.slice(0, maxBytes)
          : text,
      truncated: truncated || Buffer.byteLength(text, 'utf8') > maxBytes,
      unavailableReason: null,
    };
  } catch (error) {
    return {
      available: false,
      source: null,
      text: null,
      truncated: false,
      unavailableReason: errorMessage(error),
    };
  }
}

function githubActionsJobId(detailsUrl: string | null) {
  if (!detailsUrl) return null;
  const match = /\/actions\/runs\/\d+\/job\/(\d+)(?:\D|$)/.exec(detailsUrl);
  return match?.[1] ?? null;
}

async function githubActionsJobIdForCheckRun(options: {
  token: string;
  owner: string;
  repo: string;
  checkRunId?: number | null;
}) {
  if (!options.checkRunId) return null;
  const checkRunResponse = await githubFetch(
    options.token,
    `https://api.github.com/repos/${options.owner}/${options.repo}/check-runs/${options.checkRunId}`,
  );
  const checkRun = v.parse(
    v.looseObject({
      check_suite: v.optional(v.nullable(v.object({ id: v.number() }))),
    }),
    await checkRunResponse.json(),
  );
  const checkSuiteId = checkRun.check_suite?.id;
  if (!checkSuiteId) return null;

  const runsResponse = await githubFetch(
    options.token,
    `https://api.github.com/repos/${options.owner}/${options.repo}/actions/runs?check_suite_id=${checkSuiteId}&per_page=10`,
  );
  const runs = v.parse(
    v.object({
      workflow_runs: v.optional(v.array(v.object({ id: v.number() }))),
    }),
    await runsResponse.json(),
  );
  for (const run of runs.workflow_runs ?? []) {
    const jobsResponse = await githubFetch(
      options.token,
      `https://api.github.com/repos/${options.owner}/${options.repo}/actions/runs/${run.id}/jobs?per_page=100`,
    );
    const jobs = v.parse(
      v.object({
        jobs: v.optional(
          v.array(
            v.object({
              id: v.number(),
              check_run_url: v.optional(v.nullable(v.string())),
            }),
          ),
        ),
      }),
      await jobsResponse.json(),
    );
    const job = (jobs.jobs ?? []).find((candidate) =>
      candidate.check_run_url?.endsWith(`/check-runs/${options.checkRunId}`),
    );
    if (job) return String(job.id);
  }
  return null;
}

function isLikelyUtf8(buffer: Buffer) {
  return buffer.toString('utf8').includes('\uFFFD') === false;
}

async function readBoundedResponseBytes(response: Response, maxBytes: number) {
  const limit = Math.max(1, maxBytes);
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      buffer: buffer.subarray(0, limit),
      truncated: buffer.byteLength > limit,
    };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (total <= limit) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = limit - total;
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, Math.max(0, remaining)));
      total = limit + 1;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  return { buffer: Buffer.concat(chunks), truncated };
}

export async function fetchCheckRunDetails(options: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
}): Promise<GitHubCheckRunDetail[]> {
  return (await fetchCheckRunDetailsWithMetadata(options)).checkRuns;
}

export async function fetchCheckRunDetailsWithMetadata(options: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  eventBudget?: PullRequestEventFetchBudget;
}): Promise<{ checkRuns: GitHubCheckRunDetail[]; truncated: boolean }> {
  const owner = encodePathSegment(options.owner);
  const repo = encodePathSegment(options.repo);
  const ref = encodePathSegment(options.ref);
  const runs = await fetchCheckRuns(
    options.token,
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`,
    3,
    options.eventBudget,
  );

  return {
    checkRuns: runs.items.map((run, index) => ({
      id: run.id ?? index,
      name: run.name ?? `check-run-${index + 1}`,
      headSha: run.head_sha ?? options.ref,
      status: run.status,
      conclusion: run.conclusion,
      url: run.url ?? null,
      htmlUrl: run.html_url ?? null,
      detailsUrl: run.details_url ?? null,
      startedAt: run.started_at ?? null,
      completedAt: run.completed_at ?? null,
    })),
    truncated: runs.truncated,
  };
}

export async function fetchFailingCheckFacts(options: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  maxLogBytes?: number;
}): Promise<GitHubFailingCheckFact[]> {
  const owner = encodePathSegment(options.owner);
  const repo = encodePathSegment(options.repo);
  const ref = encodePathSegment(options.ref);
  const runs = await fetchCheckRuns(
    options.token,
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`,
  );
  if (runs.truncated) {
    throw new Error(
      'GitHub check run facts are truncated; CI fixer requires complete failing check facts.',
    );
  }
  const failingRuns = runs.items.filter(isFailingCheckRun);

  return Promise.all(
    failingRuns.map(async (run, index) => {
      const id = run.id ?? index;
      const [annotations, log] = await Promise.all([
        id
          ? fetchCheckRunAnnotationsWithMetadata(options.token, owner, repo, id)
          : { annotations: [], truncated: false },
        fetchCheckRunLog({
          token: options.token,
          owner,
          repo,
          checkRunId: typeof run.id === 'number' ? run.id : null,
          detailsUrl: run.details_url ?? null,
          maxLogBytes: options.maxLogBytes,
        }),
      ]);
      if (annotations.truncated) {
        throw new Error(
          'GitHub check annotation facts are truncated; CI fixer requires complete failing check facts.',
        );
      }
      return {
        id,
        name: run.name ?? `check-run-${index + 1}`,
        headSha: run.head_sha ?? options.ref,
        status: run.status,
        conclusion: run.conclusion,
        url: run.url ?? null,
        htmlUrl: run.html_url ?? null,
        detailsUrl: run.details_url ?? null,
        startedAt: run.started_at ?? null,
        completedAt: run.completed_at ?? null,
        outputTitle: run.output?.title ?? null,
        outputSummary: run.output?.summary ?? null,
        outputText: run.output?.text ?? null,
        annotations: annotations.annotations,
        log,
      };
    }),
  );
}

export async function fetchCheckSuites(options: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
}): Promise<GitHubCheckSuiteDetail[]> {
  return (await fetchCheckSuitesWithMetadata(options)).checkSuites;
}

export async function fetchCheckSuitesWithMetadata(options: {
  token: string;
  owner: string;
  repo: string;
  ref: string;
  eventBudget?: PullRequestEventFetchBudget;
}): Promise<{ checkSuites: GitHubCheckSuiteDetail[]; truncated: boolean }> {
  const owner = encodePathSegment(options.owner);
  const repo = encodePathSegment(options.repo);
  const ref = encodePathSegment(options.ref);
  const suites: GitHubCheckSuiteApiResponse['check_suites'] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-suites?per_page=100`;
  let pageCount = 0;

  let budgetExhausted = false;
  while (
    nextUrl &&
    pageCount < 3 &&
    (options.eventBudget?.canFetch('check_suites') ?? true)
  ) {
    pageCount += 1;
    const response = await githubFetch(options.token, nextUrl);
    const data = v.parse(
      githubCheckSuitesApiResponseSchema,
      await response.json(),
    );
    for (const suite of data.check_suites ?? []) {
      if (options.eventBudget?.admit('check_suites', suite) === false) {
        budgetExhausted = true;
        break;
      }
      suites.push(suite);
    }
    nextUrl = nextLink(response.headers.get('link'));
    if (budgetExhausted) break;
  }

  return {
    checkSuites: suites.map((suite) => ({
      id: suite.id,
      headSha: suite.head_sha,
      status: suite.status,
      conclusion: suite.conclusion,
      appSlug: suite.app?.slug ?? suite.app?.name ?? null,
      url: suite.url ?? null,
      htmlUrl: suite.html_url ?? null,
      createdAt: suite.created_at ?? null,
      updatedAt: suite.updated_at ?? null,
    })),
    truncated:
      Boolean(nextUrl) ||
      budgetExhausted ||
      Boolean(options.eventBudget?.exhausted('check_suites')),
  };
}
