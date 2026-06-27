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

export async function getHostMetrics() {
  return getJson<HostMetrics>('/api/metrics/host');
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
