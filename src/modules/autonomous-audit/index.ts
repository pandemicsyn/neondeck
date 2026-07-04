import { type JsonValue } from '@flue/runtime';
import { type PreparedDiffRecord } from '../prepared-diffs';

export type AutonomousCheckSummary = {
  name: string;
  status?: string;
  conclusion?: string | null;
  command?: string;
  checkRunId?: number;
  url?: string | null;
};

export type AutonomousAuditSummaryInput = {
  preparedDiff: PreparedDiffRecord;
  resultUrl?: string;
};

export type AutonomousAuditSummary = {
  title: string;
  markdown: string;
  facts: JsonValue;
};

export function buildPreparedDiffAuditSummary(
  input: AutonomousAuditSummaryInput,
): AutonomousAuditSummary {
  const record = input.preparedDiff;
  const summary = objectField(record.summary);
  const addressed = objectField(summary.addressed);
  const commit = objectField(summary.commit);
  const status = statusFromPreparedDiff(record.status);
  const commitSha = stringField(commit.sha);
  const checks = normalizeChecks(checksFromSummary(summary));
  const manualAsks = unique(arrayOfStrings(summary.remainingManualAsks) ?? []);
  const reviewCommentIds = arrayOfStrings(addressed.reviewCommentIds) ?? [];
  const reviewThreadIds = arrayOfStrings(addressed.reviewThreadIds) ?? [];
  const diffSummary = objectField(summary.diffSummary);
  const checkRunIds = checks
    .map((check) => check.checkRunId)
    .filter((id): id is number => typeof id === 'number');

  const lines = [
    `Neon autopilot result for ${record.repoFullName}#${record.prNumber ?? 'worktree'}: ${status}.`,
    '',
    `- Addressed review comments: ${formatIdList(reviewCommentIds)}.`,
    `- Addressed review threads: ${formatIdList(reviewThreadIds)}.`,
    `- Commit: ${commitSha ? shortSha(commitSha) : 'not recorded'}.`,
    `- Checks run: ${formatChecks(checks)}.`,
    `- Remaining manual asks: ${manualAsks.length > 0 ? manualAsks.join('; ') : 'none recorded'}.`,
    `- Result: prepared diff ${record.id}${input.resultUrl ? ` (${input.resultUrl})` : ''}; worktree ${record.worktreeId}.`,
  ];

  if (numberField(diffSummary.files) !== undefined) {
    lines.push(
      `- Diff summary: ${numberField(diffSummary.files) ?? 0} file(s), ${numberField(diffSummary.additions) ?? 0} addition(s), ${numberField(diffSummary.deletions) ?? 0} deletion(s).`,
    );
  }

  return {
    title: `Autopilot ${status} for ${record.repoFullName}#${record.prNumber ?? 'worktree'}`,
    markdown: lines.join('\n'),
    facts: {
      preparedDiffId: record.id,
      worktreeId: record.worktreeId,
      repoId: record.repoId,
      repoFullName: record.repoFullName,
      prNumber: record.prNumber,
      status,
      preparedDiffStatus: record.status,
      commitSha: commitSha ?? null,
      addressedReviewCommentIds: reviewCommentIds,
      addressedReviewThreadIds: reviewThreadIds,
      checksRun: checks as unknown as JsonValue,
      checkRunIds,
      remainingManualAsks: manualAsks,
      resultUrl: input.resultUrl ?? null,
      diffSummary:
        numberField(diffSummary.files) === undefined
          ? null
          : {
              files: numberField(diffSummary.files) ?? 0,
              additions: numberField(diffSummary.additions) ?? 0,
              deletions: numberField(diffSummary.deletions) ?? 0,
              binaryFiles: numberField(diffSummary.binaryFiles) ?? 0,
            },
    },
  };
}

function statusFromPreparedDiff(status: PreparedDiffRecord['status']) {
  switch (status) {
    case 'prepared':
      return 'prepared';
    case 'pushed':
      return 'pushed';
    case 'push-blocked':
    case 'revision-requested':
      return 'blocked';
    case 'verification-requested':
      return 'verification-requested';
    case 'push-approved':
      return 'push-approved';
    case 'abandoned':
      return 'abandoned';
  }
}

function checksFromSummary(summary: Record<string, unknown>) {
  const storedChecks = arrayOfObjects(summary.checksRun);
  if (storedChecks && storedChecks.length > 0) {
    return storedChecks.map((item) => ({
      name: stringField(item.name) ?? stringField(item.command) ?? 'check',
      status: stringField(item.status),
      conclusion: stringField(item.conclusion) ?? null,
      command: stringField(item.command),
      checkRunId: numberField(item.checkRunId),
      url: stringField(item.url) ?? null,
    }));
  }

  const results = arrayOfObjects(summary.results);
  if (results && results.length > 0) {
    return results.map((item) => ({
      name: stringField(item.command) ?? 'verification check',
      status: booleanField(item.ok) ? 'passed' : 'failed',
      conclusion: stringField(item.message) ?? null,
      checkRunId: numberField(item.checkRunId),
    }));
  }

  const diagnostics = arrayOfObjects(summary.diagnostics);
  if (diagnostics && diagnostics.length > 0) {
    return diagnostics.map((item) => ({
      name: stringField(item.command) ?? 'diagnostic',
      status: booleanField(item.ok) ? 'passed' : 'failed',
      conclusion: stringField(item.message) ?? null,
    }));
  }

  const failingChecks = arrayOfObjects(summary.failingChecks);
  if (failingChecks && failingChecks.length > 0) {
    return failingChecks.map((item) => ({
      name: stringField(item.name) ?? String(item.id ?? 'check'),
      status: 'fetched',
      conclusion: stringField(item.conclusion) ?? null,
      checkRunId: numberField(item.id),
    }));
  }

  return [];
}

function normalizeChecks(checks: AutonomousCheckSummary[]) {
  return checks.map((check) => ({
    name: check.name,
    status: check.status ?? check.conclusion ?? 'recorded',
    conclusion: check.conclusion ?? null,
    command: check.command ?? null,
    checkRunId: check.checkRunId ?? null,
    url: check.url ?? null,
  }));
}

function formatChecks(checks: ReturnType<typeof normalizeChecks>) {
  if (checks.length === 0) return 'none recorded';
  const formatted = checks.slice(0, 6).map((check) => {
    const name = check.command ?? check.name;
    const state = check.conclusion ?? check.status;
    return `${name} ${state}`;
  });
  return checks.length > 6
    ? `${formatted.join(', ')}, +${checks.length - 6} more`
    : formatted.join(', ');
}

function formatIdList(ids: string[]) {
  if (ids.length === 0) return 'none recorded';
  const formatted = ids.slice(0, 8).join(', ');
  return ids.length > 8 ? `${formatted}, +${ids.length - 8} more` : formatted;
}

function shortSha(sha: string) {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function arrayOfObjects(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : undefined;
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberField(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanField(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}
