import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../../lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../../runtime-home';
import type { PrWatch } from '../../watches';
import {
  listRecoverableAutopilotTurns,
  readPendingAutopilotTurn,
  registerPendingAutopilotTurn,
} from './pending';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('persisted Autopilot owner turns', () => {
  it('accepts minimal thinking and skips malformed recoverable rows', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    registerPendingAutopilotTurn(
      paths.home,
      'valid-owner',
      'valid-event',
      'prepare-only',
      'watch-event',
      undefined,
      {
        prepared: {
          schema: 'neondeck.autopilot-owner-prepared.v2',
          model: 'openai/gpt-5.4',
          thinkingLevel: 'minimal',
          instructions: 'Inspect the watch event.',
          workspaceContext: null,
          capabilities: [],
          watch: watchFixture(),
          exploreModel: 'openai/gpt-5.4',
          exploreThinkingLevel: 'minimal',
        },
      },
    );
    const malformed = registerPendingAutopilotTurn(
      paths.home,
      'malformed-owner',
      'malformed-event',
      'prepare-only',
      'watch-event',
    );
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare(
          'UPDATE autopilot_owner_turns SET prepared_json = ? WHERE turn_id = ?;',
        )
        .run('{', malformed.turnId);
    } finally {
      database.close();
    }

    expect(
      readPendingAutopilotTurn(paths.home, 'valid-owner')?.prepared,
    ).toMatchObject({
      thinkingLevel: 'minimal',
      exploreThinkingLevel: 'minimal',
    });
    expect(listRecoverableAutopilotTurns(paths.home)).toMatchObject([
      expect.objectContaining({ instanceId: 'valid-owner' }),
    ]);
    expect(listRecoverableAutopilotTurns(paths.home)).toHaveLength(1);
  });

  it('does not let a malformed idempotency row block a replacement turn', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const malformed = registerPendingAutopilotTurn(
      paths.home,
      'owner',
      undefined,
      'prepare-only',
      'watch-event',
      undefined,
      { idempotencyKey: 'owner:revision' },
    );
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare(
          'UPDATE autopilot_owner_turns SET prepared_json = ? WHERE turn_id = ?;',
        )
        .run('{', malformed.turnId);
    } finally {
      database.close();
    }

    const replacement = registerPendingAutopilotTurn(
      paths.home,
      'owner',
      undefined,
      'prepare-only',
      'watch-event',
      undefined,
      { idempotencyKey: 'owner:revision' },
    );

    expect(replacement.turnId).not.toBe(malformed.turnId);
    expect(readPendingAutopilotTurn(paths.home, 'owner')?.turnId).toBe(
      replacement.turnId,
    );
  });
});

function watchFixture(): PrWatch {
  const now = '2026-08-21T00:00:00.000Z';
  return {
    id: 'acme/widgets#1',
    repoId: 'widgets',
    repoFullName: 'acme/widgets',
    githubOwner: 'acme',
    githubName: 'widgets',
    prNumber: 1,
    desiredTerminalState: 'checks',
    status: 'watching',
    prState: 'open',
    title: 'Improve persistence',
    url: 'https://example.test/acme/widgets/pull/1',
    mergeCommitSha: null,
    lastSnapshot: null,
    lastOutcome: null,
    lastCheckedAt: null,
    createdBy: null,
    processExisting: false,
    initialEventProcessedAt: null,
    eventWatermarkVersion: 2,
    autopilotMode: 'prepare-only',
    autopilotStatus: 'watching',
    ownerInstanceId: null,
    worktreeId: null,
    lastEventFingerprint: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-owner-'));
  tempRoots.push(path);
  return path;
}
