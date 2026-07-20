import * as v from 'valibot';
import { type AppConfig, type RepoConfig } from '../../runtime-home';
import {
  appAutopilotSchema,
  defaultAutopilotConcurrency,
  metadataSchema,
  type AutopilotConcurrencyPolicy,
  type AutopilotPolicyConfig,
  type RepoGuardrails,
  type RepoAutopilotConfig,
} from './schemas';
import { matchesAny } from '../repo-guardrails/risk';
import {
  globalRepoGuardrails,
  mergeGuardrails,
  readRepoGuardrailsConfig,
  repoGuardrails,
} from '../repo-guardrails/config';

export {
  globalRepoGuardrails,
  mergeGuardrails,
  readRepoGuardrailsConfig,
  repoGuardrails,
};

export function mergeAutopilotConcurrency(
  base: AutopilotConcurrencyPolicy,
  override: Partial<AutopilotConcurrencyPolicy> | undefined,
): AutopilotConcurrencyPolicy {
  return { ...base, ...override };
}

export function globalAutopilotPolicy(
  appConfig: unknown,
): AutopilotPolicyConfig {
  const parsed = v.safeParse(appAutopilotSchema, appConfig);
  const raw = parsed.success ? parsed.output.autopilot : undefined;
  return {
    mode: raw?.defaultMode ?? raw?.mode ?? 'notify-only',
    concurrency: mergeAutopilotConcurrency(
      defaultAutopilotConcurrency,
      raw?.concurrency,
    ),
  };
}

export function readRepoAutopilotConfig(
  repo: RepoConfig | undefined,
): RepoAutopilotConfig | undefined {
  if (!repo?.metadata) return undefined;
  const parsed = v.safeParse(metadataSchema, repo.metadata);
  if (!parsed.success) return undefined;
  return parsed.output.autopilot as RepoAutopilotConfig | undefined;
}

export function repoAutopilotPolicy(
  repo: RepoConfig,
  appConfig: AppConfig,
): AutopilotPolicyConfig {
  const global = globalAutopilotPolicy(appConfig);
  const repoPolicy = readRepoAutopilotConfig(repo);
  return {
    mode: repoPolicy?.mode ?? global.mode,
    concurrency: mergeAutopilotConcurrency(
      global.concurrency,
      repoPolicy?.concurrency,
    ),
  };
}

export function repoAutopilotPolicyForWatch(
  repo: RepoConfig,
  appConfig: AppConfig,
  watch?: { id?: string | null; prNumber?: number | null },
): AutopilotPolicyConfig {
  const policy = repoAutopilotPolicy(repo, appConfig);
  if (!watch) return policy;

  const override = readRepoAutopilotConfig(repo)?.watchOverrides?.find(
    (candidate) =>
      Boolean(watch.id) &&
      candidate.watchId === watch.id &&
      candidate.prNumber === watch.prNumber,
  );
  return {
    ...policy,
    mode: override?.mode ?? policy.mode,
  };
}

export function pathDeniedByAutopilotPolicy(
  path: string,
  guardrails: RepoGuardrails,
) {
  return matchesAny(path, guardrails.deniedFileGlobs);
}

/** @deprecated Use mergeGuardrails. */
export const mergeAutopilotLimits = mergeGuardrails;
