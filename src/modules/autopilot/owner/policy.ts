import type { DatabaseSync } from 'node:sqlite';
import type { AutopilotMode } from '../../autopilot-policy';
import { repoAutopilotPolicyForWatch } from '../../autopilot-policy';
import { repoGuardrails } from '../../repo-guardrails';
import {
  parseRepoRegistry,
  type AppConfig,
  type RepoGuardrails,
} from '../../../runtime-home';
import type { AutopilotAdmission } from '../coordination/schemas';
import * as v from 'valibot';
import {
  classifyAutopilotOwnerConfigChange,
  stableJsonHash,
} from './grounding';

const modeAuthority: Record<AutopilotMode, number> = {
  'notify-only': 0,
  'prepare-only': 1,
  'autofix-with-approval': 2,
  'autofix-push-when-safe': 3,
};
const autopilotModeSchema = v.picklist([
  'notify-only',
  'prepare-only',
  'autofix-with-approval',
  'autofix-push-when-safe',
]);
const configHistoryAuthorityRowSchema = v.looseObject({
  id: v.number(),
  action: v.string(),
  target: v.nullable(v.string()),
  after_json: v.nullable(v.string()),
});
const durableAuthorityRowSchema = v.object({
  authority_mode: autopilotModeSchema,
  policy_config_history_id: v.number(),
  authority_policy_json: v.nullable(v.string()),
});
const authorityPolicySchema = v.strictObject({
  guardrails: v.object({
    maxFilesChanged: v.number(),
    maxLinesChanged: v.number(),
    deniedFileGlobs: v.array(v.string()),
    approvalRequiredFileGlobs: v.array(v.string()),
    requiredChecks: v.array(v.string()),
    allowedPushDestinations: v.array(v.string()),
    allowForcePush: v.boolean(),
    highRiskClasses: v.array(v.string()),
    generatedFileSizeThresholdBytes: v.number(),
  }),
  diagnosticCommands: v.array(v.string()),
  transitionHash: v.string(),
});

export function initialAutopilotAdmissionAuthority(
  guardrails: RepoGuardrails,
  input: {
    configHistoryId: number;
    mode: AutopilotMode;
    repoId: string;
    watchId: string;
  },
) {
  return {
    guardrails,
    diagnosticCommands: normalizeCommands(guardrails.requiredChecks),
    transitionHash: stableJsonHash({
      kind: 'autopilot-admission-authority',
      configHistoryId: input.configHistoryId,
      mode: input.mode,
      repoId: input.repoId,
      watchId: input.watchId,
    }),
  };
}

/** Never grant more authority than either admission-time or current policy. */
export function effectiveAutopilotOwnerMode(
  admissionMode: AutopilotMode,
  configuredMode: AutopilotMode,
): AutopilotMode {
  return modeAuthority[admissionMode] <= modeAuthority[configuredMode]
    ? admissionMode
    : configuredMode;
}

export function autopilotOwnerPolicySnapshot(input: {
  admissionMode: AutopilotMode;
  authorityMode?: AutopilotMode;
  configuredMode: AutopilotMode;
  guardrails: unknown;
  executionPolicy: unknown;
  worktreePolicy: unknown;
  learningPolicy: unknown;
  diagnosticCommands: string[];
  authorityTransitionHash?: string;
}) {
  const effectiveMode = effectiveAutopilotOwnerMode(
    input.authorityMode ?? input.admissionMode,
    input.configuredMode,
  );
  return {
    admissionMode: input.admissionMode,
    authorityMode: input.authorityMode ?? input.admissionMode,
    currentConfiguredMode: input.configuredMode,
    effectiveMode,
    guardrails: input.guardrails,
    executionPolicy: input.executionPolicy,
    worktreePolicy: input.worktreePolicy,
    learningPolicy: input.learningPolicy,
    diagnosticCommands: input.diagnosticCommands,
    authorityTransitionHash: input.authorityTransitionHash ?? null,
    fixAllowed: effectiveMode !== 'notify-only',
    localCommit:
      effectiveMode === 'autofix-with-approval' ||
      effectiveMode === 'autofix-push-when-safe',
    pushAllowedInThisTurn: false,
  };
}

export function constrainAutopilotAdmissionAuthority(
  database: DatabaseSync,
  input: {
    admission: AutopilotAdmission;
    repoId: string;
    watchId: string;
    prNumber: number;
    appConfig: AppConfig;
    currentConfiguredMode: AutopilotMode;
    currentGuardrails: RepoGuardrails;
  },
) {
  const rows = database
    .prepare(
      `SELECT id, action, target, after_json FROM config_history
       WHERE id > ? ORDER BY id ASC;`,
    )
    .all(input.admission.policyConfigHistoryId)
    .map((row) => v.parse(configHistoryAuthorityRowSchema, row));
  let authorityMode = input.admission.authorityMode;
  const stored = readStoredAuthorityPolicy(database, input.admission.id);
  let authorityGuardrails = stored?.guardrails ?? input.currentGuardrails;
  let diagnosticCommands =
    stored?.diagnosticCommands ??
    normalizeCommands(input.currentGuardrails.requiredChecks);
  let transitionHash = stored?.transitionHash ?? stableJsonHash('initial');
  let historyId = input.admission.policyConfigHistoryId;
  for (const row of rows) {
    const drift = classifyAutopilotOwnerConfigChange(row, input.repoId);
    if (drift === 'block' || drift === 'rotate') break;
    historyId = row.id;
    if (
      row.action !== 'config_update_repo_autopilot_policy' ||
      row.target !== input.repoId
    ) {
      if (policyAuthorityChangeApplies(row, input.repoId)) {
        transitionHash = stableJsonHash({
          previous: transitionHash,
          id: row.id,
          action: row.action,
          target: row.target,
          after: row.after_json,
        });
        const historicalGuardrails = guardrailsFromHistory(row, input);
        if (historicalGuardrails) {
          authorityGuardrails = intersectGuardrails(
            authorityGuardrails,
            historicalGuardrails,
          );
          diagnosticCommands = intersectCommands(
            diagnosticCommands,
            historicalGuardrails.requiredChecks,
          );
        }
      }
      continue;
    }
    authorityMode = minimumAutopilotMode(
      authorityMode,
      configuredModeFromHistory(row.after_json, input),
    );
    transitionHash = stableJsonHash({
      previous: transitionHash,
      id: row.id,
      action: row.action,
      target: row.target,
      after: row.after_json,
    });
    const historicalGuardrails = guardrailsFromHistory(row, input);
    if (historicalGuardrails) {
      authorityGuardrails = intersectGuardrails(
        authorityGuardrails,
        historicalGuardrails,
      );
      diagnosticCommands = intersectCommands(
        diagnosticCommands,
        historicalGuardrails.requiredChecks,
      );
    }
  }
  authorityMode = minimumAutopilotMode(
    authorityMode,
    input.currentConfiguredMode,
  );
  authorityGuardrails = intersectGuardrails(
    authorityGuardrails,
    input.currentGuardrails,
  );
  diagnosticCommands = intersectCommands(
    diagnosticCommands,
    input.currentGuardrails.requiredChecks,
  );
  database
    .prepare(
      `UPDATE autopilot_admissions
       SET authority_mode = ?, policy_config_history_id = ?,
           authority_policy_json = ?, updated_at = updated_at
       WHERE id = ? AND COALESCE(authority_mode, mode) = ?
         AND policy_config_history_id = ?;`,
    )
    .run(
      authorityMode,
      historyId,
      JSON.stringify({
        guardrails: authorityGuardrails,
        diagnosticCommands,
        transitionHash,
      }),
      input.admission.id,
      input.admission.authorityMode,
      input.admission.policyConfigHistoryId,
    );
  const durable = v.parse(
    durableAuthorityRowSchema,
    database
      .prepare(
        `SELECT COALESCE(authority_mode, mode) AS authority_mode,
              policy_config_history_id, authority_policy_json
       FROM autopilot_admissions WHERE id = ?;`,
      )
      .get(input.admission.id),
  );
  const durablePolicy = parseAuthorityPolicy(durable.authority_policy_json);
  return {
    authorityMode: durable.authority_mode,
    policyConfigHistoryId: durable.policy_config_history_id,
    guardrails: durablePolicy.guardrails,
    diagnosticCommands: durablePolicy.diagnosticCommands,
    transitionHash: durablePolicy.transitionHash,
  };
}

function readStoredAuthorityPolicy(
  database: DatabaseSync,
  admissionId: string,
) {
  const row = database
    .prepare(
      'SELECT authority_policy_json FROM autopilot_admissions WHERE id = ?;',
    )
    .get(admissionId) as { authority_policy_json?: unknown } | undefined;
  return typeof row?.authority_policy_json === 'string'
    ? parseAuthorityPolicy(row.authority_policy_json)
    : null;
}

function parseAuthorityPolicy(value: string | null) {
  if (value === null) throw new Error('Admission authority policy is missing.');
  return v.parse(authorityPolicySchema, JSON.parse(value));
}

function policyAuthorityChangeApplies(
  row: v.InferOutput<typeof configHistoryAuthorityRowSchema>,
  repoId: string,
) {
  return (
    (row.action === 'config_update_repo_autopilot_policy' &&
      row.target === repoId) ||
    [
      'config_update_execution_policy',
      'config_update_learning',
      'config_update_worktree_policy',
    ].includes(row.action)
  );
}

function guardrailsFromHistory(
  row: v.InferOutput<typeof configHistoryAuthorityRowSchema>,
  input: { repoId: string; appConfig: AppConfig },
) {
  if (
    row.action !== 'config_update_repo_autopilot_policy' ||
    row.target !== input.repoId ||
    row.after_json === null
  ) {
    return null;
  }
  try {
    const registry = parseRepoRegistry(
      JSON.parse(row.after_json),
      'config_history.after_json',
    );
    const repo = registry.repos.find(
      (candidate) => candidate.id === input.repoId,
    );
    return repo ? repoGuardrails(repo, input.appConfig) : null;
  } catch {
    return null;
  }
}

function intersectGuardrails(
  left: RepoGuardrails,
  right: RepoGuardrails,
): RepoGuardrails {
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();
  return {
    maxFilesChanged: Math.min(left.maxFilesChanged, right.maxFilesChanged),
    maxLinesChanged: Math.min(left.maxLinesChanged, right.maxLinesChanged),
    deniedFileGlobs: union(left.deniedFileGlobs, right.deniedFileGlobs),
    approvalRequiredFileGlobs: union(
      left.approvalRequiredFileGlobs,
      right.approvalRequiredFileGlobs,
    ),
    requiredChecks: union(left.requiredChecks, right.requiredChecks),
    allowedPushDestinations: left.allowedPushDestinations
      .filter((destination) =>
        right.allowedPushDestinations.includes(destination),
      )
      .sort(),
    allowForcePush: left.allowForcePush && right.allowForcePush,
    highRiskClasses: union(left.highRiskClasses, right.highRiskClasses),
    generatedFileSizeThresholdBytes: Math.min(
      left.generatedFileSizeThresholdBytes,
      right.generatedFileSizeThresholdBytes,
    ),
  };
}

function normalizeCommands(commands: string[]) {
  return [
    ...new Set(commands.map((command) => command.trim()).filter(Boolean)),
  ].sort();
}

function intersectCommands(left: string[], right: string[]) {
  const allowed = new Set(normalizeCommands(right));
  return normalizeCommands(left).filter((command) => allowed.has(command));
}

function configuredModeFromHistory(
  afterJson: string | null,
  input: {
    repoId: string;
    watchId: string;
    prNumber: number;
    appConfig: AppConfig;
    currentConfiguredMode: AutopilotMode;
  },
): AutopilotMode {
  if (afterJson === null) return input.currentConfiguredMode;
  try {
    const registry = parseRepoRegistry(
      JSON.parse(afterJson ?? 'null'),
      'config_history.after_json',
    );
    const repo = registry.repos.find(
      (candidate) => candidate.id === input.repoId,
    );
    if (!repo) return 'notify-only';
    return repoAutopilotPolicyForWatch(repo, input.appConfig, {
      id: input.watchId,
      prNumber: input.prNumber,
    }).mode;
  } catch {
    return 'notify-only';
  }
}

function minimumAutopilotMode(
  left: AutopilotMode,
  right: AutopilotMode,
): AutopilotMode {
  return modeAuthority[left] <= modeAuthority[right] ? left : right;
}
