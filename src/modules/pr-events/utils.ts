/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  fetchPullRequestEventState,
  postPullRequestComment,
  type GitHubPullRequestEventState,
} from '../../github';
import { readRepoRegistrySnapshot, repoFullName } from '../../repos';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  listPrWatchRecords,
  parseWatchPrReference,
  type PrWatch,
} from '../../watch-actions';
import { type PrEventActionResult, type PullRequestTarget } from './schemas';

export function eventTargetJson(target: PullRequestTarget): JsonValue {
  return {
    repoFullName: target.repoFullName,
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    watchId: target.watch?.id ?? null,
  };
}

export function okResult(
  action: string,
  changed: boolean,
  message: string,
  data: JsonValue,
): PrEventActionResult {
  return {
    ok: true,
    action,
    changed,
    message,
    data,
  };
}

export function failResult(
  action: string,
  message: string,
  details: Pick<PrEventActionResult, 'errors' | 'requires'> = {},
): PrEventActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message,
    ...(details.requires ? { requires: details.requires } : {}),
    ...(details.errors ? { errors: details.errors } : {}),
  };
}

export function maxString(values: Array<string | null | undefined>) {
  const filtered = values.filter((value): value is string => Boolean(value));
  if (filtered.length === 0) return null;
  return filtered.sort((a, b) => b.localeCompare(a))[0];
}

export function stableJson(value: unknown) {
  return JSON.stringify(value);
}

export function isFailingConclusion(value: string | null) {
  return [
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'startup_failure',
  ].includes(value ?? '');
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
