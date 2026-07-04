import type { JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../../lib/action-result';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  parseAppConfig,
  readRuntimeJson,
  resolveLearningConfig,
  type RuntimePaths,
} from '../../../runtime-home';
import { listRuntimeSkills, type RuntimeSkillMetadata } from '../../runtime';
import type {
  SkillPatchCandidateRecord,
  SkillPatchMutationSource,
} from './schemas';
import { nonEmptyStringSchema, skillPatchOperationSchema } from './schemas';

export async function resolvePatchableSkill(
  skillId: string,
  paths: RuntimePaths,
) {
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

export async function isPatchableSkill(
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

export function pathSeparatorFor(path: string) {
  return path.includes('\\') ? '\\' : '/';
}

export function applyPatchOperation(
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

export function validateSkillPatch(
  beforeContent: string,
  afterContent: string,
) {
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

export function frontmatterBlock(content: string) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  return end < 0 ? null : content.slice(0, end + 5);
}

export async function skillPatchPolicyResult(
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

export async function skillPatchApplyPolicyResult(
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

export function insertSkillPatchCandidate(
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

export function readSkillPatchCandidateById(
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

export function readSkillPatchCandidateRow(
  row: unknown,
): SkillPatchCandidateRecord {
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

export function parsePatchPayload(value: JsonValue) {
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

export function recordLearningEvent(
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

export function recordConfigHistory(
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

export function unifiedWholeFileDiff(
  path: string,
  before: string,
  after: string,
) {
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

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function ensureTrailingNewline(value: string) {
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseNullableJson(value: unknown): JsonValue | null {
  if (typeof value !== 'string') return null;
  return JSON.parse(value) as JsonValue;
}

export function failedSkillPatch(
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

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
