import type { DashboardConfig } from './types';

export type GitHubPullRequest = {
  id: number;
  title: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  draft?: boolean;
  author: string;
  labels: string[];
  comments: number;
  updatedAt: string;
  createdAt: string;
  relations: Array<
    'authored' | 'assigned' | 'review-requested' | 'configured-repo'
  >;
  ageDays: number;
  stale: boolean;
  headSha: string | null;
  baseRef: string | null;
  checks: {
    status: 'success' | 'failure' | 'pending' | 'none';
    total: number;
    successful: number;
    failed: number;
    pending: number;
    statusContexts: number;
    checkedAt: string;
  } | null;
  checkError?: string;
};

export type GitHubQueueIssue = {
  type:
    | 'search-truncated'
    | 'search-error'
    | 'enrichment-error'
    | 'queue-truncated';
  message: string;
  query?: string;
  repo?: string;
  number?: number;
};

export type GitHubPullRequestResponse = {
  login?: string;
  repos?: string[];
  items: GitHubPullRequest[];
  fetchedAt?: string;
  truncated?: boolean;
  issues?: GitHubQueueIssue[];
  error?: string;
};

export type RepoConfig = {
  id: string;
  github: {
    owner: string;
    name: string;
  };
  path: string;
  defaultBranch: string;
  worktreeRoot?: 'home' | 'repo-local';
  productionTarget?: string;
  packageScripts?: Record<string, string>;
  metadata?: Record<string, unknown>;
  watchRules?: unknown[];
  activeWorktrees?: WorktreeLink[];
};

export type WorktreeLink = Pick<
  WorktreeRecord,
  | 'id'
  | 'prNumber'
  | 'headRef'
  | 'headSha'
  | 'localPath'
  | 'lifecycleStatus'
  | 'adopted'
  | 'updatedAt'
>;

export type RepoRegistryResponse = {
  home: string;
  path: string;
  repos: RepoConfig[];
  count: number;
  fetchedAt: string;
};

export type RepoHealth = {
  id: string;
  repo: string;
  path: string;
  branch: string | null;
  defaultBranch: string;
  dirty: boolean;
  changeCount: number;
  ahead: number | null;
  behind: number | null;
  changes: string[];
  error?: string;
};

export type RepoHealthResponse = {
  home: string;
  path: string;
  repos: RepoHealth[];
  attention: RepoHealth[];
  count: number;
  fetchedAt: string;
};

export type RuntimeHealth = {
  ok: boolean;
  service: string;
  home: string;
  uptimeSeconds: number;
};

export type ConfigChangeEvent = {
  id: string;
  action: string;
  changed: boolean;
  home: string;
  files: string[];
  target: string | null;
  changedAt: string;
};

export type RuntimeStatusCheck = {
  id: string;
  label: string;
  ok: boolean;
  level: 'ready' | 'needs-config' | 'attention';
  message: string;
};

export type RuntimeStatus = {
  ok: boolean;
  status: 'ready' | 'needs-config' | 'attention';
  service: string;
  home: string;
  paths: {
    env: string;
    config: string;
    repos: string;
    schedules: string;
    dashboard: string;
    skills: string;
    worktrees: string;
    neondeckDatabase: string;
    flueDatabase: string;
  };
  uptimeSeconds: number;
  providers: {
    registered: string[];
    credentials: {
      kilo: boolean;
      openai: boolean;
      anthropic: boolean;
      github: boolean;
    };
    configs: {
      kilocode: {
        enabled: boolean;
        apiKeyEnv: string;
        organizationIdEnv: string | null;
        apiKeyPresent: boolean;
        organizationIdPresent: boolean;
      };
      openai: {
        enabled: boolean;
        apiKeyEnv: string;
        apiKeyPresent: boolean;
      };
      anthropic: {
        enabled: boolean;
        apiKeyEnv: string;
        apiKeyPresent: boolean;
      };
    };
  };
  models: {
    displayAssistant: string;
    displayAssistantProvider: string;
    displayAssistantThinkingLevel: string;
    utility: string;
    utilityProvider: string;
    utilityThinkingLevel: string;
    utilityConfigured: boolean;
    utilityRecommendation: string | null;
    subagents: Record<string, string>;
    subagentThinkingLevels: Record<string, string>;
  };
  execution: {
    defaultBackend: string;
    enabledBackends: string[];
    supportedBackends: string[];
    approvalMode: string;
    unattended: string;
    preapprovedCommandCount: number;
  };
  session: {
    id: string;
    label: string;
    stale: boolean;
    staleReasons: Array<{
      type: 'config' | 'memory';
      message: string;
      changedAt: string;
      target: string | null;
    }>;
    activatedAt: string;
  };
  counts: {
    repos: number;
    activeSchedules: number;
    activeJobs: number;
    activeWatches: number;
    activeSkills: number;
    duplicateSkills: number;
    ignoredSkills: number;
    failedWorkflowSummaries: number;
    flueFailureNotifications: number;
    activeWorktrees: number;
    staleWorktreeLocks: number;
    worktreeCleanupFailures: number;
  };
  checks: RuntimeStatusCheck[];
  lastFlueErrors: Array<{
    id: string;
    source: 'workflow-summary' | 'notification';
    title: string;
    message: string;
    runId: string | null;
    createdAt: string;
  }>;
  fetchedAt: string;
};

export type ExecutionApproval = {
  id: string;
  command: string;
  backend: 'local' | 'exe.dev';
  cwd: string | null;
  context: 'interactive' | 'unattended';
  risk: 'read-only' | 'safe-mutation' | 'destructive-mutation' | 'hardline';
  policyDecision: 'allow' | 'ask' | 'deny';
  status: 'pending' | 'approved' | 'denied' | 'executed' | 'failed' | 'blocked';
  approvalDecision:
    | 'preapproved'
    | 'allow-once'
    | 'allow-session'
    | 'allow-always'
    | 'deny'
    | null;
  approverSurface: string | null;
  sessionId: string | null;
  requestContext: unknown;
  result: unknown;
  exitCode: number | null;
  stdoutPreview: string | null;
  stderrPreview: string | null;
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
  executedAt: string | null;
  updatedAt: string;
};

export type ExecutionApprovalsResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  approvals: ExecutionApproval[];
  fetchedAt: string;
};

export type RepoEditEvent = {
  id: string;
  repoId: string;
  worktreeId: string | null;
  sessionId: string | null;
  workflowRunId: string | null;
  actorType: string;
  actorId: string | null;
  action: string;
  status: 'preview' | 'applied' | 'failed' | 'blocked';
  reason: string | null;
  paths: string[];
  inputHash: string | null;
  diffSummary: unknown;
  diffPatch: string | null;
  error: unknown;
  createdAt: string;
  updatedAt: string;
};

export type RepoEditEventsResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  events: RepoEditEvent[];
  fetchedAt: string;
};

export type WorktreeRecord = {
  id: string;
  repoId: string;
  repoFullName: string;
  githubOwner: string;
  githubName: string;
  prNumber: number | null;
  baseRef: string;
  headOwner: string | null;
  headName: string | null;
  headRef: string;
  headSha: string | null;
  localPath: string;
  storageKind: 'home' | 'repo-local';
  owningWorkflowRunId: string | null;
  lifecycleStatus:
    | 'creating'
    | 'ready'
    | 'busy'
    | 'stale'
    | 'needs-sync'
    | 'failed'
    | 'prepared-diff'
    | 'succeeded'
    | 'cleanup-pending'
    | 'deleted';
  lastSyncedSha: string | null;
  lastPushedSha: string | null;
  cleanupPolicy: {
    retainFailed: boolean;
    retainPreparedDiff: boolean;
    successfulGraceHours: number;
    staleAgeHours: number;
  };
  directPushAllowed: boolean;
  adopted: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type WorktreeLockRecord = {
  id: string;
  scope: 'worktree' | 'pr';
  scopeKey: string;
  worktreeId: string | null;
  repoId: string;
  prNumber: number | null;
  owner: string;
  workflowRunId: string | null;
  expiresAt: string;
  releasedAt: string | null;
  staleRecoveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorktreeCleanupFailure = {
  id: string;
  worktreeId: string;
  repoId: string;
  action: string;
  outcome: string;
  reason: string;
  error: string | null;
  deleted: boolean;
  attemptedAt: string;
};

export type WorktreesResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  worktrees: WorktreeRecord[];
  activeLocks: WorktreeLockRecord[];
  staleLocks: WorktreeLockRecord[];
  cleanupFailures: WorktreeCleanupFailure[];
  fetchedAt: string;
};

export type AutopilotMode =
  | 'notify-only'
  | 'prepare-only'
  | 'autofix-with-approval'
  | 'autofix-push-when-safe';

export type AutopilotPolicyLimits = {
  maxFilesChanged: number;
  maxLinesChanged: number;
  deniedFileGlobs: string[];
  approvalRequiredFileGlobs: string[];
  requiredChecks: string[];
  allowedPushDestinations: string[];
  allowForcePush: boolean;
  highRiskClasses: string[];
};

export type AutopilotQueueItem = {
  id: string;
  source: 'watch' | 'worktree' | 'workflow' | 'approval';
  status:
    | 'watching'
    | 'queued'
    | 'running'
    | 'prepared'
    | 'waiting-approval'
    | 'blocked';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  repoId: string;
  repoFullName: string;
  prNumber: number | null;
  title: string;
  mode: AutopilotMode;
  reason: string;
  nextStep: string;
  worktreeId: string | null;
  runId: string | null;
  updatedAt: string;
};

export type AutopilotRepoPolicy = {
  repoId: string;
  repoFullName: string;
  mode: AutopilotMode;
  source: 'global-default' | 'repo-metadata';
  reason: string;
  limits: AutopilotPolicyLimits;
};

export type AutopilotWatchPolicy = {
  watchId: string;
  repoId: string;
  repoFullName: string;
  prNumber: number;
  mode: AutopilotMode;
  source: 'repo-policy' | 'watch-override';
  reason: string;
};

export type AutopilotPreparedDiff = {
  id: string;
  repoId: string;
  repoFullName: string;
  prNumber: number | null;
  worktreeId: string;
  localPath: string;
  title: string;
  status: string;
  sourceOfTruth: 'worktree';
  summary: string;
  updatedAt: string;
};

export type AutopilotApproval = {
  id: string;
  repoId: string | null;
  repoFullName: string | null;
  prNumber: number | null;
  command: string;
  risk: string;
  status: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
};

export type AutopilotRunningCheck = {
  id: string;
  runId: string;
  workflow: string;
  repoId: string | null;
  repoFullName: string | null;
  prNumber: number | null;
  status: 'running';
  startedAt: string;
  lastEventAt: string;
  lastMessage: string;
  runUrl: string;
};

export type AutopilotActivity = {
  id: string;
  type: 'workflow' | 'worktree' | 'notification';
  level: NotificationLevel | 'info' | 'attention';
  title: string;
  message: string;
  repoId: string | null;
  repoFullName: string | null;
  prNumber: number | null;
  createdAt: string;
};

export type AutopilotState = {
  ok: boolean;
  action: 'autopilot_state_read';
  changed: boolean;
  modeLabels: Record<AutopilotMode, string>;
  summary: {
    activeWatches: number;
    queuedItems: number;
    preparedDiffs: number;
    pendingApprovals: number;
    runningChecks: number;
    recentActivity: number;
    placeholderAdapters: string[];
  };
  queue: AutopilotQueueItem[];
  policies: {
    global: {
      mode: AutopilotMode;
      limits: AutopilotPolicyLimits;
    };
    repos: AutopilotRepoPolicy[];
    watches: AutopilotWatchPolicy[];
  };
  preparedDiffs: AutopilotPreparedDiff[];
  pendingApprovals: AutopilotApproval[];
  runningChecks: AutopilotRunningCheck[];
  recentActivity: AutopilotActivity[];
  fetchedAt: string;
};

export type ConfigActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  home: string;
  files: string[];
  data?: unknown;
  errors?: string[];
  requires?: string[];
};

export type AgentModelUpdate = {
  displayAssistant?: string;
  displayAssistantThinkingLevel?: string;
  utility?: string | null;
  utilityThinkingLevel?: string;
  subagents?: {
    defaultThinkingLevel?: string;
    repoResearcher?: string;
    repoResearcherThinkingLevel?: string;
    ciInvestigator?: string;
    ciInvestigatorThinkingLevel?: string;
    releaseReviewer?: string;
    releaseReviewerThinkingLevel?: string;
  };
};

export type ProviderUpdate = {
  enabled?: boolean;
  apiKeyEnv?: string | null;
  organizationIdEnv?: string | null;
};

export type NeonSessionRecord = {
  id: string;
  label: string;
  agentName: string;
  status: 'active' | 'archived';
  reason: string | null;
  createdAt: string;
  activatedAt: string;
  endedAt: string | null;
  updatedAt: string;
};

export type ChatSessionKind =
  'main' | 'scratch' | 'general' | 'repo' | 'watch' | 'task' | 'briefing';

export type ChatSessionRecord = {
  id: string;
  title: string;
  agentName: string;
  kind: ChatSessionKind;
  pinned: boolean;
  archivedAt: string | null;
  linkedRepoId: string | null;
  linkedWatchId: string | null;
  linkedTaskId: string | null;
  staleReasons: Array<{
    type: 'config' | 'memory';
    message: string;
    changedAt: string;
    target: string | null;
  }>;
  uiMetadata: unknown;
  summary: string | null;
  contextLoadedAt: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
};

export type NeonSessionState = {
  ok: boolean;
  action: 'session_status';
  activeSession: NeonSessionRecord;
  activeChatSession: ChatSessionRecord;
  activeSessionId: string;
  surface: string;
  stale: boolean;
  staleReasons: Array<{
    type: 'config' | 'memory';
    message: string;
    changedAt: string;
    target: string | null;
  }>;
  history: NeonSessionRecord[];
  sessions: ChatSessionRecord[];
  fetchedAt: string;
};

export type ChatSessionListResponse = {
  ok: boolean;
  action: 'session_list';
  changed: boolean;
  sessions: ChatSessionRecord[];
  activeSessionId: string | null;
  surface: string;
  fetchedAt: string;
};

export type ChatSessionMutationResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  session?: ChatSessionRecord;
  state?: NeonSessionState;
  errors?: string[];
};

export type ChatSessionChangeEvent = {
  id: string;
  action: 'created' | 'updated' | 'switched' | 'archived' | 'restored';
  session: ChatSessionRecord;
  surface: string | null;
  changedAt: string;
};

export type WorkflowEventRecord = {
  id: number;
  runId: string | null;
  workflow: string | null;
  eventType: string;
  eventIndex: number | null;
  level: string | null;
  message: string;
  name: string | null;
  operationKind: string | null;
  operationId: string | null;
  durationMs: number | null;
  isError: boolean;
  summary: unknown;
  createdAt: string;
  runUrl: string | null;
};

export type WorkflowObservability = {
  ok: boolean;
  action: 'workflow_observability_read';
  activeRuns: Array<{
    runId: string;
    workflow: string;
    startedAt: string;
    lastEventAt: string;
    lastMessage: string;
    eventCount: number;
    runUrl: string;
  }>;
  recentFailures: WorkflowEventRecord[];
  recentData: WorkflowEventRecord[];
  recentLogs: WorkflowEventRecord[];
  recentTools: WorkflowEventRecord[];
  recentOperations: WorkflowEventRecord[];
  recentEvents: WorkflowEventRecord[];
  fetchedAt: string;
};

export type WorkflowSummary = {
  id: string;
  workflow: string;
  runId: string | null;
  status: string;
  summary: unknown;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowSummaryResponse = {
  items: WorkflowSummary[];
  fetchedAt: string;
};

export type SchedulerJob = {
  id: string;
  type: string;
  blueprint: string | null;
  enabled: boolean;
  intervalSeconds: number;
  config: unknown;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastMessage: string | null;
  lastResult: unknown;
  createdAt: string;
  updatedAt: string;
};

export type SchedulerJobsResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  jobs: SchedulerJob[];
};

export type MemoryScope = 'user' | 'project' | 'session' | 'watch';

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
};

export type MemoryResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  memories: MemoryRecord[];
  fetchedAt: string;
};

export type NotificationLevel = 'info' | 'ready' | 'attention' | 'urgent';

export type NotificationRecord = {
  id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  source: string | null;
  sourceId: string | null;
  data: unknown;
  readAt: string | null;
  resolvedAt: string | null;
  occurrenceCount: number;
  createdAt: string;
  updatedAt: string;
};

export type NotificationResponse = {
  items: NotificationRecord[];
  policy: Record<NotificationLevel | 'reconcile', string>;
  fetchedAt: string;
};

export type NotificationChangeEvent = {
  id: string;
  action: 'created' | 'read' | 'reconciled' | 'resolved';
  notification: NotificationRecord;
  changedAt: string;
};

export type SafetyClass =
  'read-only' | 'safe-mutation' | 'destructive-mutation' | 'host-execution';

export type SafetyPolicyEntry = {
  id: string;
  primitive: 'tool' | 'action' | 'workflow' | 'route';
  title: string;
  class: SafetyClass;
  unattended: boolean;
  requiresConfirmation: boolean;
  audited: boolean;
  auditTarget: string;
  notes: string;
};

export type SafetyPolicy = {
  ok: boolean;
  action: 'safety_policy_read';
  version: number;
  summary: {
    readOnly: number;
    safeMutation: number;
    destructiveMutation: number;
    hostExecution: number;
    requiresConfirmation: number;
    unattendedAllowed: number;
    audited: number;
  };
  confirmationPolicy: string;
  hostExecutionPolicy: string;
  executionPolicy: {
    defaultBackend: string;
    enabledBackends: string[];
    supportedBackends: string[];
    approvalMode: string;
    unattended: string;
    preapprovedCommandCount: number;
    defaultLocalAccess: boolean;
    exeDevPlanned: boolean;
  };
  entries: SafetyPolicyEntry[];
  fetchedAt: string;
};

export type RuntimeSkill = {
  id: string;
  description: string;
  path: string;
  directory: string;
  root: string;
  source: string;
  status: 'active' | 'duplicate';
};

export type RuntimeSkillRoot = {
  path: string;
  source: string;
};

export type RuntimeSkillIssue = {
  id?: string;
  path?: string;
  paths?: string[];
  reason?: string;
};

export type RuntimeSkillsResponse = {
  roots: RuntimeSkillRoot[];
  skills: RuntimeSkill[];
  duplicates: RuntimeSkillIssue[];
  ignored: RuntimeSkillIssue[];
  loadedAt: string;
};

export type NeonCommandResult = {
  ok: boolean;
  command: string;
  input: string;
  status: 'completed' | 'failed' | 'needs-config';
  message: string;
  flueRunId?: string;
  data?: unknown;
  errors?: string[];
  requires?: string[];
  workflowSummary?: {
    id: string;
    workflow: string;
    status: string;
    createdAt: string;
  };
};

export type PrWatch = {
  id: string;
  repoId: string;
  repoFullName: string;
  githubOwner: string;
  githubName: string;
  prNumber: number;
  desiredTerminalState: string;
  status: string;
  prState: string | null;
  title: string | null;
  url: string | null;
  mergeCommitSha: string | null;
  lastCheckedAt: string | null;
  updatedAt: string;
};

export type PrWatchResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  watches: PrWatch[];
};

export type HostMetrics = {
  hostname: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  loadAverage: number[];
  cpuCount: number;
  cpuModel: string;
  cpu: {
    loadPercent: number | null;
    avgLoad: number | null;
  };
  memory: {
    total: number;
    free: number;
    used: number;
    usedRatio: number;
  };
  gpu: {
    name: string | null;
    utilizationPercent: number | null;
    temperatureC: number | null;
    memoryTotal: number | null;
    memoryUsed: number | null;
  };
  temperature: {
    cpuC: number | null;
    maxC: number | null;
  };
  network: {
    iface: string | null;
    downBytesPerSecond: number | null;
    upBytesPerSecond: number | null;
  };
  process: {
    uptimeSeconds: number;
    rss: number;
  };
  sampledAt: string;
};

export async function getDashboardConfig() {
  return getJson<DashboardConfig>('/api/dashboard/config');
}

export async function updateDashboardConfig(input: DashboardConfig) {
  return postJson<ConfigActionResult>('/api/dashboard/config', input);
}

export async function applyDashboardPreset(input: {
  preset: 'classic' | 'cockpit';
  statuslinePosition?: 'top' | 'bottom';
}) {
  return postJson<ConfigActionResult>('/api/dashboard/preset', input);
}

export async function getGitHubPullRequests() {
  return getJson<GitHubPullRequestResponse>('/api/github/prs');
}

export async function getRepoRegistry() {
  return getJson<RepoRegistryResponse>('/api/repos');
}

export async function getRepoHealth() {
  return getJson<RepoHealthResponse>('/api/repos/health');
}

export async function getRuntimeHealth() {
  return getJson<RuntimeHealth>('/api/health');
}

export async function getRuntimeStatus() {
  return getJson<RuntimeStatus>('/api/runtime/status');
}

export async function getAutopilotState() {
  return getJson<AutopilotState>('/api/autopilot/state');
}

export function openConfigEventStream(
  onEvent: (event: ConfigChangeEvent) => void,
  onError?: () => void,
) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/events/config');
  source.addEventListener('config-change', (event) => {
    onEvent(JSON.parse(event.data) as ConfigChangeEvent);
  });
  if (onError) source.addEventListener('error', onError);

  return () => source.close();
}

export function openNotificationEventStream(
  onEvent: (event: NotificationChangeEvent) => void,
  onError?: () => void,
) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/events/notifications');
  source.addEventListener('notification-change', (event) => {
    onEvent(JSON.parse(event.data) as NotificationChangeEvent);
  });
  if (onError) source.addEventListener('error', onError);

  return () => source.close();
}

export function openChatSessionEventStream(
  onEvent: (event: ChatSessionChangeEvent) => void,
  onError?: () => void,
) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/events/sessions');
  source.addEventListener('chat-session-change', (event) => {
    onEvent(JSON.parse(event.data) as ChatSessionChangeEvent);
  });
  if (onError) source.addEventListener('error', onError);

  return () => source.close();
}

export async function getSafetyPolicy() {
  return getJson<SafetyPolicy>('/api/safety/policy');
}

export async function getNeonSession() {
  return getJson<NeonSessionState>('/api/session');
}

export async function getChatSessions(
  input: { includeArchived?: boolean } = {},
) {
  const query = input.includeArchived ? '?includeArchived=1' : '';
  return getJson<ChatSessionListResponse>(`/api/sessions${query}`);
}

export async function startNeonSession(
  input: {
    label?: string;
    reason?: string;
  } = {},
) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    state?: NeonSessionState;
    errors?: string[];
  }>('/api/session/new', input);
}

export async function createChatSession(
  input: {
    title?: string;
    kind?: ChatSessionKind;
    activate?: boolean;
    surface?: string;
  } = {},
) {
  return postJson<ChatSessionMutationResponse>('/api/sessions', input);
}

export async function switchChatSession(id: string) {
  return postJson<ChatSessionMutationResponse>(`/api/sessions/${id}/switch`, {
    surface: 'dashboard',
    reason: 'dashboard-session-switcher',
  });
}

export async function renameChatSession(id: string, title: string) {
  return postJson<ChatSessionMutationResponse>(`/api/sessions/${id}/rename`, {
    title,
    reason: 'dashboard-session-switcher',
  });
}

export async function pinChatSession(id: string, pinned: boolean) {
  return postJson<ChatSessionMutationResponse>(`/api/sessions/${id}/pin`, {
    pinned,
    reason: 'dashboard-session-switcher',
  });
}

export async function archiveChatSession(id: string) {
  return postJson<ChatSessionMutationResponse>(`/api/sessions/${id}/archive`, {
    surface: 'dashboard',
    reason: 'dashboard-session-switcher',
  });
}

export async function restoreChatSession(id: string) {
  return postJson<ChatSessionMutationResponse>(`/api/sessions/${id}/restore`, {
    surface: 'dashboard',
    reason: 'dashboard-session-switcher',
  });
}

export async function updateAgentModels(input: AgentModelUpdate) {
  return postJson<ConfigActionResult>('/api/models', input);
}

export async function updateProvider(provider: string, input: ProviderUpdate) {
  return postJson<ConfigActionResult>(`/api/providers/${provider}`, input);
}

export async function getWorkflowObservability() {
  return getJson<WorkflowObservability>('/api/workflows/observability');
}

export async function getExecutionApprovals(
  input: { includeResolved?: boolean } = {},
) {
  const query = input.includeResolved ? '?includeResolved=1' : '';
  return getJson<ExecutionApprovalsResponse>(
    `/api/execution/approvals${query}`,
  );
}

export async function resolveExecutionApproval(
  id: string,
  decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny',
) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    approval?: ExecutionApproval;
  }>(`/api/execution/approvals/${id}/resolve`, {
    decision,
    approverSurface: 'dashboard',
  });
}

export async function getWorkflowSummaries() {
  return getJson<WorkflowSummaryResponse>('/api/workflows/summaries');
}

export async function getSchedulerJobs() {
  return getJson<SchedulerJobsResponse>('/api/jobs');
}

export async function getRuntimeSkills() {
  return getJson<RuntimeSkillsResponse>('/api/skills');
}

export async function getMemories(input: { scope?: MemoryScope } = {}) {
  const params = new URLSearchParams();
  if (input.scope) params.set('scope', input.scope);
  const query = params.toString();
  return getJson<MemoryResponse>(`/api/memories${query ? `?${query}` : ''}`);
}

export async function upsertMemory(input: {
  scope: MemoryScope;
  key: string;
  value: unknown;
}) {
  return postJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    message: string;
    memory?: MemoryRecord;
    errors?: string[];
    requires?: string[];
  }>('/api/memories', input);
}

export async function getNotifications() {
  return getJson<NotificationResponse>('/api/notifications');
}

export async function getRepoEditEvents() {
  return getJson<RepoEditEventsResponse>('/api/repo-edits');
}

export async function getWorktrees() {
  return getJson<WorktreesResponse>('/api/worktrees');
}

export async function markNotificationRead(id: string) {
  return postJson<{ ok: boolean }>(`/api/notifications/${id}/read`, {});
}

export async function resolveNotification(id: string) {
  return postJson<{ ok: boolean }>(`/api/notifications/${id}/resolve`, {});
}

export async function getHostMetrics() {
  return getJson<HostMetrics>('/api/metrics/host');
}

export async function getPrWatches() {
  return getJson<PrWatchResponse>('/api/watches');
}

async function getJson<T>(url: string) {
  const response = await fetch(url);
  const data = (await response.json()) as T;

  if (!response.ok) {
    const message =
      readErrorMessage(data) ?? `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function postJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T;

  if (!response.ok) {
    const message =
      readErrorMessage(data) ?? `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return data;
}

function readErrorMessage(data: unknown) {
  if (!data || typeof data !== 'object') return undefined;

  if ('message' in data && typeof data.message === 'string') {
    return data.message;
  }

  if (!('error' in data)) return undefined;

  const error = data.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }

  return undefined;
}
