/* eslint-disable no-unused-vars */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { type GitHubCheckSummary, type GitHubFailingCheckFact, type GitHubPullRequestDetail, type GitHubPullRequestEventState, fetchPullRequestEventState, fetchCheckSummary, fetchFailingCheckFacts, fetchPullRequestDetail } from '../../github';
import { checkAutopilotConcurrency, checkAutopilotPolicy, pathDeniedByAutopilotPolicy, repoAutopilotPolicy, withAutopilotLocalExecutionSlot } from '../../autopilot-policy';
import { addWorkflowSummary, updateWorkflowSummary } from '../../app-state';
import { notifyAutopilotState, recoveryActionsForPreparedDiff } from '../../autopilot-notifications';
import { buildPreparedDiffAuditSummary } from '../../autonomous-audit';
import { runApprovedExecution } from '../../execution-actions';
import { getGitHubPrBranchPermissions, postGitHubPrComment } from '../../pr-event-state';
import { ensurePreparedDiffForWorktree, markPreparedDiffPushBlocked, markPreparedDiffPushed, readPreparedDiff, readPreparedDiffByWorktree, readPreparedDiffRecord, recordPreparedDiffVerification, type PreparedDiffRecord } from '../../prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../../repos';
import { gitCurrentSha, gitCommitAll, gitCommitPaths, gitPushHead, gitStatus, type GitCommitResult } from '../../repo-edit/git';
import { patchRepoFiles, readRepoDiff, readRepoFile, replaceRepoFile } from '../../repo-edit';
import { parseV4APatch } from '../../repo-edit/patch-parser';
import { repoRelativePathSchema } from '../../repo-edit/schemas';
import { type RuntimePaths, parseAppConfig, ensureRuntimeHome, readRuntimeJson, runtimePaths } from '../../runtime-home';
import { createWorktree, listWorktrees, lockWorktree, recordWorktreePushBlocked, recordWorktreePushSucceeded, readManagedWorktree, readWorktreeStatus, releaseWorktreeLock, syncWorktree, type WorktreeRecord } from '../../worktrees';
import { AutopilotActionResult, AutopilotDependencies, AutopilotTriageClass, autopilotFixtureSchema, autopilotModeSchema, autopilotOutputSchema, checkSummarySchema, commentPrAutofixResultInputSchema, fixPrCiFailureInputSchema, fixPrReviewFeedbackInputSchema, prEventDeltaSchema, prEventSnapshotSchema, prFactsSchema, prReviewEventStateSchema, preparePrWorktreeInputSchema, pushPrAutofixInputSchema, reviewFixReplacementSchema, triagePrEventInputSchema, verifyPrWorktreeInputSchema } from './schemas';
import { prFactsFromDetail } from './triage-support';
import { arrayField, failResult, numberField, objectField, resolveVerificationChecks, stringField, unique } from './utils';

export async function fetchPreparedPrFacts(
  owner: string,
  repo: string,
  number: number,
  dependencies: AutopilotDependencies,
): Promise<v.InferOutput<typeof prFactsSchema> | AutopilotActionResult> {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'autopilot_prepare_pr_worktree',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const detail = await (
    dependencies.fetchPullRequestDetail ?? fetchPullRequestDetail
  )({ token, owner, repo, number });
  return prFactsFromDetail(detail);
}

export async function fetchPreparedCheckFacts(
  owner: string,
  repo: string,
  ref: string,
  dependencies: AutopilotDependencies,
): Promise<GitHubCheckSummary | AutopilotActionResult> {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'autopilot_prepare_pr_worktree',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const checks = await (dependencies.fetchCheckSummary ?? fetchCheckSummary)({
    token,
    owner,
    repo,
    ref,
  });
  return v.parse(checkSummarySchema, checks);
}

export async function fetchCiFailureFacts(
  owner: string,
  repo: string,
  ref: string,
  maxLogBytes: number | undefined,
  dependencies: AutopilotDependencies,
): Promise<GitHubFailingCheckFact[] | AutopilotActionResult> {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'autopilot_fix_pr_ci_failure',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const facts = await (
    dependencies.fetchFailingCheckFacts ?? fetchFailingCheckFacts
  )({
    token,
    owner,
    repo,
    ref,
    maxLogBytes,
  });
  return facts;
}

export function identifyLikelyCommands(
  facts: GitHubFailingCheckFact[],
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  policyChecks: string[],
  inputChecks: string[] | undefined,
  inputDiagnostics: string[] | undefined,
) {
  const explicit = unique([
    ...(inputDiagnostics ?? []),
    ...(inputChecks ?? []),
    ...policyChecks,
  ]);
  if (explicit.length > 0) return explicit;

  const scripts = repo.packageScripts ?? {};
  const haystack = facts
    .flatMap((fact) => [
      fact.name,
      fact.outputTitle ?? '',
      fact.outputSummary ?? '',
      fact.outputText ?? '',
      fact.log.text ?? '',
      ...fact.annotations.flatMap((annotation) => [
        annotation.title ?? '',
        annotation.message,
        annotation.rawDetails ?? '',
      ]),
    ])
    .join('\n')
    .toLowerCase();
  const preferred = ['check', 'test', 'typecheck', 'lint'];
  const inferred = preferred
    .filter((script) => scripts[script])
    .filter((script) => {
      if (haystack.includes(`npm run ${script}`)) return true;
      if (haystack.includes(`pnpm ${script}`)) return true;
      if (haystack.includes(`yarn ${script}`)) return true;
      return facts.some((fact) => fact.name.toLowerCase().includes(script));
    })
    .map((script) => `npm run ${script}`);
  return inferred.length > 0
    ? unique(inferred)
    : resolveVerificationChecks(undefined, repo, policyChecks).slice(0, 1);
}

export async function runAutopilotDiagnostics(
  commands: string[],
  limits: Awaited<ReturnType<typeof checkAutopilotConcurrency>>['limits'],
  requestContext: {
    repoId: string;
    repoFullName: string;
    prNumber: number | null;
    worktreeId: string;
    workflow: string;
  },
  cwd: string,
  paths: RuntimePaths,
  input: v.InferOutput<typeof fixPrCiFailureInputSchema>,
  dependencies: AutopilotDependencies,
) {
  const runExecution = dependencies.runExecution ?? runApprovedExecution;
  const results = [];
  for (const command of commands) {
    const slot = await withAutopilotLocalExecutionSlot(limits, () =>
      runExecution(
        {
          command,
          backend: input.backend,
          cwd,
          context: input.context ?? 'unattended',
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          requestContext: {
            source: 'autopilot',
            ...requestContext,
          },
        },
        paths,
      ),
    );
    if ('blocked' in slot) {
      results.push({
        command,
        ok: false,
        message: slot.message,
        requires: ['localExecutionLimit'],
        approvalId: null,
        exitCode: null,
      });
      break;
    }
    results.push({
      command,
      ok: Boolean(slot.ok),
      message: stringField(slot, 'message') ?? 'Execution completed.',
      requires: arrayField(slot, 'requires'),
      approvalId: stringField(objectField(slot, 'approval'), 'id') ?? null,
      exitCode: numberField(objectField(slot, 'result'), 'exitCode') ?? null,
    });
    if (!slot.ok) break;
  }
  return results;
}

export function generatedCiFixCommitMessage(
  repo: string,
  prNumber: number | null,
  facts: GitHubFailingCheckFact[],
) {
  const checkIds = facts
    .map((fact) => fact.id)
    .slice(0, 3)
    .join(', ');
  const pr = prNumber === null ? repo : `${repo}#${prNumber}`;
  return checkIds
    ? `Fix PR CI failure for ${pr} (checks ${checkIds})`
    : `Fix PR CI failure for ${pr}`;
}
