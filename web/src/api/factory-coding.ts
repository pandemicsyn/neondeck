import * as v from 'valibot';
import {
  factoryCodingStateSchema,
  factoryCodingPageSchema,
  factoryCodingRunSchema,
  factoryCodingEventsSchema,
  factoryCodingLogsSchema,
  factoryCodingControlSchema,
  factoryCodingConfigInputSchema,
  type FactoryCodingConfig,
} from '../../../shared/factory-coding';
import { getJson, postJson, type ApiRequestOptions } from './http';
import type { PreparedDiffRecord } from './types';

const prefix = '/api/factory/coding';
export async function getFactoryCodingState(options: ApiRequestOptions = {}) {
  return v.parse(
    factoryCodingStateSchema,
    await getJson<unknown>(`${prefix}/state`, options),
  );
}
export async function saveFactoryCodingConfig(
  config: FactoryCodingConfig,
  expectedFingerprint: string,
) {
  return v.parse(
    factoryCodingStateSchema,
    await postJson<unknown>(
      `${prefix}/config`,
      v.parse(factoryCodingConfigInputSchema, { expectedFingerprint, config }),
    ),
  );
}
export async function getFactoryCodingRuns(
  workId: string,
  after = 0,
  options: ApiRequestOptions = {},
) {
  const params = new URLSearchParams({
    workId,
    after: String(after),
    limit: '25',
  });
  const page = v.parse(
    factoryCodingPageSchema,
    await getJson<unknown>(`${prefix}/runs?${params}`, options),
  );
  if (page.attention && page.attention.workId !== workId)
    throw new Error('Admission attention does not match this task.');
  return page;
}
export async function getFactoryCodingRun(
  id: string,
  options: ApiRequestOptions = {},
) {
  const run = v.parse(
    factoryCodingRunSchema,
    await getJson<unknown>(`${prefix}/runs/${encodeURIComponent(id)}`, options),
  );
  if (run.record.runId !== id)
    throw new Error('The returned coding run does not match this request.');
  return run;
}
export async function controlFactoryCodingRun(
  id: string,
  action: 'cancel' | 'reconcile',
  expectedVersion: number,
) {
  const result = v.parse(
    factoryCodingRunSchema,
    await postJson<unknown>(
      `${prefix}/runs/${encodeURIComponent(id)}/${action}`,
      v.parse(factoryCodingControlSchema, { expectedVersion }),
    ),
  );
  if (result.record.runId !== id)
    throw new Error('The returned coding run does not match this request.');
  return result;
}
export async function getFactoryCodingEvents(
  id: string,
  after = 0,
  options: ApiRequestOptions = {},
) {
  const page = v.parse(
    factoryCodingEventsSchema,
    await getJson<unknown>(
      `${prefix}/runs/${encodeURIComponent(id)}/events?after=${after}&limit=25`,
      options,
    ),
  );
  if (page.items.some((event) => event.runId !== id))
    throw new Error('Event history does not match this run.');
  return page;
}
export async function getFactoryCodingLogs(
  id: string,
  offset = 0,
  options: ApiRequestOptions = {},
) {
  return v.parse(
    factoryCodingLogsSchema,
    await getJson<unknown>(
      `${prefix}/runs/${encodeURIComponent(id)}/logs?offset=${offset}&limit=16384`,
      options,
    ),
  );
}

// Existing summary route returns the stored record, not the dashboard projection.
// Validate only the fields needed to adapt it to the existing review surface.
const preparedSummarySchema = v.object({
  ok: v.literal(true),
  preparedDiff: v.object({
    id: v.string(),
    repoId: v.string(),
    repoFullName: v.string(),
    prNumber: v.nullable(v.number()),
    worktreeId: v.string(),
    sourceWorktreePath: v.string(),
    title: v.string(),
    status: v.string(),
    pushApprovalStatus: v.string(),
    verificationStatus: v.string(),
    sourceOfTruth: v.literal('worktree'),
    updatedAt: v.string(),
  }),
});
export async function getFactoryCandidateDiff(
  id: string,
  worktreeId: string,
  options: ApiRequestOptions = {},
): Promise<PreparedDiffRecord> {
  const { preparedDiff } = v.parse(
    preparedSummarySchema,
    await getJson<unknown>(
      `/api/prepared-diffs/${encodeURIComponent(id)}/summary`,
      options,
    ),
  );
  if (preparedDiff.id !== id || preparedDiff.worktreeId !== worktreeId)
    throw new Error('The retained diff does not match this candidate.');
  return {
    ...preparedDiff,
    localPath: preparedDiff.sourceWorktreePath,
    summary: '',
    revisionRun: null,
  };
}
