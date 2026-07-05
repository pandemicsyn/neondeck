import * as v from 'valibot';

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
  relations: PullRequestQueueRelation[];
  ageDays: number;
  stale: boolean;
  headSha: string | null;
  baseRef: string | null;
  checks: GitHubCheckSummary | null;
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

export type GitHubPullRequestQueue = {
  login: string;
  repos: string[];
  items: GitHubPullRequest[];
  fetchedAt: string;
  truncated: boolean;
  issues: GitHubQueueIssue[];
};

export type PullRequestQueueRelation =
  'authored' | 'assigned' | 'review-requested' | 'configured-repo';

export type PullRequestSearchResult = {
  items: GitHubPullRequest[];
  truncated: boolean;
  issues: GitHubQueueIssue[];
};

export type GitHubPullRequestDetail = {
  number: number;
  title: string;
  repo: string;
  url: string;
  state: string;
  draft?: boolean;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  headRef?: string | null;
  headOwner?: string | null;
  headName?: string | null;
  headRepoFullName?: string | null;
  baseRef: string;
  baseSha?: string | null;
  baseRepoFullName?: string | null;
  mergeable?: boolean | null;
  mergeableState?: string | null;
  maintainerCanModify?: boolean;
  updatedAt: string;
};

export type GitHubCheckSummary = {
  status: 'success' | 'failure' | 'pending' | 'none';
  total: number;
  successful: number;
  failed: number;
  pending: number;
  statusContexts?: number;
  checkedAt: string;
};

export type GitHubPullRequestCommit = {
  sha: string;
  url: string;
  authorLogin: string | null;
  committedAt: string | null;
};

export type GitHubPullRequestFile = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  binary: boolean;
  generatedLike: boolean;
  patch: string | null;
  truncated: boolean;
  sha: string | null;
  htmlUrl: string | null;
  rawUrl: string | null;
  contentsUrl: string | null;
  message: string | null;
};

export const githubPullRequestFileSchema = v.object({
  path: v.string(),
  previousPath: v.nullable(v.string()),
  status: v.string(),
  additions: v.number(),
  deletions: v.number(),
  changes: v.number(),
  binary: v.boolean(),
  generatedLike: v.boolean(),
  patch: v.nullable(v.string()),
  truncated: v.boolean(),
  sha: v.nullable(v.string()),
  htmlUrl: v.nullable(v.string()),
  rawUrl: v.nullable(v.string()),
  contentsUrl: v.nullable(v.string()),
  message: v.nullable(v.string()),
});

export type GitHubPullRequestFiles = {
  repo: string;
  number: number;
  files: GitHubPullRequestFile[];
  diffSummary: GitHubDiffSummary;
  fetchedAt: string;
};

export type GitHubDiffSummary = {
  files: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
};

export type GitHubPullRequestReview = {
  id: number;
  nodeId: string | null;
  state: string;
  authorLogin: string | null;
  submittedAt: string | null;
  commitId: string | null;
  url: string | null;
};

export type GitHubSubmittedPullRequestReview = GitHubPullRequestReview & {
  body: string | null;
};

export type GitHubPullRequestRequestedChangesState = {
  active: GitHubPullRequestReview[];
  latestByReviewer: GitHubPullRequestReview[];
  history: GitHubPullRequestReview[];
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

export type GitHubCheckSuiteDetail = {
  id: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  appSlug: string | null;
  url: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type GitHubCheckRunDetail = {
  id: number;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  htmlUrl: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type GitHubCheckAnnotation = {
  path: string;
  startLine: number | null;
  endLine: number | null;
  annotationLevel: string;
  message: string;
  title: string | null;
  rawDetails: string | null;
};

export type GitHubFailingCheckFact = GitHubCheckRunDetail & {
  outputTitle: string | null;
  outputSummary: string | null;
  outputText: string | null;
  annotations: GitHubCheckAnnotation[];
  log: {
    available: boolean;
    source: 'github-actions-job' | null;
    text: string | null;
    truncated: boolean;
    unavailableReason: string | null;
  };
};

export type GitHubBranchPushPermissions = {
  headRepoFullName: string | null;
  baseRepoFullName: string | null;
  isFork: boolean;
  maintainerCanModify: boolean;
  headRepoPush: boolean | null;
  baseRepoPush: boolean | null;
  canLikelyPush: boolean | null;
  checkedAt: string;
};

export type GitHubPullRequestComment = {
  id: number;
  nodeId: string | null;
  url: string;
  authorLogin: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type GitHubPullRequestEventState = {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  headRef: string | null;
  baseRef: string;
  baseSha: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  maintainerCanModify: boolean;
  commits: GitHubPullRequestCommit[];
  reviewThreads: GitHubPullRequestReviewThread[];
  requestedChangesReviews: GitHubPullRequestReview[];
  requestedChangesState: GitHubPullRequestRequestedChangesState;
  checkSuites: GitHubCheckSuiteDetail[];
  checkRuns: GitHubCheckRunDetail[];
  branchPermissions: GitHubBranchPushPermissions;
  isOutOfDate: boolean;
  fetchedAt: string;
};

export const githubSearchIssueSchema = v.object({
  id: v.number(),
  title: v.string(),
  repository_url: v.string(),
  number: v.number(),
  html_url: v.string(),
  state: v.string(),
  draft: v.optional(v.boolean()),
  user: v.optional(v.object({ login: v.optional(v.string()) })),
  labels: v.optional(v.array(v.object({ name: v.optional(v.string()) }))),
  comments: v.number(),
  updated_at: v.string(),
  created_at: v.string(),
});

export const githubSearchIssuesApiResponseSchema = v.object({
  total_count: v.number(),
  items: v.array(githubSearchIssueSchema),
});

export const githubPullRequestApiResponseSchema = v.object({
  number: v.number(),
  title: v.string(),
  html_url: v.string(),
  state: v.string(),
  draft: v.optional(v.boolean()),
  merged: v.boolean(),
  merge_commit_sha: v.nullable(v.string()),
  mergeable: v.optional(v.nullable(v.boolean())),
  mergeable_state: v.optional(v.nullable(v.string())),
  maintainer_can_modify: v.optional(v.boolean()),
  updated_at: v.string(),
  head: v.object({
    sha: v.string(),
    ref: v.optional(v.string()),
    repo: v.optional(
      v.nullable(
        v.object({
          full_name: v.string(),
          name: v.string(),
          owner: v.object({ login: v.string() }),
        }),
      ),
    ),
  }),
  base: v.object({
    sha: v.optional(v.string()),
    ref: v.string(),
    repo: v.optional(
      v.nullable(
        v.object({
          full_name: v.string(),
        }),
      ),
    ),
  }),
});

export const githubCheckRunsApiResponseSchema = v.object({
  check_runs: v.optional(
    v.array(
      v.object({
        id: v.optional(v.number()),
        name: v.optional(v.string()),
        head_sha: v.optional(v.string()),
        status: v.string(),
        conclusion: v.nullable(v.string()),
        url: v.optional(v.nullable(v.string())),
        html_url: v.optional(v.nullable(v.string())),
        details_url: v.optional(v.nullable(v.string())),
        started_at: v.optional(v.nullable(v.string())),
        completed_at: v.optional(v.nullable(v.string())),
        output: v.optional(
          v.nullable(
            v.object({
              title: v.optional(v.nullable(v.string())),
              summary: v.optional(v.nullable(v.string())),
              text: v.optional(v.nullable(v.string())),
            }),
          ),
        ),
      }),
    ),
  ),
});

export type GitHubCheckRun = NonNullable<
  v.InferOutput<typeof githubCheckRunsApiResponseSchema>['check_runs']
>[number];

export const githubCheckRunAnnotationsApiResponseSchema = v.array(
  v.object({
    path: v.string(),
    start_line: v.optional(v.nullable(v.number())),
    end_line: v.optional(v.nullable(v.number())),
    annotation_level: v.string(),
    message: v.string(),
    title: v.optional(v.nullable(v.string())),
    raw_details: v.optional(v.nullable(v.string())),
  }),
);

export const githubCommitStatusApiResponseSchema = v.object({
  statuses: v.optional(
    v.array(
      v.object({
        state: v.picklist(['error', 'failure', 'pending', 'success']),
      }),
    ),
  ),
});

export const githubCheckSuitesApiResponseSchema = v.object({
  check_suites: v.optional(
    v.array(
      v.object({
        id: v.number(),
        head_sha: v.string(),
        status: v.string(),
        conclusion: v.nullable(v.string()),
        url: v.optional(v.nullable(v.string())),
        html_url: v.optional(v.nullable(v.string())),
        created_at: v.optional(v.nullable(v.string())),
        updated_at: v.optional(v.nullable(v.string())),
        app: v.optional(
          v.nullable(
            v.object({
              slug: v.optional(v.nullable(v.string())),
              name: v.optional(v.nullable(v.string())),
            }),
          ),
        ),
      }),
    ),
  ),
});
export type GitHubCheckSuiteApiResponse = v.InferOutput<
  typeof githubCheckSuitesApiResponseSchema
>;

export const githubPullRequestCommitApiItemSchema = v.object({
  sha: v.string(),
  html_url: v.string(),
  author: v.optional(v.nullable(v.object({ login: v.string() }))),
  commit: v.object({
    author: v.optional(v.nullable(v.object({ date: v.string() }))),
    committer: v.optional(v.nullable(v.object({ date: v.string() }))),
  }),
});
export type GitHubPullRequestCommitApiItem = v.InferOutput<
  typeof githubPullRequestCommitApiItemSchema
>;

export const githubPullRequestFileApiItemSchema = v.object({
  sha: v.optional(v.nullable(v.string())),
  filename: v.string(),
  status: v.string(),
  additions: v.number(),
  deletions: v.number(),
  changes: v.number(),
  patch: v.optional(v.nullable(v.string())),
  previous_filename: v.optional(v.nullable(v.string())),
  blob_url: v.optional(v.nullable(v.string())),
  raw_url: v.optional(v.nullable(v.string())),
  contents_url: v.optional(v.nullable(v.string())),
});
export type GitHubPullRequestFileApiItem = v.InferOutput<
  typeof githubPullRequestFileApiItemSchema
>;

export const githubPullRequestReviewApiItemSchema = v.object({
  id: v.number(),
  node_id: v.optional(v.string()),
  state: v.string(),
  user: v.optional(v.nullable(v.object({ login: v.string() }))),
  submitted_at: v.optional(v.nullable(v.string())),
  commit_id: v.optional(v.nullable(v.string())),
  html_url: v.optional(v.nullable(v.string())),
  body: v.optional(v.nullable(v.string())),
});
export type GitHubPullRequestReviewApiItem = v.InferOutput<
  typeof githubPullRequestReviewApiItemSchema
>;

export const githubPullRequestReviewCreatedApiResponseSchema =
  githubPullRequestReviewApiItemSchema;

export const githubRepositoryApiResponseSchema = v.object({
  full_name: v.string(),
  permissions: v.optional(
    v.object({
      admin: v.optional(v.boolean()),
      maintain: v.optional(v.boolean()),
      push: v.optional(v.boolean()),
      triage: v.optional(v.boolean()),
      pull: v.optional(v.boolean()),
    }),
  ),
});

export const githubIssueCommentApiResponseSchema = v.object({
  id: v.number(),
  node_id: v.optional(v.nullable(v.string())),
  html_url: v.string(),
  body: v.string(),
  user: v.optional(v.nullable(v.object({ login: v.string() }))),
  created_at: v.string(),
  updated_at: v.string(),
});

export const githubGraphqlBaseResponseSchema = v.looseObject({
  errors: v.optional(v.array(v.object({ message: v.string() }))),
});

export const githubReviewThreadCommentGraphqlNodeSchema = v.object({
  id: v.string(),
  databaseId: v.optional(v.nullable(v.number())),
  body: v.string(),
  url: v.optional(v.nullable(v.string())),
  author: v.optional(v.nullable(v.object({ login: v.string() }))),
  createdAt: v.string(),
  updatedAt: v.string(),
  path: v.optional(v.nullable(v.string())),
  line: v.optional(v.nullable(v.number())),
  originalLine: v.optional(v.nullable(v.number())),
  diffHunk: v.optional(v.nullable(v.string())),
  pullRequestReview: v.optional(
    v.nullable(
      v.object({
        databaseId: v.optional(v.nullable(v.number())),
      }),
    ),
  ),
});
export type GitHubReviewThreadCommentGraphqlNode = v.InferOutput<
  typeof githubReviewThreadCommentGraphqlNodeSchema
>;

const githubReviewThreadPullRequestGraphqlSchema = v.object({
  number: v.number(),
  repository: v.object({
    nameWithOwner: v.string(),
  }),
});

export const githubReviewThreadsGraphqlResponseSchema = v.object({
  data: v.object({
    repository: v.nullable(
      v.object({
        pullRequest: v.nullable(
          v.object({
            reviewThreads: v.object({
              pageInfo: v.object({
                hasNextPage: v.boolean(),
                endCursor: v.nullable(v.string()),
              }),
              nodes: v.optional(
                v.array(
                  v.object({
                    id: v.string(),
                    isResolved: v.boolean(),
                    isOutdated: v.boolean(),
                    path: v.optional(v.nullable(v.string())),
                    line: v.optional(v.nullable(v.number())),
                    originalLine: v.optional(v.nullable(v.number())),
                    diffSide: v.optional(v.string()),
                    pullRequest: v.optional(
                      v.nullable(githubReviewThreadPullRequestGraphqlSchema),
                    ),
                    comments: v.object({
                      pageInfo: v.object({
                        hasNextPage: v.boolean(),
                        endCursor: v.nullable(v.string()),
                      }),
                      nodes: v.optional(
                        v.array(githubReviewThreadCommentGraphqlNodeSchema),
                      ),
                    }),
                  }),
                ),
              ),
            }),
          }),
        ),
      }),
    ),
  }),
});
export type GitHubReviewThreadGraphqlNode = NonNullable<
  NonNullable<
    NonNullable<
      v.InferOutput<
        typeof githubReviewThreadsGraphqlResponseSchema
      >['data']['repository']
    >['pullRequest']
  >['reviewThreads']['nodes']
>[number];

export const githubReviewThreadCommentsGraphqlResponseSchema = v.object({
  data: v.object({
    node: v.nullable(
      v.object({
        comments: v.object({
          pageInfo: v.object({
            hasNextPage: v.boolean(),
            endCursor: v.nullable(v.string()),
          }),
          nodes: v.optional(
            v.array(githubReviewThreadCommentGraphqlNodeSchema),
          ),
        }),
      }),
    ),
  }),
});

export const githubReviewThreadNodeGraphqlResponseSchema = v.object({
  data: v.object({
    node: v.nullable(
      v.object({
        id: v.string(),
        isResolved: v.boolean(),
        isOutdated: v.boolean(),
        path: v.optional(v.nullable(v.string())),
        line: v.optional(v.nullable(v.number())),
        originalLine: v.optional(v.nullable(v.number())),
        diffSide: v.optional(v.string()),
        pullRequest: v.optional(
          v.nullable(githubReviewThreadPullRequestGraphqlSchema),
        ),
        comments: v.object({
          pageInfo: v.object({
            hasNextPage: v.boolean(),
            endCursor: v.nullable(v.string()),
          }),
          nodes: v.optional(
            v.array(githubReviewThreadCommentGraphqlNodeSchema),
          ),
        }),
      }),
    ),
  }),
});
export type GitHubReviewThreadNodeGraphqlNode = NonNullable<
  v.InferOutput<
    typeof githubReviewThreadNodeGraphqlResponseSchema
  >['data']['node']
>;

export const pullRequestReviewThreadsQuery = `
  query NeondeckPullRequestReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            originalLine
            diffSide
            pullRequest {
              number
              repository {
                nameWithOwner
              }
            }
            comments(first: 100) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                databaseId
                body
                url
                author {
                  login
                }
                createdAt
                updatedAt
                path
                line
                originalLine
                diffHunk
                pullRequestReview {
                  databaseId
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const reviewThreadCommentsQuery = `
  query NeondeckPullRequestReviewThreadComments($threadId: ID!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            databaseId
            body
            url
            author {
              login
            }
            createdAt
            updatedAt
            path
            line
            originalLine
            diffHunk
            pullRequestReview {
              databaseId
            }
          }
        }
      }
    }
  }
`;

export const pullRequestReviewThreadNodeQuery = `
  query NeondeckPullRequestReviewThread($threadId: ID!) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        id
        isResolved
        isOutdated
        path
        line
        originalLine
        diffSide
        pullRequest {
          number
          repository {
            nameWithOwner
          }
        }
        comments(first: 100) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            databaseId
            body
            url
            author {
              login
            }
            createdAt
            updatedAt
            path
            line
            originalLine
            diffHunk
            pullRequestReview {
              databaseId
            }
          }
        }
      }
    }
  }
`;

export type GitHubSearchIssue = v.InferOutput<typeof githubSearchIssueSchema>;
