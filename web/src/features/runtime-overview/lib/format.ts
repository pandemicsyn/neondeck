import type {
  ExecutionApproval,
  KiloTaskRecord,
  NotificationRecord,
  RepoEditEvent,
  RepoHealth,
  RuntimeStatusCheck,
  SafetyPolicy,
  SafetyPolicyEntry,
  WorkflowObservability,
  WorktreeRecord,
} from '../../../api';
import type { SetupStep } from '../types';

export function repoHealthStatus(health: RepoHealth | undefined) {
  if (!health) return { label: 'unknown', className: '' };
  if (health.error) {
    return { label: 'error', className: 'border-accent text-accent' };
  }
  if (health.dirty) {
    return {
      label: `${health.changeCount} dirty`,
      className: 'border-accent text-accent',
    };
  }
  if (health.behind && health.behind > 0) {
    return {
      label: `${health.behind} behind`,
      className: 'border-accent text-accent',
    };
  }
  if (health.ahead && health.ahead > 0) {
    return {
      label: `${health.ahead} ahead`,
      className: 'border-violet text-violet',
    };
  }
  return { label: 'clean', className: 'border-primary text-primary' };
}

export function checkClass(check: RuntimeStatusCheck) {
  if (check.ok) return 'border-primary text-primary';
  if (check.level === 'attention') return 'border-accent text-accent';
  return 'border-violet text-violet';
}

export function notificationClass(notification: NotificationRecord) {
  if (notification.level === 'urgent') return 'border-accent text-accent';
  if (notification.level === 'attention') return 'border-accent text-accent';
  if (notification.level === 'ready') return 'border-primary text-primary';
  return '';
}

export function executionApprovalClass(approval: ExecutionApproval) {
  if (approval.status === 'pending') return 'border-accent text-accent';
  if (approval.status === 'executed') return 'border-primary text-primary';
  if (approval.status === 'failed' || approval.status === 'blocked') {
    return 'border-accent text-accent';
  }
  return '';
}

export function repoEditEventClass(event: RepoEditEvent) {
  if (event.status === 'applied') return 'border-primary text-primary';
  if (event.status === 'failed' || event.status === 'blocked') {
    return 'border-accent text-accent';
  }
  if (event.status === 'preview') return 'border-violet text-violet';
  return '';
}

export function kiloTaskStatusClass(status: KiloTaskRecord['status']) {
  if (
    status === 'succeeded' ||
    status === 'ready-to-verify' ||
    status === 'ready-to-push'
  ) {
    return 'border-primary text-primary';
  }
  if (status === 'failed' || status === 'unknown') {
    return 'border-accent text-accent';
  }
  if (
    status === 'needs-reconcile' ||
    status === 'needs-review' ||
    status === 'discarded'
  ) {
    return 'border-violet text-violet';
  }
  if (status === 'running') return 'border-primary text-primary';
  return '';
}

export function worktreeStatusClass(status: WorktreeRecord['lifecycleStatus']) {
  if (status === 'ready' || status === 'succeeded') {
    return 'border-primary text-primary';
  }
  if (
    status === 'failed' ||
    status === 'needs-sync' ||
    status === 'stale' ||
    status === 'cleanup-pending'
  ) {
    return 'border-accent text-accent';
  }
  if (status === 'busy' || status === 'prepared-diff') {
    return 'border-violet text-violet';
  }
  return '';
}

export function setupStep(check: RuntimeStatusCheck): SetupStep {
  const docsBase = 'https://neondeck.dev/docs/getting-started/';
  const steps: Record<string, SetupStep> = {
    config: {
      action: 'neondeck_config_validate',
      docsHref: `${docsBase}#runtime-home`,
      docsLabel: 'runtime',
      surface: 'action',
      detail: 'Validate config.json or rerun setup for the runtime home.',
    },
    'repos-config': {
      action: 'neondeck_config_validate',
      docsHref: `${docsBase}#repositories`,
      docsLabel: 'repos',
      surface: 'action',
      detail: 'Repair repos.json before repo status, queues, or watches run.',
    },
    'schedules-config': {
      action: 'neondeck_config_validate',
      docsHref: `${docsBase}#commands`,
      docsLabel: 'commands',
      surface: 'action',
      detail: 'Repair schedules.json before scheduler jobs can load.',
    },
    skills: {
      action: 'neondeck_skills_reload',
      docsHref: `${docsBase}#runtime-skills`,
      docsLabel: 'skills',
      surface: 'action',
      detail: 'Fix ignored or invalid runtime skills, then reload skills.',
    },
    'session-context': {
      action: 'neondeck_session_start',
      docsHref: `${docsBase}#agent-models`,
      docsLabel: 'models',
      surface: 'action',
      detail:
        'Start a new session so changed config, models, skills, or memory apply.',
    },
    'kilo-key': {
      action: 'neondeck_config_update_provider',
      docsHref: `${docsBase}#secrets`,
      docsLabel: 'secrets',
      surface: 'config',
      detail: 'Set the Kilo API key environment reference or disable Kilo.',
    },
    'openai-key': {
      action: 'neondeck_config_update_provider',
      docsHref: `${docsBase}#secrets`,
      docsLabel: 'secrets',
      surface: 'config',
      detail: 'Set the OpenAI API key environment reference or disable OpenAI.',
    },
    'anthropic-key': {
      action: 'neondeck_config_update_provider',
      docsHref: `${docsBase}#secrets`,
      docsLabel: 'secrets',
      surface: 'config',
      detail:
        'Set the Anthropic API key environment reference or disable Anthropic.',
    },
    'github-token': {
      action: 'GITHUB_TOKEN',
      docsHref: `${docsBase}#secrets`,
      docsLabel: 'secrets',
      surface: 'env',
      detail: 'Set GitHub credentials before queues, checks, and watches run.',
    },
    'model-providers': {
      action: 'neondeck_config_update_agent_models',
      docsHref: `${docsBase}#agent-models`,
      docsLabel: 'models',
      surface: 'action',
      detail: 'Point model strings at registered, enabled providers.',
    },
    'execution-policy': {
      action: 'neondeck_config_update_execution_policy',
      docsHref: `${docsBase}#execution-approvals`,
      docsLabel: 'execution',
      surface: 'action',
      detail:
        'Enable at least one execution backend and keep approval policy explicit.',
    },
    repos: {
      action: 'neondeck_config_add_repo',
      docsHref: `${docsBase}#repositories`,
      docsLabel: 'repos',
      surface: 'action',
      detail:
        'Add a local checkout so queues, watches, and repo status have context.',
    },
    'flue-errors': {
      action: 'neondeck_workflow_summaries_lookup',
      docsHref: `${docsBase}#commands`,
      docsLabel: 'commands',
      surface: 'tool',
      detail:
        'Inspect recent workflow failures before trusting automation output.',
    },
    'app-db': {
      action: 'npm run setup',
      docsHref: `${docsBase}#runtime-home`,
      docsLabel: 'runtime',
      surface: 'shell',
      detail: 'Initialize or repair the Neondeck app database.',
    },
    'flue-db': {
      action: 'npm run setup',
      docsHref: `${docsBase}#runtime-home`,
      docsLabel: 'runtime',
      surface: 'shell',
      detail: 'Initialize or repair the Flue runtime database.',
    },
  };

  return (
    steps[check.id] ?? {
      action: 'neondeck_runtime_status_lookup',
      docsHref: `${docsBase}#runtime-home`,
      docsLabel: 'docs',
      surface: 'tool',
      detail:
        'Inspect the readiness message and update the related runtime config.',
    }
  );
}

export function safetyRank(entry: SafetyPolicyEntry) {
  if (entry.class === 'host-execution') return 0;
  if (entry.requiresConfirmation) return 1;
  if (entry.class === 'safe-mutation') return 2;
  return 3;
}

export function shortPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-3).join('/')}`;
}

export function formatUptime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatInterval(seconds: number) {
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export function relativeTime(value: string) {
  const delta = Date.now() - Date.parse(value);
  const minutes = Math.max(1, Math.round(delta / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function emptySafetyPolicy(fetchedAt: string): SafetyPolicy {
  return {
    ok: false,
    action: 'safety_policy_read',
    version: 0,
    summary: {
      readOnly: 0,
      safeMutation: 0,
      destructiveMutation: 0,
      hostExecution: 0,
      requiresConfirmation: 0,
      unattendedAllowed: 0,
      audited: 0,
    },
    confirmationPolicy: 'Safety policy could not be loaded.',
    hostExecutionPolicy: 'Host execution is unavailable.',
    executionPolicy: {
      defaultBackend: 'local',
      enabledBackends: [],
      supportedBackends: ['local', 'exe.dev'],
      approvalMode: 'manual',
      unattended: 'deny',
      preapprovedCommandCount: 0,
      defaultLocalAccess: false,
      exeDevPlanned: true,
    },
    entries: [],
    fetchedAt,
  };
}

export function emptyWorkflows(): WorkflowObservability {
  return {
    ok: true,
    action: 'workflow_observability_read',
    activeRuns: [],
    recentFailures: [],
    recentData: [],
    recentLogs: [],
    recentTools: [],
    recentOperations: [],
    recentEvents: [],
    fetchedAt: new Date().toISOString(),
  };
}
