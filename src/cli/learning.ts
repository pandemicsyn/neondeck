import type { RuntimePaths } from '../runtime-home';
import { memoryActionsModule, skillPatchesModule } from './modules';

export async function decideLearningCandidateCli(
  id: string,
  decision: 'apply' | 'reject',
  reason: string | undefined,
  paths: RuntimePaths,
) {
  const { decideMemoryCandidate } = await memoryActionsModule();
  const memoryResult = await decideMemoryCandidate(
    {
      id,
      decision,
      reason: reason ?? `CLI learning candidate ${decision}.`,
    },
    paths,
  );
  if (memoryResult.ok || !memoryCandidateWasNotFound(memoryResult)) {
    return memoryResult;
  }

  const { applySkillPatchCandidate, rejectSkillPatchCandidate } =
    await skillPatchesModule();
  return decision === 'apply'
    ? applySkillPatchCandidate(
        { id, reason: reason ?? 'CLI skill patch approval.' },
        paths,
      )
    : rejectSkillPatchCandidate(
        { id, reason: reason ?? 'CLI skill patch rejection.' },
        paths,
      );
}

export function memoryCandidateWasNotFound(result: {
  message?: string;
  requires?: readonly string[];
}) {
  return (
    result.message === 'Memory candidate was not found.' &&
    result.requires?.includes('id') === true
  );
}
