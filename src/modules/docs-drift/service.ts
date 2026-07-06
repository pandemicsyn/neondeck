import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import {
  asJsonValue,
  failedAction,
  invalidInputAction,
  okAction,
} from '../../lib/action-result';
import { runBoundedGit, runBoundedGitLines } from '../../lib/git';
import { renderReportHtml } from '../../lib/report-html';
import { parseInput, nonEmptyStringSchema } from '../../lib/valibot';
import type { JobRecord } from '../app-state';
import { recordDocsDriftFixTaskBoundary, startKiloTask } from '../kilo';
import { loadMemoryBackgroundContextSync } from '../memory';
import { loadRuntimeSkill } from '../runtime';
import { readReport, writeReport, type ReportRecord } from '../reports';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import { createWorktree } from '../worktrees';
import type { RuntimePaths } from '../../runtime-home';
import { runtimePaths } from '../../runtime-home';
import type { JobExecutionResult } from '../app-state';

type ChangedPath = {
  path: string;
  previousPath: string | null;
  status: string;
  removedSymbols: string[];
};

type DriftHit = {
  docPath: string;
  changedPath: string;
  previousPath: string | null;
  status: string;
  line: number;
  excerpt: string;
};

const maxDocsToScan = 200;
const maxSourceChangesToScan = 200;
const neonDocsFixSkillPath = fileURLToPath(
  new URL('../../skills/neon-docs-fix/SKILL.md', import.meta.url),
);

export const docsDriftStageFixInputSchema = v.object({
  reportId: nonEmptyStringSchema,
});

export type DocsDriftStageFixDependencies = {
  createWorktree?: typeof createWorktree;
  readReport?: typeof readReport;
  startKiloTask?: typeof startKiloTask;
};

export async function runDocsDriftJob(
  job: JobRecord,
  paths: RuntimePaths,
): Promise<JobExecutionResult> {
  try {
    return await runDocsDriftJobInner(job, paths);
  } catch (error) {
    return failed(job, `Docs drift failed: ${errorMessage(error)}.`);
  }
}

async function runDocsDriftJobInner(
  job: JobRecord,
  paths: RuntimePaths,
): Promise<JobExecutionResult> {
  const config = objectConfig(job.config);
  const repoRef = stringConfig(config.repo);
  if (!repoRef) {
    return failed(job, 'Docs drift requires a configured repository.');
  }

  const registry = await readRepoRegistrySnapshot(paths);
  const repo = registry.repos.find(
    (candidate) =>
      candidate.id === repoRef ||
      candidate.github.name === repoRef ||
      repoFullName(candidate).toLowerCase() === repoRef.toLowerCase(),
  );
  if (!repo) {
    return failed(job, `Docs drift repository "${repoRef}" is not configured.`);
  }

  const target = await docsDriftHead(repo.path, repo.defaultBranch);
  if (!target) {
    return failed(
      job,
      `Could not read ${repoFullName(repo)} default branch state.`,
    );
  }
  const previousCursor = docsDriftCursor(job.lastResult, target.head);
  const base =
    previousCursor?.base ??
    lastScannedCommit(job.lastResult) ??
    (await git(repo.path, ['rev-parse', `${target.head}~1`]).catch(
      () => target.head,
    ));
  const sourceOffset = previousCursor?.sourceOffset ?? 0;
  const docOffset = previousCursor?.docOffset ?? 0;
  const docsGlobs = stringArrayConfig(config.docsGlobs);
  const sourceGlobs = stringArrayConfig(config.sourceGlobs);
  const changed = await changedPaths(repo.path, base, target.head);
  const allSourceChanges = changed.filter(
    (item) =>
      !matchesDocsPath(item.path, docsGlobs) &&
      (!sourceGlobs.length || matchesAnyGlob(item.path, sourceGlobs)),
  );
  const sourceChanges = await addRemovedExportSymbols(
    repo.path,
    base,
    target.head,
    allSourceChanges.slice(sourceOffset, sourceOffset + maxSourceChangesToScan),
  );
  const allDocs = (
    await gitLines(repo.path, ['ls-tree', '-r', '--name-only', target.head])
  ).filter((file) => matchesDocsPath(file, docsGlobs));
  const docs = allDocs.slice(docOffset, docOffset + maxDocsToScan);
  const scan = await findDriftHits(repo.path, target.head, docs, sourceChanges);
  const nextCursor = scan.truncated
    ? { base, target: target.head, sourceOffset, docOffset }
    : nextDocsDriftCursor({
        base,
        target: target.head,
        sourceOffset,
        docOffset,
        allSourceChanges: allSourceChanges.length,
        scannedSourceChanges: sourceChanges.length,
        allDocs: allDocs.length,
        scannedDocs: docs.length,
      });
  const truncated = Boolean(nextCursor || scan.truncated);
  const hits = scan.hits;
  const result = {
    repo: repo.id,
    repoFullName: repoFullName(repo),
    base,
    scannedCommit: nextCursor ? base : target.head,
    attemptedCommit: target.head,
    cursor: nextCursor,
    headSource: target.source,
    headFetchError: target.fetchError,
    changedPathCount: allSourceChanges.length,
    scannedChangedPathCount: sourceChanges.length,
    sourceOffset,
    docCount: allDocs.length,
    scannedDocCount: docs.length,
    docOffset,
    hitCount: hits.length,
    truncated,
    hitTruncated: scan.truncated,
    hits,
    checkedAt: new Date().toISOString(),
  };

  if (hits.length === 0) {
    return {
      outcome: 'silent',
      message: `Docs drift found no hits for ${repoFullName(repo)}.`,
      result,
    };
  }

  const scanReportItems = [
    { label: 'repo', value: repoFullName(repo) },
    { label: 'range', value: `${base}..${target.head}` },
    { label: 'head source', value: target.source },
    target.fetchError
      ? { label: 'fetch warning', value: target.fetchError }
      : null,
    {
      label: 'docs scanned',
      value: `${docs.length} of ${allDocs.length}`,
    },
    {
      label: 'source changes scanned',
      value: `${sourceChanges.length} of ${allSourceChanges.length}`,
    },
    { label: 'truncated', value: truncated ? 'yes' : 'no' },
  ].filter((item): item is { label: string; value: string } => item !== null);

  const report = await writeReport(
    {
      kind: 'docs-drift',
      title: `Docs drift: ${repoFullName(repo)}`,
      repoId: repo.id,
      sourceRef: `${base}..${target.head}`,
      createdBy: `scheduler:${job.id}`,
      summary: result,
      html: renderReportHtml({
        title: `Docs drift: ${repoFullName(repo)}`,
        eyebrow: 'DOCS DRIFT',
        summary: `${hits.length} documentation reference${hits.length === 1 ? '' : 's'} may need review after ${sourceChanges.length} source path change${sourceChanges.length === 1 ? '' : 's'}.`,
        sections: [
          {
            title: 'Scan',
            items: scanReportItems,
          },
          {
            title: 'Stage Fix',
            items: [
              {
                label: 'action',
                value:
                  'Use the Reports panel stage button to start a docs-only Kilo handoff for these drift hits.',
              },
            ],
          },
          {
            title: 'Hits',
            items: hits.slice(0, 40).map((hit) => ({
              label: `${hit.docPath}:${hit.line}`,
              value: `${hit.changedPath}${hit.previousPath ? ` (was ${hit.previousPath})` : ''}\n${hit.excerpt}`,
            })),
          },
        ],
      }),
    },
    paths,
  );

  return {
    outcome: 'updated',
    message: `Docs drift found ${hits.length} hit${hits.length === 1 ? '' : 's'} for ${repoFullName(repo)}.`,
    result: { ...result, reportId: report.id },
    notifications: [
      {
        level: 'attention',
        title: 'Docs drift found',
        message: `${repoFullName(repo)} has ${hits.length} documentation reference${hits.length === 1 ? '' : 's'} to review.`,
        source: 'docs-drift',
        sourceId: job.id,
        data: {
          repo: repo.id,
          reportId: report.id,
          reportUrl: `/reports/${report.id}`,
        },
      },
    ],
  };
}

export async function stageDocsDriftFix(
  rawInput: unknown,
  paths = runtimePaths(),
  dependencies: DocsDriftStageFixDependencies = {},
) {
  const parsed = parseInput(docsDriftStageFixInputSchema, rawInput, (message) =>
    invalidInputAction('docs_drift_stage_fix', message),
  );
  if (!parsed.ok) return parsed.result;

  const report = await (dependencies.readReport ?? readReport)(
    parsed.input.reportId,
    paths,
  );
  if (!report) {
    return failedAction(
      'docs_drift_stage_fix',
      'Docs drift report not found.',
      {
        requires: ['reportId'],
      },
    );
  }
  if (report.kind !== 'docs-drift') {
    return failedAction(
      'docs_drift_stage_fix',
      'Only docs-drift reports can stage docs fixes.',
      { requires: ['docsDriftReport'] },
    );
  }

  const summary = docsDriftSummary(report);
  if (!summary || summary.hits.length === 0) {
    return failedAction(
      'docs_drift_stage_fix',
      'Docs drift report has no fixable drift hits.',
      { requires: ['driftHits'] },
    );
  }

  const registry = await readRepoRegistrySnapshot(paths);
  const repo = registry.repos.find(
    (candidate) => candidate.id === summary.repo,
  );
  if (!repo) {
    return failedAction(
      'docs_drift_stage_fix',
      `Repository "${summary.repo}" is not configured.`,
      { requires: ['repo'] },
    );
  }

  const created = await (dependencies.createWorktree ?? createWorktree)(
    {
      repoId: repo.id,
      baseRef: docsFixHeadSha(summary),
      headSha: docsFixHeadSha(summary),
      createdBy: 'neondeck',
    },
    paths,
  );
  if (!created.ok || !('worktree' in created)) {
    const result = objectConfig(created);
    return failedAction('docs_drift_stage_fix', created.message, {
      errors: stringArrayConfig(result.errors),
      requires: stringArrayConfig(result.requires),
    });
  }

  const taskId = `docs-drift-${randomUUID()}`;
  try {
    await recordDocsDriftFixTaskBoundary(
      {
        taskId,
        reportId: report.id,
        repoId: repo.id,
        repoFullName: summary.repoFullName,
        worktreeId: created.worktree.id,
        allowedDocsPaths: docsFixAllowedDocsPaths(summary),
      },
      paths,
    );
  } catch (error) {
    return failedAction(
      'docs_drift_stage_fix',
      `Could not record docs drift fix boundary: ${errorMessage(error)}.`,
      {
        requires: ['docsDriftBoundary'],
        errors: [errorMessage(error)],
      },
    );
  }

  const kilo = await (dependencies.startKiloTask ?? startKiloTask)(
    {
      taskId,
      worktreeId: created.worktree.id,
      title: `Docs drift fix: ${summary.repoFullName}`,
      prompt: await docsFixPrompt(summary, report, paths),
      mode: 'draft-fix',
      allowAuto: true,
      confirmAuto: true,
      explicitUserRequest: true,
    },
    paths,
  );
  if (!kilo.ok) {
    const result = objectConfig(kilo);
    return failedAction('docs_drift_stage_fix', kilo.message, {
      errors: stringArrayConfig(result.errors),
      requires: stringArrayConfig(result.requires),
    });
  }
  const startedTaskId = 'task' in kilo ? kilo.task.id : taskId;

  return okAction(
    'docs_drift_stage_fix',
    true,
    `Started docs drift fix task for ${summary.repoFullName}.`,
    {
      data: asJsonValue({
        report: reportLink(report),
        worktree: {
          id: created.worktree.id,
          path: created.worktree.localPath,
          headSha: created.worktree.headSha,
          targetSha: docsFixHeadSha(summary),
        },
        kiloTask: {
          id: startedTaskId,
        },
      }),
    },
  );
}

type DocsDriftSummary = {
  repo: string;
  repoFullName: string;
  base: string | null;
  scannedCommit: string;
  attemptedCommit: string | null;
  truncated: boolean;
  hits: DriftHit[];
};

function docsDriftSummary(report: ReportRecord): DocsDriftSummary | null {
  const summary = objectConfig(report.summary);
  const repo = stringConfig(summary.repo);
  const repoFullName = stringConfig(summary.repoFullName);
  const scannedCommit = stringConfig(summary.scannedCommit);
  if (!repo || !repoFullName || !scannedCommit) return null;

  const hits = Array.isArray(summary.hits)
    ? summary.hits.flatMap((hit) => {
        const record = objectConfig(hit);
        const docPath = stringConfig(record.docPath);
        const changedPath = stringConfig(record.changedPath);
        const status = stringConfig(record.status);
        const excerpt = stringConfig(record.excerpt);
        const line =
          typeof record.line === 'number' && Number.isInteger(record.line)
            ? record.line
            : null;
        if (!docPath || !changedPath || !status || !excerpt || line === null) {
          return [];
        }
        return [
          {
            docPath,
            changedPath,
            previousPath: stringConfig(record.previousPath),
            status,
            line,
            excerpt,
          },
        ];
      })
    : [];

  return {
    repo,
    repoFullName,
    base: stringConfig(summary.base),
    scannedCommit,
    attemptedCommit: stringConfig(summary.attemptedCommit),
    truncated: Boolean(summary.truncated),
    hits,
  };
}

async function docsFixPrompt(
  summary: DocsDriftSummary,
  report: ReportRecord,
  paths: RuntimePaths,
) {
  const skill = await runtimeSkillContent(
    'neon-docs-fix',
    neonDocsFixSkillPath,
    paths,
  );
  const docPaths = docsFixAllowedDocsPaths(summary);
  return [
    skill.trim()
      ? `Runtime skill neon-docs-fix:\n${skill.trim()}`
      : 'Runtime skill neon-docs-fix was unavailable; follow the task bounds below.',
    '',
    `Task: update stale documentation references for ${summary.repoFullName}.`,
    `Report: /reports/${report.id}`,
    `Scanned commit: ${summary.scannedCommit}`,
    summary.attemptedCommit
      ? `Attempted commit: ${summary.attemptedCommit}`
      : null,
    summary.truncated
      ? 'The drift scan was truncated. Fix only the listed, evidence-backed hits.'
      : null,
    '',
    'Bounds:',
    '- Edit only documentation files listed under allowedDocsPaths.',
    '- Do not change source code, tests, generated files, package metadata, lockfiles, or runtime config.',
    '- Keep documentation edits minimal and fact-backed by the drift hits.',
    '- Commit local changes in this managed worktree when you make a fix.',
    '- Never push, open a pull request, post comments, submit reviews, or mutate external systems.',
    '',
    loadMemoryBackgroundContextSync(paths, { repoId: summary.repo }).text,
    '',
    'Drift facts:',
    JSON.stringify(
      {
        report: reportLink(report),
        repo: summary.repo,
        repoFullName: summary.repoFullName,
        base: summary.base,
        scannedCommit: summary.scannedCommit,
        attemptedCommit: summary.attemptedCommit,
        targetCommit: docsFixHeadSha(summary),
        allowedDocsPaths: docPaths,
        hits: summary.hits.slice(0, 100),
      },
      null,
      2,
    ),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

async function runtimeSkillContent(
  id: string,
  fallbackPath: string,
  paths: RuntimePaths,
) {
  const loaded = await loadRuntimeSkill({ id }, paths);
  if (loaded.ok) return loaded.skill.content;
  return readFile(fallbackPath, 'utf8').catch(() => '');
}

function docsFixAllowedDocsPaths(summary: DocsDriftSummary) {
  return [...new Set(summary.hits.map((hit) => hit.docPath))].sort();
}

function docsFixHeadSha(summary: DocsDriftSummary) {
  return summary.attemptedCommit ?? summary.scannedCommit;
}

function reportLink(report: ReportRecord) {
  return {
    id: report.id,
    title: report.title,
    url: `/reports/${report.id}`,
  };
}

async function docsDriftHead(repoPath: string, defaultBranch: string) {
  const localHead = await git(repoPath, ['rev-parse', 'HEAD']).catch(
    () => null,
  );
  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  let fetchError: string | null = null;
  await git(repoPath, [
    'fetch',
    '--quiet',
    'origin',
    `+refs/heads/${defaultBranch}:${remoteRef}`,
  ]).catch((error) => {
    fetchError = errorMessage(error);
  });
  const remoteHead = await git(repoPath, [
    'rev-parse',
    '--verify',
    `${remoteRef}^{commit}`,
  ]).catch(() => null);
  if (remoteHead) {
    return {
      head: remoteHead,
      source: `origin/${defaultBranch}`,
      fetchError,
    };
  }
  if (localHead) {
    return {
      head: localHead,
      source: 'local-head',
      fetchError,
    };
  }
  return null;
}

function nextDocsDriftCursor(input: {
  base: string;
  target: string;
  sourceOffset: number;
  docOffset: number;
  allSourceChanges: number;
  scannedSourceChanges: number;
  allDocs: number;
  scannedDocs: number;
}) {
  if (input.allSourceChanges === 0 || input.allDocs === 0) return null;
  const nextDocOffset = input.docOffset + input.scannedDocs;
  if (nextDocOffset < input.allDocs) {
    return {
      base: input.base,
      target: input.target,
      sourceOffset: input.sourceOffset,
      docOffset: nextDocOffset,
    };
  }

  const nextSourceOffset = input.sourceOffset + input.scannedSourceChanges;
  if (nextSourceOffset < input.allSourceChanges) {
    return {
      base: input.base,
      target: input.target,
      sourceOffset: nextSourceOffset,
      docOffset: 0,
    };
  }

  return null;
}

async function changedPaths(cwd: string, base: string, head: string) {
  if (base === head) return [];
  const lines = await gitLines(cwd, ['diff', '--name-status', base, head]);
  return lines.flatMap((line): ChangedPath[] => {
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R')) {
      const previousPath = parts[1] ?? null;
      const path = parts[2] ?? previousPath;
      return path ? [{ path, previousPath, status, removedSymbols: [] }] : [];
    }
    const path = parts[1];
    return path
      ? [{ path, previousPath: null, status, removedSymbols: [] }]
      : [];
  });
}

async function addRemovedExportSymbols(
  cwd: string,
  base: string,
  head: string,
  changes: ChangedPath[],
) {
  return Promise.all(
    changes.map(async (change) => ({
      ...change,
      removedSymbols: await removedExportSymbols(cwd, base, head, change),
    })),
  );
}

async function removedExportSymbols(
  cwd: string,
  base: string,
  head: string,
  change: ChangedPath,
) {
  const diff = await git(cwd, [
    'diff',
    '--unified=0',
    base,
    head,
    '--',
    change.previousPath ?? change.path,
    change.path,
  ]).catch(() => '');
  const symbols = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    for (const symbol of removedExportSymbolsFromLine(line.slice(1))) {
      symbols.add(symbol);
    }
  }
  return [...symbols].sort();
}

function removedExportSymbolsFromLine(line: string) {
  const trimmed = line.trim();
  const declaration = trimmed.match(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  );
  if (declaration?.[1]) return [declaration[1]];

  const grouped = trimmed.match(/^export\s*\{\s*([^}]+)\s*\}/);
  if (!grouped?.[1]) return [];
  return grouped[1]
    .split(',')
    .flatMap((part) => {
      const names = part
        .trim()
        .split(/\s+as\s+/i)
        .map((name) => name.trim())
        .filter(Boolean);
      return names.length === 2 ? names : names.slice(0, 1);
    })
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

async function findDriftHits(
  repoPath: string,
  treeish: string,
  docs: string[],
  changes: ChangedPath[],
) {
  const hits: DriftHit[] = [];
  let truncated = false;
  const needles = changes.flatMap((change) =>
    [
      change.path,
      change.previousPath,
      basename(change.path),
      ...change.removedSymbols,
    ]
      .filter((value): value is string => Boolean(value && value.length > 2))
      .map((value) => ({ value, change })),
  );
  for (const docPath of docs) {
    const content = await readGitFile(repoPath, treeish, docPath).catch(
      () => '',
    );
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const needle of needles) {
        if (!line.includes(needle.value)) continue;
        if (hits.length < 100) {
          hits.push({
            docPath,
            changedPath: needle.change.path,
            previousPath: needle.change.previousPath,
            status: needle.change.status,
            line: index + 1,
            excerpt: line.trim().slice(0, 240),
          });
        } else {
          truncated = true;
        }
        break;
      }
    }
  }
  return { hits, truncated };
}

async function readGitFile(repoPath: string, treeish: string, path: string) {
  return git(repoPath, ['show', `${treeish}:${path}`]);
}

function matchesDocsPath(path: string, globs: string[]) {
  if (globs.length === 0) return /^docs\/.*\.(md|mdx|astro)$/.test(path);
  return matchesAnyGlob(path, globs);
}

function matchesAnyGlob(path: string, globs: string[]) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function globToRegExp(glob: string) {
  const globStarSlash = '__NEONDECK_GLOBSTAR_SLASH__';
  const globStar = '__NEONDECK_GLOBSTAR__';
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(
      /\\\{([^}]+)\\\}/g,
      (_, choices: string) =>
        `(${choices.split(',').map(escapeRegExp).join('|')})`,
    )
    .replace(/\*\*\//g, globStarSlash)
    .replace(/\*\*/g, globStar)
    .replace(/\*/g, '[^/]*')
    .replaceAll(globStarSlash, '(?:.*/)?')
    .replaceAll(globStar, '.*');
  return new RegExp(`^${escaped}$`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function gitLines(cwd: string, args: string[]) {
  return runBoundedGitLines(cwd, args);
}

async function git(cwd: string, args: string[]) {
  return runBoundedGit(cwd, args);
}

function lastScannedCommit(value: unknown) {
  const result = objectConfig(value);
  const commit = result.scannedCommit;
  return typeof commit === 'string' && commit.trim() ? commit : null;
}

function docsDriftCursor(value: unknown, target: string) {
  const result = objectConfig(value);
  const cursor = objectConfig(result.cursor);
  if (cursor.target !== target) return null;
  const base = stringConfig(cursor.base);
  const sourceOffset =
    typeof cursor.sourceOffset === 'number' &&
    Number.isInteger(cursor.sourceOffset) &&
    cursor.sourceOffset >= 0
      ? cursor.sourceOffset
      : null;
  const docOffset =
    typeof cursor.docOffset === 'number' &&
    Number.isInteger(cursor.docOffset) &&
    cursor.docOffset >= 0
      ? cursor.docOffset
      : null;
  if (!base || sourceOffset === null || docOffset === null) return null;
  return { base, target, sourceOffset, docOffset };
}

function stringConfig(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArrayConfig(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
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
        title: 'Docs drift failed',
        message,
        source: 'docs-drift',
        sourceId: job.id,
      },
    ],
  };
}
