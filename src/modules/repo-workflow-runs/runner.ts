import * as v from 'valibot';
import {
  repoWorkflowProfileSchema,
  type RepoWorkflowProfile,
} from '../../../shared/repo-workflows';
import { workflowCommandCwd } from './runtime';
import type {
  candidateCheckInputSchema,
  CandidateCheckResult,
} from '../factory-delivery';

export type WorkflowPhase = 'setup' | 'validation';
export type WorkflowCommandResult = CandidateCheckResult & {
  command: string;
  cwd: string;
};
/** Shared phase runner. Caller owns checkout, authority, receipts and durable process claims. */
export async function runWorkflowPhase(input: {
  workflow: RepoWorkflowProfile;
  phase: WorkflowPhase;
  root: string;
  remainingMs: number;
  run: (
    request: v.InferOutput<typeof candidateCheckInputSchema>,
    index: number,
  ) => Promise<CandidateCheckResult>;
  before?: () => Promise<void>;
  after?: () => Promise<void>;
  onResult?: (result: WorkflowCommandResult) => Promise<void>;
}) {
  const workflow = v.parse(repoWorkflowProfileSchema, input.workflow);
  v.parse(v.picklist(['setup', 'validation']), input.phase);
  v.parse(
    v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(10800000)),
    input.remainingMs,
  );
  const commands =
    input.phase === 'setup'
      ? workflow.setupCommands
      : workflow.validationCommands;
  const phaseStarted = Date.now();
  const phaseBudget = Math.min(
    input.remainingMs,
    input.phase === 'setup'
      ? workflow.setupTimeoutMs
      : workflow.validationTimeoutMs,
  );
  const results: WorkflowCommandResult[] = [];
  for (const [index, step] of commands.entries()) {
    await input.before?.();
    const remaining = Math.min(
      phaseBudget - (Date.now() - phaseStarted),
      phaseBudget - results.reduce((n, r) => n + r.durationMs, 0),
    );
    if (remaining <= 0) break;
    let result: CandidateCheckResult;
    let cwd: string;
    try {
      cwd = await workflowCommandCwd(input.root, step.cwd);
    } catch {
      result = {
        setupBlocked: true,
        noWriter: true,
        exitCode: null,
        truncated: false,
        timedOut: false,
        cancelled: false,
        durationMs: 0,
        stdout: '',
        stderr:
          'ENVIRONMENT SETUP: command directory is missing or escapes the owned checkout.',
      };
      const recorded = { ...result, ...step };
      results.push(recorded);
      await input.onResult?.(recorded);
      break;
    }
    try {
      result = await input.run(
        {
          command: step.command,
          cwd,
          timeoutMs: remaining,
          maxOutputBytes: 16384,
          workflow: {
            root: input.root,
            runtime: workflow.runtime,
            environmentRefs: workflow.environmentRefs,
          },
        },
        index,
      );
    } catch {
      // No execution proof is inferred from an arbitrary runner error.
      throw new Error(
        'Workflow command completion is uncertain; retain owned resources.',
      );
    }
    if (!result.noWriter)
      throw new Error(
        'Workflow process death is unproven; retain owned resources.',
      );
    await input.after?.();
    const recorded = { ...result, ...step };
    results.push(recorded);
    await input.onResult?.(recorded);

    if (
      result.exitCode !== 0 ||
      result.truncated ||
      result.timedOut ||
      result.cancelled
    )
      break;
  }
  return {
    passed:
      (input.phase === 'setup' || commands.length > 0) &&
      results.length === commands.length &&
      Date.now() - phaseStarted <= phaseBudget &&
      results.every(
        (r) => r.exitCode === 0 && !r.truncated && !r.timedOut && !r.cancelled,
      ),
    results,
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
  };
}
