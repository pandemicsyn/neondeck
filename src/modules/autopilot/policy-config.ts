/* eslint-disable no-unused-vars */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { gitDiff, type RepoDiffFile } from '../../repo-edit/git';
import {
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
  type AppConfig,
  type RepoConfig,
  type RuntimePaths,
} from '../../runtime-home';
import { listWorktrees } from '../../worktrees';
import {
  appAutopilotSchema,
  defaultAutopilotConcurrency,
  defaultAutopilotPolicyLimits,
  metadataSchema,
  modeAliasMap,
  type AutopilotConcurrencyPolicy,
  type AutopilotMode,
  type AutopilotModeAlias,
  type AutopilotPolicyConfig,
  type AutopilotPolicyLimits,
  type RepoAutopilotConfig,
} from './policy-schemas';
import { matchesAny } from './policy-risk';

export function normalizeAutopilotMode(
  mode: AutopilotMode | AutopilotModeAlias,
): AutopilotMode {
  if (mode in modeAliasMap) return modeAliasMap[mode as AutopilotModeAlias];
  return mode as AutopilotMode;
}

export function mergeAutopilotLimits(
  base: AutopilotPolicyLimits,
  override: Partial<AutopilotPolicyLimits> | undefined,
): AutopilotPolicyLimits {
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
    mode: normalizeAutopilotMode(
      raw?.defaultMode ?? raw?.mode ?? 'notify-only',
    ),
    limits: mergeAutopilotLimits(defaultAutopilotPolicyLimits, raw?.limits),
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
    mode: repoPolicy?.mode
      ? normalizeAutopilotMode(repoPolicy.mode)
      : global.mode,
    limits: mergeAutopilotLimits(global.limits, repoPolicy?.limits),
    concurrency: mergeAutopilotConcurrency(
      global.concurrency,
      repoPolicy?.concurrency,
    ),
  };
}

export function pathDeniedByAutopilotPolicy(
  path: string,
  limits: AutopilotPolicyLimits,
) {
  return matchesAny(path, limits.deniedFileGlobs);
}
