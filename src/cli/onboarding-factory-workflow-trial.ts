import { log } from '@clack/prompts';
import type { RepoWorkflowRun } from '../../shared/repo-workflow-runs';
import type { RuntimePaths } from '../runtime-home';
import {
  startRepoWorkflowRun,
  getRepoWorkflowRun,
  cancelRepoWorkflowRun,
} from '../modules/repo-workflow-runs';

/** Same trial service as the dashboard; the CLI owns only presentation and cancellation. */
export async function runFactoryWorkflowTrial(
  repoId: string,
  profileId: string,
  expectedFingerprint: string,
  paths: RuntimePaths,
) {
  let run: RepoWorkflowRun | undefined;
  let interrupted = false;
  let cancellation: Promise<unknown> | undefined;
  let cancelFailure = false;
  const cancel = () => {
    interrupted = true;
    if (!run || cancellation) return;
    log.info(`Cancelling workflow test ${run.runId}…`);
    cancellation = Promise.resolve()
      .then(() => cancelRepoWorkflowRun(repoId, run!.runId, paths))
      .catch(() => {
        cancelFailure = true;
      });
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  let logged = 0;
  let phase = '';
  try {
    run = await startRepoWorkflowRun(
      repoId,
      { profileId, expectedFingerprint },
      paths,
    );
    log.info(
      `Workflow test ${run.runId} started for ${repoId}/${profileId}. Press Ctrl+C to cancel.`,
    );
    if (interrupted) cancel();
    let cancellationStarted = 0;
    while (true) {
      if (phase !== run.phase) {
        phase = run.phase;
        log.info(
          {
            setup: 'Setting up repository',
            validation: 'Running checks',
            cleanup: 'Cleaning up test checkout',
            complete: 'Test complete',
          }[run.phase],
        );
      }
      for (const entry of run.logs.slice(logged)) {
        log.info(
          `${entry.phase === 'setup' ? 'Setup' : 'Checks'}: ${entry.command} (directory ${entry.cwd}, exit ${entry.exitCode ?? 'stopped'})\n${entry.output || 'No output.'}${entry.truncated ? '\nOutput shortened to the retained log limit.' : ''}`,
        );
      }
      logged = run.logs.length;
      if (
        run.status !== 'running' &&
        (run.phase === 'complete' || run.cleanup === 'retained')
      )
        break;
      if (interrupted) {
        cancel();
        cancellationStarted ||= Date.now();
        if (cancelFailure || Date.now() - cancellationStarted > 15000)
          throw new Error('Cancellation could not be confirmed.');
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      run = await getRepoWorkflowRun(repoId, run.runId, paths);
    }
    const labels = {
      passed: 'Setup and checks passed',
      failed: 'Checks failed',
      'setup-blocked': 'Repository setup needs attention',
      cancelled: 'Test cancelled',
      uncertain: 'Test outcome needs review',
    };
    log.info(
      `${labels[run.status]}: ${run.runId}. ${run.guidance} Checkout ${run.cleanup}.`,
    );
    return run;
  } catch (cause) {
    if (run) {
      cancel();
      await Promise.race([
        cancellation,
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      log.info(
        `Workflow test needs review. Retained run ID: ${run.runId}. Inspect /api/repos/${encodeURIComponent(repoId)}/factory-workflow-runs/${encodeURIComponent(run.runId)} on the private dashboard listener before retrying. Cancellation or cleanup may be incomplete.`,
      );
    }
    throw cause;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
