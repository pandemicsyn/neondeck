import type { AutopilotMode } from '../../autopilot-policy';

const modeAuthority: Record<AutopilotMode, number> = {
  'notify-only': 0,
  'prepare-only': 1,
  'autofix-with-approval': 2,
  'autofix-push-when-safe': 3,
};

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
  configuredMode: AutopilotMode;
  guardrails: unknown;
  executionPolicy: unknown;
  worktreePolicy: unknown;
  learningPolicy: unknown;
}) {
  const effectiveMode = effectiveAutopilotOwnerMode(
    input.admissionMode,
    input.configuredMode,
  );
  return {
    admissionMode: input.admissionMode,
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
