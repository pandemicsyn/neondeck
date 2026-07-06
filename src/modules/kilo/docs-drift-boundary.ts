import { DatabaseSync } from 'node:sqlite';
import { asJsonValue } from '../../lib/action-result';
import { ensureRuntimeHome, type RuntimePaths } from '../../runtime-home';
import type { RepoDiffSummary } from '../repos';

export type DocsDriftFixTaskBoundary = {
  taskId: string;
  reportId: string;
  repoId: string;
  repoFullName: string;
  worktreeId: string;
  allowedDocsPaths: string[];
  createdAt: string;
};

export type DocsDriftFixDiffViolation = {
  boundary: DocsDriftFixTaskBoundary | null;
  changedPaths: string[];
  disallowedPaths: string[];
  missingBoundary: boolean;
};

const keyPrefix = 'docs-drift.fix-task.';

export async function recordDocsDriftFixTaskBoundary(
  input: Omit<DocsDriftFixTaskBoundary, 'createdAt'>,
  paths: RuntimePaths,
) {
  await ensureRuntimeHome(paths);
  const boundary: DocsDriftFixTaskBoundary = {
    ...input,
    allowedDocsPaths: normalizeAllowedPaths(input.allowedDocsPaths),
    createdAt: new Date().toISOString(),
  };
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        boundaryKey(input.taskId),
        JSON.stringify(asJsonValue(boundary)),
        boundary.createdAt,
      );
  } finally {
    database.close();
  }
}

export function validateDocsDriftFixTaskDiff(
  task: { id: string; title?: string | null },
  diff: RepoDiffSummary,
  paths: RuntimePaths,
): DocsDriftFixDiffViolation | null {
  const boundary = readDocsDriftFixTaskBoundary(task.id, paths);
  if (!diff.ok || diff.fileCount === 0) return null;

  const changedPaths = diff.files
    .map((file) => normalizeRelativePath(file.path) ?? file.path)
    .sort();
  if (!boundary) {
    if (!isDocsDriftFixTask(task.title)) return null;
    return {
      boundary: null,
      changedPaths,
      disallowedPaths: changedPaths,
      missingBoundary: true,
    };
  }

  const allowed = new Set(boundary.allowedDocsPaths);
  const disallowedPaths = changedPaths.filter((path) => !allowed.has(path));
  if (disallowedPaths.length === 0) return null;

  return {
    boundary,
    changedPaths,
    disallowedPaths,
    missingBoundary: false,
  };
}

function readDocsDriftFixTaskBoundary(
  taskId: string,
  paths: RuntimePaths,
): DocsDriftFixTaskBoundary | null {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(boundaryKey(taskId));
    return parseBoundary(readMetadataValue(row));
  } finally {
    database.close();
  }
}

function parseBoundary(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return null;
    const allowedDocsPaths = Array.isArray(parsed.allowedDocsPaths)
      ? normalizeAllowedPaths(parsed.allowedDocsPaths)
      : [];
    if (
      typeof parsed.taskId !== 'string' ||
      typeof parsed.reportId !== 'string' ||
      typeof parsed.repoId !== 'string' ||
      typeof parsed.repoFullName !== 'string' ||
      typeof parsed.worktreeId !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      allowedDocsPaths.length === 0
    ) {
      return null;
    }

    return {
      taskId: parsed.taskId,
      reportId: parsed.reportId,
      repoId: parsed.repoId,
      repoFullName: parsed.repoFullName,
      worktreeId: parsed.worktreeId,
      allowedDocsPaths,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function normalizeAllowedPaths(paths: unknown[]) {
  return [
    ...new Set(paths.flatMap((path) => normalizeRelativePath(path) ?? [])),
  ].sort();
}

function normalizeRelativePath(value: unknown) {
  if (typeof value !== 'string') return null;
  const path = value
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .trim();
  if (
    !path ||
    path.startsWith('/') ||
    path === '..' ||
    path.startsWith('../')
  ) {
    return null;
  }
  return path;
}

function boundaryKey(taskId: string) {
  return `${keyPrefix}${taskId}`;
}

function isDocsDriftFixTask(title: string | null | undefined) {
  return typeof title === 'string' && title.startsWith('Docs drift fix:');
}

function readMetadataValue(row: unknown) {
  if (!row || typeof row !== 'object' || !('value' in row)) return undefined;
  const value = (row as { value: unknown }).value;
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
