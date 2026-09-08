import * as v from 'valibot';
import {
  proposeRepoWorkflowsInputSchema,
  repoWorkflowsProposalResultSchema,
} from '../../shared/repo-workflows';
import { normalizeListenerEnv, privateServerUrl } from '../lib/server-address';
import { localApiAuthHeader, readLocalApiToken } from '../modules/runtime';
import type { RuntimePaths } from '../runtime-home';

/** Ask the already-running server, which owns the initialized Neon runtime. */
export async function requestFactoryWorkflowProposal(
  repoId: string,
  expectedFingerprint: string,
  paths: RuntimePaths,
) {
  const input = v.parse(proposeRepoWorkflowsInputSchema, {
    expectedFingerprint,
  });
  const { privatePort } = normalizeListenerEnv();
  const address = privateServerUrl(privatePort);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, 60000);
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const token = await readLocalApiToken(paths);
    const response = await fetch(
      `${address}/api/repos/${encodeURIComponent(repoId)}/factory-workflows/propose`,
      {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(token ? { [localApiAuthHeader]: token } : {}),
        },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409)
        throw new Error(
          'Repository settings changed. Restart workflow setup to review current settings before asking Neon again.',
        );
      throw new Error(
        `Neon could not suggest workflows (server response ${response.status}). Check that the server uses this runtime home and has a configured planning model.`,
      );
    }
    const result = v.parse(
      repoWorkflowsProposalResultSchema,
      await response.json(),
    );
    if (result.repoId !== repoId || result.fingerprint !== expectedFingerprint)
      throw new Error(
        'Neon returned settings for a different repository or configuration. Restart workflow setup and verify the server runtime home.',
      );
    return result;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        'Neon suggestion request cancelled or timed out after 60 seconds. No workflow was saved. Retry from the dashboard or continue manual setup.',
      );
    if (error instanceof TypeError)
      throw new Error(
        `Neon server unavailable at ${address}. Start neondeck serve separately with the same --home, then retry Ask Neon; or continue manual setup.`,
      );
    throw error;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
