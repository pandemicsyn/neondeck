import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
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
  kind: string;
  title: string;
  html: string;
  repoId?: string | null;
  sourceRef?: string | null;
  summary?: unknown;
  createdBy: string;
  createdAt?: string | Date;
};

export async function writeReport(
  input: WriteReportInput,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const kind = normalizeReportKind(input.kind);
  const id = randomUUID();
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
  await writeFile(filePath, input.html, 'utf8');

  const database = openDb(paths.neondeckDatabase);
  try {
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

  await pruneReports(paths, { kind, preserveIds: [id] });
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
    const rows = kind
      ? database
          .prepare(
            `
            SELECT *
            FROM reports
            WHERE kind = ?
            ORDER BY created_at DESC
            LIMIT ?;
          `,
          )
          .all(kind, limit)
      : excludeKind
        ? database
            .prepare(
              `
              SELECT *
              FROM reports
              WHERE kind != ?
              ORDER BY created_at DESC
              LIMIT ?;
            `,
            )
            .all(excludeKind, limit)
        : database
            .prepare(
              `
            SELECT *
            FROM reports
            ORDER BY created_at DESC
            LIMIT ?;
          `,
            )
            .all(limit);
    return rows.map(readReportRow);
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
    return row ? readReportRow(row) : null;
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
      .all(cutoff) as Array<{ id: string; html_path: string }>;
    for (const row of ageRows) {
      if (!preserved.has(row.id)) toDelete.set(row.id, row.html_path);
    }

    const kinds = options.kind
      ? [normalizeReportKind(options.kind)]
      : (
          database
            .prepare('SELECT DISTINCT kind FROM reports;')
            .all() as Array<{ kind: string }>
        ).map((row) => row.kind);

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
        .all(kind, maxPerKind) as Array<{ id: string; html_path: string }>;
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

function readReportRow(row: unknown): ReportRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    kind: String(record.kind),
    title: String(record.title),
    repoId: typeof record.repo_id === 'string' ? record.repo_id : null,
    sourceRef: typeof record.source_ref === 'string' ? record.source_ref : null,
    htmlPath: String(record.html_path),
    summary:
      typeof record.summary_json === 'string'
        ? JSON.parse(record.summary_json)
        : null,
    createdBy: String(record.created_by),
    createdAt: String(record.created_at),
  };
}

function normalizeReportKind(value: string) {
  const kind = value.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(kind) || kind.length > 64) {
    throw new Error('Report kind must be lowercase kebab-case.');
  }
  return kind;
}

function isNodeErrorCode(error: unknown, code: string) {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
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
