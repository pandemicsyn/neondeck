import type { JsonValue } from '@flue/runtime';
import type { WorkflowSummaryRecord } from '../app-state';
import type { fetchGitHubLogin, fetchPullRequestQueue } from '../github';
import type { CiFixRunInput, createCiFailureDossierReport } from '../autopilot';
import type { PrReviewAssistInput } from '../pr-review-assist';
import type { addPrWatch } from '../watches';
import * as v from 'valibot';

export type NeonCommandName =
  | 'repo-status'
  | 'review-queue'
  | 'review-pr'
  | 'fix-ci'
  | 'explain-ci'
  | 'summarize-pr'
  | 'draft-pr-description'
  | 'prepare-pr'
  | 'review-local'
  | 'briefing'
  | 'reasoning'
  | 'memory'
  | 'watch-pr'
  | 'dev-doctor';

export type ParsedNeonCommand = {
  name: NeonCommandName;
  args: string[];
  raw: string;
};

export type NeonCommandResult = {
  ok: boolean;
  command: NeonCommandName;
  input: string;
  status: 'completed' | 'failed' | 'needs-config';
  message: string;
  data?: JsonValue;
  errors?: string[];
  requires?: string[];
  workflowSummary?: WorkflowSummaryRecord;
};

export type CommandDependencies = {
  fetchPullRequestQueue?: typeof fetchPullRequestQueue;
  fetchGitHubLogin?: typeof fetchGitHubLogin;
  invokeReviewPrWorkflow?: (
    input: PrReviewAssistInput,
  ) => Promise<{ runId: string }>;
  invokeFixCiWorkflow?: (input: CiFixRunInput) => Promise<{ runId: string }>;
  createCiFailureDossierReport?: typeof createCiFailureDossierReport;
  addPrWatch?: typeof addPrWatch;
};

export type CommandExecutionContext = {
  sessionId?: string;
  surface?: string;
};

export type ReviewQueueAction = {
  title: string;
  reason: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  url?: string | null;
  repo?: string;
  number?: number;
};

export const commandRunInputSchema = v.object({
  command: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.optional(v.pipe(v.string(), v.minLength(1))),
  surface: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
});
export const workflowSummaryRecordSchema = v.looseObject({
  id: v.string(),
  workflow: v.string(),
  runId: v.nullable(v.string()),
  status: v.string(),
  summary: v.nullable(v.unknown()),
  createdAt: v.string(),
  updatedAt: v.string(),
});
export const supportedCommandSchema = v.object({
  name: v.string(),
  usage: v.string(),
  description: v.string(),
});
export const commandRunOutputSchema = v.looseObject({
  ok: v.boolean(),
  command: v.string(),
  input: v.string(),
  status: v.picklist(['completed', 'failed', 'needs-config']),
  message: v.string(),
  data: v.optional(v.unknown()),
  errors: v.optional(v.array(v.string())),
  requires: v.optional(v.array(v.string())),
  workflowSummary: v.optional(workflowSummaryRecordSchema),
});
export const commandActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.optional(v.string()),
  commands: v.optional(v.array(supportedCommandSchema)),
  summaries: v.optional(v.array(workflowSummaryRecordSchema)),
  errors: v.optional(v.array(v.string())),
  requires: v.optional(v.array(v.string())),
});
