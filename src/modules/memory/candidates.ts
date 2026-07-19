import { openDb } from '../../lib/sqlite.ts';
import type { JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../lib/action-result';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  resolveLearningConfig,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import type {
  MemoryCandidateRecord,
  MemoryMutationSource,
  MemoryRecord,
} from './schemas';
import {
  memoryCandidateCreateInputSchema,
  memoryCandidateDecideInputSchema,
  memoryCandidateListInputSchema,
  memoryCurateInputSchema,
} from './schemas';
import {
  archiveMemory,
  listMemories,
  mergeMemories,
  rewriteMemory,
  upsertMemory,
} from './service';
import {
  boundedRejectedCandidateAfter,
  failedMemoryMutation,
  insertMemoryCandidate,
  isActiveLearningMemory,
  memoryCandidatePolicyResult,
  memoryRejectionReason,
  memoryValuePreview,
  patchString,
  patchStringArray,
  readMemoryCandidateRow,
  recordLearningEvent,
  recordMemoryEvent,
} from './store';

export async function createMemoryCandidate(
  input: v.InferInput<typeof memoryCandidateCreateInputSchema>,
  paths = runtimePaths(),
  options: { source?: MemoryMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryCandidateCreateInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation(
      'memory_candidate_create',
      v.summarize(parsed.issues),
    );
  }
  const policy = await memoryCandidatePolicyResult(
    paths,
    options.source ?? 'user',
  );
  if (!policy.ok) {
    return { ...policy.result, action: 'memory_candidate_create' };
  }

  const now = new Date().toISOString();
  if (parsed.output.value !== undefined) {
    const rejection = memoryRejectionReason(parsed.output.value);
    if (rejection) {
      const database = openDb(paths.neondeckDatabase);
      try {
        recordMemoryEvent(database, {
          action: 'rejected',
          actor: options.source ?? 'user',
          reason: rejection,
          before: null,
          after: boundedRejectedCandidateAfter(parsed.output),
          createdAt: now,
        });
      } finally {
        database.close();
      }
      return failedMemoryMutation('memory_candidate_create', rejection, [
        'value',
      ]);
    }
  }

  const candidate: MemoryCandidateRecord = {
    id: randomUUID(),
    target: 'memory',
    status: 'proposed',
    action: parsed.output.action,
    scope: parsed.output.scope ?? null,
    key: parsed.output.key ?? null,
    value:
      parsed.output.value === undefined
        ? null
        : asJsonValue(parsed.output.value),
    repoId: parsed.output.repoId ?? null,
    reason: parsed.output.reason ?? null,
    reviewId: parsed.output.reviewId ?? null,
    patch:
      parsed.output.patch === undefined
        ? null
        : asJsonValue(parsed.output.patch),
    createdAt: now,
    decidedAt: null,
  };

  const database = openDb(paths.neondeckDatabase);
  try {
    insertMemoryCandidate(database, candidate);
    recordLearningEvent(database, {
      type: 'memory_candidate_created',
      source: 'workflow',
      repoId: candidate.repoId,
      data: { candidateId: candidate.id, action: candidate.action },
      createdAt: now,
    });
    return {
      ok: true,
      action: 'memory_candidate_create',
      changed: true,
      candidate,
      message: `Created memory ${candidate.action} candidate.`,
    };
  } finally {
    database.close();
  }
}

export async function listMemoryCandidates(
  input: v.InferInput<typeof memoryCandidateListInputSchema> = {},
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryCandidateListInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'memory_candidate_list',
      changed: false,
      candidates: [],
      message: v.summarize(parsed.issues),
      errors: [v.summarize(parsed.issues)],
    };
  }

  const database = openDb(paths.neondeckDatabase);
  try {
    const candidates = database
      .prepare(
        `
        SELECT *
        FROM learning_candidates
        WHERE target = 'memory'
          ${parsed.output.status ? 'AND status = ?' : ''}
        ORDER BY created_at DESC
        LIMIT ?;
      `,
      )
      .all(
        ...(parsed.output.status ? [parsed.output.status] : []),
        parsed.output.limit ?? 100,
      )
      .map(readMemoryCandidateRow);
    return {
      ok: true,
      action: 'memory_candidate_list',
      changed: false,
      candidates,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

export async function decideMemoryCandidate(
  input: v.InferInput<typeof memoryCandidateDecideInputSchema>,
  paths = runtimePaths(),
  options: { source?: MemoryMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryCandidateDecideInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation(
      'memory_candidate_decide',
      v.summarize(parsed.issues),
    );
  }
  if ((options.source ?? 'user') !== 'user') {
    return failedMemoryMutation(
      'memory_candidate_decide',
      'Memory candidates require an explicit user/API decision before they can be applied, rejected, or archived.',
      ['explicit-user-decision'],
    );
  }

  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    const candidateRow = database
      .prepare(
        `
        SELECT *
        FROM learning_candidates
        WHERE id = ?
          AND target = 'memory';
      `,
      )
      .get(parsed.output.id);
    if (!candidateRow) {
      return failedMemoryMutation(
        'memory_candidate_decide',
        'Memory candidate was not found.',
        ['id'],
      );
    }
    const candidate = readMemoryCandidateRow(candidateRow);
    if (candidate.status !== 'proposed') {
      return failedMemoryMutation(
        'memory_candidate_decide',
        'Memory candidate was already decided.',
        ['id'],
      );
    }

    if (parsed.output.decision !== 'apply') {
      const status =
        parsed.output.decision === 'reject' ? 'rejected' : 'archived';
      database
        .prepare(
          `
          UPDATE learning_candidates
          SET status = ?, decided_at = ?
          WHERE id = ?;
        `,
        )
        .run(status, now, candidate.id);
      recordMemoryEvent(database, {
        action: parsed.output.decision === 'reject' ? 'rejected' : 'archived',
        actor: parsed.output.actor ?? 'user',
        reason: parsed.output.reason ?? candidate.reason,
        before: null,
        after: { candidateId: candidate.id },
        createdAt: now,
      });
      return {
        ok: true,
        action: 'memory_candidate_decide',
        changed: true,
        decision: parsed.output.decision,
        message: `Memory candidate ${status}.`,
      };
    }

    const applyResult = await applyMemoryCandidate(candidate, paths, 'user');
    if (!applyResult.ok) return applyResult;

    database
      .prepare(
        `
        UPDATE learning_candidates
        SET status = 'applied', decided_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, candidate.id);
    return {
      ok: true,
      action: 'memory_candidate_decide',
      changed: true,
      decision: 'apply',
      applied: applyResult,
      message: 'Applied memory candidate.',
    };
  } finally {
    database.close();
  }
}

export async function curateMemoryStore(
  input: v.InferInput<typeof memoryCurateInputSchema> = {},
  paths = runtimePaths(),
  options: { source?: MemoryMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(memoryCurateInputSchema, input);
  if (!parsed.success) {
    return failedMemoryMutation('memory_curate', v.summarize(parsed.issues));
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig)
    .then((value) => resolveLearningConfig(value))
    .catch(() => resolveLearningConfig());
  const mode = parsed.output.mode ?? config.memoryCurationMode;
  const source = options.source ?? 'user';
  if (!config.enabled && source !== 'user') {
    return {
      ok: false,
      action: 'memory_curate',
      changed: false,
      mode,
      message: 'Learning is disabled; autonomous memory curation is blocked.',
      errors: ['Learning is disabled.'],
    };
  }
  if ((source !== 'user' && !config.memoryCurationEnabled) || mode === 'off') {
    return {
      ok: true,
      action: 'memory_curate',
      changed: false,
      mode,
      message: 'Memory curation is disabled.',
      proposals: [],
      applied: [],
    };
  }

  const active = (
    await listMemories(
      {
        status: 'active',
        includeArchived: false,
      },
      paths,
    )
  ).memories.filter(isActiveLearningMemory);
  const proposals = curationProposals(active, config.memoryMaxActiveItems);
  if (mode === 'review') {
    const candidates = [];
    for (const proposal of proposals) {
      const result = await createMemoryCandidate(
        {
          ...proposal,
          reason: proposal.reason ?? parsed.output.reason,
        },
        paths,
        { source: source === 'user' ? 'user' : 'workflow' },
      );
      if (result.ok && 'candidate' in result) candidates.push(result.candidate);
    }
    return {
      ok: true,
      action: 'memory_curate',
      changed: candidates.length > 0,
      mode,
      proposals,
      candidates,
      message:
        candidates.length > 0
          ? `Created ${candidates.length} memory curation candidate${candidates.length === 1 ? '' : 's'}.`
          : 'No memory curation candidates were needed.',
    };
  }

  const applied = [];
  for (const proposal of proposals) {
    if (proposal.action !== 'archive') continue;
    const memoryId = patchString(proposal.patch as JsonValue, 'memoryId');
    if (!memoryId) continue;
    const result = await archiveMemory(
      {
        id: memoryId,
        actor: 'workflow',
        reason: proposal.reason ?? parsed.output.reason,
      },
      paths,
      { source: source === 'user' ? 'user' : 'workflow' },
    );
    if (result.changed) applied.push(result);
  }

  return {
    ok: true,
    action: 'memory_curate',
    changed: applied.length > 0,
    mode,
    proposals,
    applied,
    message:
      applied.length > 0
        ? `Applied ${applied.length} safe memory curation action${applied.length === 1 ? '' : 's'}.`
        : 'No safe automatic memory curation actions were needed.',
  };
}

async function applyMemoryCandidate(
  candidate: MemoryCandidateRecord,
  paths: RuntimePaths,
  source: MemoryMutationSource,
) {
  if (candidate.action === 'upsert') {
    if (!candidate.scope || !candidate.key || candidate.value === null) {
      return failedMemoryMutation(
        'memory_candidate_apply',
        'Memory upsert candidate is missing scope, key, or value.',
      );
    }
    return upsertMemory(
      {
        scope: candidate.scope,
        key: candidate.key,
        value: candidate.value,
        repoId: candidate.repoId ?? undefined,
        reason: candidate.reason ?? undefined,
        actor: 'workflow',
      },
      paths,
      { source },
    );
  }

  if (candidate.action === 'rewrite') {
    const memoryId = patchString(candidate.patch, 'memoryId');
    if (!memoryId || candidate.value === null) {
      return failedMemoryMutation(
        'memory_candidate_apply',
        'Memory rewrite candidate is missing memory id or value.',
      );
    }
    return rewriteMemory(
      {
        id: memoryId,
        value: candidate.value,
        reason: candidate.reason ?? undefined,
        actor: 'workflow',
      },
      paths,
      { source },
    );
  }

  if (candidate.action === 'archive') {
    const memoryId = patchString(candidate.patch, 'memoryId');
    if (!memoryId) {
      return failedMemoryMutation(
        'memory_candidate_apply',
        'Memory archive candidate is missing memory id.',
      );
    }
    return archiveMemory(
      {
        id: memoryId,
        reason: candidate.reason ?? undefined,
        actor: 'workflow',
      },
      paths,
      { source },
    );
  }

  const targetId = patchString(candidate.patch, 'targetId');
  const sourceIds = patchStringArray(candidate.patch, 'sourceIds');
  if (!targetId || sourceIds.length === 0) {
    return failedMemoryMutation(
      'memory_candidate_apply',
      'Memory merge candidate is missing target or source ids.',
    );
  }
  return mergeMemories(
    {
      targetId,
      sourceIds,
      ...(candidate.value === null ? {} : { value: candidate.value }),
      reason: candidate.reason ?? undefined,
      actor: 'workflow',
    },
    paths,
    { source },
  );
}

function curationProposals(
  memories: MemoryRecord[],
  maxActiveItems: number,
): Array<v.InferInput<typeof memoryCandidateCreateInputSchema>> {
  const proposals: Array<
    v.InferInput<typeof memoryCandidateCreateInputSchema>
  > = [];
  const sortedOldest = [...memories].sort(
    (a, b) =>
      a.useCount - b.useCount ||
      Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
  );
  const overflowCount = Math.max(0, sortedOldest.length - maxActiveItems);
  for (const memory of sortedOldest.slice(0, overflowCount)) {
    proposals.push({
      action: 'archive',
      scope: isActiveLearningMemory(memory) ? memory.scope : undefined,
      key: memory.key,
      reason: `Active memory count exceeds configured memoryMaxActiveItems (${maxActiveItems}).`,
      patch: { memoryId: memory.id },
    });
  }

  const byValue = new Map<string, MemoryRecord[]>();
  for (const memory of memories) {
    const key = `${memory.scope}:${memory.repoId ?? ''}:${memoryValuePreview(memory.value).toLowerCase()}`;
    byValue.set(key, [...(byValue.get(key) ?? []), memory]);
  }
  for (const group of byValue.values()) {
    if (group.length < 2) continue;
    const [target, ...sources] = group;
    if (!target) continue;
    proposals.push({
      action: 'merge',
      scope: isActiveLearningMemory(target) ? target.scope : undefined,
      key: target.key,
      value: target.value,
      repoId: target.repoId ?? undefined,
      reason: 'Multiple active memories contain duplicate guidance.',
      patch: {
        targetId: target.id,
        sourceIds: sources.map((source) => source.id),
      },
    });
  }

  return proposals;
}
