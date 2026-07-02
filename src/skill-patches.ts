import { defineAction, type JsonValue } from '@flue/runtime';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  resolveLearningConfig,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';
import { listRuntimeSkills, type RuntimeSkillMetadata } from './runtime-skills';

type SkillPatchMutationSource = 'user' | 'neon' | 'workflow';

export type SkillPatchCandidateRecord = {
  id: string;
  target: 'skill';
  status: 'proposed' | 'applied' | 'rejected' | 'archived';
  action: 'patch';
  skillId: string;
  patch: JsonValue;
  reason: string | null;
  reviewId: string | null;
  createdAt: string;
  decidedAt: string | null;
};

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const skillPatchOperationSchema = v.variant('type', [
  v.object({
    type: v.literal('append-section'),
    heading: nonEmptyStringSchema,
    content: nonEmptyStringSchema,
  }),
  v.object({
    type: v.literal('replace-file'),
    afterContent: nonEmptyStringSchema,
  }),
]);
const skillPatchProposeInputSchema = v.object({
  skillId: nonEmptyStringSchema,
  summary: v.optional(v.string()),
  reason: v.optional(v.string()),
  reviewId: v.optional(nonEmptyStringSchema),
  operation: skillPatchOperationSchema,
});
const skillPatchListInputSchema = v.object({
  status: v.optional(
    v.picklist(['proposed', 'applied', 'rejected', 'archived']),
  ),
  skillId: v.optional(nonEmptyStringSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const skillPatchDecideInputSchema = v.object({
  id: nonEmptyStringSchema,
  reason: v.optional(v.string()),
  actor: v.optional(v.picklist(['user', 'neon', 'workflow'])),
});
const skillPatchRestoreInputSchema = v.object({
  id: nonEmptyStringSchema,
  confirm: v.literal(true),
  reason: v.optional(v.string()),
});
const skillPatchActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const skillPatchProposeAction = defineAction({
  name: 'neondeck_learning_skill_patch_propose',
  description:
    'Create an audited Neondeck-owned runtime skill patch candidate without applying it.',
  input: skillPatchProposeInputSchema,
  output: skillPatchActionOutputSchema,
  async run({ input }) {
    return proposeSkillPatch(input, runtimePaths(), { source: 'neon' });
  },
});

export const skillPatchApplyAction = defineAction({
  name: 'neondeck_learning_skill_patch_apply',
  description:
    'Apply one proposed Neondeck-owned runtime skill patch after explicit decision or auto learning policy.',
  input: skillPatchDecideInputSchema,
  output: skillPatchActionOutputSchema,
  async run({ input }) {
    return applySkillPatchCandidate(input, runtimePaths(), { source: 'neon' });
  },
});

export const skillPatchRejectAction = defineAction({
  name: 'neondeck_learning_skill_patch_reject',
  description:
    'Reject one proposed Neondeck-owned runtime skill patch candidate with audit history.',
  input: skillPatchDecideInputSchema,
  output: skillPatchActionOutputSchema,
  async run({ input }) {
    return rejectSkillPatchCandidate(input, runtimePaths(), { source: 'neon' });
  },
});

export const skillPatchListAction = defineAction({
  name: 'neondeck_learning_skill_patch_list',
  description: 'List Neondeck skill patch candidates and decisions.',
  input: skillPatchListInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    changed: v.boolean(),
    candidates: v.array(v.unknown()),
  }),
  async run({ input }) {
    return listSkillPatchCandidates(input);
  },
});

export const skillPatchRestoreAction = defineAction({
  name: 'neondeck_learning_skill_patch_restore',
  description:
    'Restore an applied skill patch from its audited before-content when the current file still matches the applied patch.',
  input: skillPatchRestoreInputSchema,
  output: skillPatchActionOutputSchema,
  async run({ input }) {
    return restoreSkillPatchCandidate(input, runtimePaths(), {
      source: 'neon',
    });
  },
});

export const neondeckSkillPatchActions = [
  skillPatchProposeAction,
  skillPatchApplyAction,
  skillPatchRejectAction,
  skillPatchListAction,
  skillPatchRestoreAction,
];

export async function proposeSkillPatch(
  input: v.InferInput<typeof skillPatchProposeInputSchema>,
  paths = runtimePaths(),
  options: { source?: SkillPatchMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(skillPatchProposeInputSchema, input);
  if (!parsed.success) {
    return failedSkillPatch('skill_patch_propose', v.summarize(parsed.issues));
  }
  const policy = await skillPatchPolicyResult(paths, options.source ?? 'user');
  if (!policy.ok) return { ...policy.result, action: 'skill_patch_propose' };

  const target = await resolvePatchableSkill(parsed.output.skillId, paths);
  if (!target.ok) return target.result;

  const beforeContent = await readFile(target.skill.path, 'utf8');
  const afterContent = applyPatchOperation(
    beforeContent,
    parsed.output.operation,
  );
  const validation = validateSkillPatch(beforeContent, afterContent);
  if (!validation.ok) {
    return failedSkillPatch('skill_patch_propose', validation.message, [
      'valid-skill-patch',
    ]);
  }
  if (beforeContent === afterContent) {
    return {
      ok: true,
      action: 'skill_patch_propose',
      changed: false,
      message: 'Skill content already matched the requested patch.',
    };
  }

  const now = new Date().toISOString();
  const patch = asJsonValue({
    skillId: target.skill.id,
    skillSource: target.skill.source,
    path: target.skill.path,
    directory: target.skill.directory,
    operation: parsed.output.operation,
    summary: parsed.output.summary ?? null,
    beforeHash: sha256(beforeContent),
    afterHash: sha256(afterContent),
    beforeContent,
    afterContent,
    diff: unifiedWholeFileDiff(target.skill.path, beforeContent, afterContent),
    proposedAt: now,
    appliesAfter: 'new-session',
  });
  const candidate: SkillPatchCandidateRecord = {
    id: randomUUID(),
    target: 'skill',
    status: 'proposed',
    action: 'patch',
    skillId: target.skill.id,
    patch,
    reason: parsed.output.reason ?? parsed.output.summary ?? null,
    reviewId: parsed.output.reviewId ?? null,
    createdAt: now,
    decidedAt: null,
  };

  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    insertSkillPatchCandidate(database, candidate);
    recordLearningEvent(database, {
      type: 'skill_patch_proposed',
      source: options.source ?? 'user',
      data: { candidateId: candidate.id, skillId: candidate.skillId },
      createdAt: now,
    });
  } finally {
    database.close();
  }

  return {
    ok: true,
    action: 'skill_patch_propose',
    changed: true,
    candidate,
    message: `Created skill patch candidate for ${candidate.skillId}.`,
  };
}

export async function listSkillPatchCandidates(
  input: v.InferInput<typeof skillPatchListInputSchema> = {},
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(skillPatchListInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'skill_patch_list',
      changed: false,
      candidates: [],
      message: v.summarize(parsed.issues),
      errors: [v.summarize(parsed.issues)],
    };
  }
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const filters = ["target = 'skill'"];
    const params: Array<string | number> = [];
    if (parsed.output.status) {
      filters.push('status = ?');
      params.push(parsed.output.status);
    }
    if (parsed.output.skillId) {
      filters.push('skill_id = ?');
      params.push(parsed.output.skillId);
    }
    return {
      ok: true,
      action: 'skill_patch_list',
      changed: false,
      candidates: database
        .prepare(
          `
          SELECT *
          FROM learning_candidates
          WHERE ${filters.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ?;
        `,
        )
        .all(...params, parsed.output.limit ?? 100)
        .map(readSkillPatchCandidateRow),
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

export async function applySkillPatchCandidate(
  input: v.InferInput<typeof skillPatchDecideInputSchema>,
  paths = runtimePaths(),
  options: { source?: SkillPatchMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(skillPatchDecideInputSchema, input);
  if (!parsed.success) {
    return failedSkillPatch('skill_patch_apply', v.summarize(parsed.issues));
  }

  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    const candidate = readSkillPatchCandidateById(database, parsed.output.id);
    if (!candidate) {
      return failedSkillPatch(
        'skill_patch_apply',
        'Skill patch was not found.',
        ['id'],
      );
    }
    if (candidate.status !== 'proposed') {
      return failedSkillPatch(
        'skill_patch_apply',
        'Skill patch candidate was already decided.',
        ['id'],
      );
    }

    const patch = parsePatchPayload(candidate.patch);
    if ((options.source ?? 'user') !== 'user') {
      const policy = await skillPatchApplyPolicyResult(
        paths,
        options.source ?? 'user',
        patch,
      );
      if (!policy.ok) return { ...policy.result, action: 'skill_patch_apply' };
    }
    const target = await resolvePatchableSkill(candidate.skillId, paths);
    if (!target.ok) return target.result;
    if (resolve(target.skill.path) !== resolve(patch.path)) {
      return failedSkillPatch(
        'skill_patch_apply',
        'Skill path no longer matches the proposed patch target.',
        ['skill-path'],
      );
    }

    const currentContent = await readFile(target.skill.path, 'utf8');
    if (sha256(currentContent) !== patch.beforeHash) {
      return failedSkillPatch(
        'skill_patch_apply',
        'Skill content changed after this patch was proposed. Reject this candidate and create a fresh patch.',
        ['stale-skill-content'],
      );
    }
    const validation = validateSkillPatch(currentContent, patch.afterContent);
    if (!validation.ok) {
      return failedSkillPatch('skill_patch_apply', validation.message, [
        'valid-skill-patch',
      ]);
    }

    await writeFile(target.skill.path, patch.afterContent, 'utf8');
    try {
      database.exec('BEGIN;');
      database
        .prepare(
          `
          UPDATE learning_candidates
          SET status = 'applied', decided_at = ?
          WHERE id = ?;
        `,
        )
        .run(now, candidate.id);
      recordLearningEvent(database, {
        type: 'skill_patch_applied',
        source: options.source ?? 'user',
        data: {
          candidateId: candidate.id,
          skillId: candidate.skillId,
          beforeHash: patch.beforeHash,
          afterHash: patch.afterHash,
          reason: parsed.output.reason ?? candidate.reason,
        },
        createdAt: now,
      });
      recordConfigHistory(database, {
        action: 'skill_patch_applied',
        target: `skill:${candidate.skillId}`,
        before: {
          path: patch.path,
          sha256: patch.beforeHash,
          content: patch.beforeContent,
        },
        after: {
          path: patch.path,
          sha256: patch.afterHash,
          content: patch.afterContent,
        },
        changedAt: now,
      });
      database.exec('COMMIT;');
    } catch (error) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // Ignore rollback failures; the file compensation below is the critical step.
      }
      await writeFile(target.skill.path, patch.beforeContent, 'utf8').catch(
        () => {},
      );
      return failedSkillPatch(
        'skill_patch_apply',
        `Skill patch audit failed; restored the previous skill content. ${errorMessage(error)}`,
        ['skill-patch-audit'],
      );
    }

    return {
      ok: true,
      action: 'skill_patch_apply',
      changed: true,
      candidateId: candidate.id,
      skillId: candidate.skillId,
      appliesAfter: 'new-session',
      message:
        'Applied skill patch. Start a new Neon session for changed guidance to enter prompt context.',
    };
  } finally {
    database.close();
  }
}

export async function rejectSkillPatchCandidate(
  input: v.InferInput<typeof skillPatchDecideInputSchema>,
  paths = runtimePaths(),
  options: { source?: SkillPatchMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(skillPatchDecideInputSchema, input);
  if (!parsed.success) {
    return failedSkillPatch('skill_patch_reject', v.summarize(parsed.issues));
  }
  if ((options.source ?? 'user') !== 'user') {
    return failedSkillPatch(
      'skill_patch_reject',
      'Skill patch candidates require an explicit user/API decision before rejection.',
      ['explicit-user-decision'],
    );
  }

  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    const candidate = readSkillPatchCandidateById(database, parsed.output.id);
    if (!candidate) {
      return failedSkillPatch(
        'skill_patch_reject',
        'Skill patch was not found.',
        ['id'],
      );
    }
    if (candidate.status !== 'proposed') {
      return failedSkillPatch(
        'skill_patch_reject',
        'Skill patch candidate was already decided.',
        ['id'],
      );
    }
    database
      .prepare(
        `
        UPDATE learning_candidates
        SET status = 'rejected', decided_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, candidate.id);
    recordLearningEvent(database, {
      type: 'skill_patch_rejected',
      source: options.source ?? 'user',
      data: {
        candidateId: candidate.id,
        skillId: candidate.skillId,
        reason: parsed.output.reason ?? candidate.reason,
      },
      createdAt: now,
    });

    return {
      ok: true,
      action: 'skill_patch_reject',
      changed: true,
      candidateId: candidate.id,
      message: 'Rejected skill patch candidate.',
    };
  } finally {
    database.close();
  }
}

export async function restoreSkillPatchCandidate(
  input: v.InferInput<typeof skillPatchRestoreInputSchema>,
  paths = runtimePaths(),
  options: { source?: SkillPatchMutationSource } = {},
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(skillPatchRestoreInputSchema, input);
  if (!parsed.success) {
    return failedSkillPatch('skill_patch_restore', v.summarize(parsed.issues));
  }
  if ((options.source ?? 'user') !== 'user') {
    return failedSkillPatch(
      'skill_patch_restore',
      'Skill patch restore requires an explicit user/API decision.',
      ['explicit-user-decision'],
    );
  }

  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    const candidate = readSkillPatchCandidateById(database, parsed.output.id);
    if (!candidate) {
      return failedSkillPatch(
        'skill_patch_restore',
        'Skill patch was not found.',
        ['id'],
      );
    }
    if (candidate.status !== 'applied') {
      return failedSkillPatch(
        'skill_patch_restore',
        'Only applied skill patches can be restored from audit.',
        ['applied-skill-patch'],
      );
    }

    const patch = parsePatchPayload(candidate.patch);
    const target = await resolvePatchableSkill(candidate.skillId, paths);
    if (!target.ok) return target.result;
    if (resolve(target.skill.path) !== resolve(patch.path)) {
      return failedSkillPatch(
        'skill_patch_restore',
        'Skill path no longer matches the audited patch target.',
        ['skill-path'],
      );
    }

    const currentContent = await readFile(target.skill.path, 'utf8');
    if (sha256(currentContent) !== patch.afterHash) {
      return failedSkillPatch(
        'skill_patch_restore',
        'Skill content changed after this patch was applied. Use the audit diff for manual restore or create a fresh patch.',
        ['stale-skill-content'],
      );
    }
    const validation = validateSkillPatch(
      patch.afterContent,
      patch.beforeContent,
    );
    if (!validation.ok) {
      return failedSkillPatch('skill_patch_restore', validation.message, [
        'valid-skill-patch',
      ]);
    }

    recordLearningEvent(database, {
      type: 'skill_patch_restore_started',
      source: options.source ?? 'user',
      data: {
        candidateId: candidate.id,
        skillId: candidate.skillId,
        fromHash: patch.afterHash,
        toHash: patch.beforeHash,
        reason:
          parsed.output.reason ??
          candidate.reason ??
          'Restoring from skill patch audit.',
      },
      createdAt: now,
    });

    try {
      await writeFile(target.skill.path, patch.beforeContent, 'utf8');
    } catch (error) {
      await writeFile(target.skill.path, patch.afterContent, 'utf8').catch(
        () => {},
      );
      try {
        recordLearningEvent(database, {
          type: 'skill_patch_restore_failed',
          source: options.source ?? 'user',
          data: {
            candidateId: candidate.id,
            skillId: candidate.skillId,
            phase: 'file-write',
            error: errorMessage(error),
          },
          createdAt: new Date().toISOString(),
        });
      } catch {
        // Best-effort failure audit when the restore write itself fails.
      }
      return failedSkillPatch(
        'skill_patch_restore',
        `Skill patch restore file write failed; reapplied the patched content when possible. ${errorMessage(error)}`,
        ['skill-patch-write'],
      );
    }
    try {
      database.exec('BEGIN;');
      database
        .prepare(
          `
          UPDATE learning_candidates
          SET status = 'archived', decided_at = ?
          WHERE id = ?;
        `,
        )
        .run(now, candidate.id);
      recordLearningEvent(database, {
        type: 'skill_patch_restored',
        source: options.source ?? 'user',
        data: {
          candidateId: candidate.id,
          skillId: candidate.skillId,
          beforeHash: patch.afterHash,
          afterHash: patch.beforeHash,
          reason:
            parsed.output.reason ??
            candidate.reason ??
            'Restored from skill patch audit.',
        },
        createdAt: now,
      });
      recordConfigHistory(database, {
        action: 'skill_patch_restored',
        target: `skill:${candidate.skillId}`,
        before: {
          path: patch.path,
          sha256: patch.afterHash,
          content: patch.afterContent,
        },
        after: {
          path: patch.path,
          sha256: patch.beforeHash,
          content: patch.beforeContent,
        },
        changedAt: now,
      });
      database.exec('COMMIT;');
    } catch (error) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // Ignore rollback failures; the file compensation below is the critical step.
      }
      await writeFile(target.skill.path, patch.afterContent, 'utf8').catch(
        () => {},
      );
      try {
        recordLearningEvent(database, {
          type: 'skill_patch_restore_failed',
          source: options.source ?? 'user',
          data: {
            candidateId: candidate.id,
            skillId: candidate.skillId,
            error: errorMessage(error),
          },
          createdAt: new Date().toISOString(),
        });
      } catch {
        // Best-effort failure audit after the file compensation path.
      }
      return failedSkillPatch(
        'skill_patch_restore',
        `Skill patch restore audit failed; reapplied the patched content. ${errorMessage(error)}`,
        ['skill-patch-audit'],
      );
    }

    return {
      ok: true,
      action: 'skill_patch_restore',
      changed: true,
      candidateId: candidate.id,
      skillId: candidate.skillId,
      appliesAfter: 'new-session',
      message:
        'Restored skill content from audit. Start a new Neon session for restored guidance to enter prompt context.',
    };
  } finally {
    database.close();
  }
}

async function resolvePatchableSkill(skillId: string, paths: RuntimePaths) {
  const inventory = await listRuntimeSkills(paths);
  const skill = inventory.skills.find(
    (candidate) => candidate.id === skillId && candidate.status === 'active',
  );
  if (!skill) {
    return {
      ok: false as const,
      result: failedSkillPatch('skill_patch_resolve', 'Skill was not found.', [
        'skillId',
      ]),
    };
  }
  if (!(await isPatchableSkill(skill, paths))) {
    return {
      ok: false as const,
      result: failedSkillPatch(
        'skill_patch_resolve',
        'Only the built-in neondeck skill and user skills under NEONDECK_HOME/skills can be patched.',
        ['patchable-skill'],
      ),
    };
  }
  return { ok: true as const, skill };
}

async function isPatchableSkill(
  skill: RuntimeSkillMetadata,
  paths: RuntimePaths,
) {
  if (skill.source === 'built-in') return skill.id === 'neondeck';
  if (skill.source !== 'user') return false;
  const skillPath = await realpath(skill.path);
  const userRoot = await realpath(paths.skills);
  return (
    skillPath === userRoot ||
    skillPath.startsWith(`${userRoot}${pathSeparatorFor(userRoot)}`)
  );
}

function pathSeparatorFor(path: string) {
  return path.includes('\\') ? '\\' : '/';
}

function applyPatchOperation(
  beforeContent: string,
  operation: v.InferOutput<typeof skillPatchOperationSchema>,
) {
  if (operation.type === 'replace-file') return operation.afterContent;

  const block = ensureTrailingNewline(operation.content);
  const headingPattern = new RegExp(
    `(^|\n)## ${escapeRegExp(operation.heading)}\\n`,
  );
  const match = headingPattern.exec(beforeContent);
  if (!match || match.index === undefined) {
    return `${ensureTrailingNewline(beforeContent)}\n## ${operation.heading}\n\n${block}`;
  }

  const headingStart = match.index + match[1].length;
  const nextSection = beforeContent
    .slice(headingStart + match[0].length - match[1].length)
    .search(/\n## /);
  if (nextSection < 0) return `${ensureTrailingNewline(beforeContent)}${block}`;
  const insertAt =
    headingStart + match[0].length - match[1].length + nextSection + 1;
  return `${beforeContent.slice(0, insertAt)}${block}\n${beforeContent.slice(insertAt)}`;
}

function validateSkillPatch(beforeContent: string, afterContent: string) {
  const beforeFrontmatter = frontmatterBlock(beforeContent);
  const afterFrontmatter = frontmatterBlock(afterContent);
  if (!beforeFrontmatter || !afterFrontmatter) {
    return {
      ok: false as const,
      message: 'Skill patches must preserve YAML frontmatter.',
    };
  }
  if (beforeFrontmatter !== afterFrontmatter) {
    return {
      ok: false as const,
      message: 'Skill patches must not change YAML frontmatter.',
    };
  }
  if (!afterContent.includes('# ')) {
    return {
      ok: false as const,
      message: 'Skill patches must preserve markdown skill content.',
    };
  }
  return { ok: true as const };
}

function frontmatterBlock(content: string) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  return end < 0 ? null : content.slice(0, end + 5);
}

async function skillPatchPolicyResult(
  paths: RuntimePaths,
  source: SkillPatchMutationSource,
) {
  if (source === 'user') return { ok: true as const };
  try {
    const config = resolveLearningConfig(
      await readRuntimeJson(paths.config, parseAppConfig),
    );
    if (!config.enabled || config.skillWriteMode === 'off') {
      return {
        ok: false as const,
        result: failedSkillPatch(
          'skill_patch_policy',
          'Skill patch learning is disabled by runtime config.',
          ['learning.skillWriteMode'],
        ),
      };
    }
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      result: failedSkillPatch(
        'skill_patch_policy',
        `Learning config is invalid; skill patches are blocked. ${errorMessage(error)}`,
        ['valid-learning-config'],
      ),
    };
  }
}

async function skillPatchApplyPolicyResult(
  paths: RuntimePaths,
  source: SkillPatchMutationSource,
  patch: { operation?: { type?: string } },
) {
  if (source === 'user') return { ok: true as const };
  if (source !== 'workflow') {
    return {
      ok: false as const,
      result: failedSkillPatch(
        'skill_patch_policy',
        'Skill patch application requires an explicit user/API decision.',
        ['explicit-user-decision'],
      ),
    };
  }
  try {
    const config = resolveLearningConfig(
      await readRuntimeJson(paths.config, parseAppConfig),
    );
    if (!config.enabled || config.skillWriteMode !== 'auto') {
      return {
        ok: false as const,
        result: failedSkillPatch(
          'skill_patch_policy',
          'Automatic skill patch application is not enabled.',
          ['learning.skillWriteMode'],
        ),
      };
    }
    if (patch.operation?.type !== 'append-section') {
      return {
        ok: false as const,
        result: failedSkillPatch(
          'skill_patch_policy',
          'Automatic skill patch application is limited to append-section patches.',
          ['review-required'],
        ),
      };
    }
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      result: failedSkillPatch(
        'skill_patch_policy',
        `Learning config is invalid; skill patches are blocked. ${errorMessage(error)}`,
        ['valid-learning-config'],
      ),
    };
  }
}

function insertSkillPatchCandidate(
  database: DatabaseSync,
  candidate: SkillPatchCandidateRecord,
) {
  database
    .prepare(
      `
      INSERT INTO learning_candidates (
        id,
        target,
        status,
        action,
        skill_id,
        patch_json,
        reason,
        review_id,
        created_at,
        decided_at
      )
      VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      candidate.id,
      candidate.status,
      candidate.action,
      candidate.skillId,
      JSON.stringify(candidate.patch),
      candidate.reason,
      candidate.reviewId,
      candidate.createdAt,
      candidate.decidedAt,
    );
}

function readSkillPatchCandidateById(
  database: DatabaseSync,
  id: string,
): SkillPatchCandidateRecord | null {
  const row = database
    .prepare(
      `
      SELECT *
      FROM learning_candidates
      WHERE id = ?
        AND target = 'skill';
    `,
    )
    .get(id);
  return row ? readSkillPatchCandidateRow(row) : null;
}

function readSkillPatchCandidateRow(row: unknown): SkillPatchCandidateRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    target: 'skill',
    status: v.parse(
      v.picklist(['proposed', 'applied', 'rejected', 'archived']),
      record.status,
    ),
    action: 'patch',
    skillId: String(record.skill_id),
    patch: parseNullableJson(record.patch_json) ?? {},
    reason: typeof record.reason === 'string' ? record.reason : null,
    reviewId: typeof record.review_id === 'string' ? record.review_id : null,
    createdAt: String(record.created_at),
    decidedAt: typeof record.decided_at === 'string' ? record.decided_at : null,
  };
}

function parsePatchPayload(value: JsonValue) {
  const schema = v.object({
    path: nonEmptyStringSchema,
    beforeHash: nonEmptyStringSchema,
    afterHash: nonEmptyStringSchema,
    beforeContent: nonEmptyStringSchema,
    afterContent: nonEmptyStringSchema,
    operation: v.optional(
      v.object({
        type: nonEmptyStringSchema,
      }),
    ),
  });
  return v.parse(schema, value);
}

function recordLearningEvent(
  database: DatabaseSync,
  input: {
    type: string;
    source: string;
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
        data_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?);
    `,
    )
    .run(
      randomUUID(),
      input.type,
      input.source,
      input.data === undefined || input.data === null
        ? null
        : JSON.stringify(input.data),
      input.createdAt,
    );
}

function recordConfigHistory(
  database: DatabaseSync,
  input: {
    action: string;
    target: string;
    before: unknown;
    after: unknown;
    changedAt: string;
  },
) {
  database
    .prepare(
      `
      INSERT INTO config_history (
        action,
        file,
        target,
        before_json,
        after_json,
        changed_at
      )
      VALUES (?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      input.action,
      'SKILL.md',
      input.target,
      JSON.stringify(asJsonValue(input.before)),
      JSON.stringify(asJsonValue(input.after)),
      input.changedAt,
    );
}

function unifiedWholeFileDiff(path: string, before: string, after: string) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function ensureTrailingNewline(value: string) {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function parseNullableJson(value: unknown): JsonValue | null {
  if (typeof value !== 'string') return null;
  return JSON.parse(value) as JsonValue;
}

function failedSkillPatch(
  action: string,
  message: string,
  requires?: string[],
) {
  return {
    ok: false as const,
    action,
    changed: false as const,
    message,
    errors: [message],
    ...(requires ? { requires } : {}),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
