import * as v from 'valibot';
import {
  proposeRepoWorkflowsInputSchema,
  repoWorkflowProposalDraftSchema,
  repoWorkflowProposalSchema,
  type RepoWorkflowsProposalResult,
} from '../../../shared/repo-workflows';
import {
  readRuntimeJsonSync,
  parseRepoRegistry,
  type RuntimePaths,
} from '../../runtime-home';
import { assertRepoWorkflowFingerprint, RepoWorkflowError } from './service';
import {
  collectRepoWorkflowEvidence,
  type RepoWorkflowEvidence,
} from './evidence';
export type RepoWorkflowProposalModel = (
  evidence: RepoWorkflowEvidence[],
  paths: RuntimePaths,
) => Promise<unknown>;
export async function proposeRepoWorkflows(
  repoId: string,
  raw: unknown,
  paths: RuntimePaths,
  model?: RepoWorkflowProposalModel,
): Promise<RepoWorkflowsProposalResult> {
  const input = v.parse(proposeRepoWorkflowsInputSchema, raw);
  assertRepoWorkflowFingerprint(repoId, input.expectedFingerprint, paths);
  const repo = readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos.find(
    (entry) => entry.id === repoId,
  )!;
  const { evidence, revision } = await collectRepoWorkflowEvidence(repo.path);
  const invoke =
    model ?? (await import('./proposal-model')).runRepoWorkflowProposalModel;
  const result = v.parse(
    repoWorkflowProposalDraftSchema,
    await invoke(evidence, paths),
  );
  const proposal = v.parse(repoWorkflowProposalSchema, {
    ...result,
    evidenceRevision: revision,
  });
  if (
    proposal.evidencePaths.some(
      (path) => !evidence.some((item) => item.path === path),
    )
  )
    throw new RepoWorkflowError('Proposal cited unavailable evidence.');
  const snapshot = assertRepoWorkflowFingerprint(
    repoId,
    input.expectedFingerprint,
    paths,
  );
  return { ...snapshot, proposal };
}
