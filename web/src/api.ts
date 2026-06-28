import type { DashboardConfig } from './types';

export type GitHubPullRequest = {
  id: number;
  title: string;
  repo: string;
  number: number;
  url: string;
  state: string;
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
  type: 'search-truncated' | 'search-error' | 'enrichment-error';
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
  productionTarget?: string;
  packageScripts?: Record<string, string>;
  metadata?: Record<string, unknown>;
  watchRules?: unknown[];
};

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
    config: string;
    repos: string;
    schedules: string;
    dashboard: string;
    skills: string;
    neondeckDatabase: string;
    flueDatabase: string;
  };
  uptimeSeconds: number;
  providers: {
    registered: string[];
    credentials: {
      kilo: boolean;
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
    };
  };
  models: {
    displayAssistant: string;
    displayAssistantProvider: string;
    subagents: Record<string, string>;
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
  subagents?: {
    repoResearcher?: string;
    ciInvestigator?: string;
    releaseReviewer?: string;
  };
};

export type KilocodeProviderUpdate = {
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

export type NeonSessionState = {
  ok: boolean;
  action: 'session_status';
  activeSession: NeonSessionRecord;
  stale: boolean;
  staleReasons: Array<{
    type: 'config' | 'memory';
    message: string;
    changedAt: string;
    target: string | null;
  }>;
  history: NeonSessionRecord[];
  fetchedAt: string;
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

export async function getSafetyPolicy() {
  return getJson<SafetyPolicy>('/api/safety/policy');
}

export async function getNeonSession() {
  return getJson<NeonSessionState>('/api/session');
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

export async function updateAgentModels(input: AgentModelUpdate) {
  return postJson<ConfigActionResult>('/api/models', input);
}

export async function updateKilocodeProvider(input: KilocodeProviderUpdate) {
  return postJson<ConfigActionResult>('/api/providers/kilocode', input);
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
