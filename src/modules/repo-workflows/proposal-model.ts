import { randomUUID } from 'node:crypto';
import { dispatch, init } from '@flue/runtime';
import { readAgentModelSelectionSync } from '../runtime';
import type { RepoWorkflowProposalModel } from './proposal';
import { RepoWorkflowProposer } from './proposal-agent';
export const runRepoWorkflowProposalModel: RepoWorkflowProposalModel = async (
  evidence,
  paths,
) => {
  const id = `repo-workflow-${randomUUID()}`;
  const handle = init(RepoWorkflowProposer, { id });
  const deadline = Date.now() + 60_000;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const admission = dispatch(RepoWorkflowProposer, {
    id,
    uid: null,
    initialData: {
      model: readAgentModelSelectionSync(paths).utility,
      evidence,
    },
    message: 'Propose editable repository workflows from the bounded evidence.',
  });
  // A late admission cannot leave background work running after timeout.
  void admission.then(
    () => {
      if (expired) void handle.abort().catch(() => undefined);
    },
    () => undefined,
  );
  try {
    return await Promise.race([
      (async () => {
        const receipt = await admission;
        if (expired || Date.now() >= deadline)
          throw new Error('Workflow proposal deadline expired.');
        const reply = await handle.read(receipt.submissionId, {
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        const entries = reply.data.repoWorkflowProposal;
        if (
          reply.submissionId !== receipt.submissionId ||
          entries?.length !== 1
        )
          throw new Error(
            'Workflow proposal did not settle with one validated submission.',
          );
        return entries[0];
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('Workflow proposal deadline expired.'));
        }, 60_000);
      }),
    ]);
  } catch (error) {
    expired = true;
    // Abort is best effort; an unavailable transport cannot hold this API open.
    void handle.abort().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
