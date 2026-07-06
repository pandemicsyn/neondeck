import { spawn } from 'node:child_process';
import { type WriteStream } from 'node:fs';
import * as v from 'valibot';
import { type RepoConfig } from '../../runtime-home';
import {
  type KiloHandoffMode,
  type KiloTaskEventRecord,
  type KiloTaskRecord,
  type KiloTaskStatus,
} from './store';

export type {
  KiloHandoffMode,
  KiloTaskEventRecord,
  KiloTaskRecord,
  KiloTaskStatus,
};

export type KiloResultPlaceholder = {
  type: 'review' | 'verification' | 'promotion';
  status: 'pending' | 'blocked' | 'unavailable';
  workflow: 'review_kilo_result' | 'verify_kilo_result' | 'promote_kilo_result';
  reason: string;
};

export type KiloChildSessionNode = {
  id: string;
  title: string;
  status: 'unknown' | 'active' | 'completed';
  latestSummary: string | null;
  eventCount: number;
  collapsed: boolean;
};

export type KiloSessionReadOptions = {
  limit: number;
  offset: number;
  includeFullTranscript: boolean;
  includeToolOutput: boolean;
  includeDiff: boolean;
  maxBytes: number;
  requesterSurface: string;
  readReason: string | null;
};

export type WorkspaceResolution = {
  repo: RepoConfig;
  repoFullName: string;
  cwd: string;
  worktreeId: string | null;
  lockId: string | null;
  lockOwner: string | null;
  managedWorktree: boolean;
};

export type RunningProcess = {
  child: ReturnType<typeof spawn>;
  rawLog?: WriteStream;
  completed: Promise<void>;
};

export type ResolvedKiloConfig = {
  enabled: boolean;
  cliPath: string;
  defaultModel?: string;
  defaultAgent?: string;
  defaultMode: KiloHandoffMode;
  autoPolicy: 'never' | 'managed-worktree-draft-fix' | 'explicit-confirmation';
  explicitHandoffOnly: boolean;
  concurrency: number;
  rawLogRetentionDays: number;
  repos: Record<string, 'allow' | 'deny'>;
};

export const runningProcesses = new Map<string, RunningProcess>();
export const terminalTaskIds = new Set<string>();

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const taskIdSchema = v.pipe(
  nonEmptyStringSchema,
  v.maxLength(128),
  v.regex(/^[A-Za-z0-9._:-]+$/),
);
export const positiveIntegerSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
);
export const handoffModeSchema = v.picklist([
  'draft-fix',
  'patch-proposal',
  'direct-edit',
]);
export const taskStatusSchema = v.picklist([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'needs-reconcile',
  'needs-review',
  'ready-to-verify',
  'ready-to-push',
  'discarded',
  'unknown',
]);
export const kiloNotificationStateSchema = v.picklist([
  'started',
  'progress',
  'waiting-approval',
  'completed',
  'failed',
  'timed-out',
  'needs-review',
  'verified',
  'promote-blocked',
  'promoted',
]);
export const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
export const notificationFactOutputSchema = v.object({
  id: v.string(),
  taskId: v.string(),
  state: kiloNotificationStateSchema,
  level: v.picklist(['info', 'ready', 'attention', 'urgent']),
  title: v.string(),
  message: v.string(),
  readAt: v.nullable(v.string()),
  resolvedAt: v.nullable(v.string()),
  occurrenceCount: v.number(),
  updatedAt: v.string(),
});
export const resultPlaceholderOutputSchema = v.object({
  type: v.picklist(['review', 'verification', 'promotion']),
  status: v.picklist(['pending', 'blocked', 'unavailable']),
  workflow: v.picklist([
    'review_kilo_result',
    'verify_kilo_result',
    'promote_kilo_result',
  ]),
  reason: v.string(),
});
export const enrichedTaskOutputSchema = v.looseObject({
  id: v.string(),
  title: v.string(),
  repoId: v.string(),
  repoFullName: v.string(),
  worktreeId: v.nullable(v.string()),
  cwd: v.string(),
  status: taskStatusSchema,
  rootSessionId: v.nullable(v.string()),
  childSessionIds: v.array(v.string()),
  updatedAt: v.string(),
  notificationFacts: v.optional(v.array(notificationFactOutputSchema)),
  latestNotificationState: v.optional(v.nullable(kiloNotificationStateSchema)),
  resultPlaceholders: v.optional(v.array(resultPlaceholderOutputSchema)),
  verificationState: v.optional(v.string()),
  reviewClassification: v.optional(v.nullable(v.string())),
  promotionState: v.optional(v.string()),
  preparedDiffId: v.optional(v.nullable(v.string())),
  pendingApprovals: v.optional(v.array(v.unknown())),
});
export const taskStatusOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  task: v.optional(enrichedTaskOutputSchema),
});
export const tasksListOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  tasks: v.optional(v.array(enrichedTaskOutputSchema)),
  fetchedAt: v.optional(v.string()),
});
export const startInputSchema = v.object({
  taskId: v.optional(taskIdSchema),
  title: nonEmptyStringSchema,
  prompt: nonEmptyStringSchema,
  repoId: v.optional(nonEmptyStringSchema),
  worktreeId: v.optional(nonEmptyStringSchema),
  mode: v.optional(handoffModeSchema),
  model: v.optional(nonEmptyStringSchema),
  agent: v.optional(nonEmptyStringSchema),
  allowAuto: v.optional(v.boolean()),
  confirmAuto: v.optional(v.boolean()),
  confirmDirectEdit: v.optional(v.boolean()),
  explicitUserRequest: v.literal(true),
});
export const taskIdInputSchema = v.object({
  taskId: taskIdSchema,
});
export const eventsInputSchema = v.object({
  taskId: taskIdSchema,
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const tasksListInputSchema = v.object({
  status: v.optional(taskStatusSchema),
  repoId: v.optional(nonEmptyStringSchema),
  limit: v.optional(positiveIntegerSchema),
  includeDiff: v.optional(v.boolean()),
});
export const reconcileInputSchema = v.object({
  taskId: v.optional(nonEmptyStringSchema),
});
export const sessionsSearchInputSchema = v.object({
  query: v.optional(nonEmptyStringSchema),
  sessionId: v.optional(nonEmptyStringSchema),
  repoId: v.optional(nonEmptyStringSchema),
  worktreeId: v.optional(nonEmptyStringSchema),
  directory: v.optional(nonEmptyStringSchema),
  taskId: v.optional(nonEmptyStringSchema),
  limit: v.optional(positiveIntegerSchema),
});
export const sessionReadInputSchema = v.object({
  sessionId: v.optional(nonEmptyStringSchema),
  taskId: v.optional(nonEmptyStringSchema),
  titleQuery: v.optional(nonEmptyStringSchema),
  limit: v.optional(positiveIntegerSchema),
  offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  includeFullTranscript: v.optional(v.boolean()),
  includeToolOutput: v.optional(v.boolean()),
  includeDiff: v.optional(v.boolean()),
  maxBytes: v.optional(positiveIntegerSchema),
  requesterSurface: v.optional(nonEmptyStringSchema),
  readReason: v.optional(nonEmptyStringSchema),
});
export const summarizeInputSchema = v.object({
  taskId: v.optional(nonEmptyStringSchema),
  sessionId: v.optional(nonEmptyStringSchema),
  titleQuery: v.optional(nonEmptyStringSchema),
});
export const kiloSessionSchema = v.looseObject({
  id: nonEmptyStringSchema,
  title: v.optional(v.string()),
  updated: v.optional(v.number()),
  created: v.optional(v.number()),
  projectId: v.optional(v.string()),
  directory: v.optional(v.string()),
  project: v.optional(v.nullable(v.unknown())),
});
export const normalizedKiloSessionSchema = v.object({
  id: nonEmptyStringSchema,
  title: v.string(),
  updated: v.optional(v.nullable(v.number())),
  created: v.optional(v.nullable(v.number())),
  projectId: v.optional(v.nullable(v.string())),
  directory: v.optional(v.nullable(v.string())),
  project: v.optional(
    v.nullable(
      v.object({
        id: v.optional(v.string()),
        name: v.optional(v.string()),
        worktree: v.optional(v.string()),
      }),
    ),
  ),
  neondeckTaskId: v.optional(v.string()),
  role: v.picklist(['root', 'child', 'cli', 'managed', 'disk']),
});
