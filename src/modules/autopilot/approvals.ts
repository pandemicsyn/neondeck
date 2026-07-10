import * as v from 'valibot';
import { gitCurrentSha } from '../../repo-edit/git';
import {
  approvePreparedDiffPush,
  approvePushInputSchema,
  readPreparedDiff,
  type PreparedDiffActionResult,
} from '../prepared-diffs';
import { checkAutopilotPolicy } from '../autopilot-policy';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';

export async function approvePreparedDiffPushWithPolicy(
  input: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<PreparedDiffActionResult> {
  const parsed = v.safeParse(approvePushInputSchema, input);
  const unavailableBinding = {
    targetSha: '',
    policyHash: '',
    policyDecision: 'allow' as const,
  };
  if (!parsed.success) {
    return approvePreparedDiffPush(input, paths, unavailableBinding);
  }
  const preparedDiff = readPreparedDiff(parsed.output.preparedDiffId, paths);
  if (!preparedDiff) {
    return approvePreparedDiffPush(input, paths, unavailableBinding);
  }
  const targetSha = await gitCurrentSha(preparedDiff.sourceWorktreePath).catch(
    () => null,
  );
  if (!targetSha) {
    return approvePreparedDiffPush(input, paths, unavailableBinding);
  }
  const policy = await checkAutopilotPolicy(
    {
      worktreeId: preparedDiff.worktreeId,
      diffBaseRef: preparedDiff.headSha ?? preparedDiff.baseRef,
      pushDestination: 'pull-request-head',
    },
    paths,
  );
  if (policy.decision === 'deny') {
    return {
      ok: false,
      action: 'prepared_diff_approve_push',
      changed: false,
      message:
        'Prepared diff policy denies push-back; approval cannot override it.',
      errors: policy.reasons,
      requires: policy.requires,
    };
  }
  return approvePreparedDiffPush(input, paths, {
    targetSha,
    policyHash: policy.policyHash,
    policyDecision: policy.decision,
  });
}
