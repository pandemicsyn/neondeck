import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensurePreparedDiffForWorktree,
  requestPreparedDiffRevision,
} from './modules/prepared-diffs';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('prepared-diff finding promotion', () => {
  it('reuses the existing revision transition idempotently without dispatching execution', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-finding-promotion-'));
    roots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const now = '2026-07-18T12:00:00.000Z';
    const database = new DatabaseSync(paths.neondeckDatabase);
    database
      .prepare(
        `INSERT INTO worktrees (
          id, repo_id, repo_full_name, github_owner, github_name, pr_number,
          base_ref, head_ref, head_sha, local_path, storage_kind,
          lifecycle_status, direct_push_allowed, adopted, created_by,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      )
      .run(
        'worktree-1',
        'repo-1',
        'example/repo',
        'example',
        'repo',
        42,
        'main',
        'feature',
        'head-sha',
        join(home, 'worktree'),
        'neondeck-home',
        'prepared-diff',
        0,
        0,
        'test',
        now,
        now,
      );
    database.close();
    const prepared = await ensurePreparedDiffForWorktree(
      {
        id: 'worktree-1',
        repoId: 'repo-1',
        repoFullName: 'example/repo',
        prNumber: 42,
        localPath: join(home, 'worktree'),
        baseRef: 'main',
        headRef: 'feature',
        headSha: 'head-sha',
        lifecycleStatus: 'prepared-diff',
      },
      paths,
    );
    const findingPromotion = {
      sourceFindingId: 'neon_surface_1234',
      surfaceId: 'review-surface:prepared',
      sourceId: `prepared-diff:${prepared.id}`,
      revisionKey: 'worktree-diff:base:head',
      findingId: 'finding-1',
    };
    const input = {
      preparedDiffId: prepared.id,
      reason: 'Guard the optional value.\n\nNeon provenance: run run-1.',
      approverSurface: 'review-surface:prepared',
      findingPromotion,
    };

    const first = await requestPreparedDiffRevision(input, paths);
    const retry = await requestPreparedDiffRevision(input, paths);

    expect(first).toMatchObject({
      ok: true,
      changed: true,
      preparedDiff: {
        status: 'revision-requested',
        summary: {
          revisionReason: expect.stringContaining('Neon provenance'),
          findingPromotion,
        },
      },
      approvals: [{ approvalType: 'revision', status: 'rejected' }],
    });
    expect(retry).toMatchObject({
      ok: true,
      changed: false,
      preparedDiff: { status: 'revision-requested' },
      approvals: [{ approvalType: 'revision' }],
    });
    expect(retry.approvals).toHaveLength(1);
  });
});
