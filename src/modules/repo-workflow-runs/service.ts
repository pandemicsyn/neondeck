import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  repoWorkflowRunSchema,
  startRepoWorkflowRunSchema,
  type RepoWorkflowRun,
} from '../../../shared/repo-workflow-runs';
import {
  readRuntimeJsonSync,
  parseRepoRegistry,
  parseAppConfig,
  type RuntimePaths,
} from '../../runtime-home';
import { readRepoWorkflows, resolveRepoWorkflow } from '../repo-workflows';
import { FactoryError } from '../factory';
import {
  artifactHash,
  atomicWrite,
  hostGit,
  privateDirectory,
} from '../coding-runs';
import {
  runSupervisedCandidateCheck,
  cancelCandidateVerification,
} from '../factory-delivery';
import { checkExecutionPolicy } from '../execution';
import { runWorkflowPhase } from './runner';
import {
  preflightRepoWorkflowRuntime,
  runtimeVersionMatches,
  workflowEnvironmentValues,
  redactWorkflowOutput,
} from '../repo-workflow-runtime';
import {
  claimTrialRecovery,
  captureTrialController,
  trialControllerState,
  requestTrialCancellation,
  trialCancellationRequested,
  trialHandle,
  readTrialOwnership,
  saveTrialOwnership,
  type TrialOwnership,
} from './trial-store';
import { assertTrialCheckout, cleanupTrial } from './trial-checkout';
import { recoverExistingCandidateCheck } from '../factory-delivery';
import { readSigned, writeSigned } from '../coding-runs';

const live = new Map<
  string,
  { cancel: () => Promise<void>; done: Promise<void> }
>();
const idSchema = v.pipe(v.string(), v.uuid());
const rootPath = (paths: RuntimePaths) =>
  join(paths.home, 'repo-workflow-runs');
const runPath = (id: string, paths: RuntimePaths) =>
  join(rootPath(paths), v.parse(idSchema, id));
async function read(id: string, paths: RuntimePaths) {
  const handle = await trialHandle(runPath(id, paths));
  const result = v.parse(
    repoWorkflowRunSchema,
    await readSigned(
      join(handle.directory, 'result.json'),
      handle.attemptToken,
    ),
  );
  if (result.runId !== id) throw new Error('Run identity mismatch');
  return result;
}
async function save(result: RepoWorkflowRun, paths: RuntimePaths) {
  const handle = await trialHandle(runPath(result.runId, paths));
  await writeSigned(
    join(handle.directory, 'result.json'),
    handle.attemptToken,
    v.parse(repoWorkflowRunSchema, result),
  );
}
async function inspectRepoWorkflowRun(
  repoId: string,
  runId: string,
  paths: RuntimePaths,
): Promise<RepoWorkflowRun> {
  let result: RepoWorkflowRun;
  try {
    result = await read(runId, paths);
  } catch {
    throw new FactoryError(404, 'Workflow test result not found.');
  }
  if (result.repoId !== repoId)
    throw new FactoryError(404, 'Workflow test result not found.');
  if (
    (result.status === 'running' || result.cleanup !== 'complete') &&
    !live.has(runPath(runId, paths))
  ) {
    // A different CLI/server process has its own map. Only durable identity
    // observation can establish that this run's controller actually exited.
    const directory = runPath(runId, paths);
    let owner: TrialOwnership;
    try {
      owner = await readTrialOwnership(directory);
      if (owner.runId !== runId || owner.repoId !== repoId)
        throw new Error('Owner mismatch');
    } catch {
      return {
        ...result,
        status: 'uncertain',
        cleanup: 'retained',
        guidance:
          'Controller ownership cannot be verified; resources retained.',
      };
    }
    const controller = await trialControllerState(owner.controller);
    if (controller === 'alive') return result;
    if (controller === 'unknown')
      return {
        ...result,
        status: 'uncertain',
        cleanup: 'retained',
        guidance: 'Controller liveness cannot be verified; resources retained.',
      };
    const claim = await claimTrialRecovery(directory);
    if (!claim)
      return {
        ...result,
        status: 'uncertain',
        cleanup: 'retained',
        guidance:
          'Recovery is already claimed by another observer or an interrupted recovery. Resources are retained; no automatic claim stealing is allowed.',
      };
    let releaseClaim = true;
    try {
      // An earlier observer may have completed between our first read and
      // acquiring this claim. Never repeat its completed cleanup.
      result = await read(runId, paths);
      if (result.repoId !== repoId) throw new Error('Run identity changed');
      if (result.cleanup === 'complete' && result.status !== 'running')
        return result;
      // The controller may have admitted a job or started Git while we awaited
      // its death observation. Discard the earlier resource/settlement snapshot.
      try {
        const fresh = await readTrialOwnership(directory);
        if (
          fresh.runId !== runId ||
          fresh.repoId !== repoId ||
          JSON.stringify(fresh.controller) !== JSON.stringify(owner.controller)
        ) {
          throw new Error('Controller identity changed during observation');
        }
        owner = fresh;
      } catch {
        return {
          ...result,
          status: 'uncertain',
          cleanup: 'retained',
          guidance:
            'Controller ownership changed or cannot be verified after observation; resources retained.',
        };
      }
      result = {
        ...result,
        status: 'uncertain',
        cleanup: 'retained',
        phase: 'complete',
        finishedAt: new Date().toISOString(),
        guidance:
          'Controller restarted. Process death or checkout ownership is unproven; resources retained.',
      };
      try {
        const handle = await trialHandle(directory);
        await cancelCandidateVerification(handle, runId);
        if (!owner.gitSettled) throw new Error('Git settlement unproven');
        for (const job of owner.jobs) {
          const receipt = await recoverExistingCandidateCheck(
            job.request,
            handle,
            job.jobId,
            runId,
          );
          if (!receipt.noWriter) throw new Error('Worker settlement unproven');
        }
        releaseClaim = false;
        await cleanupTrial(directory, owner);
        result = {
          ...result,
          status: 'cancelled',
          cleanup: 'complete',
          guidance:
            'Interrupted workflow stopped. Authenticated worker receipts proved settlement; owned checkout cleaned. Start a new explicit test.',
        };
      } catch {
        /* Missing receipts never authorize PID signals or deletion. */
      }
      await save(result, paths);
      if (result.cleanup === 'complete') releaseClaim = true;
    } finally {
      if (releaseClaim) await claim.release();
    }
  }
  return result;
}
const inspections = new Map<string, Promise<RepoWorkflowRun>>();
export async function getRepoWorkflowRun(
  repoId: string,
  runId: string,
  paths: RuntimePaths,
) {
  const key = `${runPath(runId, paths)}:${repoId}`;
  const current = inspections.get(key);
  if (current) return current;
  const pending = inspectRepoWorkflowRun(repoId, runId, paths).finally(() =>
    inspections.delete(key),
  );
  inspections.set(key, pending);
  return pending;
}
export async function cancelRepoWorkflowRun(
  repoId: string,
  runId: string,
  paths: RuntimePaths,
) {
  const result = await getRepoWorkflowRun(repoId, runId, paths);
  const owner = live.get(runPath(runId, paths));
  if (owner) await owner.cancel();
  else if (result.status === 'running' || result.status === 'uncertain') {
    const directory = runPath(runId, paths);
    await requestTrialCancellation(directory);
    await cancelCandidateVerification(await trialHandle(directory), runId);
  }
  return getRepoWorkflowRun(repoId, runId, paths);
}
/** Explicit reviewed saved-profile execution. No call is made from save/propose. */
export async function startRepoWorkflowRun(
  repoId: string,
  raw: unknown,
  paths: RuntimePaths,
) {
  const input = v.parse(startRepoWorkflowRunSchema, raw);
  const snapshot = readRepoWorkflows(repoId, paths);
  if (snapshot.fingerprint !== input.expectedFingerprint)
    throw new FactoryError(
      409,
      'Workflow settings changed. Reload and review before testing.',
    );
  const repo = readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos.find(
    (r) => r.id === repoId,
  )!;
  const workflow = resolveRepoWorkflow(
    repo,
    readRuntimeJsonSync(paths.config, parseAppConfig),
    input.profileId,
  );
  if (!workflow)
    throw new FactoryError(
      409,
      'Save and review an explicit workflow before testing.',
    );
  const storage = rootPath(paths);
  await mkdir(storage, { recursive: true, mode: 0o700 });
  await privateDirectory(storage);
  const controller = await captureTrialController();
  const lock = join(storage, `repo-${artifactHash(repoId)}.lock`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new FactoryError(
      409,
      'This repository already has a workflow test or retained uncertain checkout.',
    );
  }
  const runId = randomUUID();
  const directory = runPath(runId, paths);
  const handle = { directory, attemptToken: randomBytes(32).toString('hex') };
  let cancelled = false;
  let noWriter = true;

  let source = '';
  const root = join(directory, 'checkout');
  const ownership: TrialOwnership = {
    controller,
    runId,
    repoId,
    source: '',
    root,
    ref: `refs/neondeck-workflow-tests/${runId}`,
    baseSha: null,
    gitSettled: true,
    jobs: [],
  };
  let result: RepoWorkflowRun = {
    runId,
    repoId,
    profileId: workflow.id,
    workflowFingerprint: artifactHash(JSON.stringify(workflow)),
    status: 'running',
    baseSha: null,
    phase: 'setup',
    logs: [],
    cleanup: 'pending',
    guidance: 'Testing the reviewed saved workflow in a disposable checkout.',
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  try {
    await mkdir(directory, { mode: 0o700 });
    await atomicWrite(join(directory, 'token'), handle.attemptToken);
    await atomicWrite(join(lock, 'run-id'), runId);
    await saveTrialOwnership(directory, ownership);
    await save(result, paths);
  } catch (error) {
    await rm(lock, { recursive: true, force: true });
    throw error;
  }
  // Only messages constructed from known stages and reviewed schema fields
  // reach guidance. Never publish arbitrary caught errors or Git output.
  let failureGuidance: string | undefined;
  const fail = (guidance: string): never => {
    failureGuidance = guidance;
    throw new Error('Workflow prerequisite failed');
  };
  const assertSettings = async () => {
    if (await trialCancellationRequested(directory)) cancelled = true;
    if (
      readRepoWorkflows(repoId, paths).fingerprint !== input.expectedFingerprint
    )
      fail(
        'Workflow settings changed during the test. Reload and review the saved profile, then start a new test.',
      );
    if (cancelled) throw new Error('Workflow cancelled.');
  };
  const assertCheckout = async () => {
    await assertSettings();
    await assertTrialCheckout(ownership);
    if ((await hostGit(root, ['diff', '--name-only', 'HEAD', '--'])).trim())
      fail(
        'A workflow command changed tracked repository content. Update setup/validation to leave tracked files unchanged, review the saved profile, then test again.',
      );
  };
  const done = Promise.resolve()
    .then(async () => {
      try {
        // Keep command policy errors out of the dependency/code failure bucket.
        for (const phase of ['setup', 'validation'] as const) {
          for (const step of phase === 'setup'
            ? workflow.setupCommands
            : workflow.validationCommands) {
            const policy = await checkExecutionPolicy(
              {
                command: step.command,
                backend: 'local',
                context: 'unattended',
              },
              paths,
            );
            if (policy.decision !== 'allow') {
              result.status = 'setup-blocked';
              result.guidance =
                'Execution permission is required. Configure unattended local command permission, then explicitly retry the same saved workflow.';
              result.logs.push({
                phase,
                command: step.command,
                cwd: step.cwd,
                exitCode: null,
                output:
                  'Command is not allowed by the current execution policy. Configure permission before starting this workflow.',
                durationMs: 0,
                truncated: false,
              });
              return;
            }
          }
        }
        for (const name of workflow.environmentRefs) {
          try {
            workflowEnvironmentValues([name]);
          } catch {
            fail(
              `Environment reference ${name} is missing, invalid, or reserved. Provide a valid permitted value to the trial controller, then retry. Secret values are never shown.`,
            );
          }
        }
        if (
          workflow.runtime.node &&
          !runtimeVersionMatches(process.version, workflow.runtime.node)
        ) {
          fail(
            `Node ${workflow.runtime.node} is required. Run the trial controller with a matching installed Node version, then retry.`,
          );
        }
        const toolchain = await preflightRepoWorkflowRuntime(workflow).catch(
          () => {
            const manager = workflow.runtime.packageManager;
            return fail(
              manager
                ? `Package manager ${manager.name}${manager.version ? ` ${manager.version}` : ''} is required but unavailable for this trial. Make a matching installed executable available to the controller, then retry.`
                : 'The required runtime could not be prepared. Check the saved runtime requirements and controller environment, then retry.',
            );
          },
        );
        await assertSettings();
        source = await realpath(repo.path);
        if (
          (await hostGit(source, ['rev-parse', '--show-toplevel'])).trim() !==
          source
        )
          throw new Error('Repository root is not canonical.');
        // Fetch only the configured default branch into this run's private ref.
        const ref = `refs/neondeck-workflow-tests/${runId}`;
        ownership.source = source;
        ownership.gitSettled = false;
        await saveTrialOwnership(directory, ownership);
        await hostGit(source, [
          'check-ref-format',
          `refs/heads/${repo.defaultBranch}`,
        ]);
        await hostGit(source, [
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          'origin',
          `+refs/heads/${repo.defaultBranch}:${ref}`,
        ]);
        result.baseSha = v.parse(
          v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
          (await hostGit(source, ['rev-parse', `${ref}^{commit}`])).trim(),
        );
        ownership.baseSha = result.baseSha;
        ownership.gitSettled = true;
        await saveTrialOwnership(directory, ownership);
        await assertSettings();
        ownership.gitSettled = false;
        await saveTrialOwnership(directory, ownership);
        // Detached, individually owned checkout: never run setup in repo.path.
        await hostGit(source, [
          'worktree',
          'add',
          '--detach',
          '--',
          root,
          result.baseSha,
        ]);
        ownership.baseSha = result.baseSha;
        ownership.gitSettled = true;
        await saveTrialOwnership(directory, ownership);
        await save(result, paths);
        const started = Date.now();
        for (const phase of ['setup', 'validation'] as const) {
          result.phase = phase;
          await save(result, paths);
          const report = await runWorkflowPhase({
            workflow,
            phase,
            root,
            remainingMs: Math.max(1, 7200000 - (Date.now() - started)),
            before: assertCheckout,
            after: assertCheckout,
            run: async (request, index) => {
              if (request.workflow)
                request = {
                  ...request,
                  workflow: { ...request.workflow, toolchain },
                };
              const policy = await checkExecutionPolicy(
                {
                  command: request.command,
                  backend: 'local',
                  context: 'unattended',
                },
                paths,
              );
              if (policy.decision !== 'allow')
                fail(
                  'Execution policy changed and no longer allows this command. Configure unattended local command permission, then explicitly retry the saved workflow.',
                );
              await assertCheckout();
              ownership.jobs.push({
                jobId: `${runId}:${phase}:${index}`,
                request,
              });
              await saveTrialOwnership(directory, ownership);
              noWriter = false;
              const checked = await runSupervisedCandidateCheck(
                request,
                handle,
                `${runId}:${phase}:${index}`,
                runId,
              );
              noWriter = checked.noWriter;
              return checked;
            },
            onResult: async (checked) => {
              result.logs.push({
                phase,
                command: checked.command,
                cwd: checked.cwd,
                exitCode: checked.exitCode,
                output: redactWorkflowOutput(
                  [checked.stdout, checked.stderr].filter(Boolean).join('\n'),
                  workflowEnvironmentValues(workflow.environmentRefs),
                ).slice(0, 16384),
                durationMs: checked.durationMs,
                truncated: checked.truncated,
              });
              await save(result, paths);
            },
          });
          if (!report.passed) {
            result.status = cancelled
              ? 'cancelled'
              : phase === 'setup' || report.results.some((r) => r.setupBlocked)
                ? 'setup-blocked'
                : 'failed';
            result.guidance =
              result.status === 'setup-blocked'
                ? 'ENVIRONMENT SETUP blocked. Inspect the command and output, resolve the environment, then explicitly retry this unchanged saved workflow. Changed workflows must be reviewed again.'
                : 'Validation failed. Inspect the command output.';
            const blocked = report.results.find((entry) => entry.setupBlocked);
            if (
              blocked?.stderr ===
              'ENVIRONMENT SETUP: command directory is missing or escapes the owned checkout.'
            ) {
              result.guidance =
                'The configured command directory is missing or escapes the disposable checkout. Correct the repository-relative cwd in the saved profile, then review and retry.';
            } else if (blocked && workflow.runtime.packageManager) {
              const manager = workflow.runtime.packageManager;
              result.guidance = `Environment setup could not satisfy the saved runtime requirements: ${workflow.runtime.node ? `Node ${workflow.runtime.node}; ` : ''}${manager.name}${manager.version ? ` ${manager.version}` : ''}. Make the required tools available to the controller and inspect the redacted command output, then retry.`;
            }
            return;
          }
        }
        result.status = 'passed';
        result.guidance =
          'Setup and all validation commands passed at the fetched default-branch revision.';
      } catch {
        result.status = !noWriter
          ? 'uncertain'
          : cancelled
            ? 'cancelled'
            : 'setup-blocked';
        result.guidance = !noWriter
          ? 'Process completion is uncertain. Retained checkout ownership prevents replacement.'
          : cancelled
            ? 'Workflow test cancelled.'
            : (failureGuidance ??
              'Repository or execution preparation failed. Verify access to the configured remote default branch and inspect the saved workflow, then explicitly retry. Internal error details are withheld.');
      } finally {
        result.phase = 'cleanup';
        await save(result, paths);
        if (noWriter && ownership.gitSettled) {
          try {
            await cleanupTrial(directory, ownership);
            result.cleanup = 'complete';
          } catch {
            result.cleanup = 'retained';
            result.status = 'uncertain';
          }
        } else {
          result.cleanup = 'retained';
          result.status = 'uncertain';
          result.guidance =
            'Process or Git completion is unproven. Owned resources retained; inspect test status for receipt-based recovery.';
        }
        result.phase = 'complete';
        result.finishedAt = new Date().toISOString();
        await save(result, paths);
        // Bounded retained terminal results; never prune uncertain resource owners.
        const completed: { id: string; date: string }[] = [];
        for (const entry of await readdir(storage)) {
          if (!v.is(idSchema, entry) || entry === runId) continue;
          try {
            const prior = await read(entry, paths);
            if (prior.repoId === repoId && prior.cleanup === 'complete')
              completed.push({ id: entry, date: prior.startedAt });
          } catch {
            /* retain invalid evidence */
          }
        }
        for (const prior of completed
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(19))
          await rm(runPath(prior.id, paths), { recursive: true, force: true });
      }
    })
    .finally(() => live.delete(directory));
  live.set(directory, {
    done,
    cancel: async () => {
      cancelled = true;
      await cancelCandidateVerification(handle, runId);
    },
  });
  void done.catch(() => {});
  return structuredClone(result);
}
