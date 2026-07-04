/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  fetchPullRequestEventState,
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
  postPullRequestComment?: typeof postPullRequestComment;
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
export const prEventOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
