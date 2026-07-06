import { renderReportHtml } from '../../lib/report-html';
import type { JobRecord } from '../app-state';
import { fetchGitHubIssues, type GitHubIssue } from '../github/issues';
import { writeReport } from '../reports';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import type { JobExecutionResult } from '../scheduler';
import type { RuntimePaths } from '../../runtime-home';

export async function runIssueTriageJob(
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
  const issues = await fetchGitHubIssues({
    token,
    owner: repo.github.owner,
    repo: repo.github.name,
    since: previousWatermark,
    limit,
  });
  const classified = classifyIssues(issues.items, {
    previousWatermark,
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
    watermark: issues.fetchedAt,
    previousWatermark,
    issueCount: issues.items.length,
    total,
    truncated: issues.truncated,
    counts: {
      new: classified.newIssues.length,
      stale: classified.stale.length,
      missingInfo: classified.missingInfo.length,
      duplicateCandidates: classified.duplicateCandidates.length,
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
          issueSection('New', classified.newIssues),
          issueSection('Stale', classified.stale),
          issueSection('Missing Info', classified.missingInfo),
          issueSection('Duplicate Candidates', classified.duplicateCandidates),
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

function classifyIssues(
  issues: GitHubIssue[],
  input: {
    previousWatermark: string | null;
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
        previousTime === null || Date.parse(issue.createdAt) > previousTime,
    ),
    stale: issues.filter((issue) => Date.parse(issue.updatedAt) < staleBefore),
    missingInfo: issues.filter(isMissingInfo),
    duplicateCandidates: [...titleGroups.values()]
      .filter((group) => group.length > 1)
      .flat()
      .slice(0, 40),
  };
}

function issueSection(title: string, issues: GitHubIssue[]) {
  return {
    title,
    body: issues.length === 0 ? 'No items.' : null,
    items: issues.slice(0, 40).map((issue) => ({
      label: `#${issue.number}`,
      value: `${issue.title}\n${issue.url}\nlabels: ${issue.labels.join(', ') || 'none'}\n${issue.bodyExcerpt || 'No body.'}`,
    })),
  };
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
