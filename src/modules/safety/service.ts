import { executionPolicyFromConfig } from '../execution-policy';
import {
  type RuntimePaths,
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
} from '../../runtime-home';
import { entries } from './policy-entries';
import { type SafetyPolicy, type SafetyPolicyEntry } from './schemas';

export function readSafetyPolicy(
  paths: RuntimePaths = runtimePaths(),
): SafetyPolicy {
  ensureRuntimeHomeSync(paths);
  const execution = executionPolicyFromConfig(
    readRuntimeJsonSync(paths.config, parseAppConfig),
  );
  return {
    ok: true,
    action: 'safety_policy_read',
    version: 5,
    summary: summarizeEntries(entries),
    confirmationPolicy:
      'Destructive mutations require explicit user confirmation and action input confirm=true. Safe mutations should be user-directed and audited when they change durable state.',
    hostExecutionPolicy: `Host execution is action-mediated. Backends enabled by config: ${execution.enabledBackends.join(', ')}. Preapproved single commands may run without an interactive approval through neondeck_execution_run; all other interactive commands require approval and unattended commands default to deny. Hardline commands cannot be preapproved.`,
    executionPolicy: {
      defaultBackend: execution.defaultBackend,
      enabledBackends: execution.enabledBackends,
      supportedBackends: execution.supportedBackends,
      approvalMode: execution.approvalMode,
      unattended: execution.unattended,
      preapprovedCommandCount: execution.preapprovedCommands.length,
      defaultLocalAccess: execution.defaults.localAccess,
      exeDevPlanned: execution.defaults.exeDevPlanned,
    },
    entries,
    fetchedAt: new Date().toISOString(),
  };
}

export function summarizeEntries(
  items: SafetyPolicyEntry[],
): SafetyPolicy['summary'] {
  return {
    readOnly: items.filter((item) => item.class === 'read-only').length,
    safeMutation: items.filter((item) => item.class === 'safe-mutation').length,
    destructiveMutation: items.filter(
      (item) => item.class === 'destructive-mutation',
    ).length,
    hostExecution: items.filter((item) => item.class === 'host-execution')
      .length,
    requiresConfirmation: items.filter((item) => item.requiresConfirmation)
      .length,
    unattendedAllowed: items.filter((item) => item.unattended).length,
    audited: items.filter((item) => item.audited).length,
  };
}
