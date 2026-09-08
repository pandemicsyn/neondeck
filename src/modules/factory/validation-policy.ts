import { resolveRepoWorkflow, RepoWorkflowError } from '../repo-workflows';
import * as v from 'valibot';
import { createHash } from 'node:crypto';
import { validationPolicySchema } from '../../../shared/factory-delivery';
import { effectiveFactoryCodingConfig } from '../../../shared/factory-coding';
import {
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJsonSync,
  type RuntimePaths,
} from '../../runtime-home';
import { resolveAgentModelSelection } from '../runtime';
import { repoGuardrails } from '../autopilot-policy';
import { resolveWorktreeVerificationChecks } from '../worktree-verification';
import { FactoryError } from './error';

/** Read-only preview: no GitHub, candidate, or coding admission is required. */
export function factoryValidationPolicy(
  repoId: string,
  paths: RuntimePaths,
  profileId?: string | null,
) {
  const repo = readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos.find(
    (r) => r.id === repoId,
  );
  if (!repo) throw new FactoryError(404, 'Registered repository not found.');
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  const models = resolveAgentModelSelection(config);
  if (!models.prReviewConfigured)
    throw new FactoryError(
      409,
      'Configure an independent reviewer model before authorizing validation.',
    );
  const workflow = (() => {
    try {
      return resolveRepoWorkflow(repo, config, profileId ?? undefined);
    } catch (error) {
      if (error instanceof RepoWorkflowError)
        throw new FactoryError(error.status, error.message);
      throw error;
    }
  })();
  const checkCommands = workflow
    ? workflow.validationCommands.map((c) => c.command)
    : resolveWorktreeVerificationChecks(undefined, repo, [
        ...repoGuardrails(repo, config).requiredChecks,
      ]);
  const policy = {
    version: 'local-validation-v1',
    ...(workflow ? { workflow } : {}),
    checkCommands,
    reviewerModel: models.prReview,
    reviewerThinkingLevel: models.prReviewThinkingLevel ?? null,
    maxRepairAttempts: 2,
    totalExecutionMs: 10800000,
  };
  const configFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        policy,
        coding: effectiveFactoryCodingConfig(config.factory?.coding ?? {}),
      }),
    )
    .digest('hex');
  const result = v.safeParse(validationPolicySchema, {
    ...policy,
    configFingerprint,
  });
  if (!result.success)
    throw new FactoryError(
      409,
      'Configure between 1 and 16 bounded repository check commands before authorizing validation.',
    );
  return result.output;
}
