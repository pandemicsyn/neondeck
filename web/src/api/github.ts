import type {
  GitHubPrReviewDraftResponse,
  GitHubPrReviewThreadsResponse,
  GitHubPrReviewSubmitResponse,
  GitHubPrReviewVerdict,
  GitHubPrThreadMutationResponse,
  GitHubPullRequestFilesResponse,
  GitHubPullRequestResponse,
} from './types';
import { deleteJson, getJson, patchJson, postJson, putJson } from './http';

export async function getGitHubPullRequests() {
  return getJson<GitHubPullRequestResponse>('/api/github/prs');
}

export async function getGitHubPullRequestFiles(input: {
  repo: string;
  number: number;
  headSha?: string | null;
}) {
  const [owner, name] = input.repo.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repository "${input.repo}".`);
  }
  const query = input.headSha
    ? `?head=${encodeURIComponent(input.headSha)}`
    : '';

  const response = await getJson<GitHubPullRequestFilesResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/files${query}`,
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

export async function getGitHubPrReviewDraft(input: {
  repo: string;
  number: number;
}) {
  const [owner, name] = parseRepo(input.repo);
  const response = await getJson<GitHubPrReviewDraftResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/review-draft`,
  );
  return response.data?.draft ?? null;
}

export async function putGitHubPrReviewDraft(input: {
  repo: string;
  number: number;
  headSha: string;
  verdict?: GitHubPrReviewVerdict | null;
  body?: string | null;
}) {
  const [owner, name] = parseRepo(input.repo);
  const body: {
    headSha: string;
    verdict?: GitHubPrReviewVerdict | null;
    body?: string | null;
  } = { headSha: input.headSha };
  if ('verdict' in input) body.verdict = input.verdict ?? null;
  if ('body' in input) body.body = input.body ?? null;
  const response = await putJson<GitHubPrReviewDraftResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/review-draft`,
    body,
  );
  if (!response.data?.draft) throw new Error(response.message);
  return response.data.draft;
}

export async function postGitHubPrReviewDraftComment(input: {
  repo: string;
  number: number;
  draftId: string;
  path: string;
  side: 'RIGHT' | 'LEFT';
  line: number;
  startLine?: number | null;
  startSide?: 'RIGHT' | 'LEFT' | null;
  body: string;
}) {
  const [owner, name] = parseRepo(input.repo);
  const response = await postJson<GitHubPrReviewDraftResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/review-draft/comments`,
    {
      draftId: input.draftId,
      path: input.path,
      side: input.side,
      line: input.line,
      startLine: input.startLine ?? null,
      startSide: input.startSide ?? null,
      body: input.body,
    },
  );
  if (!response.data?.draft) throw new Error(response.message);
  return response.data.draft;
}

export async function patchGitHubPrReviewDraftComment(input: {
  repo: string;
  number: number;
  id: string;
  body: string;
}) {
  const [owner, name] = parseRepo(input.repo);
  const response = await patchJson<GitHubPrReviewDraftResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/review-draft/comments/${encodeURIComponent(input.id)}`,
    { body: input.body },
  );
  if (!response.data?.draft) throw new Error(response.message);
  return response.data.draft;
}

export async function deleteGitHubPrReviewDraftComment(input: {
  repo: string;
  number: number;
  id: string;
}) {
  const [owner, name] = parseRepo(input.repo);
  const response = await deleteJson<GitHubPrReviewDraftResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/review-draft/comments/${encodeURIComponent(input.id)}`,
  );
  if (!response.data?.draft) throw new Error(response.message);
  return response.data.draft;
}

export async function deleteGitHubPrReviewDraft(input: {
  repo: string;
  number: number;
}) {
  const [owner, name] = parseRepo(input.repo);
  const response = await deleteJson<GitHubPrReviewDraftResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/review-draft`,
  );
  return response.data?.draft ?? null;
}

export async function postGitHubPrReview(input: {
  repo: string;
  number: number;
  draftId: string;
  headSha: string;
  commentIds?: string[];
}) {
  const [owner, name] = parseRepo(input.repo);
  const response = await postJson<GitHubPrReviewSubmitResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/reviews`,
    {
      draftId: input.draftId,
      headSha: input.headSha,
      commentIds: input.commentIds,
    },
  );
  if (!response.ok) throw new Error(response.message);
  return response.data;
}

export async function postGitHubPrThreadReply(input: {
  threadId: string;
  text: string;
}) {
  const response = await postJson<GitHubPrThreadMutationResponse>(
    `/api/github/pr-threads/${encodeURIComponent(input.threadId)}/reply`,
    { text: input.text },
  );
  if (!response.data?.thread) throw new Error(response.message);
  return response.data.thread;
}

export async function postGitHubPrThreadResolution(input: {
  threadId: string;
  resolved: boolean;
}) {
  const response = await postJson<GitHubPrThreadMutationResponse>(
    `/api/github/pr-threads/${encodeURIComponent(input.threadId)}/${input.resolved ? 'resolve' : 'unresolve'}`,
    {},
  );
  if (!response.data?.thread) throw new Error(response.message);
  return response.data.thread;
}

function parseRepo(repo: string): [string, string] {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repository "${repo}".`);
  }
  return [owner, name];
}
