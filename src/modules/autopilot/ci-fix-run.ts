import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { asJsonValue } from '../../lib/action-result';
import { renderReportHtml } from '../../lib/report-html';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RepoConfig,
  type RuntimePaths,
} from '../../runtime-home';
import { addNotification, addWorkflowSummary } from '../app-state';
import {
  fetchFailingCheckFacts,
  type GitHubFailingCheckFact,
  type GitHubPullRequestEventState,
} from '../github';
import { startKiloTask } from '../kilo';
import { writeReport, type ReportRecord } from '../reports';
import { getGitHubPrEventState, type PullRequestTarget } from '../pr-events';
import type { PrEventStateDependencies } from '../pr-events';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import { lockWorktree, releaseWorktreeLock } from '../worktrees';
import { preparePrWorktree } from './worktree';
import { identifyLikelyCommands } from './github-facts';

const nonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
const positiveIntegerSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
);

export const ciFixRunInputSchema = v.object({
  ref: v.optional(nonEmptyStringSchema),
  repo: v.optional(nonEmptyStringSchema),
  prNumber: v.optional(positiveIntegerSchema),
  reportOnly: v.optional(v.boolean()),
  maxLogBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * 1024)),
  ),
});

export const ciFixRunOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export type CiFixRunInput = v.InferInput<typeof ciFixRunInputSchema>;
export type CiFixRunOutput = Awaited<ReturnType<typeof runCiFix>>;

export type CiFixDossier = {
  target: PullRequestTarget;
  state: GitHubPullRequestEventState;
  repo: RepoConfig | null;
  failingChecks: GitHubFailingCheckFact[];
  likelyCommands: string[];
  fetchedAt: string;
};

export type CiFixRunDependencies = {
  readDossier?: (
    input: v.InferOutput<typeof ciFixRunInputSchema>,
    paths: RuntimePaths,
  ) => Promise<CiFixDossier>;
  fetchFailingCheckFacts?: typeof fetchFailingCheckFacts;
  prEventDependencies?: PrEventStateDependencies;
  preparePrWorktree?: typeof preparePrWorktree;
  startKiloTask?: typeof startKiloTask;
  lockWorktree?: typeof lockWorktree;
  releaseWorktreeLock?: typeof releaseWorktreeLock;
};

export async function createCiFixReport(
  rawInput: CiFixRunInput,
  paths = runtimePaths(),
  dependencies: CiFixRunDependencies = {},
) {
  const parsed = parseCiFixInput(rawInput);
  if (!parsed.ok) return parsed.result;
  const dossier = await readCiFixDossier(parsed.input, paths, dependencies);
  if (!dossier.ok) return dossier.result;
  const report = await writeCiFixDossierReport(
    dossier.dossier,
    {
      createdBy: 'explain-ci',
      mode: 'report-only',
    },
    paths,
  );
  return {
    ok: true,
    action: 'ci_fix_report' as const,
    changed: true,
    message: `Wrote CI failure dossier report for ${sourceRef(dossier.dossier)}.`,
    report,
    data: asJsonValue({
      report: reportLink(report),
      dossier: dossierSummary(dossier.dossier),
      workflow: 'fix-pr-ci',
      mode: 'report-only',
    }),
  };
}

export async function runCiFix(
  rawInput: CiFixRunInput,
  paths = runtimePaths(),
  dependencies: CiFixRunDependencies = {},
) {
  const parsed = parseCiFixInput(rawInput);
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);

  const dossierResult = await readCiFixDossier(
    parsed.input,
    paths,
    dependencies,
  );
  if (!dossierResult.ok) return dossierResult.result;
  const dossier = dossierResult.dossier;
  const report = await writeCiFixDossierReport(
    dossier,
    {
      createdBy: 'fix-pr-ci',
      mode: parsed.input.reportOnly ? 'report-only' : 'fix',
    },
    paths,
  );

  if (parsed.input.reportOnly) {
    return {
      ok: true,
      action: 'ci_fix_run' as const,
      changed: true,
      message: `Wrote CI failure dossier report for ${sourceRef(dossier)}.`,
      data: asJsonValue({
        workflow: 'fix-pr-ci',
        mode: 'report-only',
        report: reportLink(report),
        dossier: dossierSummary(dossier),
      }),
    };
  }

  if (!dossier.repo) {
    await notifyCiFixAttention(
      dossier,
      report,
      'Repository is not configured.',
      paths,
    );
    return failure(
      `Repository ${dossier.target.repoFullName} is not configured for managed worktrees.`,
      {
        requires: ['repo'],
        data: {
          report: reportLink(report),
          dossier: dossierSummary(dossier),
        },
      },
    );
  }

  const lock = await (dependencies.lockWorktree ?? lockWorktree)(
    {
      repoId: dossier.repo.id,
      prNumber: dossier.target.number,
      scope: 'pr',
      owner: 'ci-fix-run',
      ttlSeconds: 86_400,
    },
    paths,
  );
  if (!lock.ok || !('lock' in lock)) {
    await notifyCiFixAttention(dossier, report, lock.message, paths);
    return failure(lock.message, {
      requires: ['worktreeLock'],
      data: {
        report: reportLink(report),
        dossier: dossierSummary(dossier),
        lock,
      },
    });
  }

  let releaseStatus: 'ready' | 'failed' | null = 'ready';
  try {
    const prepared = await (dependencies.preparePrWorktree ?? preparePrWorktree)(
      {
        repoId: dossier.repo.id,
        prNumber: dossier.target.number,
        createWorktree: true,
        sync: true,
        fetch: true,
        lock: false,
      },
      paths,
    );
    if (!prepared.ok) {
      releaseStatus = 'failed';
      await notifyCiFixAttention(dossier, report, prepared.message, paths);
      return lowerLevelFailure('autopilot_prepare_pr_worktree', prepared, {
        report,
        dossier,
      });
    }

    const worktreeId = stringField(
      objectField(objectField(prepared.data).worktree).id,
    );
    if (!worktreeId) {
      releaseStatus = 'failed';
      const message = 'PR worktree preparation did not return a worktree id.';
      await notifyCiFixAttention(dossier, report, message, paths);
      return failure(message, {
        requires: ['worktreeId'],
        data: {
          report: reportLink(report),
          dossier: dossierSummary(dossier),
        },
      });
    }

    const prompt = await ciFixPrompt(dossier, report, paths);
    const kilo = await (dependencies.startKiloTask ?? startKiloTask)(
      {
        worktreeId,
        title: `Fix CI: ${sourceRef(dossier)}`,
        prompt,
        mode: 'draft-fix',
        allowAuto: true,
        confirmAuto: true,
        explicitUserRequest: true,
      },
      paths,
    );
    if (!kilo.ok) {
      releaseStatus = 'failed';
      await notifyCiFixAttention(dossier, report, kilo.message, paths);
      return lowerLevelFailure('kilo_task_start', kilo, { report, dossier });
    }

    const kiloTaskId = stringField(objectField(kilo).taskId);
    const workflowSummary = await addWorkflowSummary(
      {
        workflow: 'ci_fix_run',
        ...(kiloTaskId ? { runId: kiloTaskId } : {}),
        status: 'running',
        summary: {
          type: 'ci_fix_run',
          outcome: 'kilo-started',
          pr: sourceRef(dossier),
          repoId: dossier.repo.id,
          repoFullName: dossier.target.repoFullName,
          prNumber: dossier.target.number,
          headSha: dossier.state.headSha,
          failedCheckCount: dossier.failingChecks.length,
          checks: dossier.failingChecks.map((check) => ({
            id: check.id,
            name: check.name,
            conclusion: check.conclusion,
          })),
          reportId: report.id,
          ciFixLockId: lock.lock.id,
          kiloTaskId: kiloTaskId ?? null,
          worktreeId,
        },
      },
      paths,
    );
    releaseStatus = null;
    await addNotification(
      {
        level: 'info',
        title: 'CI fix queued',
        message: `Queued Kilo CI fix for ${sourceRef(dossier)}.`,
        source: 'fix-pr-ci',
        sourceId: `${sourceRef(dossier)}:${dossier.state.headSha}:queued`,
        data: {
          workflow: 'fix-pr-ci',
          reportId: report.id,
          reportUrl: `/reports/${report.id}`,
          ciFixLockId: lock.lock.id,
          kiloTaskId: kiloTaskId ?? null,
          worktreeId,
        },
      },
      paths,
    );

    return {
      ok: true,
      action: 'ci_fix_run' as const,
      changed: true,
      message: `Queued CI fix for ${sourceRef(dossier)}.`,
      data: asJsonValue({
        workflow: 'fix-pr-ci',
        outcome: 'kilo-started',
        report: reportLink(report),
        dossier: dossierSummary(dossier),
        ciFixLockId: lock.lock.id,
        kiloTaskId: kiloTaskId ?? null,
        worktreeId,
      }),
      workflowSummary,
    };
  } finally {
    if (releaseStatus) {
      await (dependencies.releaseWorktreeLock ?? releaseWorktreeLock)(
        {
          lockId: lock.lock.id,
          owner: 'ci-fix-run',
          finalStatus: releaseStatus,
        },
        paths,
      );
    }
  }
}

export const fixPrCiRun = runCiFix;
export const createCiFailureDossierReport = createCiFixReport;

export async function readCiFixDossier(
  input: v.InferOutput<typeof ciFixRunInputSchema>,
  paths: RuntimePaths,
  dependencies: CiFixRunDependencies = {},
): Promise<
  | { ok: true; dossier: CiFixDossier }
  | { ok: false; result: ReturnType<typeof failure> }
> {
  if (dependencies.readDossier) {
    return { ok: true, dossier: await dependencies.readDossier(input, paths) };
  }

  const stateResult = await getGitHubPrEventState(
    {
      ref: input.ref,
      repo: input.repo,
      prNumber: input.prNumber,
    },
    paths,
    dependencies.prEventDependencies,
  );
  if (!stateResult.ok) {
    return {
      ok: false,
      result: failure(stateResult.message, {
        errors: stateResult.errors,
        requires: stateResult.requires,
      }),
    };
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

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      ok: false,
      result: failure('GITHUB_TOKEN is not configured.', {
        requires: ['GITHUB_TOKEN'],
      }),
    };
  }
  const failingChecks = await (
    dependencies.fetchFailingCheckFacts ?? fetchFailingCheckFacts
  )({
    token,
    owner: target.owner,
    repo: target.repo,
    ref: state.headSha,
    maxLogBytes: input.maxLogBytes ?? 64 * 1024,
  });
  const registry = await readRepoRegistrySnapshot(paths);
  const repo =
    registry.repos.find(
      (candidate) =>
        repoFullName(candidate).toLowerCase() ===
        target.repoFullName.toLowerCase(),
    ) ?? null;
  const likelyCommands = repo
    ? identifyLikelyCommands(failingChecks, repo, [], undefined, undefined)
    : [];

  return {
    ok: true,
    dossier: {
      target,
      state,
      repo,
      failingChecks,
      likelyCommands,
      fetchedAt: new Date().toISOString(),
    },
  };
}

export async function writeCiFixDossierReport(
  dossier: CiFixDossier,
  input: {
    createdBy: string;
    mode: 'fix' | 'report-only';
  },
  paths = runtimePaths(),
) {
  const ref = sourceRef(dossier);
  const generatedAt = new Date();
  return writeReport(
    {
      kind: 'ci-fix',
      title: `CI Failure Dossier: ${ref}`,
      repoId: dossier.repo?.id ?? null,
      sourceRef: ref,
      createdBy: input.createdBy,
      summary: {
        workflow: 'fix-pr-ci',
        mode: input.mode,
        repo: dossier.target.repoFullName,
        prNumber: dossier.target.number,
        headSha: dossier.state.headSha,
        failedCheckCount: dossier.failingChecks.length,
        likelyCommands: dossier.likelyCommands.slice(0, 5),
      },
      html: renderReportHtml({
        eyebrow: 'CI FIX',
        title: `CI Failure Dossier: ${ref}`,
        summary:
          dossier.failingChecks.length === 0
            ? 'No failing GitHub check runs were present in the fetched facts.'
            : `${dossier.failingChecks.length} failing check run${dossier.failingChecks.length === 1 ? '' : 's'} found for ${dossier.state.headSha.slice(0, 12)}.`,
        generatedAt,
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
                label: 'registered repo',
                value: dossier.repo
                  ? `${dossier.repo.id} (${dossier.repo.path})`
                  : 'not configured',
              },
            ],
          },
          {
            title: 'Failing Checks',
            items:
              dossier.failingChecks.length > 0
                ? dossier.failingChecks.map((check) => ({
                    label: check.name,
                    value: checkReportValue(check),
                  }))
                : [{ label: 'checks', value: 'No failing checks found.' }],
          },
          {
            title: 'Extracted Error Lines',
            items:
              extractedErrorLines(dossier).length > 0
                ? extractedErrorLines(dossier).map((line, index) => ({
                    label: `${index + 1}. ${line.check}`,
                    value: line.text,
                  }))
                : [
                    {
                      label: 'errors',
                      value:
                        'No high-signal error lines were extracted from annotations or logs.',
                    },
                  ],
          },
          {
            title: 'Suspect Files',
            items:
              suspectFiles(dossier).length > 0
                ? suspectFiles(dossier).map((path, index) => ({
                    label: `file ${index + 1}`,
                    value: path,
                  }))
                : [
                    {
                      label: 'files',
                      value:
                        'No suspect files were extracted from annotations or logs.',
                    },
                  ],
          },
          {
            title: 'Likely Local Commands',
            items:
              dossier.likelyCommands.length > 0
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
          {
            title: 'Recent Commits',
            items: recentCommits(dossier).map((commit) => ({
              label: commit.sha.slice(0, 12),
              value: [
                commit.authorLogin ? `author: ${commit.authorLogin}` : null,
                commit.committedAt ? `committed: ${commit.committedAt}` : null,
                commit.url,
              ]
                .filter(Boolean)
                .join('\n'),
            })),
          },
          {
            title: 'Run History',
            items: [
              {
                label: 'prior related runs',
                value:
                  'Not typed separately by the current GitHub helpers; this dossier includes current failing check runs and recent PR commits.',
              },
            ],
          },
        ],
      }),
    },
    paths,
  );
}

function parseCiFixInput(rawInput: CiFixRunInput):
  | { ok: true; input: v.InferOutput<typeof ciFixRunInputSchema> }
  | { ok: false; result: ReturnType<typeof failure> } {
  const parsed = v.safeParse(ciFixRunInputSchema, rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      result: failure('Invalid CI fix input.', {
        errors: [v.summarize(parsed.issues)],
        requires: ['pr'],
      }),
    };
  }
  if (!parsed.output.ref && (!parsed.output.repo || !parsed.output.prNumber)) {
    return {
      ok: false,
      result: failure('A PR reference or repo/prNumber is required.', {
        requires: ['pr'],
      }),
    };
  }
  return { ok: true, input: parsed.output };
}

async function ciFixPrompt(
  dossier: CiFixDossier,
  report: ReportRecord,
  paths: RuntimePaths,
) {
  const skill = await readFile(
    join(paths.skills, 'neon-ci-fix', 'SKILL.md'),
    'utf8',
  ).catch(() => '');
  return [
    skill.trim()
      ? `Runtime skill neon-ci-fix:\n${skill.trim()}`
      : 'Runtime skill neon-ci-fix was unavailable; follow the task bounds below.',
    '',
    `Task: fix the failing CI checks for ${sourceRef(dossier)}.`,
    `Report: /reports/${report.id}`,
    `Head SHA: ${dossier.state.headSha}`,
    '',
    'Bounds:',
    '- Fix only the failing checks described in the dossier.',
    '- Keep the change minimal and localized.',
    '- Run likely local commands only when they are allowed by the environment.',
    '- Commit local changes in this managed worktree when you make a fix.',
    '- Never push, open a pull request, submit a review, or post a GitHub comment.',
    '',
    'Dossier facts:',
    JSON.stringify(
      {
        pullRequest: {
          repo: dossier.target.repoFullName,
          number: dossier.target.number,
          title: dossier.state.title,
          url: dossier.state.url,
          headSha: dossier.state.headSha,
          baseRef: dossier.state.baseRef,
        },
        failingChecks: dossier.failingChecks.map((check) => ({
          id: check.id,
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          outputTitle: check.outputTitle,
          outputSummary: truncate(check.outputSummary ?? '', 4_000),
          outputText: truncate(check.outputText ?? '', 8_000),
          annotations: check.annotations.slice(0, 20),
          log: {
            available: check.log.available,
            truncated: check.log.truncated,
            unavailableReason: check.log.unavailableReason,
            text: truncate(check.log.text ?? '', 24_000),
          },
        })),
        likelyCommands: dossier.likelyCommands,
        recentCommits: recentCommits(dossier),
      },
      null,
      2,
    ),
  ].join('\n');
}

function checkReportValue(check: GitHubFailingCheckFact) {
  return [
    `status: ${check.status}`,
    `conclusion: ${check.conclusion ?? 'unknown'}`,
    check.outputTitle ? `title: ${check.outputTitle}` : null,
    check.outputSummary ? `summary: ${truncate(check.outputSummary, 2_000)}` : null,
    check.outputText ? `output: ${truncate(check.outputText, 4_000)}` : null,
    check.annotations.length
      ? `annotations:\n${check.annotations
          .slice(0, 10)
          .map(
            (annotation) =>
              `${annotation.path}${annotation.startLine ? `:${annotation.startLine}` : ''} ${annotation.annotationLevel}: ${annotation.message}`,
          )
          .join('\n')}`
      : null,
    check.log.available && check.log.text
      ? `log excerpt${check.log.truncated ? ' (truncated)' : ''}:\n${truncate(check.log.text, 6_000)}`
      : `log unavailable: ${check.log.unavailableReason ?? 'not available'}`,
    check.htmlUrl ? `url: ${check.htmlUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function extractedErrorLines(dossier: CiFixDossier) {
  const pattern =
    /\b(error|failed|failure|exception|traceback|assertion|panic|fatal|npm err|ts\d{4})\b/i;
  const lines: Array<{ check: string; text: string }> = [];
  for (const check of dossier.failingChecks) {
    for (const annotation of check.annotations) {
      lines.push({
        check: check.name,
        text: `${annotation.path}${annotation.startLine ? `:${annotation.startLine}` : ''} ${annotation.annotationLevel}: ${annotation.message}`,
      });
      if (lines.length >= 25) return lines;
    }
    for (const line of (check.log.text ?? '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !pattern.test(trimmed)) continue;
      lines.push({ check: check.name, text: truncate(trimmed, 1_000) });
      if (lines.length >= 25) return lines;
    }
  }
  return lines;
}

function suspectFiles(dossier: CiFixDossier) {
  const files = new Set<string>();
  const filePattern =
    /(?:^|\s)([A-Za-z0-9_.@/-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|astro|yml|yaml|sql|py|go|rs|java|kt|swift|rb|php|sh))(?:[:\s]|$)/g;
  for (const check of dossier.failingChecks) {
    for (const annotation of check.annotations) {
      if (annotation.path) files.add(annotation.path);
    }
    for (const line of (check.log.text ?? '').split(/\r?\n/)) {
      for (const match of line.matchAll(filePattern)) {
        const path = match[1];
        if (path && !path.startsWith('/')) files.add(path);
      }
    }
  }
  return [...files].slice(0, 40);
}

function recentCommits(dossier: CiFixDossier) {
  return dossier.state.commits.slice(-8);
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
    failingChecks: dossier.failingChecks.map((check) => ({
      id: check.id,
      name: check.name,
      conclusion: check.conclusion,
    })),
    errorLines: extractedErrorLines(dossier).slice(0, 10),
    suspectFiles: suspectFiles(dossier),
    likelyCommands: dossier.likelyCommands.slice(0, 5),
  };
}

function reportLink(report: ReportRecord) {
  return {
    id: report.id,
    title: report.title,
    url: `/reports/${report.id}`,
  };
}

async function notifyCiFixAttention(
  dossier: CiFixDossier,
  report: ReportRecord,
  message: string,
  paths: RuntimePaths,
) {
  await addNotification(
    {
      level: 'attention',
      title: 'CI fix needs attention',
      message,
      source: 'fix-pr-ci',
      sourceId: `${sourceRef(dossier)}:${dossier.state.headSha}:attention`,
      data: {
        workflow: 'fix-pr-ci',
        repo: dossier.target.repoFullName,
        prNumber: dossier.target.number,
        reportId: report.id,
        reportUrl: `/reports/${report.id}`,
      },
    },
    paths,
  );
}

function lowerLevelFailure(
  action: string,
  result: { message: string; requires?: string[]; errors?: string[] },
  input: { report: ReportRecord; dossier: CiFixDossier },
) {
  return failure(result.message, {
    requires: result.requires,
    errors: result.errors,
    data: {
      action,
      report: reportLink(input.report),
      dossier: dossierSummary(input.dossier),
      result,
    },
  });
}

function failure(
  message: string,
  options: {
    errors?: string[];
    requires?: string[];
    data?: unknown;
  } = {},
) {
  return {
    ok: false,
    action: 'ci_fix_run' as const,
    changed: false,
    message,
    ...(options.errors ? { errors: options.errors } : {}),
    ...(options.requires ? { requires: options.requires } : {}),
    ...(options.data ? { data: asJsonValue(options.data) } : {}),
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
  if (!repoFullName || !owner || !repo || !number) return null;
  return { repoFullName, owner, repo, number };
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[truncated]`;
}
