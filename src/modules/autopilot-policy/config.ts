import * as v from 'valibot';
import { type AppConfig, type RepoConfig } from '../../runtime-home';
import {
  appAutopilotSchema,
  autopilotConcurrencySchema,
  defaultAutopilotConcurrency,
  modeSchema,
  nonEmptyStringSchema,
  watchOverrideSchema,
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

const repoAutopilotConfigInputSchema = v.looseObject({
  mode: v.optional(modeSchema),
  reason: v.optional(nonEmptyStringSchema),
  concurrency: v.optional(autopilotConcurrencySchema),
  watchOverrides: v.optional(v.array(v.unknown())),
});

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
  appConfig: v.InferInput<typeof appAutopilotSchema>,
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
  const autopilot = v.safeParse(
    v.optional(repoAutopilotConfigInputSchema),
    repo.metadata.autopilot,
  );
  if (!autopilot.success || !autopilot.output) return undefined;
  const { watchOverrides: rawWatchOverrides, ...config } = autopilot.output;
  const watchOverrides = (rawWatchOverrides ?? []).flatMap((value) => {
    const parsed = v.safeParse(watchOverrideSchema, value);
    return parsed.success ? [parsed.output] : [];
  });
  if (rawWatchOverrides === undefined) return config;
  return { ...config, watchOverrides };
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
      (watch.id && candidate.watchId === watch.id) ||
      (watch.prNumber !== undefined &&
        watch.prNumber !== null &&
        candidate.prNumber === watch.prNumber),
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
