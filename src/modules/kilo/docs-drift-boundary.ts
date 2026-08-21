import { openDb } from '../../lib/sqlite.ts';
import { asJsonValue } from '../../lib/action-result';
import * as v from 'valibot';
import { ensureRuntimeHome, type RuntimePaths } from '../../runtime-home';
import type { RepoDiffSummary } from '../repos';
import type { KiloUntrustedInput } from './utils';

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
const boundaryRecordSchema = v.object({
  taskId: v.string(),
  reportId: v.string(),
  repoId: v.string(),
  repoFullName: v.string(),
  worktreeId: v.string(),
  allowedDocsPaths: v.array(v.unknown()),
  createdAt: v.string(),
});
const metadataRowSchema = v.object({ value: v.string() });

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
  const database = openDb(paths.neondeckDatabase);
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
  const database = openDb(paths.neondeckDatabase);
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
    const parsed = v.safeParse(boundaryRecordSchema, JSON.parse(value));
    if (!parsed.success) return null;
    const allowedDocsPaths = normalizeAllowedPaths(
      parsed.output.allowedDocsPaths,
    );
    if (allowedDocsPaths.length === 0) return null;

    return {
      taskId: parsed.output.taskId,
      reportId: parsed.output.reportId,
      repoId: parsed.output.repoId,
      repoFullName: parsed.output.repoFullName,
      worktreeId: parsed.output.worktreeId,
      allowedDocsPaths,
      createdAt: parsed.output.createdAt,
    };
  } catch {
    return null;
  }
}

function normalizeAllowedPaths(paths: KiloUntrustedInput[]) {
  return [
    ...new Set(paths.flatMap((path) => normalizeRelativePath(path) ?? [])),
  ].sort();
}

function normalizeRelativePath(value: KiloUntrustedInput) {
  const parsed = v.safeParse(v.string(), value);
  if (!parsed.success) return null;
  const path = parsed.output
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
  const parsed = v.safeParse(v.string(), title);
  return parsed.success && parsed.output.startsWith('Docs drift fix:');
}

function readMetadataValue(row: KiloUntrustedInput) {
  const parsed = v.safeParse(metadataRowSchema, row);
  return parsed.success ? parsed.output.value : undefined;
}
