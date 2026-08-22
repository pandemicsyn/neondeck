import type { JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  parseAppConfig,
  readRuntimeJson,
  readRuntimeJsonSync,
  resolveLearningConfig,
  type RuntimePaths,
} from '../../runtime-home';
import type {
  ActiveMemoryScope,
  MemoryCandidateRecord,
  MemoryEventRecord,
  MemoryMutationSource,
  MemoryRecord,
  MemoryScope,
  MemoryExternalValue,
} from './schemas';
import {
  activeMemoryScopeSchema,
  allMemoryScopeSchema,
  memoryActorSchema,
  memoryCandidateActionSchema,
  memoryIdentifierSchema,
  jsonValueSchema,
  memoryStatusSchema,
} from './schemas';

export type FailedMemoryMutation = {
  ok: false;
  action: string;
  changed: false;
  message: string;
  errors: string[];
  requires?: string[];
};

const nullableStringSchema = v.nullable(v.string());
const memoryRowSchema = v.object({
  id: v.string(),
  scope: allMemoryScopeSchema,
  key: v.string(),
  value_json: v.string(),
  repo_id: nullableStringSchema,
  status: v.unknown(),
  use_count: v.number(),
  last_used_at: nullableStringSchema,
  created_at: v.string(),
  updated_at: v.string(),
});
const memoryEventActionSchema = v.picklist([
  'created',
  'updated',
  'rewritten',
  'merged',
  'archived',
  'rejected',
]);
const memoryEventRowSchema = v.object({
  id: v.string(),
  memory_id: nullableStringSchema,
  action: memoryEventActionSchema,
  actor: memoryActorSchema,
  reason: nullableStringSchema,
  before_json: nullableStringSchema,
  after_json: nullableStringSchema,
  created_at: v.string(),
});
const memoryCandidateStatusSchema = v.picklist([
  'proposed',
  'applied',
  'rejected',
  'archived',
]);
const memoryCandidateRowSchema = v.object({
  id: v.string(),
  status: memoryCandidateStatusSchema,
  action: memoryCandidateActionSchema,
  scope: v.nullable(v.string()),
  key: nullableStringSchema,
  value_json: nullableStringSchema,
  repo_id: nullableStringSchema,
  reason: nullableStringSchema,
  review_id: nullableStringSchema,
  patch_json: nullableStringSchema,
  created_at: v.string(),
  decided_at: nullableStringSchema,
});
const jsonRecordSchema = v.record(v.string(), jsonValueSchema);
const stringArraySchema = v.array(v.string());
const stringRecordSchema = v.record(v.string(), v.string());

export function failedMemoryMutation(
  action: string,
  message: string,
  requires?: string[],
) {
  const result: FailedMemoryMutation = {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
  };
  if (requires) result.requires = requires;
  return result;
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
        'memory_learn',
        'Learning is disabled; autonomous memory writes are blocked.',
        ['learning-enabled'],
      ),
    };
  }
  if (config.memoryWriteMode === 'off') {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_learn',
        'Memory write mode is off; autonomous memory writes are blocked.',
        ['memory-write-mode'],
      ),
    };
  }
  if (config.memoryWriteMode === 'review') {
    return {
      ok: false as const,
      result: failedMemoryMutation(
        'memory_learn',
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

export function readMemoryRow(row: MemoryExternalValue): MemoryRecord {
  const record = v.parse(memoryRowSchema, row);
  const status = v.safeParse(memoryStatusSchema, record.status);
  return {
    id: record.id,
    scope: record.scope,
    key: record.key,
    value: v.parse(jsonValueSchema, JSON.parse(record.value_json)),
    repoId: record.repo_id,
    status: status.success ? status.output : 'active',
    useCount: record.use_count,
    lastUsedAt: record.last_used_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function safeReadMemoryRow(row: MemoryExternalValue) {
  try {
    return [readMemoryRow(row)];
  } catch {
    return [];
  }
}

export function readMemoryEventRow(
  row: MemoryExternalValue,
): MemoryEventRecord {
  const record = v.parse(memoryEventRowSchema, row);
  return {
    id: record.id,
    memoryId: record.memory_id,
    action: record.action,
    actor: record.actor,
    reason: record.reason,
    before: parseNullableJson(record.before_json),
    after: parseNullableJson(record.after_json),
    createdAt: record.created_at,
  };
}

export function safeReadMemoryEventRow(row: MemoryExternalValue) {
  try {
    return [readMemoryEventRow(row)];
  } catch {
    return [];
  }
}

export function readMemoryCandidateRow(
  row: MemoryExternalValue,
): MemoryCandidateRecord {
  const record = v.parse(memoryCandidateRowSchema, row);
  return {
    id: record.id,
    target: 'memory',
    status: record.status,
    action: record.action,
    scope:
      record.scope !== null
        ? v.parse(activeMemoryScopeSchema, record.scope)
        : null,
    key: record.key,
    value: parseNullableJson(record.value_json),
    repoId: record.repo_id,
    reason: record.reason,
    reviewId: record.review_id,
    patch: parseNullableJson(record.patch_json),
    createdAt: record.created_at,
    decidedAt: record.decided_at,
  };
}

function parseNullableJson(value: string | null): JsonValue | null {
  return value === null ? null : v.parse(jsonValueSchema, JSON.parse(value));
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
  const text = v.safeParse(v.string(), value);
  return text.success ? text.output : JSON.stringify(value);
}

export function memoryLine(memory: MemoryRecord) {
  const repo = memory.repoId ? ` (${memory.repoId})` : '';
  return `- ${memory.key}${repo}: ${memoryValuePreview(memory.value)}`;
}

export function memoryRejectionReason(value: MemoryExternalValue) {
  const parsedText = v.safeParse(v.string(), value);
  const text = parsedText.success
    ? parsedText.output
    : (JSON.stringify(value) ?? String(value));
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
  const record = v.safeParse(jsonRecordSchema, value);
  if (!record.success || Array.isArray(value)) return undefined;
  const item = v.safeParse(v.string(), record.output[key]);
  return item.success ? item.output : undefined;
}

export function patchStringArray(value: JsonValue | null, key: string) {
  const record = v.safeParse(jsonRecordSchema, value);
  if (!record.success || Array.isArray(value)) return [];
  const item = v.safeParse(stringArraySchema, record.output[key]);
  return item.success ? item.output : [];
}

export function patchNullableString(value: JsonValue | null, key: string) {
  const record = v.safeParse(jsonRecordSchema, value);
  if (!record.success || Array.isArray(value)) return undefined;
  const item = v.safeParse(v.nullable(v.string()), record.output[key]);
  return item.success ? item.output : undefined;
}

export function patchStringRecord(value: JsonValue | null, key: string) {
  const record = v.safeParse(jsonRecordSchema, value);
  if (!record.success || Array.isArray(value)) return undefined;
  const item = v.safeParse(stringRecordSchema, record.output[key]);
  return item.success ? item.output : undefined;
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
