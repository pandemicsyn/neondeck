/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  fetchPullRequestEventState,
  fetchPullRequestFiles,
  replyToPullRequestReviewThread,
  resolvePullRequestReviewThread,
  submitPullRequestReview,
  unresolvePullRequestReviewThread,
  postPullRequestComment,
  type GitHubPullRequestEventState,
} from '../github';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  listPrWatchRecords,
  parseWatchPrReference,
  type PrWatch,
} from '../watches';

export type PrEventActionResult<TData extends JsonValue = JsonValue> = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: TData;
  requires?: string[];
  errors?: string[];
};

export type PrWatchEventWatermarkCategory =
  | 'commits'
  | 'review_threads'
  | 'requested_changes_reviews'
  | 'check_suites'
  | 'check_runs'
  | 'mergeability'
  | 'out_of_date_branch';

export type PrWatchEventWatermarkRecord = {
  watchId: string;
  category: PrWatchEventWatermarkCategory;
  watermark: JsonValue;
  sourceUpdatedAt: string | null;
  checkedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type PullRequestTarget = {
  repoFullName: string;
  owner: string;
  repo: string;
  number: number;
  watch?: PrWatch;
};

export type PrEventStateDependencies = {
  fetchPullRequestEventState?: typeof fetchPullRequestEventState;
  fetchPullRequestFiles?: typeof fetchPullRequestFiles;
  postPullRequestComment?: typeof postPullRequestComment;
  submitPullRequestReview?: typeof submitPullRequestReview;
  replyToPullRequestReviewThread?: typeof replyToPullRequestReviewThread;
  resolvePullRequestReviewThread?: typeof resolvePullRequestReviewThread;
  unresolvePullRequestReviewThread?: typeof unresolvePullRequestReviewThread;
  token?: string;
};

export const watermarkCategories: PrWatchEventWatermarkCategory[] = [
  'commits',
  'review_threads',
  'requested_changes_reviews',
  'check_suites',
  'check_runs',
  'mergeability',
  'out_of_date_branch',
];

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const prEventTargetInputSchema = v.object({
  watchId: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  repo: v.optional(nonEmptyStringSchema),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const prWatchEventWatermarkListInputSchema = v.object({
  watchId: v.optional(nonEmptyStringSchema),
});
export const prCommentInputSchema = v.object({
  watchId: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  repo: v.optional(nonEmptyStringSchema),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(65_536)),
  addressedReviewThreadIds: v.optional(v.array(nonEmptyStringSchema)),
  addressedReviewCommentIds: v.optional(v.array(nonEmptyStringSchema)),
  checkRunIds: v.optional(v.array(v.pipe(v.number(), v.integer()))),
  commitSha: v.optional(nonEmptyStringSchema),
});
export const prReviewVerdictSchema = v.picklist([
  'comment',
  'approve',
  'request-changes',
]);
export const prReviewDraftInputSchema = v.object({
  headSha: nonEmptyStringSchema,
  verdict: v.optional(v.nullable(prReviewVerdictSchema)),
  body: v.optional(v.nullable(v.string())),
});
export const prReviewDraftCommentInputSchema = v.object({
  draftId: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  side: v.picklist(['RIGHT', 'LEFT']),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  startLine: v.optional(
    v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  ),
  startSide: v.optional(v.nullable(v.picklist(['RIGHT', 'LEFT']))),
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(65_536)),
});
export const prReviewDraftCommentUpdateInputSchema = v.object({
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(65_536)),
});
export const prReviewSubmitInputSchema = v.object({
  draftId: nonEmptyStringSchema,
  headSha: nonEmptyStringSchema,
  commentIds: v.optional(v.array(nonEmptyStringSchema)),
});
export const prReviewThreadReplyInputSchema = v.object({
  text: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(65_536)),
});
export const prEventOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
