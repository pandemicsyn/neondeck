import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  consumePrReviewWorkspaceBudget,
  prReviewWorkspaceBudgetKey,
} from './modules/pr-reviewer';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PR review workspace budget', () => {
  it('atomically persists a shared call limit outside Flue parent state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-review-budget-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const budget = {
      key: prReviewWorkspaceBudgetKey({
        kind: 'initial',
        reviewId: 'review-1:attempt-1',
        revision: 'abc123',
      }),
      limit: 2,
    };

    expect(consumePrReviewWorkspaceBudget(budget, paths)).toBe(1);
    expect(consumePrReviewWorkspaceBudget(budget, paths)).toBe(0);
    expect(consumePrReviewWorkspaceBudget(budget, paths)).toBeNull();
  });
});
