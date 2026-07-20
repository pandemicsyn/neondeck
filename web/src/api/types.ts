import type { ReviewRevision } from '../../../shared/review-source';

export type DashboardTheme = 'light' | 'dark' | 'system';
export type DashboardDensity = 'compact' | 'comfortable' | 'large';
export type DashboardLayoutMode = 'auto' | 'xeneon' | 'stacked';

export type DashboardConfig = {
  $schema?: string;
  schemaVersion: number;
  display: {
    preset?: string;
    width: number;
    height: number;
  };
  theme: DashboardTheme;
  appearance?: {
    density?: DashboardDensity;
    textScale?: number;
  };
  notifications?: {
    toasts?: DashboardToastConfig;
  };
  windows?: Record<string, DashboardWindowProfile>;
  statusline?: DashboardStatusline;
  layout: {
    mode?: DashboardLayoutMode;
    columns: number;
    rows: number;
    regions: DashboardRegion[];
  };
};

export type DashboardToastConfig = {
  enabled: boolean;
  soundEnabled: boolean;
  minimumLevel: NotificationLevel;
  readyDurationMs: number;
  maxVisible: number;
};

export type DashboardWindowProfile = {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  kiosk?: boolean;
};

export type DashboardStatusline = {
  position: 'top' | 'bottom';
  pluginId: string;
  config?: Record<string, unknown>;
};

export type DashboardRegion = {
  id: string;
  title: string;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
  defaultTab?: string;
  tabs: DashboardTab[];
};

export type DashboardTab = {
  id: string;
  title: string;
  pluginId: string;
  config?: Record<string, unknown>;
};

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
  baseSha?: string | null;
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

export type PrReviewStatus =
  'reviewing' | 'ready' | 'submitting' | 'submitted' | 'failed';

export type PrReviewVerdict = 'comment' | 'approve' | 'request-changes';

export type PrReviewReportOnlyFinding = {
  sourceId?: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  path: string;
  line: number | null;
  summary: string;
  suggestedFix: string;
  reason: string;
};

export type PrReviewRecord = {
  id: string;
  ref: string;
  repoFullName: string;
  prNumber: number;
  title: string;
  author: string | null;
  prUrl: string;
  status: PrReviewStatus;
  runId: string | null;
  headSha: string;
  origin: 'chat' | 'panel' | 'api';
  reviewUrl: string;
  reportIds: string[];
  findingCount: number;
  seededCount: number;
  reportOnlyCount: number;
  reportOnlyFindings: PrReviewReportOnlyFinding[];
  trustBoundary: string;
  verdict: PrReviewVerdict | null;
  previousVerdict: PrReviewVerdict | null;
  githubReviewUrl: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  submittedAt: string | null;
  failedAt: string | null;
};

export type PrReviewAwaitingItem = {
  pullRequest: GitHubPullRequest;
  review: PrReviewRecord | null;
};

export type PrReviewsResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  items: PrReviewRecord[];
  groups: {
    awaiting: PrReviewAwaitingItem[];
    inProgress: PrReviewRecord[];
    needsAction: PrReviewRecord[];
    submitted: PrReviewRecord[];
  };
  queueIssues?: string[];
};

export type PrReviewMutationResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  review: PrReviewRecord;
  reviewId: string;
  runId: string;
};

export type PrReviewChangeEvent = {
  id: string;
  action: 'created' | 'changed';
  review: PrReviewRecord;
  changedAt: string;
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

export type GitHubPullRequestDetailResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: {
    pullRequest?: GitHubPullRequest;
  };
  requires?: string[];
  errors?: string[];
};

export type ReportRecord = {
  id: string;
  kind: string;
  title: string;
  repoId: string | null;
  sourceRef: string | null;
  htmlPath: string;
  summary: unknown | null;
  createdBy: string;
  createdAt: string;
};

export type ReportsResponse = {
  ok: boolean;
  action: 'reports_list';
  items: ReportRecord[];
  fetchedAt?: string;
  message?: string;
};

export type ReportResponse = {
  ok: boolean;
  action: 'reports_read';
  item: ReportRecord | null;
  fetchedAt?: string;
  message?: string;
};

export type ReportActionResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: unknown;
  errors?: string[];
  requires?: string[];
};

export type GitHubPullRequestFile = Omit<RepoDiffFile, 'patch'> & {
  patch?: string | null;
  previousPath?: string | null;
  changes: number;
  sha?: string | null;
  htmlUrl?: string | null;
  rawUrl?: string | null;
  contentsUrl?: string | null;
  message?: string | null;
};

export type GitHubPullRequestFilesResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: {
    target?: {
      repoFullName: string;
      owner: string;
      repo: string;
      number: number;
      watchId?: string | null;
    };
    files: GitHubPullRequestFile[];
    diffSummary: DiffSummary;
    fetchedAt: string;
    source?: 'local' | 'github';
    revision: ReviewRevision;
  };
  requires?: string[];
  errors?: string[];
};

export type GitHubPullRequestFileDiffResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: {
    target?: {
      repoFullName: string;
      owner: string;
      repo: string;
      number: number;
      watchId?: string | null;
    };
    file: GitHubPullRequestFile | null;
    diff: string;
    diffSummary: DiffSummary;
    fetchedAt: string;
    source?: 'local' | 'github';
    revision: ReviewRevision;
  };
  requires?: string[];
  errors?: string[];
};

export type GitHubPullRequestReviewThreadComment = {
  id: string;
  databaseId: number | null;
  authorLogin: string | null;
  body: string;
  url: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  diffHunk: string | null;
  reviewId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubPullRequestReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  originalLine?: number | null;
  diffSide?: string | null;
  pullRequestRepo?: string | null;
  pullRequestNumber?: number | null;
  comments: GitHubPullRequestReviewThreadComment[];
};

export type GitHubPrReviewVerdict = 'comment' | 'approve' | 'request-changes';

export type GitHubPrReviewDraftComment = {
  id: string;
  draftId: string;
  path: string;
  side: 'RIGHT' | 'LEFT';
  line: number;
  startLine: number | null;
  startSide: 'RIGHT' | 'LEFT' | null;
  body: string;
  origin: 'human' | 'neon';
  sourceFindingId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubPrReviewDraft = {
  id: string;
  repo: string;
  prNumber: number;
  headSha: string;
  verdict: GitHubPrReviewVerdict | null;
  body: string | null;
  status: 'draft' | 'submitted' | 'discarded';
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  comments: GitHubPrReviewDraftComment[];
};

export type GitHubSubmittedPullRequestReview = {
  id: number;
  nodeId: string | null;
  state: string;
  authorLogin: string | null;
  submittedAt: string | null;
  commitId: string | null;
  url: string | null;
  body: string | null;
};

export type GitHubPrReviewDraftResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: {
    target?: {
      repoFullName: string;
      owner: string;
      repo: string;
      number: number;
      watchId?: string | null;
    };
    draft: GitHubPrReviewDraft | null;
  };
  requires?: string[];
  errors?: string[];
};

export type GitHubPrReviewSubmitResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: {
    code?: string;
    failingCommentIds?: string[];
    target?: {
      repoFullName: string;
      owner: string;
      repo: string;
      number: number;
      watchId?: string | null;
    };
    draft?: GitHubPrReviewDraft;
    review?: GitHubSubmittedPullRequestReview;
  };
  requires?: string[];
  errors?: string[];
};

export type GitHubPrThreadMutationResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: {
    thread?: GitHubPullRequestReviewThread;
  };
  requires?: string[];
  errors?: string[];
};

export type GitHubPrReviewThreadsResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: {
    reviewThreads?: GitHubPullRequestReviewThread[];
    reviewThreadsTruncated?: boolean;
    unresolvedReviewThreads?: GitHubPullRequestReviewThread[];
  };
  requires?: string[];
  errors?: string[];
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

export type AutopilotReadinessFact = {
  id:
    | 'runtime-home'
    | 'worktree-root'
    | 'source-repo'
    | 'api'
    | 'fetch'
    | 'git-push'
    | 'comment'
    | 'identity'
    | 'check-commands'
    | 'gh';
  label: string;
  status: 'ready' | 'blocked' | 'warning' | 'not-required' | 'not-checked';
  required: boolean;
  message: string;
  action: string | null;
  details?: Record<string, unknown>;
};

export type AutopilotReadiness = {
  ok: true;
  action: 'autopilot_readiness_read';
  changed: false;
  ready: boolean;
  status: 'ready' | 'blocked' | 'warning';
  message: string;
  repoId: string;
  repoFullName: string;
  prNumber: number | null;
  mode:
    | 'notify-only'
    | 'prepare-only'
    | 'autofix-with-approval'
    | 'autofix-push-when-safe';
  facts: Record<AutopilotReadinessFact['id'], AutopilotReadinessFact>;
  blocking: AutopilotReadinessFact['id'][];
  warnings: AutopilotReadinessFact['id'][];
  pushTarget: {
    repoFullName: string;
    remote: string;
    branch: string;
    fork: boolean;
    maintainerCanModify: boolean;
    canLikelyPush: boolean | null;
  } | null;
  checkedAt: string;
};

export type RuntimeStatus = {
  ok: boolean;
  status: 'ready' | 'needs-config' | 'attention';
  service: string;
  home: string;
  paths: {
    env: string;
    config: string;
    mcp: string;
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
  autopilot: AutopilotReadiness | null;
  session: {
    id: string;
    label: string;
    stale: boolean;
    staleReasons: Array<{
      type:
        'config' | 'memory' | 'model' | 'provider' | 'repo' | 'skill' | 'soul';
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
    mcpServers: number;
    mcpConnectedServers: number;
    mcpNeedsLoginServers: number;
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
  usedAt: string | null;
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

export type McpServerStatus =
  | 'disabled'
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'needs-login'
  | 'error';

export type McpServer = {
  id: string;
  transport: 'http' | 'stdio';
  enabled: boolean;
  status: McpServerStatus;
  auth: {
    kind: 'none' | 'header' | 'oauth';
    authorized: boolean;
    expiresAt: string | null;
  };
  toolCount: number;
  message: string | null;
  lastConnectedAt: string | null;
  lastErrorAt: string | null;
};

export type McpServersResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  servers: McpServer[];
};

export type McpApproval = {
  id: string;
  serverId: string;
  toolName: string;
  adaptedName: string;
  argumentsHash: string;
  argumentsPreview: string;
  status: 'pending' | 'approved' | 'denied' | 'used' | 'expired';
  approverSurface: string | null;
  sessionId: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  usedAt: string | null;
  updatedAt: string;
};

export type McpApprovalsResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  approvals: McpApproval[];
};

export type McpLoginResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  authorizationUrl?: string | null;
  loginId?: string;
  login?: unknown;
  requires?: string[];
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
  reviewRevision: ReviewRevision;
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

export type DiffSummary = {
  files: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
};

export type RepoDiffFile = {
  path: string;
  previousPath?: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  generatedLike?: boolean;
  patch?: string;
  truncated?: boolean;
};

export type PreparedDiffFilesResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  revision?: ReviewRevision;
  files?: RepoDiffFile[];
  diffSummary?: DiffSummary;
  errors?: string[];
};

export type PreparedDiffFileDiffResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  revision?: ReviewRevision;
  file?: RepoDiffFile | null;
  diff?: string;
  diffSummary?: DiffSummary;
  errors?: string[];
};

export type RepoDiffResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  repoId?: string;
  worktreeId?: string | null;
  base?: string;
  revision?: ReviewRevision;
  files?: RepoDiffFile[];
  diffSummary?: DiffSummary;
  errors?: string[];
  requires?: string[];
};

export type KiloTaskDiffResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  diff?: KiloTaskRecord['diff'];
  errors?: string[];
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

export type KiloTaskStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs-reconcile'
  | 'needs-review'
  | 'ready-to-verify'
  | 'ready-to-push'
  | 'discarded'
  | 'unknown';

export type KiloChildSessionNode = {
  id: string;
  title: string;
  status: 'unknown' | 'active' | 'completed';
  latestSummary: string | null;
  eventCount: number;
  collapsed: boolean;
};

export type KiloNotificationFact = {
  id: string;
  taskId: string;
  state:
    | 'started'
    | 'progress'
    | 'waiting-approval'
    | 'completed'
    | 'failed'
    | 'timed-out'
    | 'needs-review'
    | 'verified'
    | 'promote-blocked'
    | 'promoted';
  level: 'info' | 'ready' | 'attention' | 'urgent';
  title: string;
  message: string;
  readAt: string | null;
  resolvedAt: string | null;
  occurrenceCount: number;
  updatedAt: string;
};

export type KiloResultPlaceholder = {
  type: 'review' | 'verification' | 'promotion';
  status: 'pending' | 'blocked' | 'unavailable';
  workflow: 'review_kilo_result' | 'verify_kilo_result' | 'promote_kilo_result';
  reason: string;
};

export type KiloTaskRecord = {
  id: string;
  title: string;
  prompt: string;
  repoId: string;
  repoFullName: string;
  worktreeId: string | null;
  lockId: string | null;
  cwd: string;
  mode: 'draft-fix' | 'patch-proposal' | 'direct-edit';
  status: KiloTaskStatus;
  explicitUserRequest: boolean;
  autoEnabled: boolean;
  cliPath: string;
  args: string[];
  pid: number | null;
  processStartedAt: string | null;
  rootSessionId: string | null;
  childSessionIds: string[];
  rawLogPath: string | null;
  summary: string | null;
  exitCode: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  changedFiles?: string[];
  diff?: {
    ok: boolean;
    repo: string;
    path: string;
    baseRef: string;
    files: Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
    }>;
    fileCount: number;
    additions: number;
    deletions: number;
    binaryFiles: number;
    error?: string;
  };
  verificationState?: string;
  reviewClassification?: string | null;
  promotionState?: string;
  preparedDiffId?: string | null;
  pendingApprovals?: unknown[];
  notificationFacts?: KiloNotificationFact[];
  latestNotificationState?: KiloNotificationFact['state'] | null;
  resultPlaceholders?: KiloResultPlaceholder[];
};

export type KiloTasksResponse = {
  ok: boolean;
  action: 'kilo_tasks_list';
  changed: boolean;
  message: string;
  tasks: KiloTaskRecord[];
  fetchedAt: string;
};

export type PreparedDiffRecord = {
  id: string;
  repoId: string;
  repoFullName: string;
  prNumber: number | null;
  worktreeId: string;
  localPath: string;
  title: string;
  status: string;
  pushApprovalStatus: string;
  verificationStatus: string;
  sourceOfTruth: 'worktree';
  summary: string;
  revisionRun: {
    kiloTaskId: string | null;
    reason: string | null;
    startedAt: string | null;
    completedAt: string | null;
    outcome: string | null;
    status: string | null;
    title: string | null;
    cwd: string | null;
  } | null;
  updatedAt: string;
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
    type:
      'config' | 'memory' | 'model' | 'provider' | 'repo' | 'skill' | 'soul';
    message: string;
    changedAt: string;
    target: string | null;
  }>;
  uiMetadata: unknown;
  summary: string | null;
  summaryGeneratedAt: string | null;
  summarySource: 'manual' | 'metadata' | 'agent' | 'transcript-summary' | null;
  summaryRefreshNote: string | null;
  summaryStatus: 'missing' | 'fresh' | 'stale';
  contextLoadedAt: string;
  contextMemoryIds: string[];
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
};

export type NeonSessionState = {
  ok: boolean;
  action: 'session_status';
  activeChatSession: ChatSessionRecord;
  activeSessionId: string;
  surface: string;
  stale: boolean;
  staleReasons: Array<{
    type:
      'config' | 'memory' | 'model' | 'provider' | 'repo' | 'skill' | 'soul';
    message: string;
    changedAt: string;
    target: string | null;
  }>;
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
  reference?: unknown;
  errors?: string[];
  requires?: string[];
};

export type ChatSessionCommandEvent = {
  id: string;
  sessionId: string;
  input: string;
  status: 'running' | 'completed' | 'failed';
  result: NeonCommandResult | null;
  flueRunId: string | null;
  workflowSummaryId: string | null;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string;
};

export type ChatSessionCommandEventListResponse = {
  ok: boolean;
  action: 'session_command_events_list';
  changed: false;
  events: ChatSessionCommandEvent[];
  fetchedAt: string;
  errors?: string[];
  requires?: string[];
};

export type ChatSessionCommandEventMutationResponse = {
  ok: boolean;
  action: 'session_command_event_create' | 'session_command_event_update';
  changed: boolean;
  message: string;
  event?: ChatSessionCommandEvent;
  errors?: string[];
  requires?: string[];
};

export type ChatSessionActivityItem = NotificationRecord & {
  kind: 'notification';
};

export type ChatSessionActivityListResponse = {
  ok: boolean;
  action: 'session_activity_list';
  changed: false;
  items: ChatSessionActivityItem[];
  fetchedAt: string;
  errors?: string[];
  requires?: string[];
};

export type ChatSessionChangeEvent = {
  id: string;
  action: 'created' | 'updated' | 'switched' | 'archived' | 'restored';
  session: ChatSessionRecord;
  surface: string | null;
  changedAt: string;
};

export type ChatSessionCommandChangeEvent = {
  id: string;
  action: 'created' | 'updated';
  sessionId: string;
  event: ChatSessionCommandEvent;
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
    runUrl: string | null;
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

export type ScheduledTask = {
  id: string;
  spec: { kind: string };
  trigger: { kind: string; everySeconds?: number };
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  claimId: string | null;
  claimExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledTasksResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  tasks: ScheduledTask[];
};

export type ActiveMemoryScope = 'user' | 'local' | 'project';
export type MemoryScope = ActiveMemoryScope;

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  key: string;
  value: unknown;
  repoId: string | null;
  status: 'active' | 'archived';
  useCount: number;
  lastUsedAt: string | null;
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

export type LearningWriteMode = 'off' | 'review' | 'auto';

export type LearningConfig = {
  enabled: boolean;
  memoryWriteMode: LearningWriteMode;
  skillWriteMode: LearningWriteMode;
  memoryCurationEnabled: boolean;
  memoryCurationMode: LearningWriteMode;
  conversationReviewTurnInterval: number;
  memoryCurationTurnInterval: number;
  prRetrospectiveThreshold: number;
  notifications: 'off' | 'on';
  memoryMaxActiveItems: number;
  maxRecentTurns: number;
  maxPrBatchItems: number;
  memoryPromptBudgetChars: number;
  userMemoryBudgetChars: number;
  localMemoryBudgetChars: number;
  projectMemoryBudgetChars: number;
};

export type LearningReviewRecord = {
  id: string;
  kind: 'conversation' | 'curation' | 'pr-batch';
  status: 'running' | 'completed' | 'failed';
  model: string;
  thinkingLevel: string;
  trigger: unknown;
  inputSummary: unknown;
  result: unknown;
  error: string | null;
  flueRunId: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type LearningCandidateStatus =
  'proposed' | 'applied' | 'rejected' | 'archived';

export type LearningCandidate = {
  id: string;
  target: 'memory' | 'skill';
  status: LearningCandidateStatus;
  action: string | null;
  scope: string | null;
  key: string | null;
  value: unknown;
  skillId: string | null;
  repoId: string | null;
  reason: string | null;
  reviewId: string | null;
  patch: unknown;
  createdAt: string;
  decidedAt: string | null;
};

export type LearningAuditEvent = {
  id: string;
  type?: string;
  source?: string;
  sourceId?: string | null;
  repoId?: string | null;
  sessionId?: string | null;
  prKey?: string | null;
  memoryId?: string | null;
  action?: string;
  actor?: string;
  reason?: string | null;
  data?: unknown;
  before?: unknown;
  after?: unknown;
  createdAt: string;
};

export type LearningOperatorState = {
  ok: boolean;
  action: 'learning_operator_state';
  changed: boolean;
  config: LearningConfig;
  summary: {
    reviews: Record<string, number>;
    candidates: Record<string, number>;
    targets: Record<string, number>;
    activeMemories: number;
    archivedMemories: number;
    handledPrEvents: number;
    pendingDecisions: number;
    failedReviews: number;
  };
  reviews: LearningReviewRecord[];
  candidates: LearningCandidate[];
  memoryCandidates: LearningCandidate[];
  skillPatchCandidates: LearningCandidate[];
  memoryEvents: LearningAuditEvent[];
  learningEvents: LearningAuditEvent[];
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
  policy: Record<
    NotificationLevel | 'reconcile' | 'autopilot' | 'kilo',
    string
  >;
  fetchedAt: string;
};

export type NotificationChangeEvent = {
  id: string;
  action: 'created' | 'read' | 'reconciled' | 'resolved';
  notification: NotificationRecord;
  changedAt: string;
};

export type BriefingProfile = {
  id: string;
  name: string;
  enabled: boolean;
  instructions: string;
  instructionsVersion: number;
  schedule: string;
  timezone: string;
  sessionId: string | null;
  compatibility: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type BriefingRun = {
  id: string;
  profileId: string | null;
  trigger: 'manual' | 'scheduled' | 'dashboard';
  sessionId: string;
  commandEventId: string | null;
  dispatchId: string | null;
  workflowRunId: string | null;
  status: 'queued' | 'ready' | 'failed';
  error: string | null;
  queuedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  snapshot: {
    version: 1;
    collectedAt: string;
    byteSize: number;
    truncated: boolean;
  };
  instructionsVersion: number;
};

export type BriefingStateResponse = {
  ok: boolean;
  action: 'briefing_state_read';
  changed: boolean;
  profile: BriefingProfile;
  latestRun: BriefingRun | null;
  runs: BriefingRun[];
  unreadCount: number;
  sessionStaleReasons: ChatSessionRecord['staleReasons'];
  fetchedAt: string;
};

export type BriefingMutationResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  profile?: BriefingProfile;
  run?: BriefingRun;
  workflowRunId?: string;
  errors?: string[];
};

export type SafetyClass =
  'read-only' | 'safe-mutation' | 'destructive-mutation' | 'host-execution';

export type SafetyPolicyEntry = {
  id: string;
  primitive: 'tool' | 'action' | 'workflow' | 'route' | 'cli';
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
  status: 'running' | 'completed' | 'failed' | 'needs-config';
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

export type NeonCommandDefinition = {
  name: string;
  usage: string;
  description: string;
};

export type NeonCommandsResponse = {
  items: NeonCommandDefinition[];
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
  lastSnapshot: PrWatchSnapshot | null;
  lastCheckedAt: string | null;
  createdBy: string | null;
  processExisting: boolean;
  autopilotMode:
    | 'notify-only'
    | 'prepare-only'
    | 'autofix-with-approval'
    | 'autofix-push-when-safe';
  autopilotStatus: 'watching' | 'working' | 'waiting' | 'blocked' | 'complete';
  ownerInstanceId: string | null;
  worktreeId: string | null;
  worktreeHeadSha?: string | null;
  lastEventFingerprint: string | null;
  nextRunAt?: string | null;
  pollingEnabled?: boolean;
  pollIntervalSeconds?: number | null;
  updatedAt: string;
};

export type PrWatchSnapshot = {
  state: string;
  merged: boolean;
  mergeCommitSha: string | null;
  checks: {
    status: 'success' | 'failure' | 'pending' | 'none';
    total: number;
    successful: number;
    failed: number;
    pending: number;
    checkedAt: string;
  } | null;
  title: string;
  url: string;
  updatedAt: string;
  headSha: string;
  baseRef: string;
};

export type PrWatchResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  watches: PrWatch[];
};

export type PrWatchMutationResponse = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  watch?: PrWatch;
  watches?: PrWatch[];
  requires?: string[];
  errors?: string[];
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
