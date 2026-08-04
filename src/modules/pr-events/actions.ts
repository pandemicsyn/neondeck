import { defineTool } from '@flue/runtime';
import {
  getGitHubPrBranchPermissions,
  getGitHubPrEventState,
  getGitHubPrFileDiff,
  getGitHubPrFiles,
  getGitHubPrRequestedChanges,
  getGitHubPrReviewThreads,
  listPrWatchEventWatermarks,
  postGitHubPrComment,
  refreshPrWatchEventState,
} from './service';
import {
  prCommentInputSchema,
  prEventOutputSchema,
  prEventTargetInputSchema,
  prFileDiffInputSchema,
  prFilesInputSchema,
  prWatchEventWatermarkListInputSchema,
} from './schemas';

export const githubPrEventStateGetAction = defineTool({
  name: 'neondeck_github_pr_event_state_get',
  description:
    'Fetch read-only GitHub PR event facts: commits, review threads, requested-changes reviews, checks, mergeability, out-of-date state, and branch push permissions.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await getGitHubPrEventState(input) };
  },
});

export const githubPrReviewThreadsGetAction = defineTool({
  name: 'neondeck_github_pr_review_threads_get',
  description:
    'Fetch read-only GitHub PR review thread state, including unresolved and resolved threads.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await getGitHubPrReviewThreads(input) };
  },
});

export const githubPrFilesGetAction = defineTool({
  name: 'neondeck_github_pr_files_get',
  description:
    'Fetch read-only GitHub PR file diffs and per-file patch metadata.',
  input: prFilesInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await getGitHubPrFiles(input) };
  },
});

export const githubPrFileDiffGetAction = defineTool({
  name: 'neondeck_github_pr_file_diff_get',
  description: 'Fetch a single read-only GitHub PR file diff patch by path.',
  input: prFileDiffInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await getGitHubPrFileDiff(input) };
  },
});

export const githubPrRequestedChangesGetAction = defineTool({
  name: 'neondeck_github_pr_requested_changes_get',
  description:
    'Fetch read-only requested-changes review state for a GitHub PR.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await getGitHubPrRequestedChanges(input) };
  },
});

export const githubPrBranchPermissionsGetAction = defineTool({
  name: 'neondeck_github_pr_branch_permissions_get',
  description:
    'Fetch read-only branch push permission facts for a GitHub PR without pushing or commenting.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await getGitHubPrBranchPermissions(input) };
  },
});

export const prCommentAction = defineTool({
  name: 'neondeck_pr_comment',
  description:
    'Post a GitHub PR summary comment with optional addressed review feedback, commit, and check metadata.',
  input: prCommentInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await postGitHubPrComment(input) };
  },
});

export const prReviewCommentsLookupTool = defineTool({
  name: 'neondeck_pr_review_comments_lookup',
  description:
    'Fetch unresolved GitHub PR review comments and review thread metadata.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await getGitHubPrReviewThreads(input) };
  },
});

export const prFileDiffLookupTool = defineTool({
  name: 'neondeck_pr_file_diff_lookup',
  description:
    'Fetch one GitHub PR file diff patch by path without loading every PR file patch.',
  input: prFileDiffInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await getGitHubPrFileDiff(input) };
  },
});

export const prRequestedChangesLookupTool = defineTool({
  name: 'neondeck_pr_requested_changes_lookup',
  description: 'Fetch current requested-changes review state for a GitHub PR.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await getGitHubPrRequestedChanges(input) };
  },
});

export const prBranchPermissionsLookupTool = defineTool({
  name: 'neondeck_pr_branch_permissions_lookup',
  description:
    'Fetch branch push permission facts for a GitHub PR without pushing.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await getGitHubPrBranchPermissions(input) };
  },
});

export const prWatchEventStateRefreshAction = defineTool({
  name: 'neondeck_pr_watch_event_state_refresh',
  description:
    'Refresh a watched PR event-state snapshot and persist per-category event watermarks.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await refreshPrWatchEventState(input) };
  },
});

export const prWatchEventWatermarksListAction = defineTool({
  name: 'neondeck_pr_watch_event_watermarks_list',
  description: 'List persisted per-watch PR event watermarks.',
  input: prWatchEventWatermarkListInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await listPrWatchEventWatermarks(input) };
  },
});

export const prWatchEventWatermarksLookupTool = defineTool({
  name: 'neondeck_pr_watch_event_watermarks_lookup',
  description:
    'Read persisted PR watch event watermarks without refreshing GitHub.',
  input: prWatchEventWatermarkListInputSchema,
  output: prEventOutputSchema,
  async run({ data: input }) {
    return { output: await listPrWatchEventWatermarks(input) };
  },
});

export const neondeckPrEventActions = [
  githubPrEventStateGetAction,
  githubPrReviewThreadsGetAction,
  githubPrFilesGetAction,
  githubPrFileDiffGetAction,
  githubPrRequestedChangesGetAction,
  githubPrBranchPermissionsGetAction,
  prCommentAction,
  prWatchEventStateRefreshAction,
  prWatchEventWatermarksListAction,
];

export const neondeckPrEventTools = [
  prReviewCommentsLookupTool,
  prFileDiffLookupTool,
  prRequestedChangesLookupTool,
  prBranchPermissionsLookupTool,
  prWatchEventWatermarksLookupTool,
];
