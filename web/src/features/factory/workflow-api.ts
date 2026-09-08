import * as v from 'valibot';
import {
  repoWorkflowsSnapshotSchema,
  repoWorkflowsProposalResultSchema,
  saveRepoWorkflowsInputSchema,
  proposeRepoWorkflowsInputSchema,
  type SaveRepoWorkflowsInput,
} from '../../../../shared/repo-workflows';
import {
  currentRepoWorkflowRunSchema,
  repoWorkflowRunSchema,
  startRepoWorkflowRunSchema,
} from '../../../../shared/repo-workflow-runs';
import {
  getJson,
  putJson,
  postJson,
  type ApiRequestOptions,
} from '../../api/http';
const configUrl = (repoId: string) =>
  `/api/repos/${encodeURIComponent(repoId)}/factory-workflows`;
const runUrl = (repoId: string) =>
  `/api/repos/${encodeURIComponent(repoId)}/factory-workflow-runs`;
function matchRepo<T extends { repoId: string }>(value: T, repoId: string): T {
  if (value.repoId !== repoId)
    throw new Error('Workflow response belongs to another repository.');
  return value;
}
export async function getRepoWorkflows(
  repoId: string,
  options: ApiRequestOptions = {},
) {
  return matchRepo(
    v.parse(
      repoWorkflowsSnapshotSchema,
      await getJson(configUrl(repoId), options),
    ),
    repoId,
  );
}
export async function saveRepoWorkflows(
  repoId: string,
  input: SaveRepoWorkflowsInput,
) {
  return matchRepo(
    v.parse(
      repoWorkflowsSnapshotSchema,
      await putJson(
        configUrl(repoId),
        v.parse(saveRepoWorkflowsInputSchema, input),
      ),
    ),
    repoId,
  );
}
export async function proposeRepoWorkflows(
  repoId: string,
  expectedFingerprint: string,
) {
  return matchRepo(
    v.parse(
      repoWorkflowsProposalResultSchema,
      await postJson(
        `${configUrl(repoId)}/propose`,
        v.parse(proposeRepoWorkflowsInputSchema, { expectedFingerprint }),
      ),
    ),
    repoId,
  );
}
export async function startRepoWorkflowRun(
  repoId: string,
  input: v.InferOutput<typeof startRepoWorkflowRunSchema>,
) {
  const result = matchRepo(
    v.parse(
      repoWorkflowRunSchema,
      await postJson(
        runUrl(repoId),
        v.parse(startRepoWorkflowRunSchema, input),
      ),
    ),
    repoId,
  );
  if (result.profileId !== input.profileId)
    throw new Error('Test response belongs to another profile.');
  return result;
}
export async function getRepoWorkflowRun(
  repoId: string,
  runId: string,
  options: ApiRequestOptions = {},
) {
  const result = matchRepo(
    v.parse(
      repoWorkflowRunSchema,
      await getJson(`${runUrl(repoId)}/${encodeURIComponent(runId)}`, options),
    ),
    repoId,
  );
  if (result.runId !== runId)
    throw new Error('Test response belongs to another run.');
  return result;
}
export async function cancelRepoWorkflowRun(repoId: string, runId: string) {
  const result = matchRepo(
    v.parse(
      repoWorkflowRunSchema,
      await postJson(
        `${runUrl(repoId)}/${encodeURIComponent(runId)}/cancel`,
        {},
      ),
    ),
    repoId,
  );
  if (result.runId !== runId)
    throw new Error('Test response belongs to another run.');
  return result;
}

export async function getCurrentRepoWorkflowRun(
  repoId: string,
  options: ApiRequestOptions = {},
) {
  const result = v.parse(
    currentRepoWorkflowRunSchema,
    await getJson(`${runUrl(repoId)}/current`, options),
  );
  if (result.run) matchRepo(result.run, repoId);
  return result;
}
