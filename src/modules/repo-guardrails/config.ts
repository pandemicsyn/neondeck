import * as v from 'valibot';
import {
  defaultRepoGuardrails,
  repoGuardrailsSchema,
  type AppConfig,
  type RepoConfig,
  type RepoGuardrails,
  type RepoGuardrailsConfig,
} from '../../runtime-home';

const appGuardrailsContainerSchema = v.looseObject({
  guardrails: v.optional(repoGuardrailsSchema),
});

export function mergeGuardrails(
  base: RepoGuardrails,
  override: Partial<RepoGuardrails> | undefined,
): RepoGuardrails {
  return {
    ...base,
    ...override,
    deniedFileGlobs: override?.deniedFileGlobs ?? base.deniedFileGlobs,
    approvalRequiredFileGlobs:
      override?.approvalRequiredFileGlobs ?? base.approvalRequiredFileGlobs,
    requiredChecks: override?.requiredChecks ?? base.requiredChecks,
    allowedPushDestinations:
      override?.allowedPushDestinations ?? base.allowedPushDestinations,
    highRiskClasses: override?.highRiskClasses ?? base.highRiskClasses,
    allowForcePush: override?.allowForcePush ?? base.allowForcePush,
    generatedFileSizeThresholdBytes:
      override?.generatedFileSizeThresholdBytes ??
      base.generatedFileSizeThresholdBytes,
  };
}

export function globalRepoGuardrails(appConfig: unknown): RepoGuardrails {
  const parsed = v.safeParse(appGuardrailsContainerSchema, appConfig);
  return mergeGuardrails(
    defaultRepoGuardrails,
    parsed.success ? parsed.output.guardrails : undefined,
  );
}

export function readRepoGuardrailsConfig(
  repo: RepoConfig | undefined,
): RepoGuardrailsConfig | undefined {
  if (!repo?.metadata?.guardrails) return undefined;
  const parsed = v.safeParse(repoGuardrailsSchema, repo.metadata.guardrails);
  if (!parsed.success) return undefined;
  return parsed.output as RepoGuardrailsConfig;
}

export function repoGuardrails(
  repo: RepoConfig,
  appConfig: AppConfig,
): RepoGuardrails {
  return mergeGuardrails(
    globalRepoGuardrails(appConfig),
    readRepoGuardrailsConfig(repo),
  );
}
