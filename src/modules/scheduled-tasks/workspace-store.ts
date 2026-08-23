import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { openDb, rollbackQuietly } from '../../lib/sqlite';
import { isJsonValue } from '../execution/utils';
import {
  isoDateStringSchema,
  nonEmptyStringSchema,
  nullableIsoDateStringColumnSchema,
  nullableStringColumnSchema,
} from '../../lib/valibot';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import {
  workspaceProviderSnapshotSchema,
  type WorkspaceProviderSnapshot,
  type WorkspaceResource,
} from '../workspace-providers';
import {
  acquireLockInTransaction,
  type WorktreeLockRecord,
} from '../worktrees';
import type { ScheduledWorkspacePolicy } from './schemas';
import {
  maxPersistedScheduledArtifactBytes,
  sanitizedBoundedContent,
} from './content';

export type TaskWorkspaceStatus =
  | 'provisioning'
  | 'preparing'
  | 'ready'
  | 'active'
  | 'collecting'
  | 'retained'
  | 'cleanup-pending'
  | 'deleted'
  | 'failed';

export type TaskWorkspaceRecord = {
  id: string;
  taskId: string;
  owningRunId: string | null;
  providerId: string;
  providerResourceId: string;
  providerSnapshot: WorkspaceProviderSnapshot;
  physicalResourceKey: string;
  resourceMetadata: WorkspaceResourceMetadata;
  lifecycle: 'per-run' | 'reuse-task' | 'existing';
  repoId: string;
  repoSnapshot: ScheduledRepositoryIdentity;
  workspaceRoot: string;
  requestedRef: string;
  revisionMode: 'latest-each-run' | 'pinned' | 'continue';
  gitMode: 'run-branch' | 'task-branch' | 'direct-branch';
  branchName: string | null;
  baseSha: string | null;
  initialSha: string | null;
  finalSha: string | null;
  dirty: boolean | null;
  localWorktreeId: string | null;
  authority: 'read-only' | 'trusted-workspace' | 'delivery-enabled';
  retention: 'cleanup-success' | 'retain-always';
  status: TaskWorkspaceStatus;
  lockOwner: string | null;
  lockExpiresAt: string | null;
  collectionOwner: string | null;
  collectionExpiresAt: string | null;
  releaseFencedAt: string | null;
  retentionReason: string | null;
  providerError: string | null;
  createdAt: string;
  lastUsedAt: string;
  retainedAt: string | null;
  cleanupAttemptedAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
};

export type ScheduledRepositoryIdentity = {
  verified: boolean;
  id: string;
  github: { owner: string; name: string };
  path: string;
  defaultBranch: string;
};

const scheduledRepositoryIdentitySchema = v.strictObject({
  verified: v.boolean(),
  id: nonEmptyStringSchema,
  github: v.strictObject({
    owner: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
  }),
  path: nonEmptyStringSchema,
  defaultBranch: nonEmptyStringSchema,
});

type WorkspaceResourceMetadata =
  | {
      privateHome: string;
      scheduledWorktreeLockId?: string;
    }
  | {
      host: string;
      port?: number;
      username: string;
      providerRoot: string;
      privateHome: string;
      managedInfrastructure: boolean;
      managedDirectory?: boolean;
      pathsCanonical?: boolean;
      vmName?: string;
      attachedResourceId?: string;
    };

const localWorkspaceResourceMetadataSchema = v.strictObject({
  privateHome: nonEmptyStringSchema,
  scheduledWorktreeLockId: v.optional(nonEmptyStringSchema),
});

const remoteWorkspaceResourceMetadataSchema = v.strictObject({
  host: nonEmptyStringSchema,
  port: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
  ),
  username: nonEmptyStringSchema,
  providerRoot: nonEmptyStringSchema,
  privateHome: nonEmptyStringSchema,
  managedInfrastructure: v.boolean(),
  managedDirectory: v.optional(v.boolean()),
  pathsCanonical: v.optional(v.boolean()),
  vmName: v.optional(nonEmptyStringSchema),
  attachedResourceId: v.optional(nonEmptyStringSchema),
});

const workspaceResourceMetadataSchema = v.union([
  localWorkspaceResourceMetadataSchema,
  remoteWorkspaceResourceMetadataSchema,
]);

const taskWorkspaceRecordSchema: v.GenericSchema<unknown, TaskWorkspaceRecord> =
  v.pipe(
    v.strictObject({
      id: nonEmptyStringSchema,
      taskId: nonEmptyStringSchema,
      owningRunId: nullableStringColumnSchema,
      providerId: nonEmptyStringSchema,
      providerResourceId: nonEmptyStringSchema,
      providerSnapshot: workspaceProviderSnapshotSchema,
      physicalResourceKey: nonEmptyStringSchema,
      resourceMetadata: workspaceResourceMetadataSchema,
      lifecycle: v.picklist(['per-run', 'reuse-task', 'existing']),
      repoId: nonEmptyStringSchema,
      repoSnapshot: scheduledRepositoryIdentitySchema,
      workspaceRoot: nonEmptyStringSchema,
      requestedRef: nonEmptyStringSchema,
      revisionMode: v.picklist(['latest-each-run', 'pinned', 'continue']),
      gitMode: v.picklist(['run-branch', 'task-branch', 'direct-branch']),
      branchName: nullableStringColumnSchema,
      baseSha: nullableStringColumnSchema,
      initialSha: nullableStringColumnSchema,
      finalSha: nullableStringColumnSchema,
      dirty: v.nullable(v.boolean()),
      localWorktreeId: nullableStringColumnSchema,
      authority: v.picklist([
        'read-only',
        'trusted-workspace',
        'delivery-enabled',
      ]),
      retention: v.picklist(['cleanup-success', 'retain-always']),
      status: v.picklist([
        'provisioning',
        'preparing',
        'ready',
        'active',
        'collecting',
        'retained',
        'cleanup-pending',
        'deleted',
        'failed',
      ]),
      lockOwner: nullableStringColumnSchema,
      lockExpiresAt: nullableIsoDateStringColumnSchema,
      collectionOwner: nullableStringColumnSchema,
      collectionExpiresAt: nullableIsoDateStringColumnSchema,
      releaseFencedAt: nullableIsoDateStringColumnSchema,
      retentionReason: nullableStringColumnSchema,
      providerError: nullableStringColumnSchema,
      createdAt: isoDateStringSchema,
      lastUsedAt: isoDateStringSchema,
      retainedAt: nullableIsoDateStringColumnSchema,
      cleanupAttemptedAt: nullableIsoDateStringColumnSchema,
      deletedAt: nullableIsoDateStringColumnSchema,
      updatedAt: isoDateStringSchema,
    }),
    v.check(
      (record) => Boolean(record.lockOwner) === Boolean(record.lockExpiresAt),
      'Workspace lock owner and expiration must be present or absent together.',
    ),
    v.check(
      (record) =>
        Boolean(record.collectionOwner) === Boolean(record.collectionExpiresAt),
      'Workspace collection owner and expiration must be present or absent together.',
    ),
    v.check(
      (record) => record.status !== 'deleted' || record.deletedAt !== null,
      'Deleted workspaces require a deletion timestamp.',
    ),
    v.check(
      (record) => record.providerSnapshot.providerId === record.providerId,
      'Workspace provider snapshot id must match the live provider id.',
    ),
    v.check(
      (record) => record.repoSnapshot.id === record.repoId,
      'Workspace repository snapshot id must match the live repository id.',
    ),
    v.check(
      (record) =>
        record.providerSnapshot.driver === 'local'
          ? record.providerId === 'local' &&
            record.physicalResourceKey.startsWith('local:') &&
            v.safeParse(
              localWorkspaceResourceMetadataSchema,
              record.resourceMetadata,
            ).success
          : 'host' in record.resourceMetadata &&
            typeof record.resourceMetadata.host === 'string' &&
            typeof record.resourceMetadata.username === 'string' &&
            typeof record.resourceMetadata.providerRoot === 'string' &&
            record.workspaceRoot.startsWith('/') &&
            record.workspaceRoot !== '/' &&
            record.physicalResourceKey.startsWith('ssh://') &&
            v.safeParse(
              remoteWorkspaceResourceMetadataSchema,
              record.resourceMetadata,
            ).success,
      'Workspace provider resource metadata and physical identity must match its admitted adapter.',
    ),
  );

const taskWorkspaceDbRowSchema = v.strictObject({
  id: nonEmptyStringSchema,
  task_id: nonEmptyStringSchema,
  owning_run_id: nullableStringColumnSchema,
  provider_id: nonEmptyStringSchema,
  provider_resource_id: nonEmptyStringSchema,
  provider_snapshot_json: v.string(),
  physical_resource_key: nonEmptyStringSchema,
  resource_metadata_json: v.string(),
  lifecycle: v.picklist(['per-run', 'reuse-task', 'existing']),
  repo_id: nonEmptyStringSchema,
  repo_snapshot_json: v.string(),
  workspace_root: nonEmptyStringSchema,
  requested_ref: nonEmptyStringSchema,
  revision_mode: v.picklist(['latest-each-run', 'pinned', 'continue']),
  git_mode: v.picklist(['run-branch', 'task-branch', 'direct-branch']),
  branch_name: nullableStringColumnSchema,
  base_sha: nullableStringColumnSchema,
  initial_sha: nullableStringColumnSchema,
  final_sha: nullableStringColumnSchema,
  dirty: v.nullable(v.picklist([0, 1])),
  local_worktree_id: nullableStringColumnSchema,
  authority: v.picklist(['read-only', 'trusted-workspace', 'delivery-enabled']),
  retention: v.picklist(['cleanup-success', 'retain-always']),
  status: v.picklist([
    'provisioning',
    'preparing',
    'ready',
    'active',
    'collecting',
    'retained',
    'cleanup-pending',
    'deleted',
    'failed',
  ]),
  lock_owner: nullableStringColumnSchema,
  lock_expires_at: nullableIsoDateStringColumnSchema,
  collection_owner: nullableStringColumnSchema,
  collection_expires_at: nullableIsoDateStringColumnSchema,
  release_fenced_at: nullableIsoDateStringColumnSchema,
  retention_reason: nullableStringColumnSchema,
  provider_error: nullableStringColumnSchema,
  created_at: isoDateStringSchema,
  last_used_at: isoDateStringSchema,
  retained_at: nullableIsoDateStringColumnSchema,
  cleanup_attempted_at: nullableIsoDateStringColumnSchema,
  deleted_at: nullableIsoDateStringColumnSchema,
  updated_at: isoDateStringSchema,
  run_status: v.optional(
    v.nullable(v.picklist(['claimed', 'active', 'completed', 'failed'])),
  ),
});

const taskWorkspaceSnapshotDbRowSchema = v.strictObject({
  snapshot_json: v.string(),
});

export type ScheduledRunArtifact = {
  id: string;
  runId: string;
  workspaceId: string | null;
  kind: 'response' | 'command' | 'git-status' | 'diff' | 'patch' | 'cleanup';
  summary: string;
  content: string | null;
  truncated: boolean;
  redacted: boolean;
  createdAt: string;
};

const scheduledRunArtifactDbRowSchema = v.strictObject({
  id: nonEmptyStringSchema,
  run_id: nonEmptyStringSchema,
  workspace_id: nullableStringColumnSchema,
  kind: v.picklist([
    'response',
    'command',
    'git-status',
    'diff',
    'patch',
    'cleanup',
  ]),
  summary: v.string(),
  content: nullableStringColumnSchema,
  truncated: v.picklist([0, 1]),
  redacted: v.picklist([0, 1]),
  created_at: isoDateStringSchema,
});

const orphanedWorktreeDbRowSchema = v.strictObject({
  worktree_id: nonEmptyStringSchema,
  run_id: nullableStringColumnSchema,
  run_status: v.nullable(
    v.picklist(['claimed', 'active', 'completed', 'failed']),
  ),
});

const scheduledWorktreeMetadataSchema = v.object({
  scheduledWorktreeLockId: v.optional(nonEmptyStringSchema),
});

const physicalWorkspaceLeaseSchema = v.strictObject({
  owner: nonEmptyStringSchema,
  providerId: nonEmptyStringSchema,
  physicalResourceKey: nonEmptyStringSchema,
  expiresAt: isoDateStringSchema,
});

const physicalWorkspaceLeasePrefix = 'workspace-resource-lease:';
const physicalWorkspaceQuarantinePrefix = 'workspace-resource-quarantine:';

const physicalWorkspaceQuarantineSchema = v.strictObject({
  physicalResourceKey: nonEmptyStringSchema,
  providerId: nonEmptyStringSchema,
  source: v.picklist([
    'scheduled-run',
    'approved-execution',
    'preparation',
    'collection',
    'cleanup',
  ]),
  sourceId: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  createdAt: isoDateStringSchema,
  updatedAt: isoDateStringSchema,
});

export type PhysicalWorkspaceQuarantine = v.InferOutput<
  typeof physicalWorkspaceQuarantineSchema
>;

function physicalWorkspaceLeaseKey(physicalResourceKey: string) {
  return `${physicalWorkspaceLeasePrefix}${physicalResourceKey}`;
}

function physicalWorkspaceQuarantineKey(physicalResourceKey: string) {
  return `${physicalWorkspaceQuarantinePrefix}${physicalResourceKey}`;
}

function acquirePhysicalWorkspaceLeaseInTransaction(
  database: import('node:sqlite').DatabaseSync,
  input: {
    physicalResourceKey: string;
    providerId: string;
    owner: string;
    expiresAt: string;
    ignoreWorkspaceId?: string;
    allowQuarantined?: boolean;
  },
  now: string,
) {
  if (
    !input.allowQuarantined &&
    database
      .prepare('SELECT 1 FROM app_metadata WHERE key = ?;')
      .get(physicalWorkspaceQuarantineKey(input.physicalResourceKey))
  ) {
    return false;
  }
  const blockingWorkspace = database
    .prepare(
      `SELECT 1 FROM task_workspaces
       WHERE physical_resource_key = ?
         AND id <> COALESCE(?, '')
         AND lock_owner IS NOT NULL
         AND (
           lock_expires_at > ? OR EXISTS (
             SELECT 1 FROM scheduled_task_runs
             WHERE scheduled_task_runs.id = task_workspaces.owning_run_id
               AND scheduled_task_runs.status = 'active'
           )
         )
       LIMIT 1;`,
    )
    .get(input.physicalResourceKey, input.ignoreWorkspaceId ?? null, now);
  if (blockingWorkspace) return false;
  const key = physicalWorkspaceLeaseKey(input.physicalResourceKey);
  const currentRow = v.parse(
    v.optional(v.strictObject({ value: v.string() })),
    database.prepare('SELECT value FROM app_metadata WHERE key = ?;').get(key),
  );
  if (currentRow) {
    const current = v.parse(
      physicalWorkspaceLeaseSchema,
      JSON.parse(currentRow.value),
    );
    if (
      current.expiresAt <= now &&
      input.physicalResourceKey.startsWith('ssh://') &&
      !input.allowQuarantined
    ) {
      quarantineExpiredPhysicalLeaseInTransaction(
        database,
        input.physicalResourceKey,
        current,
        now,
      );
      return false;
    }
    if (current.owner !== input.owner && current.expiresAt > now) return false;
  }
  database
    .prepare(
      `INSERT INTO app_metadata (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
    )
    .run(
      key,
      JSON.stringify({
        owner: input.owner,
        providerId: input.providerId,
        physicalResourceKey: input.physicalResourceKey,
        expiresAt: input.expiresAt,
      }),
      now,
    );
  return true;
}

function releasePhysicalWorkspaceLeaseInTransaction(
  database: import('node:sqlite').DatabaseSync,
  physicalResourceKey: string,
  owner: string,
) {
  const now = new Date().toISOString();
  const fencedWorkspace = v.parse(
    v.optional(
      v.strictObject({
        provider_id: nonEmptyStringSchema,
        owning_run_id: nullableStringColumnSchema,
        release_fenced_at: isoDateStringSchema,
      }),
    ),
    database
      .prepare(
        `SELECT provider_id, owning_run_id, release_fenced_at
         FROM task_workspaces
         WHERE physical_resource_key = ? AND release_fenced_at IS NOT NULL
         ORDER BY release_fenced_at ASC
         LIMIT 1;`,
      )
      .get(physicalResourceKey),
  );
  const quarantineKey = physicalWorkspaceQuarantineKey(physicalResourceKey);
  const quarantined = database
    .prepare('SELECT 1 FROM app_metadata WHERE key = ?;')
    .get(quarantineKey);
  if (fencedWorkspace) {
    const quarantine = v.parse(physicalWorkspaceQuarantineSchema, {
      physicalResourceKey,
      providerId: fencedWorkspace.provider_id,
      source: 'scheduled-run',
      sourceId: fencedWorkspace.owning_run_id ?? owner,
      reason:
        'Physical release is fenced because a remote operation did not confirm settlement.',
      createdAt: fencedWorkspace.release_fenced_at,
      updatedAt: now,
    });
    database
      .prepare(
        `INSERT INTO app_metadata (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO NOTHING;`,
      )
      .run(quarantineKey, JSON.stringify(quarantine), now);
    return false;
  }
  if (quarantined) return false;
  const currentRow = v.parse(
    v.optional(v.strictObject({ value: v.string() })),
    database
      .prepare(
        `SELECT value FROM app_metadata
         WHERE key = ? AND json_extract(value, '$.owner') = ?;`,
      )
      .get(physicalWorkspaceLeaseKey(physicalResourceKey), owner),
  );
  if (currentRow && physicalResourceKey.startsWith('ssh://')) {
    const current = v.parse(
      physicalWorkspaceLeaseSchema,
      JSON.parse(currentRow.value),
    );
    if (current.expiresAt <= now) {
      quarantineExpiredPhysicalLeaseInTransaction(
        database,
        physicalResourceKey,
        current,
        now,
      );
      return false;
    }
  }
  const released = database
    .prepare(
      `DELETE FROM app_metadata
       WHERE key = ? AND json_extract(value, '$.owner') = ?;`,
    )
    .run(physicalWorkspaceLeaseKey(physicalResourceKey), owner);
  return released.changes === 1;
}

function quarantineExpiredPhysicalLeaseInTransaction(
  database: import('node:sqlite').DatabaseSync,
  physicalResourceKey: string,
  lease: v.InferOutput<typeof physicalWorkspaceLeaseSchema>,
  now: string,
) {
  const approvedExecutionOwnerPrefix = 'approved-execution:';
  const approvedExecution = lease.owner.startsWith(
    approvedExecutionOwnerPrefix,
  );
  const quarantine = v.parse(physicalWorkspaceQuarantineSchema, {
    physicalResourceKey,
    providerId: lease.providerId,
    source: approvedExecution ? 'approved-execution' : 'scheduled-run',
    sourceId: approvedExecution
      ? lease.owner.slice(approvedExecutionOwnerPrefix.length)
      : lease.owner,
    reason:
      'A remote physical-resource lease expired without a timely owner-confirmed release; process settlement is unknown.',
    createdAt: now,
    updatedAt: now,
  });
  database
    .prepare(
      `INSERT INTO app_metadata (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING;`,
    )
    .run(
      physicalWorkspaceQuarantineKey(physicalResourceKey),
      JSON.stringify(quarantine),
      now,
    );
}

export async function acquirePhysicalWorkspaceLease(
  input: {
    physicalResourceKey: string;
    providerId: string;
    owner: string;
    ttlMs: number;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const acquired = acquirePhysicalWorkspaceLeaseInTransaction(
      database,
      { ...input, expiresAt },
      nowIso,
    );
    database.exec('COMMIT;');
    return acquired;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function quarantinePhysicalWorkspace(
  input: Omit<PhysicalWorkspaceQuarantine, 'createdAt' | 'updatedAt'>,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const key = physicalWorkspaceQuarantineKey(input.physicalResourceKey);
    const existingRow = v.parse(
      v.optional(v.strictObject({ value: v.string() })),
      database
        .prepare('SELECT value FROM app_metadata WHERE key = ?;')
        .get(key),
    );
    const existing = existingRow
      ? v.parse(
          physicalWorkspaceQuarantineSchema,
          JSON.parse(existingRow.value),
        )
      : undefined;
    const quarantine = v.parse(physicalWorkspaceQuarantineSchema, {
      ...input,
      reason: sanitizedBoundedContent(input.reason, 16 * 1024).content,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    database
      .prepare(
        `INSERT INTO app_metadata (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
      )
      .run(key, JSON.stringify(quarantine), now);
    database.exec('COMMIT;');
    return quarantine;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function fenceTaskWorkspacePhysicalRelease(
  input: {
    workspaceId: string;
    runId: string;
    lockOwner?: string | null;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    const result = database
      .prepare(
        `UPDATE task_workspaces
         SET release_fenced_at = COALESCE(release_fenced_at, ?), updated_at = ?
         WHERE id = ? AND owning_run_id = ? AND provider_id <> 'local'
           AND status IN ('provisioning', 'preparing', 'ready', 'active', 'collecting', 'cleanup-pending', 'retained')
           AND (
             (? IS NULL AND lock_owner IS NULL)
             OR lock_owner = ?
           );`,
      )
      .run(
        now,
        now,
        input.workspaceId,
        input.runId,
        input.lockOwner ?? null,
        input.lockOwner ?? null,
      );
    return result.changes === 1;
  } finally {
    database.close();
  }
}

export async function listPhysicalWorkspaceQuarantines(
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const quarantines = database
      .prepare(
        `SELECT value FROM app_metadata
         WHERE key LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC;`,
      )
      .all(`${physicalWorkspaceQuarantinePrefix.replaceAll('_', '\\_')}%`)
      .map((row) =>
        v.parse(
          physicalWorkspaceQuarantineSchema,
          JSON.parse(v.parse(v.strictObject({ value: v.string() }), row).value),
        ),
      );
    const byKey = new Map(
      quarantines.map((quarantine) => [
        quarantine.physicalResourceKey,
        quarantine,
      ]),
    );
    const fencedRows = database
      .prepare(
        `SELECT physical_resource_key, provider_id, owning_run_id, release_fenced_at
         FROM task_workspaces
         WHERE release_fenced_at IS NOT NULL
         ORDER BY release_fenced_at ASC;`,
      )
      .all()
      .map((row) =>
        v.parse(
          v.strictObject({
            physical_resource_key: nonEmptyStringSchema,
            provider_id: nonEmptyStringSchema,
            owning_run_id: nullableStringColumnSchema,
            release_fenced_at: isoDateStringSchema,
          }),
          row,
        ),
      );
    for (const row of fencedRows) {
      if (byKey.has(row.physical_resource_key)) continue;
      byKey.set(
        row.physical_resource_key,
        v.parse(physicalWorkspaceQuarantineSchema, {
          physicalResourceKey: row.physical_resource_key,
          providerId: row.provider_id,
          source: 'scheduled-run',
          sourceId:
            row.owning_run_id ?? `workspace:${row.physical_resource_key}`,
          reason:
            'Physical release is fenced because durable quarantine persistence did not complete.',
          createdAt: row.release_fenced_at,
          updatedAt: row.release_fenced_at,
        }),
      );
    }
    return [...byKey.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  } finally {
    database.close();
  }
}

export async function readPhysicalWorkspaceQuarantine(
  physicalResourceKey: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = v.parse(
      v.optional(v.strictObject({ value: v.string() })),
      database
        .prepare('SELECT value FROM app_metadata WHERE key = ?;')
        .get(physicalWorkspaceQuarantineKey(physicalResourceKey)),
    );
    if (row) {
      return v.parse(physicalWorkspaceQuarantineSchema, JSON.parse(row.value));
    }
    const fenced = v.parse(
      v.optional(
        v.strictObject({
          provider_id: nonEmptyStringSchema,
          owning_run_id: nullableStringColumnSchema,
          release_fenced_at: isoDateStringSchema,
        }),
      ),
      database
        .prepare(
          `SELECT provider_id, owning_run_id, release_fenced_at
           FROM task_workspaces
           WHERE physical_resource_key = ? AND release_fenced_at IS NOT NULL
           ORDER BY release_fenced_at ASC
           LIMIT 1;`,
        )
        .get(physicalResourceKey),
    );
    return fenced
      ? v.parse(physicalWorkspaceQuarantineSchema, {
          physicalResourceKey,
          providerId: fenced.provider_id,
          source: 'scheduled-run',
          sourceId: fenced.owning_run_id ?? `workspace:${physicalResourceKey}`,
          reason:
            'Physical release is fenced because durable quarantine persistence did not complete.',
          createdAt: fenced.release_fenced_at,
          updatedAt: fenced.release_fenced_at,
        })
      : undefined;
  } finally {
    database.close();
  }
}

export async function clearPhysicalWorkspaceQuarantine(
  physicalResourceKey: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const quarantineKey = physicalWorkspaceQuarantineKey(physicalResourceKey);
    const quarantineRow = v.parse(
      v.optional(v.strictObject({ value: v.string() })),
      database
        .prepare('SELECT value FROM app_metadata WHERE key = ?;')
        .get(quarantineKey),
    );
    const fencedCount = v.parse(
      v.strictObject({ count: v.number() }),
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM task_workspaces
           WHERE physical_resource_key = ? AND release_fenced_at IS NOT NULL;`,
        )
        .get(physicalResourceKey),
    ).count;
    if (!quarantineRow && fencedCount === 0) {
      database.exec('COMMIT;');
      return false;
    }
    if (quarantineRow) {
      v.parse(
        physicalWorkspaceQuarantineSchema,
        JSON.parse(quarantineRow.value),
      );
    }

    const activeWorkspace = database
      .prepare(
        `SELECT 1 FROM task_workspaces
         WHERE physical_resource_key = ? AND release_fenced_at IS NOT NULL
           AND (lock_owner IS NOT NULL OR status IN ('provisioning', 'preparing', 'ready', 'active', 'collecting'))
         LIMIT 1;`,
      )
      .get(physicalResourceKey);
    if (activeWorkspace) {
      database.exec('COMMIT;');
      return false;
    }

    const leaseKey = physicalWorkspaceLeaseKey(physicalResourceKey);
    const leaseRow = v.parse(
      v.optional(v.strictObject({ value: v.string() })),
      database
        .prepare('SELECT value FROM app_metadata WHERE key = ?;')
        .get(leaseKey),
    );
    if (leaseRow) {
      const lease = v.parse(
        physicalWorkspaceLeaseSchema,
        JSON.parse(leaseRow.value),
      );
      if (lease.expiresAt > new Date().toISOString()) {
        database.exec('COMMIT;');
        return false;
      }
      const removedLease = database
        .prepare('DELETE FROM app_metadata WHERE key = ? AND value = ?;')
        .run(leaseKey, leaseRow.value);
      if (removedLease.changes !== 1) {
        rollbackQuietly(database);
        return false;
      }
    }
    if (quarantineRow) {
      const removedQuarantine = database
        .prepare('DELETE FROM app_metadata WHERE key = ? AND value = ?;')
        .run(quarantineKey, quarantineRow.value);
      if (removedQuarantine.changes !== 1) {
        rollbackQuietly(database);
        return false;
      }
    }
    database
      .prepare(
        `UPDATE task_workspaces
         SET release_fenced_at = NULL, updated_at = ?
         WHERE physical_resource_key = ? AND lock_owner IS NULL;`,
      )
      .run(new Date().toISOString(), physicalResourceKey);
    database.exec('COMMIT;');
    return true;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function releasePhysicalWorkspaceLease(
  input: { physicalResourceKey: string; owner: string },
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    releasePhysicalWorkspaceLeaseInTransaction(
      database,
      input.physicalResourceKey,
      input.owner,
    );
  } finally {
    database.close();
  }
}

export async function findReusableTaskWorkspace(
  taskId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(
        `SELECT * FROM task_workspaces
         WHERE task_id = ?
           AND lifecycle IN ('reuse-task', 'existing')
           AND status NOT IN ('deleted', 'failed', 'cleanup-pending')
           AND lock_owner IS NULL
         ORDER BY updated_at DESC LIMIT 1;`,
      )
      .get(taskId);
    return row ? readTaskWorkspaceRow(row) : undefined;
  } finally {
    database.close();
  }
}

export async function readTaskWorkspace(
  id: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(id);
    return row ? readTaskWorkspaceRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function readTaskWorkspaceSync(
  id: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(id);
    return row ? readTaskWorkspaceRow(row) : undefined;
  } finally {
    database.close();
  }
}

export async function readTaskWorkspaceForRun(
  runId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const value = database
      .prepare(
        `SELECT snapshot_json
         FROM scheduled_run_workspace_snapshots
         WHERE run_id = ?;`,
      )
      .get(runId);
    if (!value) return undefined;
    const row = v.parse(taskWorkspaceSnapshotDbRowSchema, value);
    return v.parse(taskWorkspaceRecordSchema, JSON.parse(row.snapshot_json));
  } finally {
    database.close();
  }
}

export async function createTaskWorkspaceRecord(
  input: {
    id?: string;
    taskId: string;
    runId: string;
    policy: Extract<ScheduledWorkspacePolicy, { kind: 'repository' }>;
    resource: WorkspaceResource;
    providerSnapshot: WorkspaceProviderSnapshot;
    physicalResourceKey: string;
    repoSnapshot: ScheduledRepositoryIdentity;
    localWorktreeId?: string;
    status?: TaskWorkspaceStatus;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const id = input.id ?? `task-workspace:${randomUUID()}`;
  const record = v.parse(taskWorkspaceRecordSchema, {
    id,
    taskId: input.taskId,
    owningRunId: input.runId,
    providerId: input.resource.providerId,
    providerResourceId: input.resource.externalId,
    providerSnapshot: input.providerSnapshot,
    physicalResourceKey: input.physicalResourceKey,
    resourceMetadata:
      input.resource.providerId === 'local'
        ? {
            privateHome: resolve(
              paths.home,
              'workspace-homes',
              input.resource.externalId.replace(/[^A-Za-z0-9._-]/g, '-'),
            ),
          }
        : input.resource.metadata,
    lifecycle: input.policy.resource.lifecycle,
    repoId: input.policy.repoId,
    repoSnapshot: v.parse(
      scheduledRepositoryIdentitySchema,
      input.repoSnapshot,
    ),
    workspaceRoot: input.resource.root,
    requestedRef: input.policy.revision.ref,
    revisionMode: input.policy.revision.mode,
    gitMode: input.policy.git.mode,
    branchName: null,
    baseSha: null,
    initialSha: null,
    finalSha: null,
    dirty: null,
    localWorktreeId: input.localWorktreeId ?? null,
    authority: input.policy.authority,
    retention: input.policy.retention ?? 'cleanup-success',
    status: input.status ?? 'provisioning',
    lockOwner: null,
    lockExpiresAt: null,
    collectionOwner: null,
    collectionExpiresAt: null,
    releaseFencedAt: null,
    retentionReason: null,
    providerError: null,
    createdAt: now,
    lastUsedAt: now,
    retainedAt: null,
    cleanupAttemptedAt: null,
    deletedAt: null,
    updatedAt: now,
  });
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    insertWorkspace(database, record);
    mergeScheduledRunResult(database, input.runId, { workspaceId: record.id });
    upsertRunWorkspaceSnapshot(database, input.runId, record);
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
  return record;
}

export async function bindReusableWorkspaceToRun(
  workspaceId: string,
  runId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const updated = database
      .prepare(
        `UPDATE task_workspaces
         SET owning_run_id = ?, status = 'preparing', retention_reason = NULL,
             provider_error = NULL, retained_at = NULL,
             last_used_at = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('deleted', 'failed', 'cleanup-pending')
           AND lock_owner IS NULL AND release_fenced_at IS NULL;`,
      )
      .run(runId, now, now, workspaceId);
    if (updated.changes !== 1) {
      throw new Error(
        `Reusable task workspace "${workspaceId}" is unavailable or being cleaned up.`,
      );
    }
    mergeScheduledRunResult(database, runId, { workspaceId });
    const row = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(workspaceId);
    if (!row) throw new Error(`Task workspace "${workspaceId}" was not found.`);
    upsertRunWorkspaceSnapshot(database, runId, readTaskWorkspaceRow(row));
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function listStrandedScheduledWorkspaces(
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT task_workspaces.*, scheduled_task_runs.status AS run_status
         FROM task_workspaces
         LEFT JOIN scheduled_task_runs
           ON scheduled_task_runs.id = task_workspaces.owning_run_id
         WHERE task_workspaces.status IN ('provisioning', 'preparing', 'ready', 'active', 'collecting')
           AND (
             scheduled_task_runs.id IS NULL
             OR scheduled_task_runs.status <> 'active'
           )
         ORDER BY task_workspaces.updated_at ASC;`,
      )
      .all()
      .map((value) => {
        const row = v.parse(taskWorkspaceDbRowSchema, value);
        return {
          workspace: readTaskWorkspaceRow(value),
          runStatus: row.run_status ?? null,
        };
      });
  } finally {
    database.close();
  }
}

export async function listOrphanedScheduledWorktreeProvisions(
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT worktrees.id AS worktree_id,
                worktrees.owning_workflow_run_id AS run_id,
                scheduled_task_runs.status AS run_status
         FROM worktrees
         LEFT JOIN task_workspaces
           ON task_workspaces.local_worktree_id = worktrees.id
         LEFT JOIN scheduled_task_runs
           ON scheduled_task_runs.id = worktrees.owning_workflow_run_id
         WHERE worktrees.owning_workflow_run_id LIKE 'scheduled-task-run:%'
           AND task_workspaces.id IS NULL
           AND worktrees.lifecycle_status <> 'deleted'
           AND (
             scheduled_task_runs.id IS NULL
             OR scheduled_task_runs.status <> 'active'
           );`,
      )
      .all()
      .map((row) => {
        const value = v.parse(orphanedWorktreeDbRowSchema, row);
        return {
          worktreeId: value.worktree_id,
          runId: value.run_id,
          runStatus: value.run_status,
        };
      });
  } finally {
    database.close();
  }
}

export async function updateTaskWorkspace(
  id: string,
  input: Partial<
    Pick<
      TaskWorkspaceRecord,
      | 'status'
      | 'workspaceRoot'
      | 'providerResourceId'
      | 'physicalResourceKey'
      | 'branchName'
      | 'baseSha'
      | 'initialSha'
      | 'finalSha'
      | 'dirty'
      | 'localWorktreeId'
      | 'retentionReason'
      | 'providerError'
      | 'retainedAt'
      | 'cleanupAttemptedAt'
      | 'deletedAt'
    >
  > & { resourceMetadata?: Record<string, unknown> },
  paths: RuntimePaths = runtimePaths(),
) {
  const current = await readTaskWorkspace(id, paths);
  if (!current) throw new Error(`Task workspace "${id}" was not found.`);
  const sanitizedInput = {
    ...input,
    ...(input.providerError !== undefined
      ? {
          providerError:
            input.providerError === null
              ? null
              : sanitizedBoundedContent(input.providerError, 16 * 1024).content,
        }
      : {}),
    ...(input.retentionReason !== undefined
      ? {
          retentionReason:
            input.retentionReason === null
              ? null
              : sanitizedBoundedContent(input.retentionReason, 16 * 1024)
                  .content,
        }
      : {}),
  };
  const next = v.parse(taskWorkspaceRecordSchema, {
    ...current,
    ...sanitizedInput,
    lastUsedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    database
      .prepare(
        `UPDATE task_workspaces SET
           workspace_root = ?, provider_resource_id = ?, physical_resource_key = ?, resource_metadata_json = ?,
           branch_name = ?, base_sha = ?, initial_sha = ?, final_sha = ?, dirty = ?,
           local_worktree_id = ?, status = ?, retention_reason = ?, provider_error = ?,
           retained_at = ?, cleanup_attempted_at = ?, deleted_at = ?,
           last_used_at = ?, updated_at = ?
         WHERE id = ?;`,
      )
      .run(
        next.workspaceRoot,
        next.providerResourceId,
        next.physicalResourceKey,
        JSON.stringify(next.resourceMetadata),
        next.branchName,
        next.baseSha,
        next.initialSha,
        next.finalSha,
        next.dirty === null ? null : next.dirty ? 1 : 0,
        next.localWorktreeId,
        next.status,
        next.retentionReason,
        next.providerError,
        next.retainedAt,
        next.cleanupAttemptedAt,
        next.deletedAt,
        next.lastUsedAt,
        next.updatedAt,
        id,
      );
    if (next.owningRunId) {
      upsertRunWorkspaceSnapshot(database, next.owningRunId, next);
    }
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
  return next;
}

export async function acquireTaskWorkspaceLock(
  input: { workspaceId: string; taskId: string; owner: string; ttlMs?: number },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 3_600_000));
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    database
      .prepare(
        `UPDATE task_workspaces SET lock_owner = NULL, lock_expires_at = NULL
         WHERE lock_expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM scheduled_task_runs
             WHERE scheduled_task_runs.id = task_workspaces.owning_run_id
               AND scheduled_task_runs.status = 'active'
           );`,
      )
      .run(now.toISOString());
    const workspaceIdentity = v.parse(
      v.optional(
        v.strictObject({
          physical_resource_key: nonEmptyStringSchema,
          provider_id: nonEmptyStringSchema,
        }),
      ),
      database
        .prepare(
          'SELECT physical_resource_key, provider_id FROM task_workspaces WHERE id = ? AND task_id = ?;',
        )
        .get(input.workspaceId, input.taskId),
    );
    if (
      !workspaceIdentity ||
      !acquirePhysicalWorkspaceLeaseInTransaction(
        database,
        {
          physicalResourceKey: workspaceIdentity.physical_resource_key,
          providerId: workspaceIdentity.provider_id,
          owner: input.owner,
          expiresAt: expiresAt.toISOString(),
          ignoreWorkspaceId: input.workspaceId,
        },
        now.toISOString(),
      )
    ) {
      database.exec('ROLLBACK;');
      return false;
    }
    const result = database
      .prepare(
        `UPDATE task_workspaces
         SET lock_owner = ?, lock_expires_at = ?, status = 'active', updated_at = ?
         WHERE id = ? AND task_id = ? AND lock_owner IS NULL
           AND release_fenced_at IS NULL
           AND status NOT IN ('cleanup-pending', 'deleted', 'failed')
           AND NOT EXISTS (
             SELECT 1 FROM task_workspaces AS physical
             WHERE physical.id <> task_workspaces.id
               AND physical.lock_owner IS NOT NULL
               AND (
                 physical.lock_expires_at > ?
                 OR EXISTS (
                   SELECT 1 FROM scheduled_task_runs AS physical_run
                   WHERE physical_run.id = physical.owning_run_id
                     AND physical_run.status = 'active'
                 )
               )
               AND physical.physical_resource_key = task_workspaces.physical_resource_key
           );`,
      )
      .run(
        input.owner,
        expiresAt.toISOString(),
        now.toISOString(),
        input.workspaceId,
        input.taskId,
        now.toISOString(),
      );
    if (result.changes !== 1) {
      database.exec('ROLLBACK;');
      return false;
    }
    database.exec('COMMIT;');
    return true;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function acquireAndBindScheduledWorktreeLock(
  input: {
    workspaceId: string;
    worktreeId: string;
    runId: string;
    owner: string;
    ttlMs?: number;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + (input.ttlMs ?? 7_200_000),
  ).toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const worktree = v.parse(
      v.strictObject({
        id: nonEmptyStringSchema,
        repo_id: nonEmptyStringSchema,
        pr_number: v.nullable(v.number()),
      }),
      database
        .prepare('SELECT id, repo_id, pr_number FROM worktrees WHERE id = ?;')
        .get(input.worktreeId),
    );
    const lock: WorktreeLockRecord = {
      id: randomUUID(),
      scope: 'worktree',
      scopeKey: `worktree:${worktree.id}`,
      worktreeId: worktree.id,
      repoId: worktree.repo_id,
      prNumber: worktree.pr_number,
      owner: input.owner,
      workflowRunId: input.runId,
      expiresAt,
      revokedAt: null,
      releasedAt: null,
      staleRecoveredAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const acquired = acquireLockInTransaction(database, lock, now);
    if (!acquired.ok) {
      database.exec('ROLLBACK;');
      return acquired;
    }
    const workspaceRow = database
      .prepare(
        `SELECT * FROM task_workspaces
         WHERE id = ? AND local_worktree_id = ? AND owning_run_id = ?
           AND status = 'preparing';`,
      )
      .get(input.workspaceId, input.worktreeId, input.runId);
    if (!workspaceRow) {
      const current = database
        .prepare(
          `SELECT local_worktree_id, owning_run_id, status
           FROM task_workspaces WHERE id = ?;`,
        )
        .get(input.workspaceId) as
        | {
            local_worktree_id: string | null;
            owning_run_id: string | null;
            status: string;
          }
        | undefined;
      throw new Error(
        `Scheduled workspace changed before its local worktree lock could be bound (expected worktree ${input.worktreeId}, run ${input.runId}, preparing; found ${current?.local_worktree_id ?? 'missing'}, ${current?.owning_run_id ?? 'missing'}, ${current?.status ?? 'missing'}).`,
      );
    }
    const workspace = readTaskWorkspaceRow(workspaceRow);
    const resourceMetadata = v.parse(localWorkspaceResourceMetadataSchema, {
      ...workspace.resourceMetadata,
      scheduledWorktreeLockId: lock.id,
    });
    const bound = database
      .prepare(
        `UPDATE task_workspaces
         SET resource_metadata_json = ?, updated_at = ?
         WHERE id = ? AND local_worktree_id = ? AND owning_run_id = ?
           AND status = 'preparing';`,
      )
      .run(
        JSON.stringify(resourceMetadata),
        createdAt,
        input.workspaceId,
        input.worktreeId,
        input.runId,
      );
    if (bound.changes !== 1) {
      throw new Error(
        'Scheduled workspace changed before its local worktree lock could be bound.',
      );
    }
    upsertRunWorkspaceSnapshot(database, input.runId, {
      ...workspace,
      resourceMetadata,
      updatedAt: createdAt,
    });
    database.exec('COMMIT;');
    return acquired;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function releaseTaskWorkspaceLock(
  workspaceId: string,
  owner: string,
  status: TaskWorkspaceStatus,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const released = database
      .prepare(
        `UPDATE task_workspaces
         SET lock_owner = NULL, lock_expires_at = NULL,
             collection_owner = NULL, collection_expires_at = NULL,
             status = ?, updated_at = ?
         WHERE id = ? AND lock_owner = ?;`,
      )
      .run(status, now, workspaceId, owner);
    if (released.changes === 1) {
      const row = database
        .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
        .get(workspaceId);
      if (row) {
        const workspace = readTaskWorkspaceRow(row);
        releasePhysicalWorkspaceLeaseInTransaction(
          database,
          workspace.physicalResourceKey,
          owner,
        );
        if (workspace.owningRunId) {
          upsertRunWorkspaceSnapshot(
            database,
            workspace.owningRunId,
            workspace,
          );
        }
      }
    }
    database.exec('COMMIT;');
    return released.changes === 1;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function finalizeTaskWorkspaceCollection(
  input: {
    workspaceId: string;
    runId: string;
    lockOwner: string;
    collectionOwner: string;
    finalSha: string | null;
    dirty: boolean;
    status: 'retained' | 'cleanup-pending';
    retentionReason: string | null;
    retainedAt: string | null;
    preservePhysicalLease?: boolean;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const currentRow = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(input.workspaceId);
    if (!currentRow) {
      throw new Error(`Task workspace "${input.workspaceId}" was not found.`);
    }
    releaseScheduledWorktreeLockInTransaction(
      database,
      readTaskWorkspaceRow(currentRow),
      input.lockOwner,
      now,
    );
    const updated = database
      .prepare(
        `UPDATE task_workspaces
         SET final_sha = ?, dirty = ?, status = ?, retention_reason = ?,
             retained_at = ?, last_used_at = ?, updated_at = ?,
             lock_owner = NULL, lock_expires_at = NULL,
             collection_owner = NULL, collection_expires_at = NULL
         WHERE id = ? AND owning_run_id = ? AND lock_owner = ? AND collection_owner = ?
           AND collection_expires_at > ?
           AND EXISTS (SELECT 1 FROM scheduled_task_runs WHERE id = ? AND status = 'active');`,
      )
      .run(
        input.finalSha,
        input.dirty ? 1 : 0,
        input.status,
        input.retentionReason,
        input.retainedAt,
        now,
        now,
        input.workspaceId,
        input.runId,
        input.lockOwner,
        input.collectionOwner,
        now,
        input.runId,
      );
    if (updated.changes !== 1) {
      throw new Error('Scheduled workspace collection lease was lost.');
    }
    const currentWorkspace = readTaskWorkspaceRow(currentRow);
    if (!input.preservePhysicalLease && !currentWorkspace.releaseFencedAt) {
      releasePhysicalWorkspaceLeaseInTransaction(
        database,
        currentWorkspace.physicalResourceKey,
        input.lockOwner,
      );
    }
    const row = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(input.workspaceId);
    if (!row)
      throw new Error(`Task workspace "${input.workspaceId}" was not found.`);
    const workspace = readTaskWorkspaceRow(row);
    upsertRunWorkspaceSnapshot(database, input.runId, workspace);
    database.exec('COMMIT;');
    return workspace;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function reconcileExpiredTerminalCollectionOwners(
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const rows = database
      .prepare(
        `SELECT * FROM task_workspaces
         WHERE status IN ('retained', 'cleanup-pending', 'deleted', 'failed')
           AND collection_owner IS NOT NULL AND collection_expires_at <= ?;`,
      )
      .all(now)
      .map(readTaskWorkspaceRow);
    for (const workspace of rows) {
      const cleared = database
        .prepare(
          `UPDATE task_workspaces
           SET lock_owner = NULL, lock_expires_at = NULL,
               collection_owner = NULL, collection_expires_at = NULL,
               updated_at = ?
           WHERE id = ? AND collection_owner = ? AND collection_expires_at <= ?;`,
        )
        .run(now, workspace.id, workspace.collectionOwner, now);
      if (cleared.changes === 1 && workspace.lockOwner) {
        releasePhysicalWorkspaceLeaseInTransaction(
          database,
          workspace.physicalResourceKey,
          workspace.lockOwner,
        );
      }
      if (cleared.changes === 1 && workspace.owningRunId) {
        const row = database
          .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
          .get(workspace.id);
        if (row) {
          upsertRunWorkspaceSnapshot(
            database,
            workspace.owningRunId,
            readTaskWorkspaceRow(row),
          );
        }
      }
    }
    database.exec('COMMIT;');
    return rows.length;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function acquireTaskWorkspaceCollectionLease(
  input: {
    workspaceId: string;
    runId: string;
    lockOwner: string;
    owner: string;
    ttlMs?: number;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 5 * 60_000));
  const database = openDb(paths.neondeckDatabase);
  try {
    const updated = database
      .prepare(
        `UPDATE task_workspaces
       SET collection_owner = ?, collection_expires_at = ?, status = 'collecting', updated_at = ?
       WHERE id = ? AND owning_run_id = ? AND lock_owner = ?
         AND status IN ('active', 'collecting')
         AND (collection_owner IS NULL OR collection_expires_at <= ? OR collection_owner = ?)
         AND EXISTS (SELECT 1 FROM scheduled_task_runs WHERE id = ? AND status = 'active');`,
      )
      .run(
        input.owner,
        expiresAt.toISOString(),
        now.toISOString(),
        input.workspaceId,
        input.runId,
        input.lockOwner,
        now.toISOString(),
        input.owner,
        input.runId,
      );
    return updated.changes === 1;
  } finally {
    database.close();
  }
}

export async function renewTaskWorkspaceCollectionLease(
  input: { workspaceId: string; runId: string; owner: string; ttlMs?: number },
  paths: RuntimePaths = runtimePaths(),
) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 5 * 60_000));
  const database = openDb(paths.neondeckDatabase);
  try {
    const result = database
      .prepare(
        `UPDATE task_workspaces SET collection_expires_at = ?, updated_at = ?
       WHERE id = ? AND owning_run_id = ? AND collection_owner = ?
         AND EXISTS (SELECT 1 FROM scheduled_task_runs WHERE id = ? AND status = 'active');`,
      )
      .run(
        expiresAt.toISOString(),
        now.toISOString(),
        input.workspaceId,
        input.runId,
        input.owner,
        input.runId,
      );
    return result.changes === 1;
  } finally {
    database.close();
  }
}

export function assertTaskWorkspaceCollectionLeaseSync(
  input: { workspaceId: string; runId: string; owner: string },
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const found = database
      .prepare(
        `SELECT 1 FROM task_workspaces
       JOIN scheduled_task_runs ON scheduled_task_runs.id = task_workspaces.owning_run_id
       WHERE task_workspaces.id = ? AND task_workspaces.owning_run_id = ?
         AND task_workspaces.collection_owner = ? AND task_workspaces.collection_expires_at > ?
         AND scheduled_task_runs.status = 'active';`,
      )
      .get(
        input.workspaceId,
        input.runId,
        input.owner,
        new Date().toISOString(),
      );
    if (!found)
      throw new Error('Scheduled workspace collection lease was lost.');
  } finally {
    database.close();
  }
}

export async function acquireWorkspaceProviderCoordinator(
  owner: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    database
      .prepare(
        `DELETE FROM workspace_provider_coordinator WHERE id = 'config' AND expires_at <= ?;`,
      )
      .run(now.toISOString());
    const result = database
      .prepare(
        `INSERT OR IGNORE INTO workspace_provider_coordinator (id, owner, expires_at, updated_at)
       VALUES ('config', ?, ?, ?);`,
      )
      .run(
        owner,
        new Date(now.getTime() + 5 * 60_000).toISOString(),
        now.toISOString(),
      );
    database.exec('COMMIT;');
    return result.changes === 1;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function renewWorkspaceProviderCoordinator(
  owner: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const now = new Date();
  const database = openDb(paths.neondeckDatabase);
  try {
    const renewed = database
      .prepare(
        `UPDATE workspace_provider_coordinator
         SET expires_at = ?, updated_at = ?
         WHERE id = 'config' AND owner = ? AND expires_at > ?;`,
      )
      .run(
        new Date(now.getTime() + 5 * 60_000).toISOString(),
        now.toISOString(),
        owner,
        now.toISOString(),
      );
    return renewed.changes === 1;
  } finally {
    database.close();
  }
}

export function assertWorkspaceProviderCoordinatorSync(
  owner: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const found = database
      .prepare(
        `SELECT 1 FROM workspace_provider_coordinator
         WHERE id = 'config' AND owner = ? AND expires_at > ?;`,
      )
      .get(owner, new Date().toISOString());
    if (!found) {
      throw new Error('Workspace provider configuration lease was lost.');
    }
  } finally {
    database.close();
  }
}

export function superviseWorkspaceProviderCoordinator(
  owner: string,
  paths: RuntimePaths = runtimePaths(),
) {
  let lost = false;
  const heartbeat = setInterval(() => {
    void renewWorkspaceProviderCoordinator(owner, paths)
      .then((renewed) => {
        if (!renewed) lost = true;
      })
      .catch(() => {
        lost = true;
      });
  }, 30_000);
  heartbeat.unref?.();
  return {
    assertLease() {
      if (lost) {
        throw new Error('Workspace provider configuration lease was lost.');
      }
      assertWorkspaceProviderCoordinatorSync(owner, paths);
    },
    stop() {
      clearInterval(heartbeat);
    },
  };
}

export async function releaseWorkspaceProviderCoordinator(
  owner: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `DELETE FROM workspace_provider_coordinator WHERE id = 'config' AND owner = ?;`,
      )
      .run(owner);
  } finally {
    database.close();
  }
}

export async function renewTaskWorkspaceLock(
  input: {
    workspaceId: string;
    runId: string;
    owner: string;
    ttlMs?: number;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 3_600_000));
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const renewed = database
      .prepare(
        `UPDATE task_workspaces
         SET lock_expires_at = ?, updated_at = ?
         WHERE id = ? AND owning_run_id = ? AND lock_owner = ?
           AND lock_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM scheduled_task_runs
             WHERE id = ? AND status = 'active'
               AND json_extract(dispatch_payload_json, '$.workspaceId') = ?
               AND json_extract(dispatch_payload_json, '$.lockOwner') = ?
           );`,
      )
      .run(
        expiresAt.toISOString(),
        now.toISOString(),
        input.workspaceId,
        input.runId,
        input.owner,
        now.toISOString(),
        input.runId,
        input.workspaceId,
        input.owner,
      );
    if (renewed.changes === 1) {
      const identity = v.parse(
        v.strictObject({
          physical_resource_key: nonEmptyStringSchema,
        }),
        database
          .prepare(
            'SELECT physical_resource_key FROM task_workspaces WHERE id = ?;',
          )
          .get(input.workspaceId),
      );
      const leaseRenewed = database
        .prepare(
          `UPDATE app_metadata
           SET value = json_set(value, '$.expiresAt', ?), updated_at = ?
           WHERE key = ? AND json_extract(value, '$.owner') = ?
             AND json_extract(value, '$.expiresAt') > ?;`,
        )
        .run(
          expiresAt.toISOString(),
          now.toISOString(),
          physicalWorkspaceLeaseKey(identity.physical_resource_key),
          input.owner,
          now.toISOString(),
        );
      if (leaseRenewed.changes !== 1) {
        throw new Error('The physical workspace lease is no longer active.');
      }
    }
    const workspace = v.parse(
      v.optional(
        v.strictObject({
          local_worktree_id: nullableStringColumnSchema,
          resource_metadata_json: v.string(),
        }),
      ),
      database
        .prepare(
          'SELECT local_worktree_id, resource_metadata_json FROM task_workspaces WHERE id = ?;',
        )
        .get(input.workspaceId),
    );
    if (renewed.changes === 1 && workspace?.local_worktree_id) {
      const metadata = v.parse(
        scheduledWorktreeMetadataSchema,
        JSON.parse(workspace.resource_metadata_json ?? '{}'),
      );
      if (typeof metadata.scheduledWorktreeLockId === 'string') {
        const worktreeRenewed = database
          .prepare(
            `UPDATE worktree_locks
             SET expires_at = ?, updated_at = ?
             WHERE id = ? AND owner = ? AND workflow_run_id = ?
               AND released_at IS NULL AND revoked_at IS NULL;`,
          )
          .run(
            expiresAt.toISOString(),
            now.toISOString(),
            metadata.scheduledWorktreeLockId,
            input.owner,
            input.runId,
          );
        if (worktreeRenewed.changes !== 1) {
          throw new Error(
            'The scheduled local-worktree lease is no longer active.',
          );
        }
      }
    }
    database.exec('COMMIT;');
    return renewed.changes === 1;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export function assertScheduledWorkspaceRunAuthorizedSync(
  input: { workspaceId: string; runId: string; owner: string },
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const authorized = database
      .prepare(
        `SELECT 1
         FROM task_workspaces
         JOIN scheduled_task_runs
           ON scheduled_task_runs.id = task_workspaces.owning_run_id
         WHERE task_workspaces.id = ?
           AND task_workspaces.owning_run_id = ?
           AND task_workspaces.lock_owner = ?
           AND task_workspaces.status = 'active'
           AND task_workspaces.release_fenced_at IS NULL
           AND EXISTS (
             SELECT 1 FROM app_metadata
             WHERE app_metadata.key = 'workspace-resource-lease:' || task_workspaces.physical_resource_key
               AND json_extract(app_metadata.value, '$.owner') = task_workspaces.lock_owner
               AND json_extract(app_metadata.value, '$.expiresAt') > ?
           )
           AND scheduled_task_runs.status = 'active'
           AND json_extract(scheduled_task_runs.dispatch_payload_json, '$.workspaceId') = ?
           AND json_extract(scheduled_task_runs.dispatch_payload_json, '$.lockOwner') = ?;`,
      )
      .get(
        input.workspaceId,
        input.runId,
        input.owner,
        new Date().toISOString(),
        input.workspaceId,
        input.owner,
      );
    if (!authorized) {
      throw new Error(
        `Scheduled run "${input.runId}" no longer owns workspace "${input.workspaceId}".`,
      );
    }
  } finally {
    database.close();
  }
}

export async function acquireTaskWorkspaceCleanupLease(
  input: {
    workspaceId: string;
    owningRunId: string;
    owner: string;
    allowAbandoned?: boolean;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const identity = v.parse(
      v.optional(
        v.strictObject({
          physical_resource_key: nonEmptyStringSchema,
          provider_id: nonEmptyStringSchema,
        }),
      ),
      database
        .prepare(
          'SELECT physical_resource_key, provider_id FROM task_workspaces WHERE id = ?;',
        )
        .get(input.workspaceId),
    );
    if (
      !identity ||
      !acquirePhysicalWorkspaceLeaseInTransaction(
        database,
        {
          physicalResourceKey: identity.physical_resource_key,
          providerId: identity.provider_id,
          owner: input.owner,
          expiresAt,
          ignoreWorkspaceId: input.workspaceId,
          allowQuarantined: true,
        },
        now.toISOString(),
      )
    ) {
      database.exec('ROLLBACK;');
      return false;
    }
    const result = database
      .prepare(
        `UPDATE task_workspaces
         SET lock_owner = ?, lock_expires_at = ?, status = 'cleanup-pending',
             cleanup_attempted_at = ?, updated_at = ?
         WHERE id = ? AND owning_run_id = ?
           AND (lock_owner IS NULL OR lock_expires_at <= ?)
           AND (
             status IN ('ready', 'retained', 'cleanup-pending', 'failed')
             OR (? = 1 AND status IN ('provisioning', 'preparing', 'active', 'collecting'))
           )
           AND NOT EXISTS (
             SELECT 1 FROM scheduled_task_runs
             WHERE scheduled_task_runs.id = task_workspaces.owning_run_id
               AND (
                 (scheduled_task_runs.status = 'active'
                   AND (? IS NULL OR scheduled_task_runs.id <> ?))
                 OR (scheduled_task_runs.status = 'claimed' AND ? = 0)
               )
           );`,
      )
      .run(
        input.owner,
        expiresAt,
        now.toISOString(),
        now.toISOString(),
        input.workspaceId,
        input.owningRunId,
        now.toISOString(),
        input.allowAbandoned ? 1 : 0,
        input.owningRunId,
        input.owningRunId,
        input.allowAbandoned ? 1 : 0,
      );
    if (result.changes !== 1) {
      database.exec('ROLLBACK;');
      return false;
    }
    database.exec('COMMIT;');
    return true;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function renewTaskWorkspaceCleanupLease(
  input: {
    workspaceId: string;
    owningRunId: string;
    owner: string;
    ttlMs?: number;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + (input.ttlMs ?? 5 * 60_000),
  ).toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const renewed = database
      .prepare(
        `UPDATE task_workspaces
         SET lock_expires_at = ?, updated_at = ?
         WHERE id = ? AND owning_run_id = ? AND lock_owner = ? AND lock_expires_at > ?
           AND status = 'cleanup-pending';`,
      )
      .run(
        expiresAt,
        now.toISOString(),
        input.workspaceId,
        input.owningRunId,
        input.owner,
        now.toISOString(),
      );
    if (renewed.changes !== 1) {
      database.exec('ROLLBACK;');
      return false;
    }
    const identity = v.parse(
      v.strictObject({ physical_resource_key: nonEmptyStringSchema }),
      database
        .prepare(
          'SELECT physical_resource_key FROM task_workspaces WHERE id = ?;',
        )
        .get(input.workspaceId),
    );
    const physicalRenewed = database
      .prepare(
        `UPDATE app_metadata
         SET value = json_set(value, '$.expiresAt', ?), updated_at = ?
         WHERE key = ? AND json_extract(value, '$.owner') = ?
           AND json_extract(value, '$.expiresAt') > ?;`,
      )
      .run(
        expiresAt,
        now.toISOString(),
        physicalWorkspaceLeaseKey(identity.physical_resource_key),
        input.owner,
        now.toISOString(),
      );
    if (physicalRenewed.changes !== 1) {
      throw new Error('Scheduled workspace cleanup physical lease was lost.');
    }
    database.exec('COMMIT;');
    return true;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export function assertTaskWorkspaceCleanupLeaseSync(
  input: { workspaceId: string; owningRunId: string; owner: string },
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const owned = database
      .prepare(
        `SELECT 1 FROM task_workspaces
         WHERE id = ? AND owning_run_id = ? AND lock_owner = ? AND lock_expires_at > ?
           AND status = 'cleanup-pending'
           AND EXISTS (
             SELECT 1 FROM app_metadata
             WHERE app_metadata.key = 'workspace-resource-lease:' || task_workspaces.physical_resource_key
               AND json_extract(app_metadata.value, '$.owner') = task_workspaces.lock_owner
               AND json_extract(app_metadata.value, '$.expiresAt') > ?
           );`,
      )
      .get(
        input.workspaceId,
        input.owningRunId,
        input.owner,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    if (!owned) throw new Error('Scheduled workspace cleanup lease was lost.');
  } finally {
    database.close();
  }
}

export async function finalizeTaskWorkspaceCleanup(
  input: {
    workspaceId: string;
    owningRunId: string;
    owner: string;
    status: 'deleted' | 'cleanup-pending';
    deletedAt: string | null;
    providerError: string | null;
    retentionReason?: string | null;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  const now = new Date().toISOString();
  const providerError =
    input.providerError === null
      ? null
      : sanitizedBoundedContent(input.providerError, 16 * 1024).content;
  const retentionReason =
    input.retentionReason == null
      ? input.retentionReason
      : sanitizedBoundedContent(input.retentionReason, 16 * 1024).content;
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const finalized = database
      .prepare(
        `UPDATE task_workspaces
         SET status = ?, deleted_at = ?, provider_error = ?,
             retention_reason = COALESCE(?, retention_reason),
             lock_owner = NULL, lock_expires_at = NULL,
             collection_owner = NULL, collection_expires_at = NULL,
             updated_at = ?
         WHERE id = ? AND owning_run_id = ? AND lock_owner = ? AND lock_expires_at > ?
           AND status = 'cleanup-pending';`,
      )
      .run(
        input.status,
        input.deletedAt,
        providerError,
        retentionReason ?? null,
        now,
        input.workspaceId,
        input.owningRunId,
        input.owner,
        now,
      );
    if (finalized.changes !== 1) {
      database.exec('COMMIT;');
      return undefined;
    }
    const row = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(input.workspaceId);
    if (!row)
      throw new Error(`Task workspace "${input.workspaceId}" was not found.`);
    const workspace = readTaskWorkspaceRow(row);
    releasePhysicalWorkspaceLeaseInTransaction(
      database,
      workspace.physicalResourceKey,
      input.owner,
    );
    if (workspace.owningRunId) {
      upsertRunWorkspaceSnapshot(database, workspace.owningRunId, workspace);
    }
    database.exec('COMMIT;');
    return workspace;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

/**
 * Finalize a managed-resource cleanup only after the provider has confirmed
 * destruction. Unlike operator quarantine clearance, this transition may
 * release the still-live cleanup lease: the exact cleanup owner is the actor
 * that just destroyed the resource, so the workspace row, lease, fence, and
 * quarantine must settle together or not at all.
 */
export async function finalizeSuccessfulTaskWorkspaceCleanup(
  input: {
    workspaceId: string;
    owningRunId: string;
    owner: string;
    deletedAt: string;
    retentionReason?: string | null;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  const now = new Date().toISOString();
  const retentionReason =
    input.retentionReason == null
      ? input.retentionReason
      : sanitizedBoundedContent(input.retentionReason, 16 * 1024).content;
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const currentRow = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(input.workspaceId);
    if (!currentRow) {
      throw new Error(`Task workspace "${input.workspaceId}" was not found.`);
    }
    const current = readTaskWorkspaceRow(currentRow);
    if (
      current.owningRunId !== input.owningRunId ||
      current.lockOwner !== input.owner ||
      current.status !== 'cleanup-pending' ||
      !current.lockExpiresAt ||
      current.lockExpiresAt <= now
    ) {
      database.exec('COMMIT;');
      return undefined;
    }

    const leaseKey = physicalWorkspaceLeaseKey(current.physicalResourceKey);
    const leaseRow = v.parse(
      v.optional(v.strictObject({ value: v.string() })),
      database
        .prepare('SELECT value FROM app_metadata WHERE key = ?;')
        .get(leaseKey),
    );
    if (!leaseRow) {
      database.exec('COMMIT;');
      return undefined;
    }
    const lease = v.parse(
      physicalWorkspaceLeaseSchema,
      JSON.parse(leaseRow.value),
    );
    if (
      lease.owner !== input.owner ||
      lease.providerId !== current.providerId ||
      lease.physicalResourceKey !== current.physicalResourceKey ||
      lease.expiresAt <= now
    ) {
      database.exec('COMMIT;');
      return undefined;
    }

    const finalized = database
      .prepare(
        `UPDATE task_workspaces
         SET status = 'deleted', deleted_at = ?, provider_error = NULL,
             retention_reason = COALESCE(?, retention_reason),
             release_fenced_at = NULL,
             lock_owner = NULL, lock_expires_at = NULL,
             collection_owner = NULL, collection_expires_at = NULL,
             updated_at = ?
         WHERE id = ? AND owning_run_id = ? AND lock_owner = ?
           AND lock_expires_at > ? AND status = 'cleanup-pending';`,
      )
      .run(
        input.deletedAt,
        retentionReason ?? null,
        now,
        input.workspaceId,
        input.owningRunId,
        input.owner,
        now,
      );
    if (finalized.changes !== 1) {
      rollbackQuietly(database);
      return undefined;
    }
    const released = database
      .prepare('DELETE FROM app_metadata WHERE key = ? AND value = ?;')
      .run(leaseKey, leaseRow.value);
    if (released.changes !== 1) {
      rollbackQuietly(database);
      return undefined;
    }
    database
      .prepare('DELETE FROM app_metadata WHERE key = ?;')
      .run(physicalWorkspaceQuarantineKey(current.physicalResourceKey));
    database
      .prepare(
        `UPDATE task_workspaces
         SET release_fenced_at = NULL, updated_at = ?
         WHERE physical_resource_key = ? AND release_fenced_at IS NOT NULL
           AND lock_owner IS NULL;`,
      )
      .run(now, current.physicalResourceKey);

    const row = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(input.workspaceId);
    if (!row) {
      throw new Error(`Task workspace "${input.workspaceId}" was not found.`);
    }
    const workspace = readTaskWorkspaceRow(row);
    upsertRunWorkspaceSnapshot(database, input.owningRunId, workspace);
    database.exec('COMMIT;');
    return workspace;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

export async function failTaskWorkspaceRunOwned(
  input: {
    workspaceId: string;
    runId: string;
    lockOwner: string;
    providerError: string;
    retentionReason: string;
    preservePhysicalLease?: boolean;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const providerError = sanitizedBoundedContent(
    input.providerError,
    16 * 1024,
  ).content;
  const retentionReason = sanitizedBoundedContent(
    input.retentionReason,
    16 * 1024,
  ).content;
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const currentRow = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(input.workspaceId);
    if (!currentRow) {
      throw new Error(`Task workspace "${input.workspaceId}" was not found.`);
    }
    const currentWorkspace = readTaskWorkspaceRow(currentRow);
    if (
      currentWorkspace.owningRunId !== input.runId ||
      currentWorkspace.lockOwner !== input.lockOwner ||
      !['provisioning', 'preparing', 'ready', 'active', 'collecting'].includes(
        currentWorkspace.status,
      )
    ) {
      database.exec('COMMIT;');
      return undefined;
    }
    releaseScheduledWorktreeLockInTransaction(
      database,
      currentWorkspace,
      input.lockOwner,
      now,
    );
    const updated = database
      .prepare(
        `UPDATE task_workspaces
         SET status = 'retained', provider_error = ?, retention_reason = ?,
             retained_at = ?, last_used_at = ?, updated_at = ?,
             lock_owner = NULL, lock_expires_at = NULL,
             collection_owner = NULL, collection_expires_at = NULL
         WHERE id = ? AND owning_run_id = ? AND lock_owner = ?
           AND status IN ('provisioning', 'preparing', 'ready', 'active', 'collecting')
           AND EXISTS (
             SELECT 1 FROM scheduled_task_runs
             WHERE id = ? AND status IN ('claimed', 'active')
           );`,
      )
      .run(
        providerError,
        retentionReason,
        now,
        now,
        now,
        input.workspaceId,
        input.runId,
        input.lockOwner,
        input.runId,
      );
    if (updated.changes !== 1) {
      database.exec('ROLLBACK;');
      return undefined;
    }
    if (!input.preservePhysicalLease && !currentWorkspace.releaseFencedAt) {
      releasePhysicalWorkspaceLeaseInTransaction(
        database,
        currentWorkspace.physicalResourceKey,
        input.lockOwner,
      );
    }
    const row = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(input.workspaceId);
    if (!row)
      throw new Error(`Task workspace "${input.workspaceId}" was not found.`);
    const workspace = readTaskWorkspaceRow(row);
    upsertRunWorkspaceSnapshot(database, input.runId, workspace);
    database.exec('COMMIT;');
    return workspace;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

function releaseScheduledWorktreeLockInTransaction(
  database: ReturnType<typeof openDb>,
  workspace: TaskWorkspaceRecord,
  owner: string,
  now: string,
) {
  if (!workspace.localWorktreeId) return;
  const lockId =
    'scheduledWorktreeLockId' in workspace.resourceMetadata
      ? workspace.resourceMetadata.scheduledWorktreeLockId
      : undefined;
  if (!lockId) {
    throw new Error(
      `Scheduled local workspace "${workspace.id}" is missing its shared worktree lock identity.`,
    );
  }
  const released = database
    .prepare(
      `UPDATE worktree_locks
       SET released_at = ?, updated_at = ?
       WHERE id = ? AND worktree_id = ? AND owner = ? AND released_at IS NULL;`,
    )
    .run(now, now, lockId, workspace.localWorktreeId, owner);
  if (released.changes !== 1) {
    throw new Error(
      `Scheduled local workspace "${workspace.id}" lost ownership of its shared worktree lock.`,
    );
  }
  const ready = database
    .prepare(
      `UPDATE worktrees SET lifecycle_status = 'ready', updated_at = ?
       WHERE id = ? AND lifecycle_status <> 'deleted';`,
    )
    .run(now, workspace.localWorktreeId);
  if (ready.changes !== 1) {
    throw new Error(
      `Scheduled local workspace "${workspace.id}" no longer has an active shared worktree record.`,
    );
  }
}

export async function listRecoverableScheduledWorkspaceCleanups(
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT * FROM task_workspaces
         WHERE status = 'cleanup-pending'
           AND (lock_owner IS NULL OR lock_expires_at <= ?)
         ORDER BY updated_at ASC;`,
      )
      .all(now.toISOString())
      .map(readTaskWorkspaceRow);
  } finally {
    database.close();
  }
}

export async function addScheduledRunArtifact(
  input: Omit<ScheduledRunArtifact, 'id' | 'createdAt' | 'redacted'> & {
    collectionOwner?: string;
    runOwner?: string;
    preparationOwner?: string;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const { collectionOwner, runOwner, preparationOwner, ...artifactInput } =
    input;
  const content =
    input.content === null
      ? null
      : sanitizedBoundedContent(
          input.content,
          maxPersistedScheduledArtifactBytes,
        );
  const summary = sanitizedBoundedContent(input.summary, 512);
  const artifact: ScheduledRunArtifact = {
    ...artifactInput,
    summary: summary.content,
    content: content?.content ?? null,
    truncated: input.truncated || Boolean(content?.truncated),
    redacted: summary.redacted || Boolean(content?.redacted),
    id: `scheduled-artifact:${randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  const database = openDb(paths.neondeckDatabase);
  try {
    const inserted = database
      .prepare(
        `INSERT INTO scheduled_run_artifacts (
           id, run_id, workspace_id, kind, summary, content, truncated, redacted, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (? IS NULL OR EXISTS (
           SELECT 1 FROM task_workspaces
           WHERE id = ? AND owning_run_id = ? AND collection_owner = ?
             AND collection_expires_at > ?
         )) AND (? IS NULL OR EXISTS (
           SELECT 1 FROM task_workspaces
           JOIN scheduled_task_runs ON scheduled_task_runs.id = task_workspaces.owning_run_id
           WHERE task_workspaces.id = ? AND task_workspaces.owning_run_id = ?
             AND task_workspaces.lock_owner = ? AND task_workspaces.status = 'active'
             AND scheduled_task_runs.status = 'active'
         )) AND (? IS NULL OR EXISTS (
           SELECT 1 FROM task_workspaces
           JOIN scheduled_task_runs ON scheduled_task_runs.id = task_workspaces.owning_run_id
           WHERE task_workspaces.id = ? AND task_workspaces.owning_run_id = ?
             AND task_workspaces.lock_owner = ?
             AND task_workspaces.status IN ('provisioning', 'preparing', 'ready', 'active')
             AND scheduled_task_runs.status IN ('claimed', 'active')
         ));`,
      )
      .run(
        artifact.id,
        artifact.runId,
        artifact.workspaceId,
        artifact.kind,
        artifact.summary,
        artifact.content,
        artifact.truncated ? 1 : 0,
        artifact.redacted ? 1 : 0,
        artifact.createdAt,
        collectionOwner ?? null,
        artifact.workspaceId,
        artifact.runId,
        collectionOwner ?? null,
        artifact.createdAt,
        runOwner ?? null,
        artifact.workspaceId,
        artifact.runId,
        runOwner ?? null,
        preparationOwner ?? null,
        artifact.workspaceId,
        artifact.runId,
        preparationOwner ?? null,
      );
    if (inserted.changes !== 1) {
      throw new Error('Scheduled workspace collection lease was lost.');
    }
  } finally {
    database.close();
  }
  return artifact;
}

export async function recordTaskWorkspaceAuditFailureOwned(
  input: {
    workspaceId: string;
    runId: string;
    lockOwner: string;
    message: string;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const sanitized = sanitizedBoundedContent(input.message, 16 * 1024);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    const updated = database
      .prepare(
        `UPDATE task_workspaces
         SET provider_error = ?, updated_at = ?
         WHERE id = ? AND owning_run_id = ? AND lock_owner = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM scheduled_task_runs
             WHERE id = ? AND status = 'active'
           );`,
      )
      .run(
        sanitized.content,
        now,
        input.workspaceId,
        input.runId,
        input.lockOwner,
        input.runId,
      );
    return updated.changes === 1;
  } finally {
    database.close();
  }
}

export async function listScheduledRunArtifacts(
  runId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    return database
      .prepare(
        `SELECT * FROM scheduled_run_artifacts
         WHERE run_id = ? ORDER BY created_at ASC;`,
      )
      .all(runId)
      .map(readArtifactRow);
  } finally {
    database.close();
  }
}

export async function retainTaskWorkspace(
  workspaceId: string,
  runId: string,
  reason: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const retained = database
      .prepare(
        `UPDATE task_workspaces
         SET status = 'retained', retention_reason = ?, retained_at = ?,
             last_used_at = ?, updated_at = ?
         WHERE id = ? AND owning_run_id = ? AND lock_owner IS NULL
           AND status <> 'deleted'
           AND NOT EXISTS (
             SELECT 1 FROM scheduled_task_runs
             WHERE id = ? AND status = 'active'
           );`,
      )
      .run(reason, now, now, now, workspaceId, runId, runId);
    if (retained.changes !== 1) {
      database.exec('COMMIT;');
      return undefined;
    }
    const row = database
      .prepare('SELECT * FROM task_workspaces WHERE id = ?;')
      .get(workspaceId);
    if (!row) throw new Error(`Task workspace "${workspaceId}" was not found.`);
    const workspace = readTaskWorkspaceRow(row);
    upsertRunWorkspaceSnapshot(database, runId, workspace);
    database.exec('COMMIT;');
    return workspace;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.close();
  }
}

function insertWorkspace(
  database: ReturnType<typeof openDb>,
  record: TaskWorkspaceRecord,
) {
  database
    .prepare(
      `INSERT INTO task_workspaces (
         id, task_id, owning_run_id, provider_id, provider_resource_id,
         provider_snapshot_json, physical_resource_key, resource_metadata_json, lifecycle, repo_id, repo_snapshot_json, workspace_root,
         requested_ref, revision_mode, git_mode, branch_name, base_sha,
         initial_sha, final_sha, dirty, local_worktree_id, authority, retention,
         status, lock_owner, lock_expires_at, collection_owner, collection_expires_at, release_fenced_at, retention_reason, provider_error,
         created_at, last_used_at, retained_at, cleanup_attempted_at, deleted_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    )
    .run(
      record.id,
      record.taskId,
      record.owningRunId,
      record.providerId,
      record.providerResourceId,
      JSON.stringify(record.providerSnapshot),
      record.physicalResourceKey,
      JSON.stringify(record.resourceMetadata),
      record.lifecycle,
      record.repoId,
      JSON.stringify(record.repoSnapshot),
      record.workspaceRoot,
      record.requestedRef,
      record.revisionMode,
      record.gitMode,
      record.branchName,
      record.baseSha,
      record.initialSha,
      record.finalSha,
      record.dirty === null ? null : record.dirty ? 1 : 0,
      record.localWorktreeId,
      record.authority,
      record.retention,
      record.status,
      record.lockOwner,
      record.lockExpiresAt,
      record.collectionOwner,
      record.collectionExpiresAt,
      record.releaseFencedAt,
      record.retentionReason,
      record.providerError,
      record.createdAt,
      record.lastUsedAt,
      record.retainedAt,
      record.cleanupAttemptedAt,
      record.deletedAt,
      record.updatedAt,
    );
}

function mergeScheduledRunResult(
  database: ReturnType<typeof openDb>,
  runId: string,
  value: Record<string, unknown>,
) {
  const row = v.parse(
    v.optional(v.strictObject({ result_json: v.nullable(v.string()) })),
    database
      .prepare('SELECT result_json FROM scheduled_task_runs WHERE id = ?;')
      .get(runId),
  );
  const current = row?.result_json
    ? v.parse(
        v.record(
          v.string(),
          v.custom(isJsonValue, 'Expected persisted JSON data.'),
        ),
        JSON.parse(row.result_json),
      )
    : {};
  database
    .prepare(
      'UPDATE scheduled_task_runs SET result_json = ?, updated_at = ? WHERE id = ?;',
    )
    .run(
      JSON.stringify({ ...current, ...value }),
      new Date().toISOString(),
      runId,
    );
}

function upsertRunWorkspaceSnapshot(
  database: ReturnType<typeof openDb>,
  runId: string,
  workspace: TaskWorkspaceRecord,
) {
  const validated = v.parse(taskWorkspaceRecordSchema, workspace);
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO scheduled_run_workspace_snapshots (
         run_id, workspace_id, snapshot_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         snapshot_json = excluded.snapshot_json,
         updated_at = excluded.updated_at;`,
    )
    .run(runId, validated.id, JSON.stringify(validated), now, now);
}

function readTaskWorkspaceRow(value: unknown): TaskWorkspaceRecord {
  const row = v.parse(taskWorkspaceDbRowSchema, value);
  return v.parse(taskWorkspaceRecordSchema, {
    id: row.id,
    taskId: row.task_id,
    owningRunId: row.owning_run_id,
    providerId: row.provider_id,
    providerResourceId: row.provider_resource_id,
    providerSnapshot: v.parse(
      workspaceProviderSnapshotSchema,
      JSON.parse(row.provider_snapshot_json),
    ),
    physicalResourceKey: row.physical_resource_key,
    resourceMetadata: v.parse(
      v.record(v.string(), v.unknown()),
      JSON.parse(row.resource_metadata_json),
    ),
    lifecycle: row.lifecycle,
    repoId: row.repo_id,
    repoSnapshot: v.parse(
      scheduledRepositoryIdentitySchema,
      JSON.parse(row.repo_snapshot_json),
    ),
    workspaceRoot: row.workspace_root,
    requestedRef: row.requested_ref,
    revisionMode: row.revision_mode,
    gitMode: row.git_mode,
    branchName: row.branch_name,
    baseSha: row.base_sha,
    initialSha: row.initial_sha,
    finalSha: row.final_sha,
    dirty: row.dirty === null ? null : row.dirty === 1,
    localWorktreeId: row.local_worktree_id,
    authority: row.authority,
    retention: row.retention,
    status: row.status,
    lockOwner: row.lock_owner,
    lockExpiresAt: row.lock_expires_at,
    collectionOwner: row.collection_owner,
    collectionExpiresAt: row.collection_expires_at,
    releaseFencedAt: row.release_fenced_at,
    retentionReason: row.retention_reason,
    providerError: row.provider_error,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    retainedAt: row.retained_at,
    cleanupAttemptedAt: row.cleanup_attempted_at,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
  });
}

function readArtifactRow(value: unknown): ScheduledRunArtifact {
  const row = v.parse(scheduledRunArtifactDbRowSchema, value);
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    summary: row.summary,
    content: row.content,
    truncated: row.truncated === 1,
    redacted: row.redacted === 1,
    createdAt: row.created_at,
  };
}
