import * as v from 'valibot';
import { isAbsolute } from 'node:path';

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));
const absolute = v.pipe(text, v.check(isAbsolute, 'Expected absolute path'));
const positive = (max: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(max));
export const handleSchema = v.strictObject({
  directory: absolute,
  attemptToken: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export const workspaceSchema = v.strictObject({
  id: text,
  repoId: text,
  root: absolute,
  storageRoot: absolute,
  sourceRoot: absolute,
  branch: v.pipe(text, v.regex(/^agent\/factory[-/][a-zA-Z0-9._/-]+$/)),
  baseSha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
});
export const configSchema = v.strictObject({
  executable: absolute,
  model: text,
  sandbox: v.picklist(['read-only', 'workspace-write']),
  path: v.pipe(
    text,
    v.check(
      (value) => value.split(':').every(isAbsolute),
      'PATH must contain absolute entries',
    ),
  ),
  wallTimeMs: positive(45 * 60_000),
  maxOutputBytes: positive(64 * 1024 * 1024),
  maxLineBytes: positive(1024 * 1024),
  termGraceMs: positive(30_000),
  mockScenario: v.optional(
    v.picklist([
      'success',
      'failure',
      'malformed',
      'oversized',
      'stall',
      'child-dev-server',
    ]),
  ),
});
export const prepareSchema = v.strictObject({
  ...handleSchema.entries,
  attemptId: text,
  ownedWorktree: workspaceSchema,
  config: configSchema,
  testPauseBeforeSpawn: v.optional(v.boolean()),
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(1024 * 1024)),
  selectedAuth: v.optional(
    v.variant('kind', [
      v.strictObject({
        kind: v.literal('api-key'),
        value: v.pipe(v.string(), v.minLength(1), v.maxLength(16384)),
      }),
      v.strictObject({
        kind: v.literal('auth-json'),
        value: v.pipe(v.string(), v.minLength(1), v.maxLength(128 * 1024)),
      }),
    ]),
  ),
});
export const manifestSchema = v.strictObject({
  version: v.literal(1),
  attemptId: text,
  cliVersion: text,
  testPauseBeforeSpawn: v.optional(v.boolean()),
  directory: absolute,
  ownedWorktree: workspaceSchema,
  config: configSchema,
  nonce: v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/)),
});
export const identitySchema = v.strictObject({
  pid: positive(2 ** 31 - 1),
  pgid: positive(2 ** 31 - 1),
  start: text,
  command: v.pipe(v.string(), v.minLength(1), v.maxLength(1024 * 1024)),
});
export const receiptSchema = v.strictObject({
  version: v.literal(1),
  attemptId: text,
  nonce: text,
  at: positive(Number.MAX_SAFE_INTEGER),
  supervisor: identitySchema,
  group: v.nullable(identitySchema),
  state: v.picklist(['running', 'cancelling', 'finished', 'needs-reconcile']),
  reason: v.nullable(text),
  exitCode: v.nullable(v.pipe(v.number(), v.integer())),
  signal: v.nullable(text),
  sessionId: v.nullable(text),
  terminal: v.nullable(v.picklist(['completed', 'failed'])),
  outputBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  noWriter: v.boolean(),
  authCleanup: v.picklist(['pending', 'removed', 'absent', 'failed']),
});
export const cancelSchema = v.strictObject({
  nonce: text,
  requestedAt: positive(Number.MAX_SAFE_INTEGER),
});
export type LocalAttemptHandle = v.InferOutput<typeof handleSchema>;
export type PrepareLocalAttemptInput = v.InferOutput<typeof prepareSchema>;
export type LocalManifest = v.InferOutput<typeof manifestSchema>;
export type ProcessIdentity = v.InferOutput<typeof identitySchema>;
export type LocalReceipt = v.InferOutput<typeof receiptSchema>;
export type LocalInspection =
  | { state: 'running' | 'cancelling' | 'finished'; receipt: LocalReceipt }
  | { state: 'needs-reconcile'; reason: string };
