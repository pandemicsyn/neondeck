import type { JsonValue } from '@flue/runtime';
import type { GitHubCheckSummary, GitHubPullRequestDetail } from '../github';
import * as v from 'valibot';

export type PrWatchStatus =
  'watching' | 'merged' | 'closed' | 'green' | 'attention-needed' | 'unknown';
export type RefWatchStatus =
  'watching' | 'green' | 'attention-needed' | 'unknown';

export type DesiredTerminalState = 'checks' | 'merged' | 'prod';
export type WatchOutcome = 'created' | 'updated' | 'removed' | 'silent';

export type WatchActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  outcome?: WatchOutcome;
  id?: string;
  deckUrl?: string;
  message: string;
  watch?: JsonValue;
  watches?: JsonValue[];
  requires?: string[];
  errors?: string[];
};

export type PrWatch = {
  id: string;
  repoId: string;
  repoFullName: string;
  githubOwner: string;
  githubName: string;
  prNumber: number;
  desiredTerminalState: DesiredTerminalState;
  status: PrWatchStatus;
  prState: string | null;
  title: string | null;
  url: string | null;
  mergeCommitSha: string | null;
  lastSnapshot: PrWatchSnapshot | null;
  lastOutcome: WatchOutcome | null;
  lastCheckedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PrWatchSnapshot = {
  state: string;
  merged: boolean;
  mergeCommitSha: string | null;
  checks: GitHubCheckSummary | null;
  title: string;
  url: string;
  updatedAt: string;
  headSha: string;
  baseRef: string;
};

export type RefWatch = {
  id: string;
  repoId: string;
  repoFullName: string;
  githubOwner: string;
  githubName: string;
  ref: string;
  status: RefWatchStatus;
  title: string | null;
  url: string | null;
  lastSnapshot: RefWatchSnapshot | null;
  lastOutcome: WatchOutcome | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RefWatchSnapshot = {
  ref: string;
  checks: GitHubCheckSummary;
  url: string;
  checkedAt: string;
};

export type ResolvedPrReference = {
  id: string;
  repoId: string;
  repoFullName: string;
  githubOwner: string;
  githubName: string;
  prNumber: number;
  desiredTerminalState: DesiredTerminalState;
};

export type ResolvedRefReference = {
  id: string;
  repoId: string;
  repoFullName: string;
  githubOwner: string;
  githubName: string;
  ref: string;
};

export type WatchFetcher = (
  watch: ResolvedPrReference,
) => Promise<GitHubPullRequestDetail>;
export type CheckFetcher = (
  watch: ResolvedPrReference | ResolvedRefReference,
  ref: string,
) => Promise<GitHubCheckSummary>;

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const desiredTerminalStateSchema = v.optional(
  v.picklist(['checks', 'merged', 'prod']),
);

export const watchPrAddInputSchema = v.object({
  ref: nonEmptyStringSchema,
  desiredTerminalState: desiredTerminalStateSchema,
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
  createdBy: v.optional(nonEmptyStringSchema),
});

export const watchPrRemoveInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  confirm: v.optional(v.boolean()),
});

export const watchPrPollingInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  enabled: v.boolean(),
});

export const watchPrRefreshInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
});
export const watchRefAddInputSchema = v.object({
  repo: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  target: v.optional(nonEmptyStringSchema),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
});
export const watchRefRefreshInputSchema = v.object({
  id: v.optional(nonEmptyStringSchema),
  repo: v.optional(nonEmptyStringSchema),
  ref: v.optional(nonEmptyStringSchema),
  target: v.optional(nonEmptyStringSchema),
});
export const watchActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
