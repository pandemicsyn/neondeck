import type { AutopilotMode } from '../../autopilot-policy';
import {
  autopilotAdmissionStates,
  type AutopilotAdmissionState,
  type AutopilotStage,
} from './schemas';

export const terminalAutopilotAdmissionStates = [
  'archived',
  'completed',
  'manual-review',
  'stopped',
  'superseded',
] as const satisfies readonly AutopilotAdmissionState[];

export const activeAutopilotAttemptStatuses = ['reserved', 'running'] as const;

export const legalAutopilotTransitions = {
  'triage-admitted': [
    'triaged',
    'completed',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
    'superseded',
  ],
  triaged: [
    'prepare-admitted',
    'completed',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
    'superseded',
  ],
  'prepare-admitted': [
    'prepared',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
    'superseded',
  ],
  prepared: [
    'owner-turn-admitted',
    'completed',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
    'superseded',
  ],
  'owner-turn-admitted': [
    'prepared',
    'owner-turn-running',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
    'superseded',
  ],
  'owner-turn-running': [
    'fix-prepared',
    'completed',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
    'superseded',
  ],
  'fix-prepared': [
    'verify-admitted',
    'approval-pending',
    'completed',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
    'superseded',
  ],
  'verify-admitted': [
    'verified',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
    'superseded',
  ],
  verified: [
    'approval-pending',
    'push-admitted',
    'completed',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
    'superseded',
  ],
  'approval-pending': [
    'push-admitted',
    'blocked',
    'manual-review',
    'stopped',
    'superseded',
  ],
  'push-admitted': [
    'pushed',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
    'superseded',
  ],
  pushed: [
    'comment-admitted',
    'completed',
    'cleanup-pending',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
  ],
  'comment-admitted': [
    'completed',
    'cleanup-pending',
    'blocked',
    'manual-review',
    'failed',
    'stopped',
  ],
  completed: ['cleanup-pending', 'archived'],
  'cleanup-pending': ['archived', 'blocked', 'manual-review', 'failed'],
  archived: [],
  blocked: [
    'triage-admitted',
    'prepare-admitted',
    'owner-turn-admitted',
    'verify-admitted',
    'push-admitted',
    'comment-admitted',
    'cleanup-pending',
    'manual-review',
    'stopped',
    'superseded',
  ],
  'manual-review': [
    'triage-admitted',
    'prepare-admitted',
    'owner-turn-admitted',
    'verify-admitted',
    'push-admitted',
    'comment-admitted',
    'cleanup-pending',
    'stopped',
    'superseded',
  ],
  failed: [
    'triage-admitted',
    'prepare-admitted',
    'owner-turn-admitted',
    'verify-admitted',
    'push-admitted',
    'comment-admitted',
    'cleanup-pending',
    'blocked',
    'manual-review',
    'stopped',
    'superseded',
  ],
  stopped: ['cleanup-pending', 'archived'],
  superseded: ['cleanup-pending', 'archived'],
} as const satisfies Record<
  AutopilotAdmissionState,
  readonly AutopilotAdmissionState[]
>;

export const autopilotStageRegistry = {
  triage: {
    workflow: 'triage-pr-event',
    admittedState: 'triage-admitted',
    transport: 'workflow',
  },
  'prepare-worktree': {
    workflow: 'prepare-pr-worktree',
    admittedState: 'prepare-admitted',
    transport: 'workflow',
  },
  'owner-turn': {
    workflow: null,
    admittedState: 'owner-turn-admitted',
    transport: 'agent-dispatch',
  },
  verify: {
    workflow: 'verify-pr-worktree',
    admittedState: 'verify-admitted',
    transport: 'workflow',
  },
  push: {
    workflow: 'push-pr-autofix',
    admittedState: 'push-admitted',
    transport: 'workflow',
  },
  'comment-result': {
    workflow: 'comment-pr-autofix-result',
    admittedState: 'comment-admitted',
    transport: 'workflow',
  },
  cleanup: {
    workflow: 'cleanup-autopilot-worktree',
    admittedState: 'cleanup-pending',
    transport: 'workflow',
  },
} as const satisfies Record<
  AutopilotStage,
  {
    workflow: string | null;
    admittedState: AutopilotAdmissionState;
    transport: 'workflow' | 'agent-dispatch';
  }
>;

export const autopilotModeProgression = {
  'notify-only': {
    ownerTurn: false,
    localCommit: false,
    verify: false,
    approval: false,
    push: false,
    comment: false,
  },
  'prepare-only': {
    ownerTurn: true,
    localCommit: false,
    verify: 'optional',
    approval: false,
    push: false,
    comment: false,
  },
  'autofix-with-approval': {
    ownerTurn: true,
    localCommit: true,
    verify: true,
    approval: true,
    push: 'after-approval',
    comment: true,
  },
  'autofix-push-when-safe': {
    ownerTurn: true,
    localCommit: true,
    verify: true,
    approval: 'policy-only',
    push: 'when-safe',
    comment: true,
  },
} as const satisfies Record<AutopilotMode, Record<string, unknown>>;

export function isLegalAutopilotTransition(
  from: AutopilotAdmissionState,
  to: AutopilotAdmissionState,
) {
  return (legalAutopilotTransitions[from] as readonly string[]).includes(to);
}

export function isTerminalAutopilotAdmissionState(
  state: AutopilotAdmissionState,
) {
  return (terminalAutopilotAdmissionStates as readonly string[]).includes(
    state,
  );
}

export function assertExhaustiveTransitionTable() {
  const tableStates = Object.keys(legalAutopilotTransitions).sort();
  const schemaStates = [...autopilotAdmissionStates].sort();
  if (JSON.stringify(tableStates) !== JSON.stringify(schemaStates)) {
    throw new Error('Autopilot transition table does not cover every state.');
  }
}
