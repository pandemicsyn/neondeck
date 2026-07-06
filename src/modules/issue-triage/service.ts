import { renderReportHtml } from '../../lib/report-html';
import type { JobExecutionResult, JobRecord } from '../app-state';
import { fetchGitHubIssues, type GitHubIssue } from '../github';
import { writeReport } from '../reports';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import type { RuntimePaths } from '../../runtime-home';

export async function runIssueTriageJob(
  job: JobRecord,
  paths: RuntimePaths,
): Promise<JobExecutionResult> {
  try {
    return await runIssueTriageJobInner(job, paths);
  } catch (error) {
    return failed(job, `Issue triage failed: ${errorMessage(error)}.`);
  }
}

async function runIssueTriageJobInner(
  job: JobRecord,
  paths: RuntimePaths,
): Promise<JobExecutionResult> {
  const config = objectConfig(job.config);
  const repoRef = stringConfig(config.repo);
  if (!repoRef)
    return failed(job, 'Issue triage requires a configured repository.');
  const token = process.env.GITHUB_TOKEN;
  if (!token) return failed(job, 'GITHUB_TOKEN is not configured.');

  const registry = await readRepoRegistrySnapshot(paths);
  const repo = registry.repos.find(
    (candidate) =>
      candidate.id === repoRef ||
      candidate.github.name === repoRef ||
      repoFullName(candidate).toLowerCase() === repoRef.toLowerCase(),
  );
  if (!repo) {
    return failed(
      job,
      `Issue triage repository "${repoRef}" is not configured.`,
    );
  }

  const staleAfterDays = numberConfig(config.staleAfterDays, 30);
  const limit = numberConfig(config.limit, 100);
  const previousWatermark = watermark(job.lastResult);
  const previousRecentIssueNumbers = issueNumberSet(job.lastResult);
  const recentIssues = await fetchGitHubIssues({
    token,
    owner: repo.github.owner,
    repo: repo.github.name,
    since: previousWatermark,
    limit,
    sort: 'created',
    direction: 'desc',
  });
  const staleScanIssues = await fetchGitHubIssues({
    token,
    owner: repo.github.owner,
    repo: repo.github.name,
    limit,
    sort: 'updated',
    direction: 'asc',
  });
  const issues = mergeIssues(recentIssues.items, staleScanIssues.items);
  const classified = classifyIssues(issues.items, {
    previousWatermark,
    previousRecentIssueNumbers,
    recentIssueNumbers: new Set(
      recentIssues.items.map((issue) => issue.number),
    ),
    staleAfterDays,
    now: new Date(),
  });
  const total =
    classified.newIssues.length +
    classified.stale.length +
    classified.missingInfo.length +
    classified.duplicateCandidates.length;
  const result = {
    repo: repo.id,
    repoFullName: repoFullName(repo),
    watermark: nextWatermark(recentIssues, previousWatermark),
    previousWatermark,
    recentIssueNumbers: recentIssues.items.map((issue) => issue.number),
    issueCount: issues.items.length,
    recentIssueCount: recentIssues.items.length,
    staleScanIssueCount: staleScanIssues.items.length,
    total,
    truncated: recentIssues.truncated || staleScanIssues.truncated,
    counts: {
      new: classified.newIssues.length,
      stale: classified.stale.length,
      missingInfo: classified.missingInfo.length,
      duplicateCandidates: classified.duplicateCandidates.length,
      draftedReplies: draftedReplyCount(classified),
    },
  };

  if (total === 0) {
    return {
      outcome: 'silent',
      message: `Issue triage found no reportable items for ${repoFullName(repo)}.`,
      result,
    };
  }

  const report = await writeReport(
    {
      kind: 'issue-triage',
      title: `Issue triage: ${repoFullName(repo)}`,
      repoId: repo.id,
      sourceRef: repoFullName(repo),
      createdBy: `scheduler:${job.id}`,
      summary: result,
      html: renderReportHtml({
        title: `Issue triage: ${repoFullName(repo)}`,
        eyebrow: 'ISSUE TRIAGE',
        summary: `${result.counts.new} new, ${result.counts.stale} stale, ${result.counts.missingInfo} missing-info, ${result.counts.duplicateCandidates} duplicate candidate issue${total === 1 ? '' : 's'}.`,
        sections: [
          issueSection('New', classified.newIssues, 'new'),
          issueSection('Stale', classified.stale, 'stale'),
          issueSection('Missing Info', classified.missingInfo, 'missing-info'),
          issueSection(
            'Duplicate Candidates',
            classified.duplicateCandidates,
            'duplicate-candidate',
          ),
        ],
      }),
    },
    paths,
  );

  return {
    outcome: 'updated',
    message: `Issue triage found ${total} item${total === 1 ? '' : 's'} for ${repoFullName(repo)}.`,
    result: { ...result, reportId: report.id },
    notifications: [
      {
        level: 'info',
        title: 'Issue triage ready',
        message: `${repoFullName(repo)}: ${result.counts.new} new, ${result.counts.stale} stale, ${result.counts.missingInfo} missing-info.`,
        source: 'issue-triage',
        sourceId: job.id,
        data: {
          repo: repo.id,
          reportId: report.id,
          reportUrl: `/reports/${report.id}`,
          counts: result.counts,
        },
      },
    ],
  };
}

function mergeIssues(...groups: GitHubIssue[][]) {
  const byNumber = new Map<number, GitHubIssue>();
  for (const issue of groups.flat()) {
    byNumber.set(issue.number, issue);
  }
  return { items: [...byNumber.values()] };
}

function nextWatermark(
  scan: { items: GitHubIssue[]; truncated: boolean },
  previousWatermark: string | null,
) {
  if (scan.truncated) return previousWatermark;
  const latest = latestCreatedAtAfter(scan.items, previousWatermark);
  return latest ? rewindIso(latest, 1_000) : previousWatermark;
}

function latestCreatedAtAfter(
  issues: GitHubIssue[],
  previousWatermark: string | null,
) {
  const previousTime = previousWatermark
    ? Date.parse(previousWatermark)
    : Number.NEGATIVE_INFINITY;
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const issue of issues) {
    const createdTime = Date.parse(issue.createdAt);
    if (
      !Number.isFinite(createdTime) ||
      (Number.isFinite(previousTime) && createdTime <= previousTime) ||
      createdTime < latestTime
    ) {
      continue;
    }
    latestTime = createdTime;
    latest = issue.createdAt;
  }
  return latest;
}

function rewindIso(value: string, milliseconds: number) {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time - milliseconds).toISOString()
    : value;
}

function classifyIssues(
  issues: GitHubIssue[],
  input: {
    previousWatermark: string | null;
    previousRecentIssueNumbers: Set<number>;
    recentIssueNumbers: Set<number>;
    staleAfterDays: number;
    now: Date;
  },
) {
  const previousTime = input.previousWatermark
    ? Date.parse(input.previousWatermark)
    : null;
  const staleBefore =
    input.now.getTime() - input.staleAfterDays * 24 * 60 * 60 * 1000;
  const titleGroups = new Map<string, GitHubIssue[]>();
  for (const issue of issues) {
    const key = normalizedTitle(issue.title);
    if (!key) continue;
    titleGroups.set(key, [...(titleGroups.get(key) ?? []), issue]);
  }

  return {
    newIssues: issues.filter(
      (issue) =>
        input.recentIssueNumbers.has(issue.number) &&
        !input.previousRecentIssueNumbers.has(issue.number) &&
        (previousTime === null || Date.parse(issue.createdAt) > previousTime),
    ),
    stale: issues.filter((issue) => Date.parse(issue.updatedAt) < staleBefore),
    missingInfo: issues.filter(isMissingInfo),
    duplicateCandidates: [...titleGroups.values()]
      .filter((group) => group.length > 1)
      .flat()
      .slice(0, 40),
  };
}

function issueSection(
  title: string,
  issues: GitHubIssue[],
  category: 'new' | 'stale' | 'missing-info' | 'duplicate-candidate',
) {
  return {
    title,
    body: issues.length === 0 ? 'No items.' : null,
    items: issues.slice(0, 40).map((issue) => ({
      label: `#${issue.number}`,
      value: [
        issue.title,
        issue.url,
        `labels: ${issue.labels.join(', ') || 'none'}`,
        `suggested labels: ${suggestedLabels(issue, category).join(', ') || 'none'}`,
        issue.bodyExcerpt || 'No body.',
        draftedReply(issue, category)
          ? `draft reply:\n${draftedReply(issue, category)}`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
    })),
  };
}

function draftedReply(
  issue: GitHubIssue,
  category: 'new' | 'stale' | 'missing-info' | 'duplicate-candidate',
) {
  const author = issue.authorLogin ? `, @${issue.authorLogin}` : '';
  if (category === 'missing-info') {
    return [
      `Thanks for opening this${author}.`,
      'Could you add the concrete reproduction steps, expected behavior, actual behavior, and relevant environment/version details?',
      'That will make this actionable to triage.',
    ].join(' ');
  }

  if (category === 'new') {
    return [
      `Thanks for the report${author}.`,
      'I am marking this for maintainer triage.',
      'If you have a minimal reproduction or extra context, please add it here.',
    ].join(' ');
  }

  return null;
}

function suggestedLabels(
  issue: GitHubIssue,
  category: 'new' | 'stale' | 'missing-info' | 'duplicate-candidate',
) {
  const labels = new Set<string>();
  if (category === 'missing-info') labels.add('needs-info');
  if (category === 'duplicate-candidate') labels.add('duplicate-candidate');
  const text = `${issue.title}\n${issue.bodyExcerpt}`.toLowerCase();
  if (/\b(doc|docs|documentation|readme)\b/.test(text)) labels.add('docs');
  if (/\b(crash|error|bug|broken|fail|failure|regression)\b/.test(text)) {
    labels.add('bug');
  }
  if (/\b(feature|enhancement|request|support)\b/.test(text)) {
    labels.add('enhancement');
  }
  return [...labels];
}

function draftedReplyCount(classified: ReturnType<typeof classifyIssues>) {
  const draftable = new Set<number>();
  for (const issue of classified.newIssues) draftable.add(issue.number);
  for (const issue of classified.missingInfo) draftable.add(issue.number);
  return draftable.size;
}

function isMissingInfo(issue: GitHubIssue) {
  const body = issue.bodyExcerpt.toLowerCase();
  if (body.length < 40) return true;
  return !/(repro|steps|expected|actual|environment|version)/.test(body);
}

function normalizedTitle(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 2)
    .slice(0, 8)
    .join(' ');
}

function watermark(value: unknown) {
  const record = objectConfig(value);
  const next = record.watermark;
  return typeof next === 'string' && next.trim() ? next : null;
}

function issueNumberSet(value: unknown) {
  const record = objectConfig(value);
  const numbers = record.recentIssueNumbers;
  return new Set(
    Array.isArray(numbers)
      ? numbers.filter((number): number is number => Number.isInteger(number))
      : [],
  );
}

function stringConfig(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberConfig(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function objectConfig(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function failed(job: JobRecord, message: string): JobExecutionResult {
  return {
    outcome: 'failed',
    message,
    notifications: [
      {
        level: 'attention',
        title: 'Issue triage failed',
        message,
        source: 'issue-triage',
        sourceId: job.id,
      },
    ],
  };
}
