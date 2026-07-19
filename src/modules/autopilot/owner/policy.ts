import type { DatabaseSync } from 'node:sqlite';
import type { AutopilotMode } from '../../autopilot-policy';
import { repoAutopilotPolicyForWatch } from '../../autopilot-policy';
import { parseRepoRegistry, type AppConfig } from '../../../runtime-home';
import type { AutopilotAdmission } from '../coordination/schemas';
import * as v from 'valibot';

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
});

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
  for (const row of rows) {
    if (
      row.action !== 'config_update_repo_autopilot_policy' ||
      row.target !== input.repoId
    ) {
      continue;
    }
    authorityMode = minimumAutopilotMode(
      authorityMode,
      configuredModeFromHistory(row.after_json, input),
    );
  }
  authorityMode = minimumAutopilotMode(
    authorityMode,
    input.currentConfiguredMode,
  );
  const historyId = rows.at(-1)?.id ?? input.admission.policyConfigHistoryId;
  database
    .prepare(
      `UPDATE autopilot_admissions
       SET authority_mode = ?, policy_config_history_id = ?, updated_at = updated_at
       WHERE id = ? AND COALESCE(authority_mode, mode) = ?
         AND policy_config_history_id = ?;`,
    )
    .run(
      authorityMode,
      historyId,
      input.admission.id,
      input.admission.authorityMode,
      input.admission.policyConfigHistoryId,
    );
  const durable = v.parse(
    durableAuthorityRowSchema,
    database
      .prepare(
        `SELECT COALESCE(authority_mode, mode) AS authority_mode,
              policy_config_history_id
       FROM autopilot_admissions WHERE id = ?;`,
      )
      .get(input.admission.id),
  );
  return {
    authorityMode: durable.authority_mode,
    policyConfigHistoryId: durable.policy_config_history_id,
  };
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
