import { openDb, withImmediateTransaction } from '../../../lib/sqlite.ts';
import { asJsonValue } from '../../../lib/action-result';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { ensureRuntimeHome, runtimePaths } from '../../../runtime-home';
import type {
  SkillPatchCandidateRecord,
  SkillPatchMutationSource,
} from './schemas';
import {
  skillPatchDecideInputSchema,
  skillPatchListInputSchema,
  skillPatchProposeInputSchema,
  skillPatchRestoreInputSchema,
} from './schemas';
import {
  applyPatchOperation,
  errorMessage,
  failedSkillPatch,
  insertSkillPatchCandidate,
  parsePatchPayload,
  readSkillPatchCandidateById,
  readSkillPatchCandidateRow,
  recordConfigHistory,
  recordLearningEvent,
  resolvePatchableSkill,
  sha256,
  skillPatchApplyPolicyResult,
  skillPatchPolicyResult,
  unifiedWholeFileDiff,
  validateSkillPatch,
} from './support';

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

  const database = openDb(paths.neondeckDatabase);
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
  const database = openDb(paths.neondeckDatabase);
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

  const database = openDb(paths.neondeckDatabase);
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

    let fileChanged = false;
    try {
      withImmediateTransaction(database, () => {
        const currentCandidate = readSkillPatchCandidateById(
          database,
          candidate.id,
        );
        if (currentCandidate?.status !== 'proposed') {
          throw new Error('Skill patch candidate was already decided.');
        }
        const latestContent = readFileSync(target.skill.path, 'utf8');
        if (sha256(latestContent) !== patch.beforeHash) {
          throw new Error(
            'Skill content changed while this patch was being applied.',
          );
        }
        writeFileSync(target.skill.path, patch.afterContent, 'utf8');
        fileChanged = true;
        const update = database
          .prepare(
            `
          UPDATE learning_candidates
          SET status = 'applied', decided_at = ?
          WHERE id = ? AND status = 'proposed';
        `,
          )
          .run(now, candidate.id);
        if (update.changes !== 1) {
          throw new Error('Skill patch candidate was concurrently decided.');
        }
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
      });
    } catch (error) {
      let compensated = true;
      if (fileChanged) {
        compensated = await restoreFileIfHashMatches(
          target.skill.path,
          patch.afterHash,
          patch.beforeContent,
        );
      }
      if (!fileChanged) {
        return failedSkillPatch(
          'skill_patch_apply',
          `Skill patch was not applied. ${errorMessage(error)}`,
          ['skill-patch-state'],
        );
      }
      if (!compensated) {
        return failedSkillPatch(
          'skill_patch_apply',
          `Skill patch audit failed and the file could not be safely restored; inspect the skill and audit state manually. ${errorMessage(error)}`,
          ['skill-patch-manual-recovery'],
        );
      }
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

  const database = openDb(paths.neondeckDatabase);
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
    const rejected = withImmediateTransaction(database, () => {
      const update = database
        .prepare(
          `
          UPDATE learning_candidates
          SET status = 'rejected', decided_at = ?
          WHERE id = ? AND status = 'proposed';
        `,
        )
        .run(now, candidate.id);
      if (update.changes !== 1) return false;
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
      return true;
    });
    if (!rejected) {
      return failedSkillPatch(
        'skill_patch_reject',
        'Skill patch candidate was concurrently decided.',
        ['id'],
      );
    }

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

  const database = openDb(paths.neondeckDatabase);
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

    let fileChanged = false;
    try {
      withImmediateTransaction(database, () => {
        const currentCandidate = readSkillPatchCandidateById(
          database,
          candidate.id,
        );
        if (currentCandidate?.status !== 'applied') {
          throw new Error('Skill patch candidate is no longer applied.');
        }
        const latestContent = readFileSync(target.skill.path, 'utf8');
        if (sha256(latestContent) !== patch.afterHash) {
          throw new Error(
            'Skill content changed while this patch was being restored.',
          );
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
        writeFileSync(target.skill.path, patch.beforeContent, 'utf8');
        fileChanged = true;
        const update = database
          .prepare(
            `
          UPDATE learning_candidates
          SET status = 'archived', decided_at = ?
          WHERE id = ? AND status = 'applied';
        `,
          )
          .run(now, candidate.id);
        if (update.changes !== 1) {
          throw new Error('Skill patch candidate was concurrently restored.');
        }
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
      });
    } catch (error) {
      let compensated = true;
      if (fileChanged) {
        compensated = await restoreFileIfHashMatches(
          target.skill.path,
          patch.beforeHash,
          patch.afterContent,
        );
      }
      if (!fileChanged) {
        return failedSkillPatch(
          'skill_patch_restore',
          `Skill patch was not restored. ${errorMessage(error)}`,
          ['skill-patch-state'],
        );
      }
      if (!compensated) {
        return failedSkillPatch(
          'skill_patch_restore',
          `Skill patch restore audit failed and the patched file could not be safely reapplied; inspect the skill and audit state manually. ${errorMessage(error)}`,
          ['skill-patch-manual-recovery'],
        );
      }
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

async function restoreFileIfHashMatches(
  path: string,
  expectedHash: string,
  content: string,
) {
  try {
    const current = await readFile(path, 'utf8');
    if (sha256(current) === expectedHash) {
      await writeFile(path, content, 'utf8');
      return true;
    }
    return false;
  } catch {
    // Preserve the original mutation/audit failure. Manual recovery remains
    // safer than overwriting a concurrently changed skill file.
    return false;
  }
}
