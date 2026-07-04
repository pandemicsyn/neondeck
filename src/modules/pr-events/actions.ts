import { defineAction, defineTool } from '@flue/runtime';
import {
  getGitHubPrBranchPermissions,
  getGitHubPrEventState,
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
  prWatchEventWatermarkListInputSchema,
} from './schemas';

export const githubPrEventStateGetAction = defineAction({
  name: 'neondeck_github_pr_event_state_get',
  description:
    'Fetch read-only GitHub PR event facts: commits, review threads, requested-changes reviews, checks, mergeability, out-of-date state, and branch push permissions.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrEventState(input);
  },
});

export const githubPrReviewThreadsGetAction = defineAction({
  name: 'neondeck_github_pr_review_threads_get',
  description:
    'Fetch read-only GitHub PR review thread state, including unresolved and resolved threads.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrReviewThreads(input);
  },
});

export const githubPrRequestedChangesGetAction = defineAction({
  name: 'neondeck_github_pr_requested_changes_get',
  description:
    'Fetch read-only requested-changes review state for a GitHub PR.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrRequestedChanges(input);
  },
});

export const githubPrBranchPermissionsGetAction = defineAction({
  name: 'neondeck_github_pr_branch_permissions_get',
  description:
    'Fetch read-only branch push permission facts for a GitHub PR without pushing or commenting.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrBranchPermissions(input);
  },
});

export const prCommentAction = defineAction({
  name: 'neondeck_pr_comment',
  description:
    'Post a GitHub PR summary comment with optional addressed review feedback, commit, and check metadata.',
  input: prCommentInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return postGitHubPrComment(input);
  },
});

export const prReviewCommentsLookupTool = defineTool({
  name: 'neondeck_pr_review_comments_lookup',
  description:
    'Fetch unresolved GitHub PR review comments and review thread metadata.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrReviewThreads(input);
  },
});

export const prRequestedChangesLookupTool = defineTool({
  name: 'neondeck_pr_requested_changes_lookup',
  description: 'Fetch current requested-changes review state for a GitHub PR.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrRequestedChanges(input);
  },
});

export const prBranchPermissionsLookupTool = defineTool({
  name: 'neondeck_pr_branch_permissions_lookup',
  description:
    'Fetch branch push permission facts for a GitHub PR without pushing.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return getGitHubPrBranchPermissions(input);
  },
});

export const prWatchEventStateRefreshAction = defineAction({
  name: 'neondeck_pr_watch_event_state_refresh',
  description:
    'Refresh a watched PR event-state snapshot and persist per-category event watermarks.',
  input: prEventTargetInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return refreshPrWatchEventState(input);
  },
});

export const prWatchEventWatermarksListAction = defineAction({
  name: 'neondeck_pr_watch_event_watermarks_list',
  description: 'List persisted per-watch PR event watermarks.',
  input: prWatchEventWatermarkListInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return listPrWatchEventWatermarks(input);
  },
});

export const prWatchEventWatermarksLookupTool = defineTool({
  name: 'neondeck_pr_watch_event_watermarks_lookup',
  description:
    'Read persisted PR watch event watermarks without refreshing GitHub.',
  input: prWatchEventWatermarkListInputSchema,
  output: prEventOutputSchema,
  async run({ input }) {
    return listPrWatchEventWatermarks(input);
  },
});

export const neondeckPrEventActions = [
  githubPrEventStateGetAction,
  githubPrReviewThreadsGetAction,
  githubPrRequestedChangesGetAction,
  githubPrBranchPermissionsGetAction,
  prCommentAction,
  prWatchEventStateRefreshAction,
  prWatchEventWatermarksListAction,
];

export const neondeckPrEventTools = [
  prReviewCommentsLookupTool,
  prRequestedChangesLookupTool,
  prBranchPermissionsLookupTool,
  prWatchEventWatermarksLookupTool,
];
