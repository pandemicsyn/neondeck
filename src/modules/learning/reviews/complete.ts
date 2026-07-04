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

export async function completeLearningReviewFromModelOutput(
  prepared: PreparedLearningReview,
  output: LearningReviewerOutput,
  paths = runtimePaths(),
) {
  const parsed = v.safeParse(learningReviewerOutputSchema, output);
  if (!parsed.success) {
    const message = v.summarize(parsed.issues);
    failLearningReview(prepared.reviewId, message, paths);
    return failedReview(reviewAction(prepared.kind), message);
  }

  const applied = [];
  const candidates = [];
  const skillCandidates = [];
  const skipped = [];
  const allowedMemoryIds = new Set(prepared.allowedMemoryIds);
  const allowedProjectRepoIds = new Set(prepared.allowedProjectRepoIds);
  const allowedSkillIds = new Set(prepared.allowedSkillIds);
  for (const proposal of parsed.output.memoryActions) {
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
      const result = await createCandidateFromProposal(
        proposal,
        prepared.reviewId,
        paths,
      );
      if (result.ok && 'candidate' in result) candidates.push(result.candidate);
      else skipped.push(result);
      continue;
    }
    const result = await applyProposal(proposal, paths);
    if (result.ok && result.changed) applied.push(result);
    else skipped.push(result);
  }
  for (const proposal of parsed.output.skillPatches) {
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
    const proposed = await proposeSkillPatch(
      { ...proposal, reviewId: prepared.reviewId },
      paths,
      { source: 'workflow' },
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
    const appliedPatch = await applySkillPatchCandidate(
      { id: candidateId, reason: proposal.reason },
      paths,
      { source: 'workflow' },
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
  completeLearningReview(prepared.reviewId, result, paths);

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
      { source: 'workflow' },
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
      { source: 'workflow' },
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
      { source: 'workflow' },
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
    { source: 'workflow' },
  );
}

export async function applyProposal(
  proposal: MemoryProposal,
  paths: RuntimePaths,
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
      { source: 'workflow' },
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
      { source: 'workflow' },
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
      { source: 'workflow' },
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
    { source: 'workflow' },
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
