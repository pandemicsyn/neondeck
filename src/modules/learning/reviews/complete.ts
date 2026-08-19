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
import type { CompletedEffectIdentifiers } from './tool';
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

export type CompletedLearningReviewEffect = {
  name: string;
  changed: boolean;
  identifiers?: CompletedEffectIdentifiers;
};

type LearningReviewFailureResult = {
  failed: boolean;
  partial: boolean;
  changed: boolean;
  outcomeUnknown: boolean;
  uncertainEffect?: string;
  completedEffects: CompletedLearningReviewEffect[];
};

const candidateIdSchema = v.object({ id: v.string() });
type CandidateWithId = v.InferInput<typeof candidateIdSchema>;

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
  const skillSnapshots = new Map(
    prepared.skillSnapshots.map((snapshot) => [snapshot.id, snapshot.sha256]),
  );
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
    const revisionContext = memoryRevisionContext(
      proposal,
      prepared.memorySnapshots,
    );
    if (!revisionContext) {
      skipped.push({
        action: proposal.action,
        reason: 'memory-revision-not-in-review-snapshot',
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
          revisionContext,
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
      applyProposal(
        proposal,
        revisionContext,
        paths,
        `${prepared.reviewId}:${effectName}`,
      ),
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
    const expectedBeforeHash = skillSnapshots.get(proposal.skillId);
    if (!expectedBeforeHash) {
      skipped.push({
        action: 'skill-patch',
        skillId: proposal.skillId,
        reason: 'skill-revision-not-in-review-snapshot',
      });
      continue;
    }
    const proposed = await runEffect(`skill-proposal:${index}`, () =>
      proposeSkillPatch({ ...proposal, reviewId: prepared.reviewId }, paths, {
        source: 'workflow',
        candidateId: `learning:${prepared.reviewId}:skill:${index}`,
        expectedBeforeHash,
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
    const candidate = v.safeParse(
      v.object({ id: v.string() }),
      proposed.candidate,
    );
    if (!candidate.success) {
      skipped.push({
        action: 'skill-patch-apply',
        skillId: proposal.skillId,
        reason: 'candidate-missing-identifier',
      });
      continue;
    }
    const candidateId = candidate.output.id;
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
      .map((candidate) => candidateIdentifier(candidate))
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
  error: Error,
  paths = runtimePaths(),
  options: {
    completedEffects?: CompletedLearningReviewEffect[];
    uncertainEffect?: string;
  } = {},
) {
  const message = errorMessage(error);
  const completedEffects = options.completedEffects ?? [];
  const changed = completedEffects.some((effect) => effect.changed);
  const outcomeUnknown = options.uncertainEffect !== undefined;
  const partial = completedEffects.length > 0 || outcomeUnknown;
  const failureResult: LearningReviewFailureResult = {
    failed: true,
    partial,
    changed,
    outcomeUnknown,
    completedEffects,
  };
  if (options.uncertainEffect) {
    failureResult.uncertainEffect = options.uncertainEffect;
  }
  const result = compactJson(failureResult);
  failLearningReview(prepared.reviewId, message, paths, result);
  const response: Omit<ReturnType<typeof failedReview>, 'changed'> & {
    changed: boolean;
    reviewId: string;
    partial: boolean;
    outcomeUnknown: boolean;
    uncertainEffect?: string;
    completedEffects: CompletedLearningReviewEffect[];
  } = {
    ...failedReview(reviewAction(prepared.kind), message),
    changed,
    reviewId: prepared.reviewId,
    partial,
    outcomeUnknown,
    completedEffects,
  };
  if (options.uncertainEffect) {
    response.uncertainEffect = options.uncertainEffect;
  }
  return response;
}

export async function createCandidateFromProposal(
  proposal: MemoryProposal,
  revisionContext: MemoryRevisionContext,
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
        patch: {
          expectedUpdatedAt: revisionContext.expectedUpdatedAt ?? null,
        },
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
        patch: {
          memoryId: proposal.memoryId,
          expectedUpdatedAt: revisionContext.expectedUpdatedAt,
        },
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
        patch: {
          memoryId: proposal.memoryId,
          expectedUpdatedAt: revisionContext.expectedUpdatedAt,
        },
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
        expectedUpdatedAts: revisionContext.expectedUpdatedAts,
      },
    },
    paths,
    { source: 'workflow', candidateId },
  );
}

export async function applyProposal(
  proposal: MemoryProposal,
  revisionContext: MemoryRevisionContext,
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
        expectedUpdatedAt: revisionContext.expectedUpdatedAt ?? null,
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
        expectedUpdatedAt: revisionContext.expectedUpdatedAt ?? undefined,
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
        expectedUpdatedAt: revisionContext.expectedUpdatedAt ?? undefined,
        reason: proposal.reason,
        actor: 'workflow',
      },
      paths,
      { source: 'workflow', effectId },
    );
  }
  const mergeInput: Parameters<typeof mergeMemories>[0] = {
    targetId: proposal.targetId,
    sourceIds: proposal.sourceIds,
    expectedUpdatedAts: revisionContext.expectedUpdatedAts,
    reason: proposal.reason,
    actor: 'workflow',
  };
  if (proposal.value !== undefined) mergeInput.value = proposal.value;
  return mergeMemories(mergeInput, paths, { source: 'workflow', effectId });
}

function candidateIdentifier(candidate: CandidateWithId | undefined) {
  const parsed = v.safeParse(candidateIdSchema, candidate);
  return parsed.success ? parsed.output.id : null;
}

type MemorySnapshot = PreparedLearningReview['memorySnapshots'][number];

type MemoryRevisionContext = {
  expectedUpdatedAt?: string | null;
  expectedUpdatedAts?: Record<string, string>;
};

export function memoryRevisionContext(
  proposal: MemoryProposal,
  snapshots: MemorySnapshot[],
): MemoryRevisionContext | null {
  if (proposal.action === 'upsert') {
    const existing = snapshots.find(
      (snapshot) =>
        snapshot.scope === proposal.scope &&
        snapshot.key === proposal.key &&
        snapshot.repoId === (proposal.repoId ?? null),
    );
    return { expectedUpdatedAt: existing?.updatedAt ?? null };
  }
  if (proposal.action === 'rewrite' || proposal.action === 'archive') {
    const snapshot = snapshots.find(
      (candidate) => candidate.id === proposal.memoryId,
    );
    return snapshot ? { expectedUpdatedAt: snapshot.updatedAt } : null;
  }
  const expectedUpdatedAts: Record<string, string> = {};
  for (const id of [proposal.targetId, ...proposal.sourceIds]) {
    const snapshot = snapshots.find((candidate) => candidate.id === id);
    if (!snapshot) return null;
    expectedUpdatedAts[id] = snapshot.updatedAt;
  }
  return { expectedUpdatedAts };
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
