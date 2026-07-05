import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import type { ExecutionBackend } from '../../runtime-home';
import {
  type ExecutionContext,
  type ExecutionDecision,
  type ExecutionRisk,
} from './policy';
import { exedevTargetInputSchema } from './exedev/context';
import { isJsonValue } from './utils';

export type ExecutionApprovalStatus =
  'pending' | 'approved' | 'denied' | 'executed' | 'failed' | 'blocked';
export type ExecutionApprovalDecision =
  'preapproved' | 'allow-once' | 'allow-session' | 'allow-always' | 'deny';

export type ExecutionApprovalRecord = {
  id: string;
  command: string;
  backend: ExecutionBackend;
  cwd: string | null;
  context: ExecutionContext;
  risk: ExecutionRisk;
  policyDecision: ExecutionDecision;
  status: ExecutionApprovalStatus;
  approvalDecision: ExecutionApprovalDecision | null;
  approverSurface: string | null;
  sessionId: string | null;
  requestContext: JsonValue | null;
  result: JsonValue | null;
  exitCode: number | null;
  stdoutPreview: string | null;
  stderrPreview: string | null;
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
  usedAt: string | null;
  executedAt: string | null;
  updatedAt: string;
};

export const maxCommandLength = 4096;
export const defaultTimeoutMs = 30_000;
export const maxTimeoutMs = 10 * 60_000;
export const defaultOutputBytes = 64 * 1024;
export const maxOutputBytes = 256 * 1024;
export const safeEnvKeys = [
  'PATH',
  'HOME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'NEONDECK_HOME',
];

export const backendSchema = v.picklist(['local', 'exe.dev']);
export const contextSchema = v.picklist(['interactive', 'unattended']);
export const approvalDecisionSchema = v.picklist([
  'allow-once',
  'allow-session',
  'allow-always',
  'deny',
]);
export const executionCommandSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(maxCommandLength),
);
export const requestApprovalInputSchema = v.object({
  command: executionCommandSchema,
  backend: v.optional(backendSchema),
  cwd: v.optional(v.string()),
  ...exedevTargetInputSchema(),
  forwardEnv: v.optional(v.boolean()),
  context: v.optional(contextSchema),
  sessionId: v.optional(v.string()),
  requestContext: v.optional(
    v.pipe(v.unknown(), v.check(isJsonValue, 'Context must be JSON-safe.')),
  ),
});
export const resolveApprovalInputSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  decision: approvalDecisionSchema,
  approverSurface: v.optional(v.pipe(v.string(), v.minLength(1))),
  note: v.optional(v.string()),
});
export const runExecutionInputSchema = v.object({
  command: executionCommandSchema,
  backend: v.optional(backendSchema),
  cwd: v.optional(v.string()),
  ...exedevTargetInputSchema(),
  forwardEnv: v.optional(v.boolean()),
  context: v.optional(contextSchema),
  approvalId: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxOutputBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  requestContext: v.optional(
    v.pipe(v.unknown(), v.check(isJsonValue, 'Context must be JSON-safe.')),
  ),
});
export const executionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
