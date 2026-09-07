import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import type { FactoryDetail } from '../../../shared/factory';
import { runUnattendedGit } from '../../lib/git';
import { safeGitRefSchema } from '../worktrees';
import { FactoryError } from './service';

import {
  commitSchema,
  retainedRefSchema,
  temporaryRefSchema,
  factoryRepoBaselineSchema,
  type FactoryRepoBaseline,
} from './repo-baseline-schema';

/** Capture independently for first planning, explicit Refresh, and initial coding.
 * No mid-session fetch: subsequent turns and repairs use their stored revision.
 * Local-only repos use refs/heads/<defaultBranch>, never HEAD.
 *
 * UUID fetch refs are always removed. SHA-addressed refs retain objects for audit
 * and replay, deduplicating repeated captures (including failed admissions) of
 * the same commit. They are retained indefinitely; automatic ref GC is deferred
 * until it can account for all historical planning/coding/repair snapshots.
 * Provenance is currently internal; it is not exposed in the dashboard state. */
export async function captureFactoryRepoBaseline(
  repo: FactoryDetail['repoContext'],
): Promise<FactoryRepoBaseline> {
  if (!repo) return { repoCommit: null };
  const signal = AbortSignal.timeout(30_000);
  const git = (args: string[]) =>
    runUnattendedGit(repo.path, args, {
      signal,
      timeoutMs: 30_000,
      maxBuffer: 64_000,
    });
  const branch = repo.defaultBranch;
  let source: 'origin' | 'local-default-branch' = 'origin';
  let fetched = false;
  const temporaryRef = v.parse(
    temporaryRefSchema,
    `refs/neondeck/factory/fetch/${randomUUID()}`,
  );
  try {
    v.parse(safeGitRefSchema, branch);
    await git(['check-ref-format', `refs/heads/${branch}`]);
    const remotes = (await git(['remote'])).trim().split('\n');
    source = remotes.includes('origin') ? 'origin' : 'local-default-branch';
    let ref = `refs/heads/${branch}`;
    if (source === 'origin') {
      ref = temporaryRef;
      fetched = true;
      await git([
        '-c',
        'fetch.prune=false',
        '-c',
        'fetch.pruneTags=false',
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--no-auto-maintenance',
        '--refmap=',
        'origin',
        `refs/heads/${branch}:${ref}`,
      ]);
    }
    const repoCommit = v.parse(
      commitSchema,
      (await git(['rev-parse', '--verify', `${ref}^{commit}`])).trim(),
    );
    const retainedRef = v.parse(
      retainedRefSchema,
      `refs/neondeck/factory/commits/${repoCommit}`,
    );
    await git(['update-ref', retainedRef, repoCommit]);
    return {
      repoCommit,
      repoBaseline: v.parse(factoryRepoBaselineSchema, {
        source,
        branch,
        ref: retainedRef,
      }),
    };
  } catch {
    throw new FactoryError(
      409,
      source === 'origin'
        ? 'Cannot capture the configured default branch from origin. Check the repository path, default branch, origin URL, network and Git credentials, then retry. No stale local fallback was used.'
        : 'No origin remote is configured and the local default branch is unavailable. Restore refs/heads/<configured default branch> or configure origin, then retry. HEAD is not used as a fallback.',
    );
  } finally {
    if (fetched) {
      // Cleanup has its own short budget even if the capture budget expired.
      await removeTemporaryRef(repo.path, temporaryRef);
    }
  }
}

async function removeTemporaryRef(path: string, ref: string) {
  try {
    await runUnattendedGit(
      path,
      ['update-ref', '-d', v.parse(temporaryRefSchema, ref)],
      { timeoutMs: 3000, maxBuffer: 64000 },
    );
  } catch {
    throw new FactoryError(
      409,
      'Cannot remove the temporary factory fetch ref. Check repository permissions and Git ref locks, then retry.',
    );
  }
}
