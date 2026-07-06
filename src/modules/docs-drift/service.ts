import { readFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { runExecFile } from '../../lib/exec';
import { renderReportHtml } from '../../lib/report-html';
import type { JobRecord } from '../app-state';
import { writeReport } from '../reports';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import type { RuntimePaths } from '../../runtime-home';
import type { JobExecutionResult } from '../scheduler';

type ChangedPath = {
  path: string;
  previousPath: string | null;
  status: string;
};

type DriftHit = {
  docPath: string;
  changedPath: string;
  previousPath: string | null;
  status: string;
  line: number;
  excerpt: string;
};

export async function runDocsDriftJob(
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

  const head = await git(repo.path, ['rev-parse', 'HEAD']).catch(() => null);
  if (!head) {
    return failed(job, `Could not read ${repoFullName(repo)} HEAD.`);
  }
  const base =
    lastScannedCommit(job.lastResult) ??
    (await git(repo.path, ['rev-parse', 'HEAD~1']).catch(() => head));
  const docsGlobs = stringArrayConfig(config.docsGlobs);
  const sourceGlobs = stringArrayConfig(config.sourceGlobs);
  const changed = await changedPaths(repo.path, base, head);
  const sourceChanges = changed.filter(
    (item) =>
      !matchesDocsPath(item.path, docsGlobs) &&
      (!sourceGlobs.length || matchesAnyGlob(item.path, sourceGlobs)),
  );
  const docs = (await gitLines(repo.path, ['ls-files'])).filter((file) =>
    matchesDocsPath(file, docsGlobs),
  );
  const hits = await findDriftHits(repo.path, docs, sourceChanges);
  const result = {
    repo: repo.id,
    repoFullName: repoFullName(repo),
    base,
    scannedCommit: head,
    changedPathCount: sourceChanges.length,
    docCount: docs.length,
    hitCount: hits.length,
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

  const report = await writeReport(
    {
      kind: 'docs-drift',
      title: `Docs drift: ${repoFullName(repo)}`,
      repoId: repo.id,
      sourceRef: `${base}..${head}`,
      createdBy: `scheduler:${job.id}`,
      summary: {
        repo: repo.id,
        hitCount: hits.length,
        changedPathCount: sourceChanges.length,
      },
      html: renderReportHtml({
        title: `Docs drift: ${repoFullName(repo)}`,
        eyebrow: 'DOCS DRIFT',
        summary: `${hits.length} documentation reference${hits.length === 1 ? '' : 's'} may need review after ${sourceChanges.length} source path change${sourceChanges.length === 1 ? '' : 's'}.`,
        sections: [
          {
            title: 'Scan',
            items: [
              { label: 'repo', value: repoFullName(repo) },
              { label: 'range', value: `${base}..${head}` },
              { label: 'docs scanned', value: String(docs.length) },
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

async function changedPaths(cwd: string, base: string, head: string) {
  if (base === head) return [];
  const lines = await gitLines(cwd, ['diff', '--name-status', base, head]);
  return lines.flatMap((line): ChangedPath[] => {
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R')) {
      const previousPath = parts[1] ?? null;
      const path = parts[2] ?? previousPath;
      return path ? [{ path, previousPath, status }] : [];
    }
    const path = parts[1];
    return path ? [{ path, previousPath: null, status }] : [];
  });
}

async function findDriftHits(
  repoPath: string,
  docs: string[],
  changes: ChangedPath[],
) {
  const hits: DriftHit[] = [];
  const needles = changes.flatMap((change) =>
    [change.path, change.previousPath, basename(change.path)]
      .filter((value): value is string => Boolean(value && value.length > 2))
      .map((value) => ({ value, change })),
  );
  for (const docPath of docs) {
    const content = await readFile(repoFile(repoPath, docPath), 'utf8').catch(
      () => '',
    );
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const needle of needles) {
        if (!line.includes(needle.value)) continue;
        hits.push({
          docPath,
          changedPath: needle.change.path,
          previousPath: needle.change.previousPath,
          status: needle.change.status,
          line: index + 1,
          excerpt: line.trim().slice(0, 240),
        });
        break;
      }
    }
  }
  return hits.slice(0, 100);
}

function matchesDocsPath(path: string, globs: string[]) {
  if (globs.length === 0) return /^docs\/.*\.(md|mdx|astro)$/.test(path);
  return matchesAnyGlob(path, globs);
}

function matchesAnyGlob(path: string, globs: string[]) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function globToRegExp(glob: string) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(
      /\\\{([^}]+)\\\}/g,
      (_, choices: string) =>
        `(${choices.split(',').map(escapeRegExp).join('|')})`,
    )
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function repoFile(repoPath: string, relativePath: string) {
  const root = resolve(repoPath);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('Path escapes repository root.');
  }
  return target;
}

async function gitLines(cwd: string, args: string[]) {
  const output = await git(cwd, args);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await runExecFile('git', args, { cwd });
  return stdout.trim();
}

function lastScannedCommit(value: unknown) {
  const result = objectConfig(value);
  const commit = result.scannedCommit;
  return typeof commit === 'string' && commit.trim() ? commit : null;
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
