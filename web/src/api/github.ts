import type {
  GitHubPrReviewDraftResponse,
  GitHubPrReviewThreadsResponse,
  GitHubPrReviewSubmitResponse,
  GitHubPrReviewVerdict,
  GitHubPrThreadMutationResponse,
  GitHubPullRequestDetailResponse,
  GitHubPullRequestFileDiffResponse,
  GitHubPullRequestFilesResponse,
  GitHubPullRequestResponse,
} from './types';
import { deleteJson, getJson, patchJson, postJson, putJson } from './http';

export async function getGitHubPullRequests() {
  return getJson<GitHubPullRequestResponse>('/api/github/prs');
}

export async function getGitHubPullRequest(input: {
  repo: string;
  number: number;
}) {
  const [owner, name] = parseRepo(input.repo);
  const response = await getJson<GitHubPullRequestDetailResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}`,
  );
  const pullRequest = response.data?.pullRequest;
  if (!pullRequest) throw new Error(response.message);
  return pullRequest;
}

export async function getGitHubPullRequestFiles(input: {
  repo: string;
  number: number;
  headSha?: string | null;
  baseSha?: string | null;
  baseRef?: string | null;
  patches?: 'all' | 'none';
  source?: 'auto' | 'local' | 'github';
}) {
  const [owner, name] = parseRepo(input.repo);
  const query = prFilesQuery(input);

  const response = await getJson<GitHubPullRequestFilesResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/files${query}`,
  );
  if (!response.data) throw new Error(response.message);
  return response.data;
}

export async function getGitHubPullRequestFileDiff(input: {
  repo: string;
  number: number;
  path: string;
  headSha?: string | null;
  baseSha?: string | null;
  baseRef?: string | null;
  source?: 'auto' | 'local' | 'github';
}) {
  const [owner, name] = parseRepo(input.repo);
  const query = prFilesQuery({ ...input, patches: undefined });
  const separator = query ? '&' : '?';
  const response = await getJson<GitHubPullRequestFileDiffResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/files/diff${query}${separator}path=${encodeURIComponent(input.path)}`,
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
    reviewThreadsTruncated: response.data?.reviewThreadsTruncated ?? false,
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
  reanchorHeadSha?: boolean;
}) {
  const [owner, name] = parseRepo(input.repo);
  const body: {
    headSha: string;
    verdict?: GitHubPrReviewVerdict | null;
    body?: string | null;
    reanchorHeadSha?: boolean;
  } = { headSha: input.headSha };
  if ('verdict' in input) body.verdict = input.verdict ?? null;
  if ('body' in input) body.body = input.body ?? null;
  if (input.reanchorHeadSha) body.reanchorHeadSha = true;
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
  path?: string;
  side?: 'RIGHT' | 'LEFT';
  line?: number;
  startLine?: number | null;
  startSide?: 'RIGHT' | 'LEFT' | null;
}) {
  const [owner, name] = parseRepo(input.repo);
  const body: {
    body: string;
    path?: string;
    side?: 'RIGHT' | 'LEFT';
    line?: number;
    startLine?: number | null;
    startSide?: 'RIGHT' | 'LEFT' | null;
  } = { body: input.body };
  if ('path' in input) body.path = input.path;
  if ('side' in input) body.side = input.side;
  if ('line' in input) body.line = input.line;
  if ('startLine' in input) body.startLine = input.startLine ?? null;
  if ('startSide' in input) body.startSide = input.startSide ?? null;
  const response = await patchJson<GitHubPrReviewDraftResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/review-draft/comments/${encodeURIComponent(input.id)}`,
    body,
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
  headSha: string;
  body: string | null;
  verdict: GitHubPrReviewVerdict;
  commentIds?: string[];
}) {
  const [owner, name] = parseRepo(input.repo);
  const response = await postJson<GitHubPrReviewSubmitResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/reviews`,
    {
      headSha: input.headSha,
      body: input.body,
      verdict: input.verdict,
      commentIds: input.commentIds,
    },
  );
  if (!response.ok) throw new Error(response.message);
  return response.data;
}

export async function postGitHubPrThreadReply(input: {
  repo: string;
  number: number;
  threadId: string;
  text: string;
}) {
  const [owner, name] = parseRepo(input.repo);
  const response = await postJson<GitHubPrThreadMutationResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/review-threads/${encodeURIComponent(input.threadId)}/reply`,
    { text: input.text },
  );
  if (!response.data?.thread) throw new Error(response.message);
  return response.data.thread;
}

export async function postGitHubPrThreadResolution(input: {
  repo: string;
  number: number;
  threadId: string;
  resolved: boolean;
}) {
  const [owner, name] = parseRepo(input.repo);
  const response = await postJson<GitHubPrThreadMutationResponse>(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${input.number}/review-threads/${encodeURIComponent(input.threadId)}/${input.resolved ? 'resolve' : 'unresolve'}`,
    {},
  );
  if (!response.data?.thread) throw new Error(response.message);
  return response.data.thread;
}

function parseRepo(repo: string): [string, string] {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid GitHub repository "${repo}".`);
  }
  return [parts[0], parts[1]];
}

function prFilesQuery(input: {
  headSha?: string | null;
  baseSha?: string | null;
  baseRef?: string | null;
  patches?: 'all' | 'none';
  source?: 'auto' | 'local' | 'github';
}) {
  const params = new URLSearchParams();
  if (input.headSha) params.set('head', input.headSha);
  if (input.baseSha) params.set('base', input.baseSha);
  if (input.baseRef) params.set('baseRef', input.baseRef);
  if (input.patches) params.set('patches', input.patches);
  if (input.source) params.set('source', input.source);
  const text = params.toString();
  return text ? `?${text}` : '';
}
