import type {
  GitHubPrReviewThreadsResponse,
  GitHubPullRequestFilesResponse,
  GitHubPullRequestResponse,
} from './types';
import { getJson, postJson } from './http';

export async function getGitHubPullRequests() {
  return getJson<GitHubPullRequestResponse>('/api/github/prs');
}

export async function getGitHubPullRequestFiles(input: {
  repo: string;
  number: number;
}) {
  const [owner, name] = input.repo.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repository "${input.repo}".`);
  }

  const response = await getJson<GitHubPullRequestFilesResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/files`,
  );
  if (!response.data) throw new Error(response.message);
  return response.data;
}

export async function getGitHubPrReviewThreads(input: {
  repo: string;
  number: number;
}) {
  const response = await postJson<GitHubPrReviewThreadsResponse>(
    '/api/github/prs/review-threads',
    { repo: input.repo, prNumber: input.number },
  );
  return {
    reviewThreads: response.data?.reviewThreads ?? [],
    unresolvedReviewThreads: response.data?.unresolvedReviewThreads ?? [],
  };
}
