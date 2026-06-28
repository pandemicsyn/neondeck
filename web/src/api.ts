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
};

export type GitHubPullRequestResponse = {
  login?: string;
  repos?: string[];
  items: GitHubPullRequest[];
  fetchedAt?: string;
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

export async function getSchedulerJobs() {
  return getJson<SchedulerJobsResponse>('/api/jobs');
}

export async function getRuntimeSkills() {
  return getJson<RuntimeSkillsResponse>('/api/skills');
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

function readErrorMessage(data: unknown) {
  if (!data || typeof data !== 'object' || !('error' in data)) return undefined;

  const error = data.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }

  return undefined;
}
