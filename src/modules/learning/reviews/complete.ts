import * as v from 'valibot';
import {
  archiveMemory,
  createMemoryCandidate,
  mergeMemories,
  rewriteMemory,
  upsertMemory,
} from '../../memory';
import { applySkillPatchCandidate, proposeSkillPatch } from '../skill-patches';
import { runtimePaths, type RuntimePaths } from '../../../runtime-home';
import type {
  MemoryProposal,
  LearningReviewerOutput,
  PreparedLearningReview,
} from './schemas';
import { learningReviewerOutputSchema } from './schemas';
import {
  compactJson,
  completeLearningReview,
  errorMessage,
  failLearningReview,
  failedReview,
  reviewAction,
} from './store';

export type LearningReviewEffectRunner = <T>(
  name: string,
  effect: () => T | Promise<T>,
) => Promise<T>;

export async function completeLearningReviewFromModelOutput(
  prepared: PreparedLearningReview,
  output: LearningReviewerOutput,
  paths = runtimePaths(),
  options: { runEffect?: LearningReviewEffectRunner } = {},
) {
  const runEffect: LearningReviewEffectRunner =
    options.runEffect ?? ((_name, effect) => Promise.resolve(effect()));
  const parsed = v.safeParse(learningReviewerOutputSchema, output);
  if (!parsed.success) {
    const message = v.summarize(parsed.issues);
    await runEffect('fail-invalid-result', () => {
      failLearningReview(prepared.reviewId, message, paths);
      return { failed: true };
    });
    return failedReview(reviewAction(prepared.kind), message);
  }

  const applied = [];
  const candidates = [];
  const skillCandidates = [];
  const skipped = [];
  const allowedMemoryIds = new Set(prepared.allowedMemoryIds);
  const allowedProjectRepoIds = new Set(prepared.allowedProjectRepoIds);
  const allowedSkillIds = new Set(prepared.allowedSkillIds);
  for (const [index, proposal] of parsed.output.memoryActions.entries()) {
    if (prepared.kind === 'pr-batch' && proposal.action === 'upsert') {
      if (proposal.scope === 'user') {
        skipped.push({
          action: proposal.action,
          reason: 'pr-review-user-scope',
        });
        continue;
      }
    }
    if (
      !proposalTargetsAllowed(proposal, allowedMemoryIds, allowedProjectRepoIds)
    ) {
      skipped.push({
        action: proposal.action,
        reason: 'memory-not-in-review-snapshot',
      });
      continue;
    }
    if (prepared.mode === 'off') {
      skipped.push({ action: proposal.action, reason: 'mode-off' });
      continue;
    }
    if (prepared.mode === 'review') {
      const result = await runEffect(`memory-candidate:${index}`, () =>
        createCandidateFromProposal(
          proposal,
          prepared.reviewId,
          paths,
          `learning:${prepared.reviewId}:memory:${index}`,
        ),
      );
      if (result.ok && 'candidate' in result) candidates.push(result.candidate);
      else skipped.push(result);
      continue;
    }
    const effectName = `memory-action:${index}`;
    const result = await runEffect(effectName, () =>
      applyProposal(proposal, paths, `${prepared.reviewId}:${effectName}`),
    );
    if (result.ok && result.changed) applied.push(result);
    else skipped.push(result);
  }
  for (const [index, proposal] of parsed.output.skillPatches.entries()) {
    if (!allowedSkillIds.has(proposal.skillId)) {
      skipped.push({
        action: 'skill-patch',
        skillId: proposal.skillId,
        reason: 'skill-not-in-review-snapshot',
      });
      continue;
    }
    if (prepared.skillMode === 'off') {
      skipped.push({
        action: 'skill-patch',
        skillId: proposal.skillId,
        reason: 'mode-off',
      });
      continue;
    }
    const proposed = await runEffect(`skill-proposal:${index}`, () =>
      proposeSkillPatch({ ...proposal, reviewId: prepared.reviewId }, paths, {
        source: 'workflow',
        candidateId: `learning:${prepared.reviewId}:skill:${index}`,
      }),
    );
    if (!proposed.ok || !('candidate' in proposed)) {
      skipped.push(proposed);
      continue;
    }
    if (prepared.skillMode === 'review') {
      skillCandidates.push(proposed.candidate);
      continue;
    }
    if (proposal.operation.type !== 'append-section') {
      skillCandidates.push(proposed.candidate);
      skipped.push({
        action: 'skill-patch-apply',
        skillId: proposal.skillId,
        reason: 'review-required-for-replace-file',
      });
      continue;
    }
    const candidateId = String(
      (proposed.candidate as Record<string, unknown>).id,
    );
    const appliedPatch = await runEffect(`skill-apply:${index}`, () =>
      applySkillPatchCandidate(
        { id: candidateId, reason: proposal.reason },
        paths,
        { source: 'workflow', idempotent: true },
      ),
    );
    if (appliedPatch.ok && appliedPatch.changed) applied.push(appliedPatch);
    else skipped.push(appliedPatch);
  }

  const result = compactJson({
    summary: parsed.output.summary,
    mode: prepared.mode,
    skillMode: prepared.skillMode,
    proposed: parsed.output.memoryActions.length,
    candidatesCreated: candidates.length + skillCandidates.length,
    memoryCandidatesCreated: candidates.length,
    skillPatchesProposed: parsed.output.skillPatches.length,
    skillCandidatesCreated: skillCandidates.length,
    applied: applied.length,
    skipped: skipped.length,
    candidateIds: [...candidates, ...skillCandidates]
      .map((candidate) =>
        candidate && typeof candidate === 'object' && 'id' in candidate
          ? String(candidate.id)
          : null,
      )
      .filter(Boolean),
  });
  await runEffect('complete-review', () => {
    completeLearningReview(prepared.reviewId, result, paths);
    return { completed: true };
  });

  return {
    ok: true,
    action: reviewAction(prepared.kind),
    changed:
      applied.length > 0 || candidates.length > 0 || skillCandidates.length > 0,
    reviewId: prepared.reviewId,
    mode: prepared.mode,
    skillMode: prepared.skillMode,
    model: prepared.model,
    thinkingLevel: prepared.thinkingLevel,
    summary: parsed.output.summary,
    candidates: [...candidates, ...skillCandidates],
    memoryCandidates: candidates,
    skillCandidates,
    applied,
    skipped,
    message:
      applied.length > 0 || candidates.length > 0 || skillCandidates.length > 0
        ? `Completed ${prepared.kind} learning review with ${applied.length} applied action${applied.length === 1 ? '' : 's'}, ${candidates.length} memory candidate${candidates.length === 1 ? '' : 's'}, and ${skillCandidates.length} skill candidate${skillCandidates.length === 1 ? '' : 's'}.`
        : `Completed ${prepared.kind} learning review with no memory changes.`,
  };
}

export function failPreparedLearningReview(
  prepared: PreparedLearningReview,
  error: unknown,
  paths = runtimePaths(),
) {
  const message = errorMessage(error);
  failLearningReview(prepared.reviewId, message, paths);
  return {
    ...failedReview(reviewAction(prepared.kind), message),
    reviewId: prepared.reviewId,
  };
}

export async function createCandidateFromProposal(
  proposal: MemoryProposal,
  reviewId: string,
  paths: RuntimePaths,
  candidateId?: string,
) {
  if (proposal.action === 'upsert') {
    return createMemoryCandidate(
      {
        action: 'upsert',
        scope: proposal.scope,
        key: proposal.key,
        value: proposal.value,
        repoId: proposal.repoId,
        reason: proposal.reason,
        reviewId,
      },
      paths,
      { source: 'workflow', candidateId },
    );
  }
  if (proposal.action === 'rewrite') {
    return createMemoryCandidate(
      {
        action: 'rewrite',
        value: proposal.value,
        reason: proposal.reason,
        reviewId,
        patch: { memoryId: proposal.memoryId },
      },
      paths,
      { source: 'workflow', candidateId },
    );
  }
  if (proposal.action === 'archive') {
    return createMemoryCandidate(
      {
        action: 'archive',
        reason: proposal.reason,
        reviewId,
        patch: { memoryId: proposal.memoryId },
      },
      paths,
      { source: 'workflow', candidateId },
    );
  }
  return createMemoryCandidate(
    {
      action: 'merge',
      value: proposal.value,
      reason: proposal.reason,
      reviewId,
      patch: {
        targetId: proposal.targetId,
        sourceIds: proposal.sourceIds,
      },
    },
    paths,
    { source: 'workflow', candidateId },
  );
}

export async function applyProposal(
  proposal: MemoryProposal,
  paths: RuntimePaths,
  effectId?: string,
) {
  if (proposal.action === 'upsert') {
    return upsertMemory(
      {
        scope: proposal.scope,
        key: proposal.key,
        value: proposal.value,
        repoId: proposal.repoId,
        reason: proposal.reason,
        actor: 'workflow',
      },
      paths,
      { source: 'workflow', effectId },
    );
  }
  if (proposal.action === 'rewrite') {
    return rewriteMemory(
      {
        id: proposal.memoryId,
        value: proposal.value,
        reason: proposal.reason,
        actor: 'workflow',
      },
      paths,
      { source: 'workflow', effectId },
    );
  }
  if (proposal.action === 'archive') {
    return archiveMemory(
      {
        id: proposal.memoryId,
        reason: proposal.reason,
        actor: 'workflow',
      },
      paths,
      { source: 'workflow', effectId },
    );
  }
  return mergeMemories(
    {
      targetId: proposal.targetId,
      sourceIds: proposal.sourceIds,
      ...(proposal.value === undefined ? {} : { value: proposal.value }),
      reason: proposal.reason,
      actor: 'workflow',
    },
    paths,
    { source: 'workflow', effectId },
  );
}

export function proposalTargetsAllowed(
  proposal: MemoryProposal,
  allowedMemoryIds: Set<string>,
  allowedProjectRepoIds: Set<string | null>,
) {
  if (proposal.action === 'upsert') {
    if (proposal.scope !== 'project') return proposal.repoId === undefined;
    return allowedProjectRepoIds.has(proposal.repoId ?? null);
  }
  if (proposal.action === 'rewrite' || proposal.action === 'archive') {
    return allowedMemoryIds.has(proposal.memoryId);
  }
  return (
    allowedMemoryIds.has(proposal.targetId) &&
    proposal.sourceIds.every((id) => allowedMemoryIds.has(id))
  );
}
