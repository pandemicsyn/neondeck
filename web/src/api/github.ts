import type { GitHubPullRequestResponse } from './types';
import { getJson } from './http';

export async function getGitHubPullRequests() {
  return getJson<GitHubPullRequestResponse>('/api/github/prs');
}
