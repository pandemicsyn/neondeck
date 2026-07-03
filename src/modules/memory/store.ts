import type { JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  parseAppConfig,
  readRuntimeJson,
  readRuntimeJsonSync,
  resolveLearningConfig,
  type RuntimePaths,
} from '../../runtime-home';
import type { ActiveMemoryScope, MemoryCandidateRecord, MemoryEventRecord, MemoryMutationSource, MemoryRecord, MemoryScope } from './schemas';
import {
  activeMemoryScopeSchema,
  allMemoryScopeSchema,
  memoryActorSchema,
  memoryCandidateActionSchema,
  memoryIdentifierSchema,
} from './schemas';

export function failedMemoryMutation(
  action: string,
  message: string,
  requires?: string[],
) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    ...(requires ? { requires } : {}),
  };
}

export function resolveMemory(
  database: DatabaseSync,
  input: v.InferOutput<typeof memoryIdentifierSchema>,
) {
  if (input.id) return readMemoryById(database, input.id);
  if (input.scope && input.key) {
    return readMemoryByScopeKey(
      database,
      input.scope,
      input.key,
      input.repoId ?? null,
    );
  }
  return undefined;
}

export function readMemoryById(database: DatabaseSync, id: string) {
  const row = database
    .prepare(
      `
      SELECT *
      FROM memories
      WHERE id = ?;
    `,
    )
    .get(id);
  return row ? readMemoryRow(row) : undefined;
}

export function readMemoryByScopeKey(
  database: DatabaseSync,
  scope: MemoryScope,
  key: string,
  repoId: string | null = null,
) {
  const row = database
    .prepare(
      `
      SELECT *
      FROM memories
      WHERE scope = ?
        AND key = ?
        AND COALESCE(repo_id, '') = COALESCE(?, '');
    `,
    )
    .get(scope, key, repoId);
  return row ? readMemoryRow(row) : undefined;
}

export function recordMemoryEvent(
  database: DatabaseSync,
  input: {
    memoryId?: string | null;
    action: MemoryEventRecord['action'];
    actor: MemoryEventRecord['actor'];
    reason?: string | null;
    before?: JsonValue | null;
    after?: JsonValue | null;
    createdAt: string;
  },
) {
  database
    .prepare(
      `
      INSERT INTO memory_events (
        id,
        memory_id,
        action,
        actor,
        reason,
        before_json,
        after_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      randomUUID(),
      input.memoryId ?? null,
      input.action,
      input.actor,
      input.reason ?? null,
      input.before === undefined || input.before === null
        ? null
        : JSON.stringify(input.before),
      input.after === undefined || input.after === null
        ? null
        : JSON.stringify(input.after),
      input.createdAt,
    );
}

export function recordLearningEvent(
  database: DatabaseSync,
  input: {
    type: string;
    source: string;
    repoId?: string | null;
    sessionId?: string | null;
    data?: JsonValue | null;
    createdAt: string;
  },
) {
  database
    .prepare(
      `
      INSERT INTO learning_events (
        id,
        type,
        source,
        repo_id,
        session_id,
        data_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      randomUUID(),
      input.type,
      input.source,
      input.repoId ?? null,
      input.sessionId ?? null,
      input.data === undefined || input.data === null
        ? null
        : JSON.stringify(input.data),
      input.createdAt,
    );
}

export function insertMemoryCandidate(
  database: DatabaseSync,
  candidate: MemoryCandidateRecord,
) {
  database
    .prepare(
      `
      INSERT INTO learning_candidates (
        id,
        target,
        status,
        action,
        scope,
        key,
        value_json,
        repo_id,
        reason,
        review_id,
        patch_json,
        created_at,
        decided_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      candidate.id,
      candidate.target,
      candidate.status,
      candidate.action,
      candidate.scope,
      candidate.key,
      candidate.value === null ? null : JSON.stringify(candidate.value),
      candidate.repoId,
      candidate.reason,
      candidate.reviewId,
      candidate.patch === null ? null : JSON.stringify(candidate.patch),
      candidate.createdAt,
      candidate.decidedAt,
    );
}

export async function memoryWritePolicyResult(
  paths: RuntimePaths,
  source: MemoryMutationSource,
) {
  if (source === 'user') return { ok: true as const };
  const config = await readRuntimeJson(paths.config, parseAppConfig)
    .then((value) => resolveLearningConfig(value))
    .catch(() => resolveLearningConfig());
  if (!config.enabled) {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_upsert',
        'Learning is disabled; autonomous memory writes are blocked.',
        ['learning-enabled'],
      ),
    };
  }
  if (config.memoryWriteMode === 'off') {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_upsert',
        'Memory write mode is off; autonomous memory writes are blocked.',
        ['memory-write-mode'],
      ),
    };
  }
  if (config.memoryWriteMode === 'review') {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_upsert',
        'Memory write mode is review; create a memory candidate instead of mutating memory directly.',
        ['memory-candidate'],
      ),
    };
  }
  return { ok: true as const };
}

export async function memoryCandidatePolicyResult(
  paths: RuntimePaths,
  source: MemoryMutationSource,
) {
  if (source === 'user') return { ok: true as const };
  const config = await readRuntimeJson(paths.config, parseAppConfig)
    .then((value) => resolveLearningConfig(value))
    .catch(() => resolveLearningConfig());
  if (!config.enabled) {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_candidate_create',
        'Learning is disabled; autonomous memory candidates are blocked.',
        ['learning-enabled'],
      ),
    };
  }
  if (config.memoryWriteMode === 'off') {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_candidate_create',
        'Memory write mode is off; autonomous memory candidates are blocked.',
        ['memory-write-mode'],
      ),
    };
  }
  return { ok: true as const };
}

export function readMemoryRow(row: unknown): MemoryRecord {
  if (!row || typeof row !== 'object') {
    throw new Error('Memory row is missing.');
  }
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    scope: v.parse(allMemoryScopeSchema, record.scope),
    key: String(record.key),
    value: JSON.parse(String(record.value_json)) as JsonValue,
    repoId: typeof record.repo_id === 'string' ? record.repo_id : null,
    status:
      record.status === 'archived' || record.status === 'active'
        ? record.status
        : 'active',
    useCount: Number(record.use_count ?? 0),
    lastUsedAt:
      typeof record.last_used_at === 'string' ? record.last_used_at : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

export function readMemoryEventRow(row: unknown): MemoryEventRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    memoryId: typeof record.memory_id === 'string' ? record.memory_id : null,
    action: v.parse(
      v.picklist([
        'created',
        'updated',
        'rewritten',
        'merged',
        'archived',
        'rejected',
      ]),
      record.action,
    ),
    actor: v.parse(memoryActorSchema, record.actor),
    reason: typeof record.reason === 'string' ? record.reason : null,
    before:
      typeof record.before_json === 'string'
        ? (JSON.parse(record.before_json) as JsonValue)
        : null,
    after:
      typeof record.after_json === 'string'
        ? (JSON.parse(record.after_json) as JsonValue)
        : null,
    createdAt: String(record.created_at),
  };
}

export function readMemoryCandidateRow(row: unknown): MemoryCandidateRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    target: 'memory',
    status: v.parse(
      v.picklist(['proposed', 'applied', 'rejected', 'archived']),
      record.status,
    ),
    action: v.parse(memoryCandidateActionSchema, record.action),
    scope:
      typeof record.scope === 'string'
        ? v.parse(activeMemoryScopeSchema, record.scope)
        : null,
    key: typeof record.key === 'string' ? record.key : null,
    value:
      typeof record.value_json === 'string'
        ? (JSON.parse(record.value_json) as JsonValue)
        : null,
    repoId: typeof record.repo_id === 'string' ? record.repo_id : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
    reviewId: typeof record.review_id === 'string' ? record.review_id : null,
    patch:
      typeof record.patch_json === 'string'
        ? (JSON.parse(record.patch_json) as JsonValue)
        : null,
    createdAt: String(record.created_at),
    decidedAt: typeof record.decided_at === 'string' ? record.decided_at : null,
  };
}

export function memoryToJson(memory: MemoryRecord): JsonValue {
  return {
    id: memory.id,
    scope: memory.scope,
    key: memory.key,
    value: memory.value,
    repoId: memory.repoId,
    status: memory.status,
    useCount: memory.useCount,
    lastUsedAt: memory.lastUsedAt,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export function boundedRejectedAfter(input: {
  scope: ActiveMemoryScope;
  key: string;
  repoId?: string;
}): JsonValue {
  return {
    scope: input.scope,
    key: input.key,
    repoId: input.repoId ?? null,
    rejected: true,
  };
}

export function boundedRejectedCandidateAfter(input: {
  action: v.InferOutput<typeof memoryCandidateActionSchema>;
  scope?: ActiveMemoryScope;
  key?: string;
  repoId?: string;
  reviewId?: string;
}): JsonValue {
  return {
    candidateAction: input.action,
    scope: input.scope ?? null,
    key: input.key ?? null,
    repoId: input.repoId ?? null,
    reviewId: input.reviewId ?? null,
    rejected: true,
  };
}

export function isActiveLearningMemory(
  memory: MemoryRecord,
): memory is MemoryRecord & {
  scope: ActiveMemoryScope;
} {
  return (
    memory.status === 'active' &&
    (memory.scope === 'user' ||
      memory.scope === 'local' ||
      memory.scope === 'project')
  );
}

export function memoryValuePreview(value: JsonValue) {
  const text = memoryValueText(value);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function memoryValueText(value: JsonValue) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function memoryLine(memory: MemoryRecord) {
  const repo = memory.repoId ? ` (${memory.repoId})` : '';
  return `- ${memory.key}${repo}: ${memoryValuePreview(memory.value)}`;
}

export function memoryRejectionReason(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/(api[_-]?key|token|secret|password)\s*[:=]/i.test(text)) {
    return 'Rejected memory because it appears to contain a secret or credential.';
  }
  if (
    /(ignore|override|bypass).{0,40}(previous|system|developer|instructions)/i.test(
      text,
    )
  ) {
    return 'Rejected memory because it resembles prompt-injection guidance.';
  }
  if (text.length > 8000) {
    return 'Rejected memory because it exceeds the bounded memory size limit.';
  }
  return null;
}

export function patchString(value: JsonValue | null, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' ? item : undefined;
}

export function patchStringArray(value: JsonValue | null, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const item = (value as Record<string, unknown>)[key];
  return Array.isArray(item)
    ? item.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function readLearningConfigSync(paths: RuntimePaths) {
  try {
    return resolveLearningConfig(
      readRuntimeJsonSync(paths.config, parseAppConfig),
    );
  } catch {
    return resolveLearningConfig();
  }
}
