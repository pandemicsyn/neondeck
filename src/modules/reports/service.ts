import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { asJsonValue } from '../../lib/action-result';
import { collectValidRowsInBatches, openDb, parseRow } from '../../lib/sqlite';
import * as v from 'valibot';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';

export const reportRetention = {
  maxPerKind: 50,
  maxAgeDays: 90,
};

export type ReportRecord = {
  id: string;
  kind: string;
  title: string;
  repoId: string | null;
  sourceRef: string | null;
  htmlPath: string;
  summary: unknown | null;
  createdBy: string;
  createdAt: string;
};

export type WriteReportInput = {
  id?: string;
  signal?: AbortSignal;
  kind: string;
  title: string;
  html: string;
  repoId?: string | null;
  sourceRef?: string | null;
  summary?: unknown;
  createdBy: string;
  createdAt?: string | Date;
};

const persistedReportSchema = v.object({
  id: v.string(),
  kind: v.string(),
  title: v.string(),
  repo_id: v.nullable(v.string()),
  source_ref: v.nullable(v.string()),
  html_path: v.string(),
  summary_json: v.nullable(v.string()),
  created_by: v.string(),
  created_at: v.string(),
});

const reportPathRowSchema = v.object({
  id: v.string(),
  html_path: v.string(),
});

const reportKindRowSchema = v.object({ kind: v.string() });

const nodeErrorSchema = v.looseObject({ code: v.optional(v.string()) });
const reportExternalValueSchema = v.unknown();
type ReportExternalValue = v.InferInput<typeof reportExternalValueSchema>;

export async function writeReport(
  input: WriteReportInput,
  paths = runtimePaths(),
  dependencies: { prune?: typeof pruneReports } = {},
) {
  await ensureRuntimeHome(paths);
  input.signal?.throwIfAborted();
  const kind = normalizeReportKind(input.kind);
  const id = input.id ? normalizeReportId(input.id) : randomUUID();
  if (input.id) {
    const existing = await readReport(id, paths);
    if (existing) return existing;
  }
  const createdAt = dateText(input.createdAt ?? new Date());
  const htmlPath = `${kind}/${id}.html`;
  const filePath = resolveReportFilePath(paths, htmlPath);
  const summary =
    input.summary === undefined ? null : asJsonValue(input.summary);
  const record: ReportRecord = {
    id,
    kind,
    title: input.title.trim(),
    repoId: nullableTrim(input.repoId),
    sourceRef: nullableTrim(input.sourceRef),
    htmlPath,
    summary,
    createdBy: input.createdBy.trim(),
    createdAt,
  };

  if (!record.title) throw new Error('Report title is required.');
  if (!record.createdBy) throw new Error('Report creator is required.');

  await mkdir(resolveReportFilePath(paths, kind), { recursive: true });
  input.signal?.throwIfAborted();
  try {
    await writeFile(filePath, input.html, {
      encoding: 'utf8',
      signal: input.signal,
    });
    input.signal?.throwIfAborted();
  } catch (error) {
    try {
      await unlink(filePath);
    } catch (cleanupError) {
      if (!isNodeErrorCode(cleanupError, 'ENOENT')) {
        throw new AggregateError(
          [error, cleanupError],
          'Failed to write or cancel a report artifact and remove its partial file.',
        );
      }
    }
    throw error;
  }

  const database = openDb(paths.neondeckDatabase);
  try {
    input.signal?.throwIfAborted();
    database
      .prepare(
        `
        INSERT INTO reports (
          id,
          kind,
          title,
          repo_id,
          source_ref,
          html_path,
          summary_json,
          created_by,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        record.id,
        record.kind,
        record.title,
        record.repoId,
        record.sourceRef,
        record.htmlPath,
        record.summary === null ? null : JSON.stringify(record.summary),
        record.createdBy,
        record.createdAt,
      );
  } catch (error) {
    try {
      await unlink(filePath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Failed to insert report record and remove report artifact.',
      );
    }
    throw error;
  } finally {
    database.close();
  }

  try {
    input.signal?.throwIfAborted();
    await (dependencies.prune ?? pruneReports)(paths, {
      kind,
      preserveIds: [id],
    });
    input.signal?.throwIfAborted();
  } catch (error) {
    if (!input.signal?.aborted) throw error;
    const cleanupErrors: unknown[] = [];
    const cleanupDatabase = openDb(paths.neondeckDatabase);
    try {
      cleanupDatabase.prepare('DELETE FROM reports WHERE id = ?;').run(id);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    } finally {
      cleanupDatabase.close();
    }
    try {
      await unlink(filePath);
    } catch (cleanupError) {
      if (!isNodeErrorCode(cleanupError, 'ENOENT')) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Cancelled report write could not be fully rolled back.',
      );
    }
    throw error;
  }
  return record;
}

export async function listReports(
  paths = runtimePaths(),
  options: { kind?: string; excludeKind?: string; limit?: number } = {},
) {
  await ensureRuntimeHome(paths);
  const limit = clampLimit(options.limit);
  const kind = options.kind ? normalizeReportKind(options.kind) : null;
  const excludeKind = options.excludeKind
    ? normalizeReportKind(options.excludeKind)
    : null;
  const database = openDb(paths.neondeckDatabase);
  try {
    return collectValidRowsInBatches(
      limit,
      (batchLimit, offset) => {
        if (kind) {
          return database
            .prepare(
              `SELECT * FROM reports
               WHERE kind = ?
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?;`,
            )
            .all(kind, batchLimit, offset);
        }
        if (excludeKind) {
          return database
            .prepare(
              `SELECT * FROM reports
               WHERE kind != ?
               ORDER BY created_at DESC
               LIMIT ? OFFSET ?;`,
            )
            .all(excludeKind, batchLimit, offset);
        }
        return database
          .prepare(
            `SELECT * FROM reports
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?;`,
          )
          .all(batchLimit, offset);
      },
      safeReportRow,
    );
  } finally {
    database.close();
  }
}

export async function readReport(
  id: string,
  paths = runtimePaths(),
): Promise<ReportRecord | null> {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM reports WHERE id = ? LIMIT 1;')
      .get(id.trim());
    return row ? (safeReportRow(row)[0] ?? null) : null;
  } finally {
    database.close();
  }
}

export async function readReportHtml(id: string, paths = runtimePaths()) {
  const report = await readReport(id, paths);
  if (!report) return null;
  const html = await readFile(
    resolveReportFilePath(paths, report.htmlPath),
    'utf8',
  );
  return { report, html };
}

export async function pruneReports(
  paths = runtimePaths(),
  options: {
    kind?: string;
    maxPerKind?: number;
    maxAgeDays?: number;
    now?: Date;
    preserveIds?: string[];
  } = {},
) {
  await ensureRuntimeHome(paths);
  const maxPerKind = Math.max(
    1,
    options.maxPerKind ?? reportRetention.maxPerKind,
  );
  const maxAgeDays = Math.max(
    1,
    options.maxAgeDays ?? reportRetention.maxAgeDays,
  );
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const database = openDb(paths.neondeckDatabase);
  const toDelete = new Map<string, string>();
  const preserved = new Set(options.preserveIds ?? []);

  try {
    const ageRows = database
      .prepare(
        `
        SELECT id, html_path
        FROM reports
        WHERE created_at < ?;
      `,
      )
      .all(cutoff)
      .map((row) => parseRow(row, reportPathRowSchema, 'report path row'));
    for (const row of ageRows) {
      if (!preserved.has(row.id)) toDelete.set(row.id, row.html_path);
    }

    const kinds = options.kind
      ? [normalizeReportKind(options.kind)]
      : database
          .prepare('SELECT DISTINCT kind FROM reports;')
          .all()
          .map((row) => parseRow(row, reportKindRowSchema, 'report kind row'))
          .map((row) => row.kind);

    for (const kind of kinds) {
      const overflowRows = database
        .prepare(
          `
          SELECT id, html_path
          FROM reports
          WHERE kind = ?
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?;
        `,
        )
        .all(kind, maxPerKind)
        .map((row) => parseRow(row, reportPathRowSchema, 'report path row'));
      for (const row of overflowRows) {
        if (!preserved.has(row.id)) toDelete.set(row.id, row.html_path);
      }
    }

    for (const [id, htmlPath] of toDelete) {
      try {
        await unlink(resolveReportFilePath(paths, htmlPath));
      } catch (error) {
        if (!isNodeErrorCode(error, 'ENOENT')) throw error;
      }
      database.prepare('DELETE FROM reports WHERE id = ?;').run(id);
    }
  } finally {
    database.close();
  }

  return { deleted: toDelete.size };
}

export function reportsRoot(paths = runtimePaths()) {
  return join(paths.home, 'reports');
}

export function resolveReportFilePath(paths: RuntimePaths, htmlPath: string) {
  const root = resolve(reportsRoot(paths));
  const target = resolve(root, htmlPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('Report path escapes the reports directory.');
  }
  return target;
}

function readReportRow(
  record: v.InferOutput<typeof persistedReportSchema>,
): ReportRecord {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    repoId: record.repo_id,
    sourceRef: record.source_ref,
    htmlPath: record.html_path,
    summary: record.summary_json
      ? asJsonValue(JSON.parse(record.summary_json))
      : null,
    createdBy: record.created_by,
    createdAt: record.created_at,
  };
}

function safeReportRow(row: ReportExternalValue) {
  const parsed = v.safeParse(persistedReportSchema, row);
  if (!parsed.success) return [];
  try {
    return [readReportRow(parsed.output)];
  } catch {
    return [];
  }
}

function normalizeReportKind(value: string) {
  const kind = value.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(kind) || kind.length > 64) {
    throw new Error('Report kind must be lowercase kebab-case.');
  }
  return kind;
}

function normalizeReportId(value: string) {
  const id = value.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || id.length > 128) {
    throw new Error(
      'Report id must use only letters, numbers, underscores, and dashes.',
    );
  }
  return id;
}

function isNodeErrorCode(cause: unknown, code: string) {
  const parsed = v.safeParse(nodeErrorSchema, cause);
  return parsed.success && parsed.output.code === code;
}

function nullableTrim(value: string | null | undefined) {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

function clampLimit(limit: number | undefined) {
  if (!limit) return 50;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function dateText(value: string | Date) {
  if (value instanceof Date) return value.toISOString();
  return value;
}
