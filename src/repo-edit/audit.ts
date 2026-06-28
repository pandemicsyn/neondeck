import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureRuntimeHome,
  type RuntimePaths,
  runtimePaths,
} from '../runtime-home';
import type { DiffSummary, RepoEditStatus } from './schemas';

export type RepoEditEventInput = {
  repoId: string;
  sessionId?: string | null;
  workflowRunId?: string | null;
  actorType?: 'agent' | 'user' | 'system';
  actorId?: string | null;
  action: string;
  status: RepoEditStatus;
  reason?: string | null;
  paths: string[];
  inputHash?: string | null;
  diffSummary?: DiffSummary | null;
  diffPatch?: string | null;
  error?: unknown;
};

export type RepoEditEventRecord = RepoEditEventInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export async function recordRepoEditEvent(
  input: RepoEditEventInput,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const record: RepoEditEventRecord = {
    ...input,
    id: randomUUID(),
    actorType: input.actorType ?? 'agent',
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    workflowRunId: input.workflowRunId ?? null,
    reason: input.reason ?? null,
    inputHash: input.inputHash ?? null,
    diffSummary: input.diffSummary ?? null,
    diffPatch: cap(input.diffPatch ?? null),
    createdAt: now,
    updatedAt: now,
  };
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        INSERT INTO repo_edit_events (
          id,
          repo_id,
          session_id,
          workflow_run_id,
          actor_type,
          actor_id,
          action,
          status,
          reason,
          paths_json,
          input_hash,
          diff_summary_json,
          diff_patch,
          error_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        record.id,
        record.repoId,
        record.sessionId ?? null,
        record.workflowRunId ?? null,
        record.actorType ?? 'agent',
        record.actorId ?? null,
        record.action,
        record.status,
        record.reason ?? null,
        JSON.stringify(record.paths),
        record.inputHash ?? null,
        record.diffSummary ? JSON.stringify(record.diffSummary) : null,
        record.diffPatch ?? null,
        record.error === undefined ? null : JSON.stringify(record.error),
        record.createdAt,
        record.updatedAt,
      );
  } finally {
    database.close();
  }

  return record;
}

export async function listRepoEditEvents(paths: RuntimePaths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });

  try {
    return {
      ok: true,
      action: 'repo_edit_events_list',
      changed: false,
      message: 'Read recent repo edit events.',
      events: database
        .prepare(
          `
          SELECT *
          FROM repo_edit_events
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 100;
        `,
        )
        .all()
        .map(readRepoEditEventRow),
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

function readRepoEditEventRow(row: unknown) {
  const item = row as Record<string, unknown>;
  return {
    id: String(item.id),
    repoId: String(item.repo_id),
    sessionId: nullableString(item.session_id),
    workflowRunId: nullableString(item.workflow_run_id),
    actorType: String(item.actor_type),
    actorId: nullableString(item.actor_id),
    action: String(item.action),
    status: String(item.status),
    reason: nullableString(item.reason),
    paths: parseJsonArray(item.paths_json),
    inputHash: nullableString(item.input_hash),
    diffSummary: parseJson(item.diff_summary_json),
    diffPatch: nullableString(item.diff_patch),
    error: parseJson(item.error_json),
    createdAt: String(item.created_at),
    updatedAt: String(item.updated_at),
  };
}

function nullableString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function parseJson(value: unknown) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseJsonArray(value: unknown) {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function cap(value: string | null) {
  if (value === null) return null;
  const max = 256 * 1024;
  return value.length > max ? value.slice(0, max) : value;
}
